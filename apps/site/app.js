import { computeKellySizing } from "./core/polymarket.js";
import { hashForecastLeaf, hashSortedPair } from "./core/merkle.js";

const CONFIG = {
  tokenCa: "",
  sealRegistry: "0xcbbc1f359ff98ec0c6a5d7ee02380f957b650bc2",
  xUrl: "https://x.com/kalibragent",
};

const state = {
  view: "board",
  domain: "all",
  sortBy: "edge",
  markets: [],
  selectedMarket: null,
  bankrollUsd: 1000,
  wallet: localStorage.getItem("kalibr_wallet") || "",
  status: null,
  epochs: [],
  activeEpoch: null,
  activeEpochLeaves: [],
  selectedLeafIdx: 0,
  tamperActive: false,
  aiLoading: false,
};

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtPct(prob) {
  return `${(Number(prob || 0) * 100).toFixed(1)}%`;
}

function fmtSignedEdge(edgeBps) {
  const pct = Number(edgeBps || 0) / 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function fmtUsdCompact(num) {
  const n = Number(num || 0);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function verdictMeta(market) {
  if (market.verdictCode === "MISPRICED_YES") {
    return {
      cls: "v-yes",
      tone: "pos",
      label: `BUY YES · ${fmtSignedEdge(market.edgeBps)} EDGE`,
    };
  }
  if (market.verdictCode === "MISPRICED_NO") {
    return {
      cls: "v-no",
      tone: "neg",
      label: `BUY NO · +${(Math.abs(market.edgeBps) / 100).toFixed(1)}% NO EDGE`,
    };
  }
  if (market.verdictCode === "SPREAD_TRAP") {
    return {
      cls: "v-trap",
      tone: "flat",
      label: `WIDE SPREAD (${(market.spread * 100).toFixed(1)}¢)`,
    };
  }
  return {
    cls: "v-flat",
    tone: "flat",
    label: `EFFICIENT (${fmtSignedEdge(market.edgeBps)})`,
  };
}

function renderVernierScale(market) {
  const cPct = Math.min(98.5, Math.max(1.5, market.crowdProb * 100));
  const fPct = Math.min(98.5, Math.max(1.5, market.fairProb * 100));
  const left = Math.min(cPct, fPct);
  const width = Math.max(0.8, Math.abs(fPct - cPct));
  const tone = market.edgeBps >= 180 ? "pos" : market.edgeBps <= -180 ? "neg" : "flat";

  return `
    <div class="vernier-box">
      <div class="vernier-readout">
        <span class="vr-crowd">CROWD YES: <strong>${fmtPct(market.crowdProb)}</strong></span>
        <span class="vr-fair ${tone}">KALIBR FAIR: <strong>${fmtPct(market.fairProb)}</strong> (${fmtSignedEdge(market.edgeBps)})</span>
      </div>
      <div class="vernier-track">
        <div class="vernier-rail">
          <i class="vernier-tick" style="left:0%"></i>
          <i class="vernier-tick" style="left:25%"></i>
          <i class="vernier-tick" style="left:50%"></i>
          <i class="vernier-tick" style="left:75%"></i>
          <i class="vernier-tick" style="left:100%"></i>
        </div>
        <div class="vernier-span ${tone}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div>
        <div class="vernier-pin-crowd" style="left:${cPct.toFixed(2)}%" title="Polymarket Crowd: ${fmtPct(market.crowdProb)}"></div>
        <div class="vernier-pin-fair ${tone}" style="left:${fPct.toFixed(2)}%" title="KALIBR Calibrated: ${fmtPct(market.fairProb)}"></div>
      </div>
      <div class="vernier-scale-nums">
        <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
      </div>
    </div>
  `;
}

function sortedMarkets() {
  const list = [...state.markets];
  if (state.sortBy === "volume") {
    list.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  } else if (state.sortBy === "tight") {
    list.sort((a, b) => a.spread - b.spread);
  } else {
    list.sort((a, b) => {
      const aAct = a.verdictCode.startsWith("MISPRICED") ? 1 : 0;
      const bAct = b.verdictCode.startsWith("MISPRICED") ? 1 : 0;
      if (aAct !== bAct) return bAct - aAct;
      return b.absEdgeBps - a.absEdgeBps;
    });
  }
  return list;
}

function renderMarketList() {
  const el = document.getElementById("marketCardsList");
  const list = sortedMarkets();
  if (!list.length) {
    el.innerHTML = `<div class="skeleton-card">No active non-sports Polymarket contracts matched this domain filter right now.</div>`;
    return;
  }

  el.innerHTML = list
    .map((m) => {
      const v = verdictMeta(m);
      const selected = state.selectedMarket && state.selectedMarket.marketId === m.marketId;
      const trapCount = (m.ruleTraps || []).length;
      return `
        <article class="m-card ${selected ? "is-selected" : ""}" data-market-id="${esc(m.marketId)}">
          <div class="m-card-top">
            <div class="m-meta-tags">
              <span class="tag-domain">${esc(m.domain?.label || "World Event")}</span>
              ${m.aiDossier ? `<span class="tag-ai-live">3-AGENT LLM VERIFIED</span>` : ""}
            </div>
            <span class="verdict-stamp ${v.cls}">${esc(v.label)}</span>
          </div>
          <h3 class="m-question">${esc(m.question)}</h3>
          ${renderVernierScale(m)}
          <div class="m-card-foot">
            <div class="m-foot-metrics">
              <span>24H VOL: <strong>${fmtUsdCompact(m.volume24hUsd)}</strong></span>
              <span>BOOK: <strong>${fmtUsdCompact(m.liquidityUsd)}</strong></span>
              <span>SPREAD: <strong>${(m.spread * 100).toFixed(1)}¢</strong></span>
              <span>HORIZON: <strong>${m.daysToResolution}d</strong></span>
            </div>
            ${trapCount > 0 ? `<span class="trap-pill">${trapCount} Rule ${trapCount === 1 ? "Flag" : "Flags"}</span>` : ""}
          </div>
        </article>
      `;
    })
    .join("");

  el.querySelectorAll(".m-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-market-id");
      const found = state.markets.find((x) => x.marketId === id);
      if (found) {
        state.selectedMarket = found;
        renderMarketList();
        renderPinnedInspector();
        renderFullBench();
      }
    });
  });
}

function renderPinnedInspector() {
  const el = document.getElementById("pinnedInspector");
  const m = state.selectedMarket;
  if (!m) {
    el.innerHTML = `<div class="inspector-empty">Select any event card to inspect its Vernier calibration, Quarter-Kelly stake &amp; fine-print rule traps.</div>`;
    return;
  }

  const v = verdictMeta(m);
  const kelly = computeKellySizing({
    fairProb: m.fairProb,
    crowdProb: m.crowdProb,
    spread: m.spread,
    bankrollUsd: state.bankrollUsd,
  });

  const factorsHtml = (m.factorBreakdown || [])
    .map((f) => {
      const sign = f.bps >= 0 ? "+" : "";
      const cls = f.bps > 0 ? "pos" : f.bps < 0 ? "neg" : "";
      return `
        <div class="factor-row">
          <span>${esc(f.label)}</span>
          <span class="factor-val ${cls}">${sign}${(f.bps / 100).toFixed(2)}%</span>
        </div>
      `;
    })
    .join("");

  const trapsHtml =
    (m.ruleTraps || []).length > 0
      ? m.ruleTraps
          .map(
            (t) => `
          <div class="trap-card">
            <strong>[${esc(t.severity)}] ${esc(t.title)}</strong>
            <div>${esc(t.detail)}</div>
            ${t.snippet ? `<em>“…${esc(t.snippet)}…”</em>` : ""}
          </div>
        `
          )
          .join("")
      : `<div style="font-size:12px;color:var(--jade-700);font-family:var(--font-mono);">✓ Clean CLOB spread &amp; standard deterministic rules.</div>`;

  el.innerHTML = `
    <div class="insp-kicker">
      <span>${esc(m.domain?.label || "EVENT")} · CONFIDENCE ${Math.round(m.confidence * 100)}%</span>
      <span class="verdict-stamp ${v.cls}">${esc(v.label)}</span>
    </div>
    <h3 class="insp-title">${esc(m.question)}</h3>
    ${renderVernierScale(m)}

    <div class="insp-block">
      <div class="insp-block-h">ACTUARIAL DE-BIASING WATERFALL</div>
      ${factorsHtml}
    </div>

    <div class="insp-block">
      <div class="insp-block-h">QUARTER-KELLY POSITION SIZER</div>
      <div class="kelly-widget">
        <div class="kelly-slider-row">
          <span>BANKROLL</span>
          <strong id="inspBankrollVal">$${state.bankrollUsd.toLocaleString()}</strong>
        </div>
        <input type="range" id="inspBankrollSlider" min="250" max="25000" step="250" value="${state.bankrollUsd}" />
        <div class="kelly-stats">
          <div class="kelly-stat-box">
            <strong>$${kelly.recommendedStakeUsd.toLocaleString()}</strong>
            <span>1/4 KELLY (${kelly.side})</span>
          </div>
          <div class="kelly-stat-box">
            <strong>${(kelly.entryPrice * 100).toFixed(1)}¢</strong>
            <span>EXEC ENTRY</span>
          </div>
          <div class="kelly-stat-box">
            <strong>${kelly.evPer100Usd >= 0 ? "+" : ""}$${kelly.evPer100Usd}</strong>
            <span>EV / $100</span>
          </div>
        </div>
      </div>
    </div>

    <div class="insp-block">
      <div class="insp-block-h">FINE-PRINT &amp; MICROSTRUCTURE AUDIT</div>
      ${trapsHtml}
    </div>

    <div class="insp-cta-row">
      <button type="button" class="btn-ink" id="openFullBenchBtn">Open 3-Agent Bench →</button>
      <a href="${esc(m.polymarketUrl)}" target="_blank" rel="noopener" class="btn-ghost">Polymarket ↗</a>
    </div>
  `;

  const slider = document.getElementById("inspBankrollSlider");
  if (slider) {
    slider.addEventListener("input", (e) => {
      state.bankrollUsd = Number(e.target.value);
      renderPinnedInspector();
      renderFullBench();
    });
  }

  const benchBtn = document.getElementById("openFullBenchBtn");
  if (benchBtn) {
    benchBtn.addEventListener("click", () => switchView("bench"));
  }
}

function renderFullBench() {
  const container = document.getElementById("benchContent");
  const headlineEl = document.getElementById("benchHeadline");
  const pmLink = document.getElementById("benchPolymarketLink");
  const m = state.selectedMarket;

  if (!m) {
    container.innerHTML = `<div class="skeleton-card">Select a contract on Folio 01 or paste any Polymarket URL above.</div>`;
    return;
  }

  headlineEl.textContent = m.question;
  pmLink.href = m.polymarketUrl;
  const v = verdictMeta(m);
  const kelly = computeKellySizing({
    fairProb: m.fairProb,
    crowdProb: m.crowdProb,
    spread: m.spread,
    bankrollUsd: state.bankrollUsd,
  });

  const sib = m.siblingCoherence;
  const siblingHtml =
    sib && sib.siblings && sib.siblings.length > 1
      ? `
        <div class="swiss-card">
          <div class="card-kicker">MULTI-BRACKET COHERENCE (${sib.bracketCount} OUTCOMES · Σ YES = ${(sib.sumYesProb * 100).toFixed(1)}%)</div>
          <div class="sibling-ladder">
            ${sib.siblings
              .map(
                (s) => `
              <div class="sib-row">
                <span>${esc(s.label)}</span>
                <strong>${fmtPct(s.crowdProb)} · ${fmtUsdCompact(s.volume24hUsd)}</strong>
              </div>
            `
              )
              .join("")}
          </div>
        </div>
      `
      : `
        <div class="swiss-card">
          <div class="card-kicker">RESOLUTION SPECIFICATION</div>
          <p class="card-p" style="max-height:175px;overflow-y:auto;white-space:pre-line;">${esc(m.description || "Standard Polymarket binary resolution criteria.")}</p>
        </div>
      `;

  let aiPanelHtml = "";
  if (m.aiDossier) {
    const d = m.aiDossier;
    const checks = d.verbatimCheck?.checks || [];
    aiPanelHtml = `
      <div class="three-agent-grid">
        <div class="agent-card">
          <span class="agent-num">[AGENT I] BASE-RATE &amp; EVIDENCE · ${esc(d.modelName)}</span>
          <h4>${esc(d.baseRateAgent.headline)}</h4>
          <p>${esc(d.baseRateAgent.analysis)}</p>
          <div class="verbatim-list">
            ${checks
              .map(
                (c) => `
              <div class="v-quote ${c.verified ? "" : "unverified"}">
                ${c.verified ? "✓ UPSTREAM JSON MATCH:" : "⚠ UNVERIFIED:"} ${esc(c.quote)}
              </div>
            `
              )
              .join("")}
          </div>
        </div>

        <div class="agent-card">
          <span class="agent-num">[AGENT II] RESOLUTION TRAP DEVIL · RISK: ${esc(d.trapDevilAgent.riskLevel)}</span>
          <h4>${esc(d.trapDevilAgent.headline)}</h4>
          <p>${esc(d.trapDevilAgent.analysis)}</p>
        </div>

        <div class="agent-card chief">
          <span class="agent-num">[AGENT III] CHIEF SUPERFORECASTER · ${d.chiefForecaster.confidencePct}% CONF</span>
          <h4>Calibrated Fair Odds: ${d.chiefForecaster.fairProbPct}% (${fmtSignedEdge(d.edgeBps)})</h4>
          <p>${esc(d.chiefForecaster.thesis)}</p>
          <p style="font-family:var(--font-mono);font-size:11px;color:var(--verm-700);margin-top:4px;">
            <strong>Invalidation:</strong> ${esc(d.chiefForecaster.invalidationTrigger)}
          </p>
        </div>
      </div>

      <div class="swiss-card">
        <div class="card-kicker">INTERROGATE CHIEF SUPERFORECASTER</div>
        <form id="askChiefForm" class="ask-chief-bar">
          <input type="text" id="askChiefInput" placeholder="Ask a follow-up about timing, entry limit price, or resolution wording…" />
          <button type="submit" class="btn-ink">Ask Agent</button>
        </form>
        <div id="askChiefReply" style="margin-top:10px;font-size:13px;color:var(--ink-700);"></div>
      </div>
    `;
  } else {
    const aiReady = state.status?.aiEngine?.live;
    aiPanelHtml = `
      <div class="swiss-card">
        <div class="card-kicker">3-AGENT ADVERSARIAL LLM CALIBRATION</div>
        <h3>${aiReady ? "Ready to dispatch live 3-Agent Superforecasting Panel" : "Actuarial Calibration Active (LLM Key Optional in Local Dev)"}</h3>
        <p class="card-p">
          ${
            aiReady
              ? "Click 'Dispatch 3-Agent AI Panel' above to run Base-Rate Analyst, Resolution Trap Devil, and Chief Superforecaster with verbatim JSON quote verification."
              : "Deterministic <1.2s CLOB midpoint, favorite-longshot, lockup yield, and fine-print trap calibration is 100% live. Configure OPENAI_API_KEY on the Worker to enable live 3-agent LLM dispatches."
          }
        </p>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="bench-top-grid">
      <div class="swiss-card">
        <div class="card-kicker" style="display:flex;justify-content:space-between;align-items:center;">
          <span>CALIBRATED POSITION &amp; VERNIER SPREAD</span>
          <span class="verdict-stamp ${v.cls}">${esc(v.label)}</span>
        </div>
        ${renderVernierScale(m)}
        <div class="kelly-stats" style="margin-top:12px;">
          <div class="kelly-stat-box">
            <strong>$${kelly.recommendedStakeUsd.toLocaleString()}</strong>
            <span>1/4 KELLY ON $${state.bankrollUsd.toLocaleString()}</span>
          </div>
          <div class="kelly-stat-box">
            <strong>${fmtUsdCompact(m.volume24hUsd)} / ${fmtUsdCompact(m.liquidityUsd)}</strong>
            <span>24H VOL / BOOK DEPTH</span>
          </div>
          <div class="kelly-stat-box">
            <strong>${(m.spread * 100).toFixed(2)}¢ · ${m.daysToResolution}d</strong>
            <span>CLOB SPREAD · HORIZON</span>
          </div>
        </div>
      </div>
      ${siblingHtml}
    </div>
    ${aiPanelHtml}
  `;

  const askForm = document.getElementById("askChiefForm");
  if (askForm) {
    askForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const inp = document.getElementById("askChiefInput");
      const out = document.getElementById("askChiefReply");
      const q = inp.value.trim();
      if (!q) return;
      out.textContent = "Calibrating response against live market JSON…";
      try {
        const res = await fetch("/v1/ask", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(state.wallet ? { "x-wallet-address": state.wallet } : {}),
          },
          body: JSON.stringify({ query: m.eventSlug || m.question, question: q, wallet: state.wallet }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Request failed");
        out.innerHTML = `<strong>[${esc(data.actionPosture)}]</strong> ${esc(data.answer)}`;
      } catch (err) {
        out.textContent = err.message;
      }
    });
  }
}

async function triggerThreeAgentCalibration() {
  const m = state.selectedMarket;
  if (!m || state.aiLoading) return;
  const btn = document.getElementById("runAiPanelBtn");
  state.aiLoading = true;
  btn.disabled = true;
  btn.textContent = "Calibrating 3 Agents…";

  try {
    const res = await fetch("/v1/calibrate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(state.wallet ? { "x-wallet-address": state.wallet } : {}),
      },
      body: JSON.stringify({ query: m.eventSlug || m.question, wallet: state.wallet }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(data.error || "3-Agent LLM calibration unavailable.");
      return;
    }
    state.selectedMarket = data.market;
    const idx = state.markets.findIndex((x) => x.marketId === data.market.marketId);
    if (idx >= 0) state.markets[idx] = data.market;
    renderMarketList();
    renderPinnedInspector();
    renderFullBench();
  } catch (err) {
    alert(err.message);
  } finally {
    state.aiLoading = false;
    btn.disabled = false;
    btn.textContent = "Dispatch 3-Agent AI Panel";
  }
}

async function loadSealsView() {
  const res = await fetch("/v1/seals?limit=16");
  const data = await res.json();
  state.epochs = data.epochs || [];
  renderEpochsList();
  if (state.epochs.length > 0 && !state.activeEpoch) {
    await selectEpoch(state.epochs[0].epoch_hour);
  }
}

function renderEpochsList() {
  const el = document.getElementById("epochsList");
  if (!state.epochs.length) {
    el.innerHTML = `<div class="skeleton-card">No sealed epochs recorded yet.</div>`;
    return;
  }
  el.innerHTML = state.epochs
    .map((ep) => {
      const dt = new Date(Number(ep.epoch_hour) * 1000).toISOString().replace(":00.000Z", " UTC");
      const active = state.activeEpoch && Number(state.activeEpoch.epoch_hour) === Number(ep.epoch_hour);
      return `
        <div class="epoch-item ${active ? "is-active" : ""}" data-epoch="${ep.epoch_hour}">
          <div class="epoch-item-top">
            <span>${esc(dt)}</span>
            <span>${ep.market_count} odds · ${ep.mispriced_count} edges</span>
          </div>
          <div class="epoch-root">Root: ${esc(ep.merkle_root)}</div>
          ${
            ep.tx_hash
              ? `<div style="margin-top:4px;font-family:var(--font-mono);font-size:10px;"><a href="https://robinhoodchain.blockscout.com/tx/${esc(ep.tx_hash)}" target="_blank" rel="noopener" style="color:var(--jade-700);">Blockscout Tx ↗</a></div>`
              : ""
          }
        </div>
      `;
    })
    .join("");

  el.querySelectorAll(".epoch-item").forEach((node) => {
    node.addEventListener("click", () => selectEpoch(Number(node.getAttribute("data-epoch"))));
  });
}

async function selectEpoch(epochHour) {
  const res = await fetch(`/v1/seals/${epochHour}`);
  const data = await res.json();
  if (!data.ok) return;
  state.activeEpoch = data.epoch;
  state.activeEpochLeaves = data.forecasts || [];
  state.selectedLeafIdx = 0;
  state.tamperActive = false;
  updateTamperButtonUI();
  renderEpochsList();
  renderVerifierStage();
}

function updateTamperButtonUI() {
  const btn = document.getElementById("tamperToggleBtn");
  if (!btn) return;
  btn.classList.toggle("is-tampered", state.tamperActive);
  btn.textContent = state.tamperActive ? "Restore Original Sealed Leaf" : "Simulate +1% Tamper Attack";
}

function renderVerifierStage() {
  const stage = document.getElementById("verifierStage");
  const ep = state.activeEpoch;
  const leaves = state.activeEpochLeaves;
  if (!ep || !leaves.length) {
    stage.innerHTML = `Select a sealed epoch on the left to verify pre-resolution Keccak-256 proofs.`;
    return;
  }

  const row = leaves[state.selectedLeafIdx] || leaves[0];
  const leafRecord = {
    epochHour: row.epoch_hour,
    chainId: 4663,
    marketId: row.market_id,
    eventSlug: row.event_slug,
    question: row.question,
    crowdProbBps: row.crowd_prob_bps,
    fairProbBps: state.tamperActive ? row.fair_prob_bps + 100 : row.fair_prob_bps,
    edgeBps: row.edge_bps,
    direction: row.direction,
    confidenceBps: row.confidence_bps,
    modelSource: row.model_source,
  };

  const recomputed = hashForecastLeaf(leafRecord);
  let walk = recomputed.leafHash;
  const steps = [];
  for (const sib of row.proof || []) {
    walk = hashSortedPair(walk, sib);
    steps.push({ sibling: sib, combined: walk });
  }
  const matches = walk.toLowerCase() === ep.merkle_root.toLowerCase();

  stage.innerHTML = `
    <div class="sealed-leaf-pills">
      ${leaves
        .slice(0, 10)
        .map(
          (l, idx) => `
        <button type="button" class="leaf-pill ${idx === state.selectedLeafIdx ? "is-active" : ""}" data-leaf-idx="${idx}">
          ${esc(l.question.slice(0, 38))}${l.question.length > 38 ? "…" : ""}
        </button>
      `
        )
        .join("")}
    </div>

    <div class="proof-banner ${matches ? "ok" : "fail"}">
      ${
        matches
          ? "✓ CRYPTOGRAPHICALLY VERIFIED IN BROWSER — Recomputed Keccak-256 leaf & sorted-pair Merkle path match sealed root byte-for-byte."
          : "✗ TAMPER DETECTED — Mutating fairProbBps by +100 bps (+1.0%) altered the Keccak-256 digest and failed the sealed Merkle root!"
      }
    </div>

    <div class="card-kicker">CANONICAL FORECAST LEAF PAYLOAD (RE-HASHED CLIENT-SIDE)</div>
    <pre class="code-slab"><code>${esc(recomputed.canonical)}</code></pre>

    <div class="card-kicker">HASH &amp; PROOF WALK (${steps.length} SORTED-PAIR LEVELS)</div>
    <pre class="code-slab"><code>Computed Leaf Hash : ${esc(recomputed.leafHash)}
Expected Epoch Root: ${esc(ep.merkle_root)}
Recomputed Root    : ${esc(walk)}
Match Verdict      : ${matches ? "EXACT_MATCH (TRUE)" : "MISMATCH (FALSE)"}</code></pre>
  `;

  stage.querySelectorAll(".leaf-pill").forEach((b) => {
    b.addEventListener("click", () => {
      state.selectedLeafIdx = Number(b.getAttribute("data-leaf-idx"));
      renderVerifierStage();
    });
  });
}

function switchView(viewName) {
  state.view = viewName;
  document.querySelectorAll(".folio-btn").forEach((b) => {
    b.classList.toggle("is-active", b.getAttribute("data-view-link") === viewName);
  });
  document.querySelectorAll(".folio-view").forEach((sec) => {
    sec.classList.toggle("is-visible", sec.id === `view-${viewName}`);
  });
  if (viewName === "bench") renderFullBench();
  if (viewName === "seals") loadSealsView();
}

async function runOmnibarInspect(rawQuery) {
  const q = String(rawQuery || "").trim();
  if (!q) return;
  const submitBtn = document.getElementById("omnibarSubmitBtn");
  const latEl = document.getElementById("lastScanLatency");
  const t0 = performance.now();
  submitBtn.disabled = true;
  submitBtn.textContent = "Calibrating…";

  try {
    const res = await fetch(`/v1/inspect?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const elapsedMs = Math.round(performance.now() - t0);
    latEl.textContent = `${elapsedMs}ms`;
    if (!data.ok) throw new Error(data.error || "Could not calibrate query");

    state.selectedMarket = data.market;
    const existingIdx = state.markets.findIndex((m) => m.marketId === data.market.marketId);
    if (existingIdx >= 0) state.markets[existingIdx] = data.market;
    else state.markets.unshift(data.market);

    renderMarketList();
    renderPinnedInspector();
    renderFullBench();
    if (state.view !== "board" && state.view !== "bench") {
      switchView("bench");
    }
  } catch (err) {
    alert(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Calibrate Event";
  }
}

async function loadStatus() {
  const qs = state.wallet ? `?wallet=${encodeURIComponent(state.wallet)}` : "";
  const res = await fetch(`/v1/status${qs}`);
  const data = await res.json();
  if (!data.ok) return;
  state.status = data;

  document.getElementById("statSealedForecasts").textContent = String(data.stats?.sealedForecasts ?? 0);
  document.getElementById("statEpochs").textContent = String(data.stats?.sealedEpochs ?? 0);
  document.getElementById("statHeadBlock").textContent = data.headBlock
    ? `#${Number(data.headBlock).toLocaleString()}`
    : "4663";

  const activeCa = data.tokenAddress || CONFIG.tokenCa;
  const caEl = document.getElementById("caDisplay");
  if (activeCa) {
    caEl.textContent = `$KALIBR: ${activeCa}`;
  }

  const regAddr = data.sealRegistryAddress || CONFIG.sealRegistry;
  if (regAddr) {
    document.getElementById("sealRegistryDisplay").textContent = `${regAddr.slice(0, 10)}…${regAddr.slice(-6)}`;
  }

  const mcpCode = document.getElementById("mcpConfigCode");
  if (mcpCode) {
    mcpCode.textContent = JSON.stringify(
      { mcpServers: { kalibr: { url: `${window.location.origin}/mcp` } } },
      null,
      2
    );
  }

  const tier = data.caller?.tier || "visitor";
  const badge = document.getElementById("callerTierBadge");
  badge.textContent = tier.toUpperCase();
  badge.className = `pass-badge tier-${tier}`;
  document.getElementById("walletStatusLine").textContent =
    data.caller?.wallet
      ? `${Number(data.caller.balanceTokens || 0).toLocaleString()} $KALIBR · ${data.caller.limits.aiPerDay} AI panels/day`
      : `Unlimited <1.2s scans · ${data.caller?.limits?.aiPerDay || 15} AI panels/day`;
}

async function loadRadar({ refresh = false } = {}) {
  const t0 = performance.now();
  const res = await fetch(
    `/v1/radar?domain=${encodeURIComponent(state.domain)}&limit=18${refresh ? "&refresh=1" : ""}`
  );
  const data = await res.json();
  const ms = Math.round(performance.now() - t0);
  document.getElementById("lastScanLatency").textContent = `${ms}ms`;

  if (!data.ok) return;
  state.markets = data.markets || [];
  document.getElementById("statMispriced").textContent = String(data.mispricedCount ?? 0);

  if (!state.selectedMarket || !state.markets.some((m) => m.marketId === state.selectedMarket.marketId)) {
    state.selectedMarket = state.markets[0] || null;
  }

  // Populate live quick-chips from top real events
  if (state.domain === "all" && state.markets.length >= 4) {
    const chipsRow = document.getElementById("quickChipsRow");
    chipsRow.innerHTML = state.markets
      .slice(0, 4)
      .map(
        (m) => `
        <button type="button" class="q-chip" data-slug="${esc(m.eventSlug)}">
          ${esc(m.eventTitle.slice(0, 30))}${m.eventTitle.length > 30 ? "…" : ""} (${fmtSignedEdge(m.edgeBps)})
        </button>
      `
      )
      .join("");
    chipsRow.querySelectorAll(".q-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const slug = chip.getAttribute("data-slug");
        document.getElementById("omnibarInput").value = `https://polymarket.com/event/${slug}`;
        runOmnibarInspect(`https://polymarket.com/event/${slug}`);
      });
    });
  }

  renderMarketList();
  renderPinnedInspector();
  renderFullBench();
}

function bindEvents() {
  document.querySelectorAll("[data-view-link]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      switchView(el.getAttribute("data-view-link"));
    });
  });

  document.getElementById("omnibarForm").addEventListener("submit", (e) => {
    e.preventDefault();
    runOmnibarInspect(document.getElementById("omnibarInput").value);
  });

  document.querySelectorAll("#quickChipsRow .q-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const q = chip.getAttribute("data-query");
      document.getElementById("omnibarInput").value = q;
      runOmnibarInspect(q);
    });
  });

  document.querySelectorAll("#domainFilterRow .dom-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#domainFilterRow .dom-pill").forEach((p) => p.classList.remove("is-active"));
      pill.classList.add("is-active");
      state.domain = pill.getAttribute("data-domain");
      loadRadar();
    });
  });

  document.getElementById("sortSelect").addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    renderMarketList();
  });

  document.getElementById("refreshRadarBtn").addEventListener("click", () => loadRadar({ refresh: true }));
  document.getElementById("runAiPanelBtn").addEventListener("click", triggerThreeAgentCalibration);

  document.getElementById("tamperToggleBtn").addEventListener("click", () => {
    state.tamperActive = !state.tamperActive;
    updateTamperButtonUI();
    renderVerifierStage();
  });

  const walletInput = document.getElementById("walletInput");
  if (state.wallet) walletInput.value = state.wallet;
  document.getElementById("walletCheckForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.wallet = walletInput.value.trim();
    if (state.wallet) localStorage.setItem("kalibr_wallet", state.wallet);
    else localStorage.removeItem("kalibr_wallet");
    await loadStatus();
  });

  document.getElementById("copyCaBtn").addEventListener("click", async () => {
    const raw = document.getElementById("caDisplay").textContent.replace(/^\$KALIBR:\s*/i, "").trim();
    await navigator.clipboard.writeText(raw).catch(() => {});
    const prev = document.getElementById("caDisplay").textContent;
    document.getElementById("caDisplay").textContent = "COPIED TO CLIPBOARD ✓";
    setTimeout(() => {
      document.getElementById("caDisplay").textContent = prev;
    }, 1200);
  });

  document.querySelectorAll(".copy-snippet-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = document.getElementById(btn.getAttribute("data-copy-target"));
      if (!target) return;
      await navigator.clipboard.writeText(target.innerText).catch(() => {});
      const orig = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => {
        btn.textContent = orig;
      }, 1200);
    });
  });
}

bindEvents();
Promise.all([loadStatus(), loadRadar()]);
