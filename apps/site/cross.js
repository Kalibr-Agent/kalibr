import { initSharedSpine, esc, fmtUsdCompact } from "./spine.js";

const state = {
  filter: "all",
  pairs: [],
  allPairsSnapshot: [],
  selected: null,
  contractsCount: 1000,
};

function badgeMeta(p) {
  switch (p.crossVerdict) {
    case "EXECUTABLE_NET_ARB":
      return { cls: "v-yes", label: `NET ARB +${(p.netArbBps / 100).toFixed(2)}% (GROSS +${(p.grossArbBps / 100).toFixed(1)}%)` };
    case "MAKER_LIMIT_ARB":
      return { cls: "v-yes", label: `MAKER ARB +${(p.grossArbBps / 100).toFixed(2)}%` };
    case "BASIS_TRAP_BLOCKED":
      return { cls: "v-no", label: `BASIS TRAP BLOCKED (${(p.absMidGapBps / 100).toFixed(1)}% GAP)` };
    case "VENUE_PRICE_ROUTING":
      return { cls: "v-info", label: `ROUTING SPREAD ${(p.absMidGapBps / 100).toFixed(1)}%` };
    default:
      return { cls: "v-flat", label: `TIGHT PARITY (${(p.absMidGapBps / 100).toFixed(1)}%)` };
  }
}

function renderDualScale(p) {
  const polyPct = Math.min(98.5, Math.max(1.5, p.polyMid * 100));
  const kalshiPct = Math.min(98.5, Math.max(1.5, p.kalshiMid * 100));
  const left = Math.min(polyPct, kalshiPct);
  const width = Math.max(0.8, Math.abs(kalshiPct - polyPct));
  const tone = p.signalTone === "pos" ? "pos" : p.signalTone === "neg" ? "neg" : "flat";

  return `
    <div class="vernier-box">
      <div class="vernier-readout">
        <span class="vr-crowd">POLY YES: <strong>${(p.polyYesBid * 100).toFixed(1)}¢ / ${(p.polyYesAsk * 100).toFixed(1)}¢</strong></span>
        <span class="vr-fair ${tone}">KALSHI YES: <strong>${(p.kalshiYesBid * 100).toFixed(1)}¢ / ${(p.kalshiYesAsk * 100).toFixed(1)}¢</strong></span>
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
        <div class="vernier-pin-crowd" style="left:${polyPct.toFixed(2)}%" title="Polymarket Mid: ${(p.polyMid * 100).toFixed(1)}%"></div>
        <div class="vernier-pin-fair ${tone}" style="left:${kalshiPct.toFixed(2)}%" title="Kalshi Mid: ${(p.kalshiMid * 100).toFixed(1)}%"></div>
      </div>
      <div class="vernier-scale-nums">
        <span>0¢</span><span>25¢</span><span>50¢</span><span>75¢</span><span>100¢</span>
      </div>
    </div>
  `;
}

function renderKpis(list) {
  document.getElementById("kpiCrossTotal").textContent = String(list.length);
  const netArbs = list.filter((p) => p.crossVerdict === "EXECUTABLE_NET_ARB");
  document.getElementById("kpiCrossNetArb").textContent = String(netArbs.length);
  document.getElementById("kpiCrossBasis").textContent = String(
    list.filter((p) => p.crossVerdict === "BASIS_TRAP_BLOCKED").length
  );
  const bestBps = netArbs.reduce((m, x) => Math.max(m, x.netArbBps), 0);
  document.getElementById("kpiCrossBestEdge").textContent = bestBps > 0 ? `+${(bestBps / 100).toFixed(2)}%` : "0.00%";
}

function renderList() {
  const el = document.getElementById("crossCardsList");
  if (!state.pairs.length) {
    el.innerHTML = `<div class="skeleton-card">No twin contracts matched this cross-venue filter right now.</div>`;
    return;
  }

  el.innerHTML = state.pairs
    .map((p) => {
      const b = badgeMeta(p);
      const selected = state.selected && state.selected.id === p.id;
      const guardPill =
        p.ruleAlignment === "EXACT_PARITY"
          ? `<span class="tag-ai-live">✓ RULE PARITY VERIFIED</span>`
          : `<span class="trap-pill">⚠ RULE-MISMATCH GUARD</span>`;

      return `
        <article class="m-card ${selected ? "is-selected" : ""}" data-id="${esc(p.id)}">
          <div class="m-card-top">
            <div class="m-meta-tags">
              <span class="tag-domain">${esc(p.domain?.label || "Macro")}</span>
              ${guardPill}
            </div>
            <span class="verdict-stamp ${b.cls}">${esc(b.label)}</span>
          </div>
          <h3 class="m-question">${esc(p.outcomeLabel)} <span style="font-weight:400;color:var(--ink-500);font-size:14.5px;">— ${esc(p.eventTitle)}</span></h3>
          ${renderDualScale(p)}
          <p style="margin:0 0 10px;font-size:12.5px;color:var(--ink-700);">${esc(p.actionSummary)}</p>
          <div class="m-card-foot">
            <div class="m-foot-metrics">
              <span>KALSHI: <strong>${esc(p.kalshiTicker)}</strong></span>
              <span>POLY 24H: <strong>${fmtUsdCompact(p.polyVolume24hUsd)}</strong></span>
              <span>KALSHI FEE: <strong>${(p.bestKalshiFee * 100).toFixed(2)}¢</strong></span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  el.querySelectorAll(".m-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-id");
      const hit = state.pairs.find((x) => x.id === id);
      if (hit) {
        state.selected = hit;
        renderList();
        renderInspector();
      }
    });
  });
}

function renderInspector() {
  const el = document.getElementById("crossInspector");
  const p = state.selected;
  if (!p) {
    el.innerHTML = `<div class="inspector-empty">Select any twin contract to simulate net-of-fee cross-venue execution.</div>`;
    return;
  }

  const b = badgeMeta(p);
  const n = state.contractsCount;
  const grossCostUsd = Number((n * p.bestGrossCost).toFixed(2));
  const kalshiFeeUsd = Number((n * p.bestKalshiFee).toFixed(2));
  const netCostUsd = Number((n * p.bestNetCost).toFixed(2));
  const netProfitUsd = Number((n - netCostUsd).toFixed(2));

  const leg1Text =
    p.bestRoute === "BUY_POLY_YES_KALSHI_NO"
      ? `Leg 1 (Polymarket): BUY YES @ ${(p.polyYesAsk * 100).toFixed(1)}¢ (0¢ fee)`
      : `Leg 1 (Kalshi): BUY YES @ ${(p.kalshiYesAsk * 100).toFixed(1)}¢`;
  const leg2Text =
    p.bestRoute === "BUY_POLY_YES_KALSHI_NO"
      ? `Leg 2 (Kalshi): BUY NO @ ${(p.kalshiNoAsk * 100).toFixed(1)}¢ (+${(p.bestKalshiFee * 100).toFixed(2)}¢ fee)`
      : `Leg 2 (Polymarket): BUY NO @ ${(p.polyNoAsk * 100).toFixed(1)}¢ (0¢ fee)`;

  el.innerHTML = `
    <div class="insp-kicker">
      <span>${esc(p.kalshiTicker)} ↔ POLYMARKET</span>
      <span class="verdict-stamp ${b.cls}">${esc(b.label)}</span>
    </div>
    <h3 class="insp-title">${esc(p.outcomeLabel)} — ${esc(p.eventTitle)}</h3>
    ${renderDualScale(p)}

    <div class="insp-block">
      <div class="insp-block-h">RULE-MISMATCH GUARD VERDICT</div>
      <div class="proof-banner ${p.ruleAlignment === "EXACT_PARITY" ? "ok" : "fail"}" style="margin-bottom:0;font-size:11.5px;">
        ${esc(p.basisNote)}
      </div>
    </div>

    <div class="insp-block">
      <div class="insp-block-h">CROSS-VENUE COMPLETE-SET CALCULATOR ($1.00 PAR)</div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--ink-700);margin-bottom:8px;">
        <div>• ${esc(leg1Text)}</div>
        <div>• ${esc(leg2Text)}</div>
      </div>
      <div class="kelly-widget">
        <div class="kelly-slider-row">
          <span>HEDGED CONTRACTS</span>
          <strong>${n.toLocaleString()} SETS ($${n.toLocaleString()} PAR)</strong>
        </div>
        <input type="range" id="crossCountSlider" min="100" max="10000" step="100" value="${n}" />
        <div class="kelly-stats">
          <div class="kelly-stat-box">
            <strong>$${grossCostUsd.toLocaleString()}</strong>
            <span>GROSS COST</span>
          </div>
          <div class="kelly-stat-box">
            <strong>$${kalshiFeeUsd.toLocaleString()}</strong>
            <span>KALSHI FEE</span>
          </div>
          <div class="kelly-stat-box">
            <strong style="color:${p.ruleAlignment === "EXACT_PARITY" && netProfitUsd > 0 ? "var(--jade-700)" : "var(--verm-700)"}">
              ${p.ruleAlignment !== "EXACT_PARITY" ? "BLOCKED" : `${netProfitUsd >= 0 ? "+" : ""}$${netProfitUsd}`}
            </strong>
            <span>NET LOCKED P&amp;L</span>
          </div>
        </div>
      </div>
    </div>

    <div class="insp-cta-row">
      <a href="${esc(p.polymarketUrl)}" target="_blank" rel="noopener" class="btn-ink">Polymarket Book ↗</a>
      <a href="${esc(p.kalshiUrl)}" target="_blank" rel="noopener" class="btn-ghost">Kalshi Book ↗</a>
    </div>
  `;

  const slider = document.getElementById("crossCountSlider");
  if (slider) {
    slider.addEventListener("input", (e) => {
      state.contractsCount = Number(e.target.value);
      renderInspector();
    });
  }
}

async function loadCross({ refresh = false } = {}) {
  const t0 = performance.now();
  const res = await fetch(`/v1/cross?filter=${encodeURIComponent(state.filter)}&limit=28${refresh ? "&refresh=1" : ""}`);
  const data = await res.json();
  document.getElementById("crossLatency").textContent = `${Math.round(performance.now() - t0)}ms`;
  if (!data.ok) return;

  state.pairs = data.pairs || [];
  if (state.filter === "all") {
    state.allPairsSnapshot = state.pairs;
    renderKpis(state.allPairsSnapshot);
  }
  if (!state.selected || !state.pairs.some((x) => x.id === state.selected.id)) {
    state.selected = state.pairs[0] || null;
  }
  renderList();
  renderInspector();
}

document.querySelectorAll("#crossFilterRow .dom-pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#crossFilterRow .dom-pill").forEach((x) => x.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.filter = btn.getAttribute("data-filter");
    loadCross();
  });
});

document.getElementById("refreshCrossBtn").addEventListener("click", () => loadCross({ refresh: true }));

Promise.all([initSharedSpine(), loadCross()]);
