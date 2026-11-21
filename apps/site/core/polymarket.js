/**
 * Polymarket Live Gamma/CLOB Ingestion, Multi-Bracket Coherence,
 * Fine-Print Resolution Rule-Trap Scanner, and Actuarial Mispricing Calibrator.
 *
 * Zero external dependencies — runs in Browser, Cloudflare Worker, and Node >=20 CLI.
 */

export const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

const SPORTS_NOISE_TAGS = new Set([
  "sports", "esports", "games", "nba", "nfl", "nhl", "mlb", "mls", "ufc", "mma",
  "soccer", "basketball", "baseball", "football", "tennis", "golf", "cricket",
  "dota-2", "cs2", "valorant", "league-of-legends", "premier-league", "champions-league",
  "f1", "formula-1", "boxing", "ncaa", "wnba", "ere", "serie-a", "la-liga", "bundesliga",
]);

const DOMAIN_RULES = [
  { id: "ai", label: "AI & Tech", re: /\b(openai|gpt|claude|anthropic|gemini|deepseek|xai|grok|ai\b|agi|apple|nvidia|tesla|spacex|meta|google|microsoft|tiktok|chip|semiconductor)\b/i },
  { id: "macro", label: "Macro & Fed", re: /\b(fed\b|fomc|interest rate|bps|inflation|cpi|recession|gdp|treasury|tariff|powell|jobs|unemployment|gold|oil|s&p|nasdaq)\b/i },
  { id: "geopolitics", label: "Geopolitics", re: /\b(ceasefire|ukraine|russia|israel|iran|china|taiwan|nato|gaza|korea|syria|treaty|war|military|strike|sanction|eu\b|un\b)\b/i },
  { id: "crypto", label: "Crypto & Digital Assets", re: /\b(bitcoin|btc|ethereum|eth|solana|sol\b|etf|sec\b|stablecoin|tether|binance|coinbase|robinhood|fdv|airdrop|defi)\b/i },
  { id: "policy", label: "US & World Policy", re: /\b(president|election|nominee|senate|congress|house|supreme court|scotus|trump|governor|parliament|prime minister|bill|ban|doj)\b/i },
];

export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function safeJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Parses any user query: Polymarket URL, slug, or natural-language question.
 */
export function parsePolymarketQuery(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return { type: "empty", value: "" };

  try {
    if (/^https?:\/\//i.test(raw) || raw.includes("polymarket.com/")) {
      const urlStr = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const u = new URL(urlStr);
      const parts = u.pathname.split("/").filter(Boolean);
      const evIdx = parts.findIndex((p) => p === "event" || p === "market");
      if (evIdx >= 0 && parts[evIdx + 1]) {
        return {
          type: "slug",
          slug: parts[evIdx + 1].toLowerCase(),
          subSlug: parts[evIdx + 2] ? parts[evIdx + 2].toLowerCase() : null,
          value: raw,
        };
      }
    }
  } catch {
    // Fall through to slug / search detection
  }

  if (/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(raw) && !raw.includes(" ")) {
    return { type: "slug", slug: raw.toLowerCase(), subSlug: null, value: raw };
  }

  return { type: "search", value: raw };
}

export function isSportsOrGameEvent(event) {
  const tags = (event?.tags || []).map((t) => String(t?.slug || t?.label || "").toLowerCase());
  if (tags.some((t) => SPORTS_NOISE_TAGS.has(t))) return true;
  const title = String(event?.title || "");
  if (/\b(vs\.?|bo3|bo5|o\/u\s+\d|spread:\s*[+-]?\d|map\s+\d\s+winner)\b/i.test(title)) return true;
  return false;
}

export function classifyEventDomain(event) {
  if (isSportsOrGameEvent(event)) return { id: "sports", label: "Sports" };
  const tagText = (event?.tags || []).map((t) => `${t?.slug || ""} ${t?.label || ""}`).join(" ");
  const blob = `${event?.title || ""} ${tagText}`;
  for (const rule of DOMAIN_RULES) {
    if (rule.re.test(blob)) return { id: rule.id, label: rule.label };
  }
  return { id: "policy", label: "World Events" };
}

function parseMarketNumbers(m, event) {
  const outcomes = safeJsonArray(m?.outcomes);
  const prices = safeJsonArray(m?.outcomePrices).map((x) => Number(x));
  const rawYes = Number.isFinite(prices[0]) ? prices[0] : 0.5;
  const bestBid = Number.isFinite(Number(m?.bestBid)) ? Number(m.bestBid) : null;
  const bestAsk = Number.isFinite(Number(m?.bestAsk)) ? Number(m.bestAsk) : null;
  const rawSpread =
    Number.isFinite(Number(m?.spread))
      ? Math.max(0, Number(m.spread))
      : bestBid !== null && bestAsk !== null && bestAsk >= bestBid
        ? bestAsk - bestBid
        : 0.01;

  const hasTightBook = bestBid !== null && bestAsk !== null && bestAsk > 0 && bestAsk >= bestBid && bestAsk - bestBid <= 0.25;
  const midpoint = hasTightBook ? (bestBid + bestAsk) / 2 : rawYes;
  const crowdProb = clamp(rawYes, 0.005, 0.995);

  const volume24hUsd = Number(m?.volume24hr ?? event?.volume24hr ?? 0) || 0;
  const totalVolumeUsd = Number(m?.volumeNum ?? m?.volume ?? event?.volume ?? 0) || 0;
  const liquidityUsd = Number(m?.liquidityNum ?? m?.liquidity ?? event?.liquidity ?? 0) || 0;
  const oneDayChange = Number.isFinite(Number(m?.oneDayPriceChange)) ? Number(m.oneDayPriceChange) : 0;
  const oneWeekChange = Number.isFinite(Number(m?.oneWeekPriceChange)) ? Number(m.oneWeekPriceChange) : 0;
  const endDate = m?.endDate || event?.endDate || null;
  const endMs = endDate ? Date.parse(endDate) : NaN;
  const daysToResolution = Number.isFinite(endMs)
    ? Math.max(0.25, (endMs - Date.now()) / 86_400_000)
    : 45;

  return {
    marketId: String(m?.id || m?.conditionId || event?.id || ""),
    conditionId: String(m?.conditionId || ""),
    marketSlug: String(m?.slug || event?.slug || ""),
    question: String(m?.question || event?.title || "").trim(),
    groupItemTitle: String(m?.groupItemTitle || "").trim(),
    outcomes: outcomes.length >= 2 ? outcomes : ["Yes", "No"],
    crowdProb,
    midpointProb: clamp(midpoint, 0.005, 0.995),
    bestBid,
    bestAsk,
    spread: Number(rawSpread.toFixed(4)),
    volume24hUsd: Math.round(volume24hUsd),
    totalVolumeUsd: Math.round(totalVolumeUsd),
    liquidityUsd: Math.round(liquidityUsd),
    oneDayChange: Number(oneDayChange.toFixed(4)),
    oneWeekChange: Number(oneWeekChange.toFixed(4)),
    endDate,
    daysToResolution: Number(daysToResolution.toFixed(1)),
    description: String(m?.description || event?.description || "").trim(),
    resolutionSource: String(m?.resolutionSource || event?.resolutionSource || "").trim(),
  };
}

/**
 * Selects the highest-signal contested binary market inside a Polymarket event
 * AND computes multi-bracket sibling probability coherence across sibling outcomes.
 */
export function selectPrimaryBinaryMarket(event, queryHint = "") {
  const rawMarkets = (event?.markets || []).filter((m) => m && m.closed !== true && m.active !== false);
  if (rawMarkets.length === 0) return null;

  const parsedList = rawMarkets.map((m) => parseMarketNumbers(m, event));
  const hintLower = String(queryHint || "").toLowerCase().trim();

  // Score submarkets: strongly prefer contested probabilities (6%..94%) with real liquidity & volume
  const scored = parsedList.map((m) => {
    const p = m.crowdProb;
    const entropyWeight = 4 * p * (1 - p); // peaks at 1.0 when p=0.50, drops near 0 or 1
    const inContestedBand = p >= 0.04 && p <= 0.96 ? 1.0 : 0.12;
    const liqScore = Math.log10(Math.max(100, m.liquidityUsd + m.volume24hUsd));
    const hintMatch =
      hintLower &&
      (m.marketSlug.toLowerCase() === hintLower ||
        m.question.toLowerCase().includes(hintLower) ||
        m.groupItemTitle.toLowerCase().includes(hintLower))
        ? 8.0
        : 0;
    const binaryBonus =
      String(m.outcomes[0]).toLowerCase() === "yes" && String(m.outcomes[1]).toLowerCase() === "no"
        ? 0.6
        : 0;
    return {
      m,
      score: hintMatch + inContestedBand * (entropyWeight * 4.5 + liqScore) + binaryBonus,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const primary = scored[0].m;

  // Multi-bracket coherence analysis (for mutually exclusive multi-choice events like Fed Decision or Nominee)
  const activeYesProbs = parsedList.filter((x) => x.crowdProb > 0.004 && x.liquidityUsd >= 250);
  const sumYesProb = Number(activeYesProbs.reduce((acc, x) => acc + x.crowdProb, 0).toFixed(4));
  const isMutuallyExclusive =
    Boolean(event?.negRisk) ||
    (activeYesProbs.length >= 3 && activeYesProbs.length <= 40 && sumYesProb >= 0.86 && sumYesProb <= 1.24);

  const overroundBps = isMutuallyExclusive ? Math.round((sumYesProb - 1.0) * 10_000) : 0;

  const siblings = activeYesProbs
    .slice()
    .sort((a, b) => b.crowdProb - a.crowdProb)
    .slice(0, 6)
    .map((s) => ({
      marketId: s.marketId,
      label: s.groupItemTitle || s.question,
      crowdProb: Number(s.crowdProb.toFixed(4)),
      spread: s.spread,
      volume24hUsd: s.volume24hUsd,
    }));

  return {
    primary,
    siblingCoherence: {
      bracketCount: activeYesProbs.length,
      isMutuallyExclusive,
      sumYesProb,
      overroundBps,
      siblings,
    },
  };
}

/**
 * Scans actual Polymarket fine-print description & CLOB book for trader traps.
 */
export function auditResolutionRules({
  description = "",
  endDate = null,
  spread = 0.01,
  liquidityUsd = 50_000,
  volume24hUsd = 10_000,
  oneDayChange = 0,
  daysToResolution = 30,
}) {
  const traps = [];
  const text = String(description || "");

  const extractSnippet = (regex) => {
    const match = text.match(regex);
    if (!match || match.index === undefined) return null;
    const start = Math.max(0, match.index - 36);
    const end = Math.min(text.length, match.index + match[0].length + 68);
    return text.slice(start, end).replace(/\s+/g, " ").trim();
  };

  if (spread >= 0.035) {
    traps.push({
      code: "WIDE_CLOB_SPREAD",
      severity: spread >= 0.07 ? "HIGH" : "MEDIUM",
      title: `Wide CLOB Bid-Ask Spread (${(spread * 100).toFixed(1)}¢)`,
      detail: `Crossing the spread immediately costs ${(spread * 100).toFixed(1)} percentage points of edge. Use limit orders near midpoint.`,
      snippet: null,
    });
  }

  if (liquidityUsd > 0 && liquidityUsd < 12_000) {
    traps.push({
      code: "THIN_ORDERBOOK_DEPTH",
      severity: "HIGH",
      title: `Thin Orderbook Depth ($${liquidityUsd.toLocaleString()})`,
      detail: "Sub-$12K resting book depth allows a single mid-sized wallet to paint headline probabilities.",
      snippet: null,
    });
  }

  const announceRe = /\b(official(?:ly)?\s+announce\w*|publicly\s+release\w*|general\s+availability|rumors?\s+or\s+leaks?|beta\s+or\s+preview)\b/i;
  if (announceRe.test(text)) {
    traps.push({
      code: "ANNOUNCEMENT_VS_RELEASE",
      severity: "MEDIUM",
      title: "Announcement vs. Live Shipment Distinction",
      detail: "Fine print distinguishes between blog announcements, previews/betas, and general public release.",
      snippet: extractSnippet(announceRe),
    });
  }

  const consensusRe = /\b(consensus\s+of\s+credible\s+reporting|sole\s+discretion|uma\b|ambiguous)\b/i;
  if (consensusRe.test(text)) {
    traps.push({
      code: "SUBJECTIVE_UMA_CONSENSUS",
      severity: "MEDIUM",
      title: "Credible-Reporting / Oracle Dispute Clause",
      detail: "Resolves on 'consensus of credible reporting' rather than a single deterministic numeric feed.",
      snippet: extractSnippet(consensusRe),
    });
  }

  const tzRe = /\b(11:59\s*PM\s*(?:ET|EST|EDT|UTC)|23:59\s*UTC|Eastern\s+Time)\b/i;
  if (tzRe.test(text) && daysToResolution <= 14) {
    traps.push({
      code: "TIMEZONE_DEADLINE_CUTOFF",
      severity: "MEDIUM",
      title: "Strict Timezone Cutoff Window (<14d)",
      detail: "Near-term resolution hinges on an exact ET/UTC clock cutoff; late-night statements after cutoff resolve NO.",
      snippet: extractSnippet(tzRe),
    });
  }

  if (Math.abs(oneDayChange) >= 0.08 && liquidityUsd > 0 && volume24hUsd / liquidityUsd > 1.5) {
    traps.push({
      code: "HEADLINE_SPIKE_CHURN",
      severity: "MEDIUM",
      title: `24h Impulse Churn (${oneDayChange > 0 ? "+" : ""}${(oneDayChange * 100).toFixed(1)}%)`,
      detail: "High 24h turnover relative to resting liquidity indicates reactive headline flow prone to partial mean reversion.",
      snippet: null,
    });
  }

  if (daysToResolution >= 180) {
    traps.push({
      code: "CAPITAL_LOCKUP_DRAG",
      severity: "LOW",
      title: `Long Duration Capital Lockup (${Math.round(daysToResolution)}d)`,
      detail: `Capital locked for ${Math.round(daysToResolution)} days carries ~5.5% annualized opportunity cost, systematically discounting high-probability favorites.`,
      snippet: endDate ? `Scheduled end: ${endDate}` : null,
    });
  }

  return traps;
}

/**
 * Computes Quarter-Kelly & Half-Kelly position sizing after spread cost.
 */
export function computeKellySizing({
  fairProb,
  crowdProb,
  spread = 0.01,
  bankrollUsd = 1000,
}) {
  const p = clamp(Number(fairProb), 0.005, 0.995);
  const c = clamp(Number(crowdProb), 0.005, 0.995);
  const halfSpread = Math.min(0.12, Math.max(0, Number(spread || 0)) / 2);

  const rawDiff = p - c;
  const side = rawDiff >= 0 ? "YES" : "NO";

  // Effective executable entry price including half-spread
  const entryPrice = side === "YES" ? clamp(c + halfSpread, 0.01, 0.99) : clamp(1 - c + halfSpread, 0.01, 0.99);
  const winProb = side === "YES" ? p : 1 - p;

  // Binary payout odds b = (1 - entryPrice) / entryPrice
  const netEdge = winProb - entryPrice;
  const fullKelly = netEdge > 0 ? clamp(netEdge / (1 - entryPrice), 0, 1) : 0;
  const quarterKelly = Number((fullKelly * 0.25).toFixed(4));
  const halfKelly = Number((fullKelly * 0.5).toFixed(4));
  const stakeUsd = Math.round(bankrollUsd * quarterKelly * 100) / 100;
  const evPer100Usd = Number(((netEdge / entryPrice) * 100).toFixed(2));

  return {
    side,
    entryPrice: Number(entryPrice.toFixed(4)),
    winProb: Number(winProb.toFixed(4)),
    netEdgeAfterSpread: Number(netEdge.toFixed(4)),
    fullKellyFraction: Number(fullKelly.toFixed(4)),
    quarterKellyFraction: quarterKelly,
    halfKellyFraction: halfKelly,
    recommendedStakeUsd: stakeUsd,
    evPer100Usd,
  };
}

/**
 * Pure <1ms actuarial probability calibrator combining 4 transparent microstructure signals:
 *  1. Executable CLOB Midpoint alignment (bestBid/bestAsk vs stale trade print)
 *  2. Favorite-Longshot Bias (FLB) + Capital Lockup Time-Value restoration
 *  3. 24h Impulse Overreaction mean-reversion on high-churn books
 *  4. Multi-Bracket Sibling Vigorish normalization (when mutually exclusive brackets sum != 1.0)
 */
export function calibrateMarket(event, queryHint = "") {
  const picked = selectPrimaryBinaryMarket(event, queryHint);
  if (!picked) return null;

  const { primary: m, siblingCoherence } = picked;
  const domain = classifyEventDomain(event);
  const p = m.crowdProb;

  // 1. Orderbook Midpoint Alignment (weight shrinks if spread is huge)
  const bookTrust = clamp(1 - m.spread / 0.12, 0.15, 0.95);
  const midpointAdj = clamp((m.midpointProb - p) * bookTrust, -0.045, 0.045);

  // 2. Empirical Favorite-Longshot & Capital Lockup Time-Value De-Biasing
  // Retail overpays for 2%-18% lottery tickets and underpays for 70%-94% base-rate favorites locked for months
  const yearsLocked = clamp(m.daysToResolution / 365, 0.01, 2.0);
  const lockupYieldRestore = p > 0.62 ? p * (1 - p) * 0.11 * Math.min(1.3, yearsLocked + 0.35) : 0;
  const longshotLotteryTrim =
    p >= 0.025 && p <= 0.22
      ? -0.028 * Math.sin(((p - 0.02) / 0.20) * Math.PI) * (m.liquidityUsd < 150_000 ? 1.25 : 0.85)
      : 0;
  const flbLockupAdj = clamp(lockupYieldRestore + longshotLotteryTrim, -0.065, 0.075);

  // 3. 24h Retail Headline Overreaction Reversion
  const turnoverRatio = m.liquidityUsd > 0 ? m.volume24hUsd / m.liquidityUsd : 1.0;
  const churnAmplifier = clamp(turnoverRatio / 1.4, 0.4, 1.75);
  const overreactionAdj =
    Math.abs(m.oneDayChange) >= 0.035
      ? clamp(-m.oneDayChange * 0.24 * churnAmplifier, -0.085, 0.085)
      : 0;

  // 4. Multi-Bracket Sibling Overround / Deflation Normalization
  let bracketAdj = 0;
  if (siblingCoherence.isMutuallyExclusive && siblingCoherence.sumYesProb > 0.5) {
    const normalizedShare = p / siblingCoherence.sumYesProb;
    bracketAdj = clamp((normalizedShare - p) * 0.75, -0.055, 0.055);
  }

  // Aggregate fair probability (before optional LLM semantic override/blend)
  const rawFair = clamp(p + midpointAdj + flbLockupAdj + overreactionAdj + bracketAdj, 0.008, 0.992);
  const edgeProb = Number((rawFair - p).toFixed(4));
  const edgeBps = Math.round(edgeProb * 10_000);
  const absEdgeBps = Math.abs(edgeBps);

  const ruleTraps = auditResolutionRules({
    description: m.description,
    endDate: m.endDate,
    spread: m.spread,
    liquidityUsd: m.liquidityUsd,
    volume24hUsd: m.volume24hUsd,
    oneDayChange: m.oneDayChange,
    daysToResolution: m.daysToResolution,
  });

  const kelly = computeKellySizing({
    fairProb: rawFair,
    crowdProb: p,
    spread: m.spread,
    bankrollUsd: 1000,
  });

  let verdictCode = "EFFICIENT";
  let direction = "NO_EDGE";
  if (m.spread >= 0.06 && absEdgeBps < Math.round(m.spread * 10_000)) {
    verdictCode = "SPREAD_TRAP";
    direction = "PASS_SPREAD";
  } else if (edgeBps >= 220 && kelly.netEdgeAfterSpread > 0.01) {
    verdictCode = "MISPRICED_YES";
    direction = "BUY_YES";
  } else if (edgeBps <= -220 && kelly.netEdgeAfterSpread > 0.01) {
    verdictCode = "MISPRICED_NO";
    direction = "BUY_NO";
  }

  // Confidence scales with book depth, tight spread, and sibling structure
  const depthConf = clamp(Math.log10(Math.max(1000, m.liquidityUsd)) / 6.5, 0.35, 0.88);
  const spreadPenalty = clamp(m.spread * 1.8, 0, 0.25);
  const confidence = Number(clamp(depthConf - spreadPenalty + (siblingCoherence.isMutuallyExclusive ? 0.06 : 0), 0.42, 0.93).toFixed(2));

  return {
    eventId: String(event?.id || m.marketId),
    eventSlug: String(event?.slug || m.marketSlug),
    eventTitle: String(event?.title || m.question),
    polymarketUrl: `https://polymarket.com/event/${event?.slug || m.marketSlug}`,
    domain,
    marketId: m.marketId,
    conditionId: m.conditionId,
    marketSlug: m.marketSlug,
    question: m.question,
    groupItemTitle: m.groupItemTitle,
    outcomes: m.outcomes,
    crowdProb: Number(p.toFixed(4)),
    crowdProbBps: Math.round(p * 10_000),
    fairProb: Number(rawFair.toFixed(4)),
    fairProbBps: Math.round(rawFair * 10_000),
    edgeProb,
    edgeBps,
    absEdgeBps,
    verdictCode,
    direction,
    confidence,
    confidenceBps: Math.round(confidence * 10_000),
    bestBid: m.bestBid,
    bestAsk: m.bestAsk,
    spread: m.spread,
    volume24hUsd: m.volume24hUsd,
    totalVolumeUsd: m.totalVolumeUsd,
    liquidityUsd: m.liquidityUsd,
    oneDayChange: m.oneDayChange,
    oneWeekChange: m.oneWeekChange,
    endDate: m.endDate,
    daysToResolution: m.daysToResolution,
    description: m.description,
    resolutionSource: m.resolutionSource,
    factorBreakdown: [
      { id: "clob_midpoint", label: "CLOB Bid/Ask Midpoint Skew", bps: Math.round(midpointAdj * 10_000) },
      { id: "flb_lockup", label: "Favorite-Longshot & Lockup Yield", bps: Math.round(flbLockupAdj * 10_000) },
      { id: "impulse_reversion", label: "24h Headline Impulse Reversion", bps: Math.round(overreactionAdj * 10_000) },
      { id: "sibling_coherence", label: "Multi-Bracket Sum Coherence", bps: Math.round(bracketAdj * 10_000) },
    ],
    siblingCoherence,
    ruleTraps,
    kelly,
    modelSource: "kalibr-actuarial-v1",
    calibratedAt: new Date().toISOString(),
  };
}

/**
 * Fetches curated non-sports world events from Polymarket Gamma API and ranks by actionable edge & liquidity.
 */
export async function fetchCuratedPolymarketRadar({ limit = 18, domainFilter = "all", fetchImpl = fetch } = {}) {
  const url = `${GAMMA_API_BASE}/events?active=true&closed=false&limit=90&order=volume24hr&ascending=false`;
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) {
    throw new Error(`Polymarket Gamma API HTTP ${res.status}`);
  }
  const events = await res.json();
  if (!Array.isArray(events)) return [];

  const calibrated = [];
  const seenSlugs = new Set();

  for (const ev of events) {
    if (!ev || !ev.slug || seenSlugs.has(ev.slug)) continue;
    if (isSportsOrGameEvent(ev)) continue;
    seenSlugs.add(ev.slug);

    const item = calibrateMarket(ev);
    if (!item) continue;
    if (item.liquidityUsd < 500 && item.volume24hUsd < 1000) continue;
    if (domainFilter && domainFilter !== "all" && item.domain.id !== domainFilter) continue;

    calibrated.push(item);
  }

  // Sort so clear actionable mispricings on liquid markets surface right at the top
  calibrated.sort((a, b) => {
    const aActionable = a.verdictCode.startsWith("MISPRICED") ? 1 : 0;
    const bActionable = b.verdictCode.startsWith("MISPRICED") ? 1 : 0;
    if (aActionable !== bActionable) return bActionable - aActionable;
    const aScore = a.absEdgeBps * Math.log10(Math.max(100, a.volume24hUsd + a.liquidityUsd));
    const bScore = b.absEdgeBps * Math.log10(Math.max(100, b.volume24hUsd + b.liquidityUsd));
    return bScore - aScore;
  });

  return calibrated.slice(0, limit);
}

/**
 * Resolves any Polymarket URL, event slug, or natural-language query against live Polymarket APIs.
 */
export async function resolveAndCalibratePolymarket(query, { fetchImpl = fetch } = {}) {
  const parsed = parsePolymarketQuery(query);
  if (parsed.type === "empty") {
    throw new Error("Provide a Polymarket URL, event slug, or world event query.");
  }

  if (parsed.type === "slug") {
    const r = await fetchImpl(`${GAMMA_API_BASE}/events?slug=${encodeURIComponent(parsed.slug)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length > 0) {
        const cal = calibrateMarket(arr[0], parsed.subSlug || "");
        if (cal) return { matchType: "exact_slug", market: cal, alternatives: [] };
      }
    }
    // Fallback to market slug lookup
    const mr = await fetchImpl(`${GAMMA_API_BASE}/markets?slug=${encodeURIComponent(parsed.slug)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (mr.ok) {
      const mArr = await mr.json();
      if (Array.isArray(mArr) && mArr.length > 0) {
        const syntheticEvent = {
          id: mArr[0].id,
          slug: mArr[0].slug,
          title: mArr[0].question,
          markets: mArr,
          tags: [],
        };
        const cal = calibrateMarket(syntheticEvent);
        if (cal) return { matchType: "market_slug", market: cal, alternatives: [] };
      }
    }
  }

  // Live public-search on Polymarket Gamma API
  const q = parsed.type === "slug" ? parsed.slug.replace(/-/g, " ") : parsed.value;
  const sr = await fetchImpl(`${GAMMA_API_BASE}/public-search?q=${encodeURIComponent(q)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!sr.ok) {
    throw new Error(`Polymarket search HTTP ${sr.status}`);
  }
  const body = await sr.json();
  const events = (body?.events || []).filter((e) => e && e.closed !== true);
  if (events.length === 0) {
    throw new Error(`No active Polymarket event matched "${query}".`);
  }

  const calibratedList = events
    .map((ev) => calibrateMarket(ev, q))
    .filter(Boolean);

  if (calibratedList.length === 0) {
    throw new Error(`Matched event "${events[0]?.title || query}" has no active binary orderbook.`);
  }

  return {
    matchType: "search",
    market: calibratedList[0],
    alternatives: calibratedList.slice(1, 5).map((x) => ({
      eventSlug: x.eventSlug,
      question: x.question,
      crowdProb: x.crowdProb,
      fairProb: x.fairProb,
      edgeBps: x.edgeBps,
      volume24hUsd: x.volume24hUsd,
    })),
  };
}

/**
 * Verifies numeric figures quoted by LLM agents against the raw upstream market payload.
 * Returns verified citations and flags any invented dollar/percentage claims.
 */
export function verifyVerbatimFigures(evidenceQuotes, marketRecord) {
  const allowedNumbers = [
    marketRecord.crowdProb * 100,
    (1 - marketRecord.crowdProb) * 100,
    marketRecord.fairProb * 100,
    marketRecord.spread * 100,
    marketRecord.volume24hUsd,
    marketRecord.totalVolumeUsd,
    marketRecord.liquidityUsd,
    marketRecord.oneDayChange * 100,
    marketRecord.daysToResolution,
    ...(marketRecord.siblingCoherence?.siblings || []).map((s) => s.crowdProb * 100),
  ].filter((n) => Number.isFinite(n));

  const results = [];
  for (const rawQuote of evidenceQuotes || []) {
    const q = String(rawQuote || "").trim();
    if (!q) continue;
    const nums = [...q.matchAll(/([+-]?\d+(?:,\d{3})*(?:\.\d+)?)\s*(%|¢|bps)?/g)].map((m) => ({
      raw: m[0],
      val: Number(m[1].replace(/,/g, "")),
      unit: m[2] || "",
    }));

    if (nums.length === 0) {
      const inRules =
        q.length >= 8 &&
        marketRecord.description.toLowerCase().includes(q.toLowerCase().slice(0, Math.min(28, q.length)));
      results.push({ quote: q, verified: inRules, mode: inRules ? "rule_text_exact" : "qualitative" });
      continue;
    }

    const matched = nums.some((n) =>
      allowedNumbers.some((allow) => {
        const tol = Math.max(0.6, Math.abs(allow) * 0.03);
        return Math.abs(n.val - allow) <= tol;
      })
    );
    results.push({ quote: q, verified: matched, mode: matched ? "upstream_json_match" : "unverified_figure" });
  }

  const numericChecks = results.filter((r) => r.mode !== "qualitative");
  const verifiedCount = numericChecks.filter((r) => r.verified).length;
  return {
    checks: results,
    verifiedCount,
    totalNumericChecks: numericChecks.length,
    integrityPct: numericChecks.length > 0 ? Math.round((verifiedCount / numericChecks.length) * 100) : 100,
  };
}

/**
 * Computes Brier Score accuracy comparing KALIBR sealed forecasts vs Polymarket crowd at seal time.
 * Lower Brier Score is better (0.00 = perfect omniscience, 0.25 = coin-flip).
 */
export function computeBrierScore(resolvedRecords) {
  if (!Array.isArray(resolvedRecords) || resolvedRecords.length === 0) {
    return { count: 0, kalibrBrier: null, crowdBrier: null, skillImprovementPct: null };
  }
  let sumKalibr = 0;
  let sumCrowd = 0;
  let n = 0;
  for (const r of resolvedRecords) {
    const outcome = Number(r.outcome); // 1 for YES, 0 for NO
    if (outcome !== 0 && outcome !== 1) continue;
    const f = clamp(Number(r.fairProb), 0, 1);
    const c = clamp(Number(r.crowdProb), 0, 1);
    sumKalibr += (f - outcome) ** 2;
    sumCrowd += (c - outcome) ** 2;
    n += 1;
  }
  if (n === 0) return { count: 0, kalibrBrier: null, crowdBrier: null, skillImprovementPct: null };
  const kalibrBrier = Number((sumKalibr / n).toFixed(4));
  const crowdBrier = Number((sumCrowd / n).toFixed(4));
  const skillImprovementPct =
    crowdBrier > 0 ? Number((((crowdBrier - kalibrBrier) / crowdBrier) * 100).toFixed(1)) : 0;
  return { count: n, kalibrBrier, crowdBrier, skillImprovementPct };
}
