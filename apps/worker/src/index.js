import {
  fetchCuratedPolymarketRadar,
  fetchNegRiskArbRadar,
  fetchResolutionTrapRadar,
  scoreContractTrapRisk,
  resolveAndCalibratePolymarket,
  computeKellySizing,
  computeBrierScore,
  GAMMA_API_BASE,
} from "../../../packages/core/src/polymarket.js";
import {
  buildMerkleTree,
  verifyMerkleProof,
} from "../../../packages/core/src/merkle.js";
import {
  getChainHead,
  resolveHolderTier,
  readRegistryStats,
  verifyDeadBurnTx,
  isValidEvmAddress,
  DEFAULT_RH_RPC_URL,
} from "../../../packages/core/src/rpc.js";
import {
  hasLiveLlmKey,
  getActiveModelName,
  runThreeAgentCalibration,
  runChiefFollowUpChat,
} from "./llm.js";
import { broadcastSealEpochOnchain } from "./signer.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-wallet-address, x-admin-key, mcp-session-id",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function textResp(body, contentType = "text/plain; charset=utf-8", status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=60",
      ...CORS_HEADERS,
    },
  });
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getActorKey(req, wallet = "") {
  if (isValidEvmAddress(wallet)) {
    return `w:${wallet.trim().toLowerCase()}`;
  }
  const ip =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anon";
  return `ip:${ip}`;
}

async function resolveCallerAccess(env, walletRaw = "") {
  const wallet = String(walletRaw || "").trim().toLowerCase();
  const rpcUrl = env.RH_RPC_URL || DEFAULT_RH_RPC_URL;
  const holdForecaster = BigInt(env.HOLD_FORECASTER || "1000000");
  const holdSyndicate = BigInt(env.HOLD_SYNDICATE || "5000000");
  const decimals = Number(env.TOKEN_DECIMALS || "18");

  let base = { tier: "visitor", tierLevel: 0, balanceTokens: 0, wallet: isValidEvmAddress(wallet) ? wallet : null };
  if (isValidEvmAddress(wallet)) {
    try {
      base = await resolveHolderTier(wallet, {
        tokenAddress: env.TOKEN_ADDRESS || "",
        holdForecaster,
        holdSyndicate,
        decimals,
        rpcUrl,
      });
    } catch {
      // Non-fatal RPC fallback
    }

    // Check active 7-day priority burn pass in D1
    if (env.DB && base.tierLevel < 2) {
      const nowSec = Math.floor(Date.now() / 1000);
      const burnPass = await env.DB.prepare(
        "SELECT tx_hash, burned_tokens, expires_at FROM priority_burns WHERE burner_wallet = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1"
      )
        .bind(wallet, nowSec)
        .first();
      if (burnPass) {
        base = {
          ...base,
          tier: "syndicate",
          tierLevel: 2,
          burnPassTx: burnPass.tx_hash,
          burnPassExpiresAt: burnPass.expires_at,
        };
      }
    }
  }

  const aiLimit =
    base.tierLevel === 2
      ? Number(env.AI_SYNDICATE_PER_DAY || 250)
      : base.tierLevel === 1
        ? Number(env.AI_FORECASTER_PER_DAY || 60)
        : Number(env.AI_FREE_PER_DAY || 15);

  const mcpLimit =
    base.tierLevel === 2
      ? Number(env.MCP_SYNDICATE_PER_DAY || 50000)
      : base.tierLevel === 1
        ? Number(env.MCP_FORECASTER_PER_DAY || 5000)
        : Number(env.MCP_FREE_PER_DAY || 300);

  return { ...base, limits: { aiPerDay: aiLimit, mcpPerDay: mcpLimit } };
}

async function consumeDailyQuota(env, actorKey, kind, limit) {
  if (!env.DB) return { allowed: true, used: 1, limit };
  const day = utcDayKey();
  const row = await env.DB.prepare(
    "SELECT used_count FROM daily_quotas WHERE actor_key = ? AND day_utc = ? AND kind = ?"
  )
    .bind(actorKey, day, kind)
    .first();
  const used = Number(row?.used_count || 0);
  if (used >= limit) {
    return { allowed: false, used, limit };
  }
  await env.DB.prepare(
    `INSERT INTO daily_quotas (actor_key, day_utc, kind, used_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(actor_key, day_utc, kind) DO UPDATE SET used_count = used_count + 1`
  )
    .bind(actorKey, day, kind)
    .run();
  return { allowed: true, used: used + 1, limit };
}

function hydrateDossierRow(row) {
  if (!row) return null;
  try {
    return {
      marketId: row.market_id,
      eventSlug: row.event_slug,
      question: row.question,
      crowdProb: row.crowd_prob,
      fairProb: row.fair_prob,
      edgeBps: row.edge_bps,
      direction: row.direction,
      confidence: row.confidence,
      modelName: row.model_name,
      baseRateAgent: JSON.parse(row.base_rate_card_json),
      trapDevilAgent: JSON.parse(row.trap_devil_card_json),
      chiefForecaster: JSON.parse(row.chief_card_json),
      verbatimCheck: JSON.parse(row.verbatim_check_json),
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function mergeDossierIntoMarket(market, dossier) {
  if (!dossier) return { ...market, aiDossier: null };
  const kelly = computeKellySizing({
    fairProb: dossier.fairProb,
    crowdProb: market.crowdProb,
    spread: market.spread,
    bankrollUsd: 1000,
  });
  const edgeProb = Number((dossier.fairProb - market.crowdProb).toFixed(4));
  const edgeBps = Math.round(edgeProb * 10_000);
  let verdictCode = "EFFICIENT";
  let direction = "NO_EDGE";
  if (market.spread >= 0.06 && Math.abs(edgeBps) < Math.round(market.spread * 10_000)) {
    verdictCode = "SPREAD_TRAP";
    direction = "PASS_SPREAD";
  } else if (edgeBps >= 220 && kelly.netEdgeAfterSpread > 0.01) {
    verdictCode = "MISPRICED_YES";
    direction = "BUY_YES";
  } else if (edgeBps <= -220 && kelly.netEdgeAfterSpread > 0.01) {
    verdictCode = "MISPRICED_NO";
    direction = "BUY_NO";
  }

  return {
    ...market,
    actuarialFairProb: market.fairProb,
    fairProb: dossier.fairProb,
    fairProbBps: Math.round(dossier.fairProb * 10_000),
    edgeProb,
    edgeBps,
    absEdgeBps: Math.abs(edgeBps),
    verdictCode,
    direction,
    confidence: dossier.confidence,
    confidenceBps: Math.round(dossier.confidence * 10_000),
    kelly,
    modelSource: `kalibr-3agent:${dossier.modelName}`,
    aiDossier: dossier,
  };
}

async function saveAiDossier(env, dossier) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO ai_dossiers (
      market_id, event_slug, question, crowd_prob, fair_prob, edge_bps,
      direction, confidence, model_name, base_rate_card_json, trap_devil_card_json,
      chief_card_json, verbatim_check_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(market_id) DO UPDATE SET
      crowd_prob = excluded.crowd_prob,
      fair_prob = excluded.fair_prob,
      edge_bps = excluded.edge_bps,
      direction = excluded.direction,
      confidence = excluded.confidence,
      model_name = excluded.model_name,
      base_rate_card_json = excluded.base_rate_card_json,
      trap_devil_card_json = excluded.trap_devil_card_json,
      chief_card_json = excluded.chief_card_json,
      verbatim_check_json = excluded.verbatim_check_json,
      created_at = excluded.created_at`
  )
    .bind(
      dossier.marketId,
      dossier.eventSlug,
      dossier.question,
      dossier.crowdProb,
      dossier.fairProb,
      dossier.edgeBps,
      dossier.direction,
      dossier.confidence,
      dossier.modelName,
      JSON.stringify(dossier.baseRateAgent),
      JSON.stringify(dossier.trapDevilAgent),
      JSON.stringify(dossier.chiefForecaster),
      JSON.stringify(dossier.verbatimCheck),
      dossier.createdAt
    )
    .run();
}

async function getRadarWithCache(env, { domain = "all", limit = 18, forceRefresh = false } = {}) {
  const cacheKey = `radar:${domain}`;
  const nowSec = Math.floor(Date.now() / 1000);

  let markets = null;
  if (!forceRefresh && env.DB) {
    const cached = await env.DB.prepare(
      "SELECT payload_json, updated_at FROM radar_cache WHERE cache_key = ?"
    )
      .bind(cacheKey)
      .first();
    if (cached && nowSec - Number(cached.updated_at) <= 45) {
      try {
        markets = JSON.parse(cached.payload_json);
      } catch {
        markets = null;
      }
    }
  }

  if (!markets) {
    markets = await fetchCuratedPolymarketRadar({ limit: Math.max(limit, 18), domainFilter: domain });
    if (env.DB && markets.length > 0) {
      await env.DB.prepare(
        `INSERT INTO radar_cache (cache_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
      )
        .bind(cacheKey, JSON.stringify(markets), nowSec)
        .run();
    }
  }

  // Merge stored 3-agent AI calibrations
  if (env.DB && markets.length > 0) {
    const { results } = await env.DB.prepare("SELECT * FROM ai_dossiers ORDER BY created_at DESC LIMIT 60").all();
    const byId = new Map((results || []).map((r) => [r.market_id, hydrateDossierRow(r)]));
    markets = markets.map((m) => mergeDossierIntoMarket(m, byId.get(m.marketId) || null));
  }

  return markets.slice(0, limit);
}

async function getNegRiskArbWithCache(env, { mode = "all", limit = 24, forceRefresh = false } = {}) {
  const cacheKey = `arb:${mode}`;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!forceRefresh && env.DB) {
    const cached = await env.DB.prepare("SELECT payload_json, updated_at FROM radar_cache WHERE cache_key = ?")
      .bind(cacheKey)
      .first();
    if (cached && nowSec - Number(cached.updated_at) <= 45) {
      try {
        const parsed = JSON.parse(cached.payload_json);
        if (Array.isArray(parsed)) return parsed.slice(0, limit);
      } catch {
        // Re-fetch below
      }
    }
  }
  const books = await fetchNegRiskArbRadar({ limit: Math.max(limit, 24), mode });
  if (env.DB && books.length > 0) {
    await env.DB.prepare(
      `INSERT INTO radar_cache (cache_key, payload_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
    )
      .bind(cacheKey, JSON.stringify(books), nowSec)
      .run();
  }
  return books.slice(0, limit);
}

async function getTrapRadarWithCache(env, { domain = "all", limit = 24, forceRefresh = false } = {}) {
  const markets = await getRadarWithCache(env, { domain, limit: Math.max(limit, 30), forceRefresh });
  const enriched = markets.map((m) => ({ ...m, ...scoreContractTrapRisk(m) }));
  enriched.sort((a, b) => {
    if (b.trapRiskScore !== a.trapRiskScore) return b.trapRiskScore - a.trapRiskScore;
    return b.volume24hUsd - a.volume24hUsd;
  });
  return enriched.slice(0, limit);
}

async function refreshResolvedOutcomes(env) {
  if (!env.DB) return 0;
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT market_id, event_slug FROM sealed_forecasts WHERE resolved_outcome IS NULL LIMIT 15"
  ).all();
  let updated = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const row of results || []) {
    try {
      const r = await fetch(`${GAMMA_API_BASE}/markets?id=${encodeURIComponent(row.market_id)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) continue;
      const arr = await r.json();
      const m = Array.isArray(arr) ? arr[0] : null;
      if (!m || m.closed !== true) continue;
      const prices = JSON.parse(m.outcomePrices || "[]").map(Number);
      if (prices[0] >= 0.98 || prices[0] <= 0.02) {
        const outcome = prices[0] >= 0.98 ? 1 : 0;
        await env.DB.prepare(
          "UPDATE sealed_forecasts SET resolved_outcome = ?, resolved_at = ? WHERE market_id = ?"
        )
          .bind(outcome, nowSec, row.market_id)
          .run();
        updated += 1;
      }
    } catch {
      // Skip transient network error
    }
  }
  return updated;
}

/**
 * Hourly Pre-Resolution Merkle Sealer:
 *  1. Fetches top live Polymarket world events
 *  2. Optionally runs 3-agent OpenAI calibration on top 2 uncalibrated markets if OPENAI_API_KEY is present
 *  3. Builds canonical Keccak-256 sorted-pair Merkle tree for `epochHour`
 *  4. Saves leaves & proofs in D1 and broadcasts `ForecastSealRegistry.sealEpoch` to Robinhood Chain (4663) if `SEAL_SIGNER_KEY` is configured
 */
export async function runHourlySealTick(env, { force = false } = {}) {
  if (!env.DB) return { ok: false, reason: "no_db" };

  const nowSec = Math.floor(Date.now() / 1000);
  const epochHour = Math.floor(nowSec / 3600) * 3600;

  const existing = await env.DB.prepare("SELECT * FROM sealed_epochs WHERE epoch_hour = ?")
    .bind(epochHour)
    .first();
  if (existing && !force) {
    return { ok: true, skipped: true, epochHour, merkleRoot: existing.merkle_root, txHash: existing.tx_hash };
  }

  const targetEpoch = existing && force ? epochHour - 3600 : epochHour;
  const alreadyTarget = await env.DB.prepare("SELECT * FROM sealed_epochs WHERE epoch_hour = ?")
    .bind(targetEpoch)
    .first();
  if (alreadyTarget) {
    return { ok: true, skipped: true, epochHour: targetEpoch, merkleRoot: alreadyTarget.merkle_root };
  }

  const markets = await getRadarWithCache(env, { domain: "all", limit: 14, forceRefresh: true });
  if (!markets || markets.length === 0) {
    return { ok: false, reason: "no_live_markets" };
  }

  // Upgrade top 2 uncalibrated markets with live 3-agent LLM calibration when key is configured
  if (hasLiveLlmKey(env)) {
    let calibratedNow = 0;
    for (let i = 0; i < markets.length && calibratedNow < 2; i++) {
      if (!markets[i].aiDossier) {
        try {
          const dossier = await runThreeAgentCalibration(env, markets[i]);
          await saveAiDossier(env, dossier);
          markets[i] = mergeDossierIntoMarket(markets[i], dossier);
          calibratedNow += 1;
        } catch {
          // Continue sealing actuarial probabilities if LLM times out
        }
      }
    }
  }

  const leafInputs = markets.map((m) => ({
    epochHour: targetEpoch,
    chainId: 4663,
    marketId: m.marketId,
    eventSlug: m.eventSlug,
    question: m.question,
    crowdProbBps: m.crowdProbBps,
    fairProbBps: m.fairProbBps,
    edgeBps: m.edgeBps,
    direction: m.direction,
    confidenceBps: m.confidenceBps,
    modelSource: m.modelSource,
  }));

  const tree = buildMerkleTree(leafInputs);
  const mispricedCount = markets.filter((m) => m.verdictCode.startsWith("MISPRICED")).length;

  let txHash = null;
  if (
    isValidEvmAddress(env.SEAL_REGISTRY_ADDRESS) &&
    env.SEAL_SIGNER_KEY &&
    String(env.SEAL_SIGNER_KEY).trim().length >= 64
  ) {
    try {
      const sent = await broadcastSealEpochOnchain({
        registryAddress: env.SEAL_REGISTRY_ADDRESS.trim(),
        signerPrivateKey: String(env.SEAL_SIGNER_KEY).trim(),
        epochHour: targetEpoch,
        merkleRoot: tree.root,
        marketCount: tree.leaves.length,
        mispricedCount,
        rpcUrl: env.RH_RPC_URL || DEFAULT_RH_RPC_URL,
      });
      txHash = sent.txHash;
    } catch (err) {
      console.error("[kalibr-sealer] onchain broadcast error:", err.message);
    }
  }

  const stmts = [
    env.DB.prepare(
      `INSERT INTO sealed_epochs (epoch_hour, merkle_root, market_count, mispriced_count, tx_hash, chain_id, sealed_at)
       VALUES (?, ?, ?, ?, ?, 4663, ?)`
    ).bind(targetEpoch, tree.root, tree.leaves.length, mispricedCount, txHash, nowSec),
  ];

  for (const leaf of tree.leaves) {
    const n = leaf.normalized;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO sealed_forecasts (
          epoch_hour, market_id, event_slug, question, crowd_prob_bps, fair_prob_bps,
          edge_bps, direction, confidence_bps, model_source, leaf_hash, canonical_leaf, proof_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        n.epochHour,
        n.marketId,
        n.eventSlug,
        n.question,
        n.crowdProbBps,
        n.fairProbBps,
        n.edgeBps,
        n.direction,
        n.confidenceBps,
        n.modelSource,
        leaf.leafHash,
        leaf.canonical,
        JSON.stringify(leaf.proof)
      )
    );
  }

  await env.DB.batch(stmts);
  await refreshResolvedOutcomes(env);

  return {
    ok: true,
    epochHour: targetEpoch,
    merkleRoot: tree.root,
    marketCount: tree.leaves.length,
    mispricedCount,
    txHash,
  };
}

async function getBrierSummary(env) {
  if (!env.DB) return { count: 0, kalibrBrier: null, crowdBrier: null, skillImprovementPct: null };
  const { results } = await env.DB.prepare(
    "SELECT crowd_prob_bps, fair_prob_bps, resolved_outcome FROM sealed_forecasts WHERE resolved_outcome IS NOT NULL"
  ).all();
  const mapped = (results || []).map((r) => ({
    crowdProb: Number(r.crowd_prob_bps) / 10_000,
    fairProb: Number(r.fair_prob_bps) / 10_000,
    outcome: Number(r.resolved_outcome),
  }));
  return computeBrierScore(mapped);
}

const MCP_TOOLS = [
  {
    name: "scan_polymarket_edge",
    description:
      "Instant <1.2s probability calibration & resolution fine-print trap audit for any Polymarket URL, slug, or world event question. Returns crowd probability, calibrated fair probability, edge bps, Quarter-Kelly stake, multi-bracket coherence, and rule traps.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Polymarket URL (https://polymarket.com/event/...), slug, or event question (e.g. 'Fed rate cut December')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_mispriced_radar",
    description:
      "List top live non-sports world events on Polymarket ranked by calibrated probability edge (Crowd vs KALIBR Fair Probability) across Macro, AI & Tech, Geopolitics, Crypto, and Policy.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          enum: ["all", "macro", "ai", "geopolitics", "crypto", "policy"],
          description: "Optional category filter",
        },
        limit: { type: "number", description: "Max markets to return (1-25)" },
      },
    },
  },
  {
    name: "run_ai_3agent_calibration",
    description:
      "Dispatch KALIBR's live 3-agent LLM panel (Base-Rate Analyst, Resolution Trap Devil, Chief Superforecaster) with verbatim upstream JSON verification on any Polymarket market.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Polymarket URL, slug, or event question" },
        wallet: { type: "string", description: "Optional read-only Robinhood Chain (4663) 0x address holding $KALIBR" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_sealed_epochs",
    description:
      "List pre-resolution hourly Keccak-256 Merkle roots sealed by KALIBR for Robinhood Chain (4663) ForecastSealRegistry.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent epochs (default 12)" },
      },
    },
  },
  {
    name: "verify_forecast_seal",
    description:
      "Fetch a sealed forecast leaf, its sorted-pair Keccak-256 Merkle proof, and verify cryptographic inclusion against the epoch Merkle root.",
    inputSchema: {
      type: "object",
      properties: {
        epochHour: { type: "number", description: "UTC epoch hour timestamp" },
        marketId: { type: "string", description: "Polymarket market ID" },
      },
      required: ["epochHour", "marketId"],
    },
  },
  {
    name: "get_brier_track_record",
    description:
      "Retrieve KALIBR's pre-resolution Brier Score accuracy vs Polymarket crowd baseline across resolved sealed forecasts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_negrisk_arb",
    description:
      "Scan live Polymarket multi-outcome NegRisk orderbooks for sum-of-odds parity anomalies: executable Dutch-book ask baskets (sumAsk < $1.00), Mint-set bid arbs (sumBid > $1.00), retail overround vigorish, and open-field unlisted candidate odds.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "closed", "open"], description: "Filter by closed partition vs augmented open field" },
        limit: { type: "number", description: "Max events to return (1-25)" },
      },
    },
  },
  {
    name: "scan_resolution_traps",
    description:
      "Rank live high-volume Polymarket world events by fine-print resolution dispute risk (UMA subjective reporting clauses, announcement vs GA shipment rules, strict timezone cutoffs, single-venue candle rules, and wide CLOB spreads).",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", enum: ["all", "macro", "ai", "geopolitics", "crypto", "policy"] },
        limit: { type: "number", description: "Max contracts to return (1-25)" },
      },
    },
  },
];

async function handleMcpRequest(req, env) {
  if (req.method === "GET") {
    return json({
      protocol: "mcp-streamable-http",
      serverInfo: { name: "kalibr-mcp", version: "0.1.0" },
      tools: MCP_TOOLS.map((t) => t.name),
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const walletHeader = req.headers.get("x-wallet-address") || "";
  const access = await resolveCallerAccess(env, walletHeader);
  const quota = await consumeDailyQuota(env, getActorKey(req, walletHeader), "mcp", access.limits.mcpPerDay);
  if (!quota.allowed) {
    return json(
      {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32029, message: `Daily MCP quota reached (${quota.limit}). Hold >=1M $KALIBR on Robinhood Chain for 5,000/day.` },
      },
      429
    );
  }

  const { id, method, params } = body || {};

  if (method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kalibr-mcp", version: "0.1.0" },
      },
    });
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (method === "ping") {
    return json({ jsonrpc: "2.0", id, result: {} });
  }

  if (method === "tools/list") {
    return json({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    try {
      let out;
      if (toolName === "scan_polymarket_edge") {
        const resolved = await resolveAndCalibratePolymarket(args.query);
        let dossier = null;
        if (env.DB) {
          const row = await env.DB.prepare("SELECT * FROM ai_dossiers WHERE market_id = ?")
            .bind(resolved.market.marketId)
            .first();
          dossier = hydrateDossierRow(row);
        }
        out = { ...resolved, market: mergeDossierIntoMarket(resolved.market, dossier) };
      } else if (toolName === "list_mispriced_radar") {
        const limit = Math.min(25, Math.max(1, Number(args.limit || 10)));
        out = { markets: await getRadarWithCache(env, { domain: args.domain || "all", limit }) };
      } else if (toolName === "run_ai_3agent_calibration") {
        if (!hasLiveLlmKey(env)) {
          throw new Error("Live LLM API key is not configured on this worker; use scan_polymarket_edge for actuarial calibration.");
        }
        const resolved = await resolveAndCalibratePolymarket(args.query);
        const dossier = await runThreeAgentCalibration(env, resolved.market);
        await saveAiDossier(env, dossier);
        out = { market: mergeDossierIntoMarket(resolved.market, dossier) };
      } else if (toolName === "list_sealed_epochs") {
        const limit = Math.min(48, Math.max(1, Number(args.limit || 12)));
        const { results } = env.DB
          ? await env.DB.prepare("SELECT * FROM sealed_epochs ORDER BY epoch_hour DESC LIMIT ?").bind(limit).all()
          : { results: [] };
        out = { epochs: results || [] };
      } else if (toolName === "verify_forecast_seal") {
        const row = env.DB
          ? await env.DB.prepare("SELECT * FROM sealed_forecasts WHERE epoch_hour = ? AND market_id = ?")
              .bind(Number(args.epochHour), String(args.marketId))
              .first()
          : null;
        const ep = env.DB
          ? await env.DB.prepare("SELECT * FROM sealed_epochs WHERE epoch_hour = ?")
              .bind(Number(args.epochHour))
              .first()
          : null;
        if (!row || !ep) throw new Error("Sealed forecast leaf not found for given epochHour and marketId.");
        const proof = JSON.parse(row.proof_json || "[]");
        const verified = verifyMerkleProof(row.leaf_hash, proof, ep.merkle_root);
        out = { verified, merkleRoot: ep.merkle_root, txHash: ep.tx_hash, leafHash: row.leaf_hash, canonicalLeaf: row.canonical_leaf, proof };
      } else if (toolName === "get_brier_track_record") {
        out = await getBrierSummary(env);
      } else if (toolName === "list_negrisk_arb") {
        const limit = Math.min(25, Math.max(1, Number(args.limit || 14)));
        out = { books: await getNegRiskArbWithCache(env, { mode: args.mode || "all", limit }) };
      } else if (toolName === "scan_resolution_traps") {
        const limit = Math.min(25, Math.max(1, Number(args.limit || 14)));
        out = { contracts: await getTrapRadarWithCache(env, { domain: args.domain || "all", limit }) };
      } else {
        return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } }, 404);
      }

      return json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        },
      });
    } catch (err) {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Error: ${err.message}` }],
        },
      });
    }
  }

  return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "Method not found" } }, 404);
}

function buildSkillMarkdown(env) {
  const siteUrl = (env.SITE_URL || "https://kalibragent.com").replace(/\/+$/, "");
  return `# KALIBR (${siteUrl}) — Agent & MCP Skill

Autonomous AI probability calibration agents, live Polymarket mispricing & fine-print rule-trap scanner, and pre-resolution Keccak-256 Merkle forecast seals on Robinhood Chain (\`4663\`).

## Connect via Streamable HTTP MCP

\`\`\`json
{
  "mcpServers": {
    "kalibr": {
      "url": "${siteUrl}/mcp"
    }
  }
}
\`\`\`

## Zero-Dependency CLI & Stdio MCP

\`\`\`bash
npx github:Kalibr-Agent/kalibr radar
npx github:Kalibr-Agent/kalibr scan "https://polymarket.com/event/fed-decision-in-december"
npx github:Kalibr-Agent/kalibr init
\`\`\`

## Tools
- \`scan_polymarket_edge({ query })\` — <1.2s actuarial edge, Quarter-Kelly stake, multi-bracket coherence & fine-print rule traps.
- \`list_mispriced_radar({ domain?, limit? })\` — live non-sports world events ranked by crowd vs fair-value divergence.
- \`list_negrisk_arb({ mode?, limit? })\` — multi-outcome NegRisk sum-of-odds parity scanner (Dutch-book ask baskets, Mint-set bid arbs, overround vigorish & unlisted field odds).
- \`scan_resolution_traps({ domain?, limit? })\` — live fine-print & UMA oracle dispute trap radar across high-volume Polymarket contracts.
- \`run_ai_3agent_calibration({ query, wallet? })\` — 3-agent LLM calibration (Base-Rate Analyst, Resolution Trap Devil, Chief Superforecaster) with verbatim JSON verification.
- \`list_sealed_epochs({ limit? })\` / \`verify_forecast_seal({ epochHour, marketId })\` — verify pre-resolution Keccak-256 Merkle seals on Robinhood Chain (4663).
`;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const pathname = url.pathname;

    try {
      if (pathname === "/mcp") {
        return await handleMcpRequest(req, env);
      }

      if (pathname === "/SKILL.md") {
        return textResp(buildSkillMarkdown(env), "text/markdown; charset=utf-8");
      }

      if (pathname === "/llms.txt") {
        const siteUrl = (env.SITE_URL || "https://kalibragent.com").replace(/\/+$/, "");
        return textResp(
          `# KALIBR\n> Autonomous AI probability calibration & Polymarket mispricing atelier.\n\n- Mispricing Board: ${siteUrl}/\n- NegRisk & Sum-of-Odds Scanner: ${siteUrl}/arb\n- Resolution Trap Radar: ${siteUrl}/traps\n- Multi-Leg Kelly Slate Builder: ${siteUrl}/kelly\n- Onchain Merkle Seals: ${siteUrl}/seals\n- Agent CLI, MCP & $KALIBR Tiers: ${siteUrl}/agents\n- GitHub Repository: https://github.com/Kalibr-Agent/kalibr\n- Streamable HTTP MCP: ${siteUrl}/mcp\n- Agent Skill: ${siteUrl}/SKILL.md\n- API Status: ${siteUrl}/v1/status\n- Live Mispricing Radar: ${siteUrl}/v1/radar\n- Live NegRisk Arb Radar: ${siteUrl}/v1/arb\n- Live Resolution Trap Radar: ${siteUrl}/v1/traps\n- Sealed Epochs: ${siteUrl}/v1/seals\n`
        );
      }

      if (pathname === "/v1/status" && req.method === "GET") {
        const walletParam = url.searchParams.get("wallet") || req.headers.get("x-wallet-address") || "";
        const rpcUrl = env.RH_RPC_URL || DEFAULT_RH_RPC_URL;

        const [headBlock, rawRegistryStats, caller, brier, onchainEpochRow, epochCountRow, forecastCountRow, dossierCountRow] =
          await Promise.all([
            getChainHead({ rpcUrl }).catch(() => null),
            readRegistryStats(env.SEAL_REGISTRY_ADDRESS || "", { rpcUrl }).catch(() => null),
            resolveCallerAccess(env, walletParam),
            getBrierSummary(env),
            env.DB
              ? env.DB
                  .prepare(
                    "SELECT COUNT(*) AS c, COALESCE(SUM(market_count), 0) AS m, COALESCE(MAX(epoch_hour), 0) AS latest FROM sealed_epochs WHERE tx_hash IS NOT NULL AND tx_hash != ''"
                  )
                  .first()
              : Promise.resolve({ c: 0, m: 0, latest: 0 }),
            env.DB ? env.DB.prepare("SELECT COUNT(*) AS c FROM sealed_epochs").first() : Promise.resolve({ c: 0 }),
            env.DB ? env.DB.prepare("SELECT COUNT(*) AS c FROM sealed_forecasts").first() : Promise.resolve({ c: 0 }),
            env.DB ? env.DB.prepare("SELECT COUNT(*) AS c FROM ai_dossiers").first() : Promise.resolve({ c: 0 }),
          ]);

        const verifiedD1Epochs = Number(onchainEpochRow?.c || 0);
        const verifiedD1Forecasts = Number(onchainEpochRow?.m || 0);
        const registryStats =
          rawRegistryStats && rawRegistryStats.totalEpochsSealed > 0
            ? rawRegistryStats
            : {
                configured: Boolean(env.SEAL_REGISTRY_ADDRESS),
                registryAddress: env.SEAL_REGISTRY_ADDRESS || null,
                latestEpoch: rawRegistryStats?.latestEpoch || Number(onchainEpochRow?.latest || 0),
                totalEpochsSealed: Math.max(rawRegistryStats?.totalEpochsSealed || 0, verifiedD1Epochs),
                totalForecastsSealed: Math.max(rawRegistryStats?.totalForecastsSealed || 0, verifiedD1Forecasts),
              };

        return json({
          ok: true,
          chainId: 4663,
          network: "Robinhood Chain",
          headBlock,
          tokenAddress: env.TOKEN_ADDRESS || null,
          sealRegistryAddress: env.SEAL_REGISTRY_ADDRESS || null,
          registryOnchain: registryStats,
          aiEngine: {
            live: hasLiveLlmKey(env),
            model: getActiveModelName(env) || "actuarial-v1 (set OPENAI_API_KEY for 3-agent LLM)",
          },
          stats: {
            sealedEpochs: registryStats.configured
              ? Number(registryStats.totalEpochsSealed || 0)
              : Number(epochCountRow?.c || 0),
            sealedForecasts: registryStats.configured
              ? Number(registryStats.totalForecastsSealed || 0)
              : Number(forecastCountRow?.c || 0),
            d1Epochs: Number(epochCountRow?.c || 0),
            d1Forecasts: Number(forecastCountRow?.c || 0),
            aiDossiers: Number(dossierCountRow?.c || 0),
            brier,
          },
          tiers: {
            forecasterTokens: Number(env.HOLD_FORECASTER || 1000000),
            syndicateTokens: Number(env.HOLD_SYNDICATE || 5000000),
            priorityBurnTokens: Number(env.BURN_PRIORITY || 100000),
          },
          caller,
        });
      }

      if (pathname === "/v1/radar" && req.method === "GET") {
        const domain = url.searchParams.get("domain") || "all";
        const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 18)));
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const markets = await getRadarWithCache(env, { domain, limit, forceRefresh });
        return json({
          ok: true,
          domain,
          count: markets.length,
          mispricedCount: markets.filter((m) => m.verdictCode.startsWith("MISPRICED")).length,
          markets,
        });
      }

      if (pathname === "/v1/arb" && req.method === "GET") {
        const mode = url.searchParams.get("mode") || "all";
        const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 20)));
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const books = await getNegRiskArbWithCache(env, { mode, limit, forceRefresh });
        return json({
          ok: true,
          mode,
          count: books.length,
          actionableCount: books.filter((b) => b.arbVerdict !== "TIGHT_COHERENT").length,
          books,
        });
      }

      if (pathname === "/v1/traps" && req.method === "GET") {
        const domain = url.searchParams.get("domain") || "all";
        const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 22)));
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const contracts = await getTrapRadarWithCache(env, { domain, limit, forceRefresh });
        return json({
          ok: true,
          domain,
          count: contracts.length,
          highRiskCount: contracts.filter((c) => c.trapVerdict === "HIGH_DISPUTE_RISK").length,
          flaggedCount: contracts.filter((c) => (c.ruleTraps || []).length > 0).length,
          contracts,
        });
      }

      if (pathname === "/v1/inspect" && req.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const resolved = await resolveAndCalibratePolymarket(q);
        let dossier = null;
        if (env.DB) {
          const row = await env.DB.prepare("SELECT * FROM ai_dossiers WHERE market_id = ?")
            .bind(resolved.market.marketId)
            .first();
          dossier = hydrateDossierRow(row);
        }
        return json({
          ok: true,
          matchType: resolved.matchType,
          market: mergeDossierIntoMarket(resolved.market, dossier),
          alternatives: resolved.alternatives,
        });
      }

      if (pathname === "/v1/calibrate" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const query = String(body.query || "").trim();
        const wallet = String(body.wallet || req.headers.get("x-wallet-address") || "").trim();
        if (!query) return json({ ok: false, error: "Provide query (Polymarket URL, slug, or event question)." }, 400);

        if (!hasLiveLlmKey(env)) {
          return json(
            {
              ok: false,
              code: "ai_key_not_configured",
              error:
                "3-Agent LLM inference requires OPENAI_API_KEY or ANTHROPIC_API_KEY on the Worker. Deterministic actuarial edge & rule-trap calibration remains 100% active.",
            },
            503
          );
        }

        const access = await resolveCallerAccess(env, wallet);
        const quota = await consumeDailyQuota(env, getActorKey(req, wallet), "ai", access.limits.aiPerDay);
        if (!quota.allowed) {
          return json(
            {
              ok: false,
              code: "quota_exceeded",
              error: `Daily 3-Agent AI quota reached (${quota.used}/${quota.limit}). Paste a Robinhood Chain wallet holding >=1,000,000 $KALIBR (0-wallet read-only) for 60/day.`,
            },
            429
          );
        }

        const resolved = await resolveAndCalibratePolymarket(query);
        const dossier = await runThreeAgentCalibration(env, resolved.market);
        await saveAiDossier(env, dossier);

        return json({
          ok: true,
          quota,
          caller: access,
          market: mergeDossierIntoMarket(resolved.market, dossier),
        });
      }

      if (pathname === "/v1/ask" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const query = String(body.query || "").trim();
        const question = String(body.question || "").trim();
        const wallet = String(body.wallet || req.headers.get("x-wallet-address") || "").trim();
        if (!query || !question) {
          return json({ ok: false, error: "Both query and question are required." }, 400);
        }
        if (!hasLiveLlmKey(env)) {
          return json(
            {
              ok: false,
              code: "ai_key_not_configured",
              error: "Live Chief Calibrator Q&A requires OPENAI_API_KEY or ANTHROPIC_API_KEY on the Worker.",
            },
            503
          );
        }

        const access = await resolveCallerAccess(env, wallet);
        const quota = await consumeDailyQuota(env, getActorKey(req, wallet), "ai", access.limits.aiPerDay);
        if (!quota.allowed) {
          return json({ ok: false, error: `Daily AI quota reached (${quota.limit}/day).` }, 429);
        }

        const resolved = await resolveAndCalibratePolymarket(query);
        let dossier = null;
        if (env.DB) {
          const row = await env.DB.prepare("SELECT * FROM ai_dossiers WHERE market_id = ?")
            .bind(resolved.market.marketId)
            .first();
          dossier = hydrateDossierRow(row);
        }
        const reply = await runChiefFollowUpChat(env, { market: resolved.market, dossier, question });
        return json({ ok: true, ...reply });
      }

      if (pathname === "/v1/seals" && req.method === "GET") {
        const limit = Math.min(48, Math.max(1, Number(url.searchParams.get("limit") || 16)));
        const { results: epochs } = env.DB
          ? await env.DB.prepare("SELECT * FROM sealed_epochs ORDER BY epoch_hour DESC LIMIT ?").bind(limit).all()
          : { results: [] };
        const brier = await getBrierSummary(env);
        return json({
          ok: true,
          sealRegistryAddress: env.SEAL_REGISTRY_ADDRESS || null,
          brier,
          epochs: epochs || [],
        });
      }

      const sealEpochMatch = pathname.match(/^\/v1\/seals\/(\d+)$/);
      if (sealEpochMatch && req.method === "GET") {
        const epochHour = Number(sealEpochMatch[1]);
        const ep = env.DB
          ? await env.DB.prepare("SELECT * FROM sealed_epochs WHERE epoch_hour = ?").bind(epochHour).first()
          : null;
        if (!ep) return json({ ok: false, error: "Epoch not found" }, 404);
        const { results: leaves } = await env.DB.prepare(
          "SELECT * FROM sealed_forecasts WHERE epoch_hour = ? ORDER BY ABS(edge_bps) DESC"
        )
          .bind(epochHour)
          .all();
        return json({
          ok: true,
          epoch: ep,
          forecasts: (leaves || []).map((l) => ({
            ...l,
            proof: JSON.parse(l.proof_json || "[]"),
          })),
        });
      }

      const proofMatch = pathname.match(/^\/v1\/proofs\/(\d+)\/([^/]+)$/);
      if (proofMatch && req.method === "GET") {
        const epochHour = Number(proofMatch[1]);
        const marketId = decodeURIComponent(proofMatch[2]);
        const ep = env.DB
          ? await env.DB.prepare("SELECT * FROM sealed_epochs WHERE epoch_hour = ?").bind(epochHour).first()
          : null;
        const row = env.DB
          ? await env.DB.prepare("SELECT * FROM sealed_forecasts WHERE epoch_hour = ? AND market_id = ?")
              .bind(epochHour, marketId)
              .first()
          : null;
        if (!ep || !row) return json({ ok: false, error: "Proof leaf not found" }, 404);
        const proof = JSON.parse(row.proof_json || "[]");
        return json({
          ok: true,
          epochHour,
          merkleRoot: ep.merkle_root,
          txHash: ep.tx_hash,
          sealedAt: ep.sealed_at,
          leafHash: row.leaf_hash,
          canonicalLeaf: row.canonical_leaf,
          proof,
          verified: verifyMerkleProof(row.leaf_hash, proof, ep.merkle_root),
        });
      }

      if (pathname === "/v1/burns" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const txHash = String(body.txHash || "").trim();
        const targetQuery = String(body.query || "").trim();
        const verified = await verifyDeadBurnTx(txHash, {
          tokenAddress: env.TOKEN_ADDRESS || "",
          minBurnTokens: BigInt(env.BURN_PRIORITY || "100000"),
          decimals: Number(env.TOKEN_DECIMALS || "18"),
          rpcUrl: env.RH_RPC_URL || DEFAULT_RH_RPC_URL,
        });

        const nowSec = Math.floor(Date.now() / 1000);
        const expiresAt = nowSec + 7 * 86_400;
        if (env.DB) {
          await env.DB.prepare(
            `INSERT INTO priority_burns (tx_hash, burner_wallet, burned_tokens, target_query, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(tx_hash) DO NOTHING`
          )
            .bind(verified.txHash, verified.burner, verified.burnedTokens, targetQuery, expiresAt, nowSec)
            .run();
        }
        return json({ ok: true, ...verified, expiresAt });
      }

      if (pathname === "/v1/admin/seal-now" && req.method === "POST") {
        const key = req.headers.get("x-admin-key") || "";
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }
        const res = await runHourlySealTick(env, { force: true });
        return json(res);
      }

      if (env.ASSETS) {
        return await env.ASSETS.fetch(req);
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      return json({ ok: false, error: err.message || "Internal worker error" }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runHourlySealTick(env));
  },
};
