import { scoreContractTrapRisk } from "./core/polymarket.js";
import { initSharedSpine, esc, fmtPct, fmtUsdCompact } from "./spine.js";

const state = {
  filter: "all",
  contracts: [],
  selected: null,
};

function trapBadge(c) {
  if (c.trapVerdict === "HIGH_DISPUTE_RISK") {
    return { cls: "v-no", label: `HIGH RISK · ${c.trapRiskScore}/100` };
  }
  if (c.trapVerdict === "CAUTION_FINE_PRINT") {
    return { cls: "v-trap", label: `CAUTION CLAUSE · ${c.trapRiskScore}/100` };
  }
  return { cls: "v-yes", label: `CLEAN RULES · ${c.trapRiskScore}/100` };
}

function filteredContracts() {
  if (state.filter === "flagged") return state.contracts.filter((c) => (c.ruleTraps || []).length > 0);
  if (state.filter === "high") return state.contracts.filter((c) => c.trapVerdict === "HIGH_DISPUTE_RISK");
  if (state.filter === "clean") return state.contracts.filter((c) => c.trapVerdict === "CLEAN_RULES");
  return state.contracts;
}

function renderKpis() {
  const all = state.contracts;
  document.getElementById("kpiTrapsTotal").textContent = String(all.length);
  document.getElementById("kpiTrapsHigh").textContent = String(
    all.filter((c) => c.trapVerdict === "HIGH_DISPUTE_RISK").length
  );
  document.getElementById("kpiTrapsMedium").textContent = String(
    all.filter((c) => c.trapVerdict === "CAUTION_FINE_PRINT").length
  );
  document.getElementById("kpiTrapsClean").textContent = String(
    all.filter((c) => c.trapVerdict === "CLEAN_RULES").length
  );
}

function renderList() {
  const el = document.getElementById("trapCardsList");
  const list = filteredContracts();
  if (!list.length) {
    el.innerHTML = `<div class="skeleton-card">No contracts matched this trap severity filter right now.</div>`;
    return;
  }

  el.innerHTML = list
    .map((c) => {
      const b = trapBadge(c);
      const selected = state.selected && state.selected.marketId === c.marketId;
      const pills = (c.ruleTraps || [])
        .map((t) => `<span class="trap-pill">${esc(t.code.replace(/_/g, " "))}</span>`)
        .join(" ");

      return `
        <article class="m-card ${selected ? "is-selected" : ""}" data-id="${esc(c.marketId)}">
          <div class="m-card-top">
            <div class="m-meta-tags">
              <span class="tag-domain">${esc(c.domain?.label || "World Event")}</span>
              <span class="tag-domain">CROWD YES ${fmtPct(c.crowdProb)}</span>
            </div>
            <span class="verdict-stamp ${b.cls}">${esc(b.label)}</span>
          </div>
          <h3 class="m-question">${esc(c.question)}</h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
            ${pills || `<span style="font-family:var(--font-mono);font-size:11px;color:var(--jade-700);">✓ Unambiguous rules &amp; tight (${(c.spread * 100).toFixed(1)}¢) spread</span>`}
          </div>
          <div class="m-card-foot">
            <div class="m-foot-metrics">
              <span>24H VOL: <strong>${fmtUsdCompact(c.volume24hUsd)}</strong></span>
              <span>BOOK: <strong>${fmtUsdCompact(c.liquidityUsd)}</strong></span>
              <span>SPREAD: <strong>${(c.spread * 100).toFixed(1)}¢</strong></span>
              <span>END: <strong>${c.daysToResolution}d</strong></span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  el.querySelectorAll(".m-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.getAttribute("data-id");
      const hit = state.contracts.find((x) => x.marketId === id);
      if (hit) {
        state.selected = hit;
        renderList();
        renderInspector();
      }
    });
  });
}

function renderInspector() {
  const el = document.getElementById("trapInspector");
  const c = state.selected;
  if (!c) {
    el.innerHTML = `<div class="inspector-empty">Select a contract on the left or paste any Polymarket URL above.</div>`;
    return;
  }

  const b = trapBadge(c);
  const trapsHtml =
    (c.ruleTraps || []).length > 0
      ? c.ruleTraps
          .map(
            (t) => `
          <div class="trap-card">
            <strong>[${esc(t.severity)}] ${esc(t.title)}</strong>
            <div>${esc(t.detail)}</div>
            ${t.snippet ? `<em>Verbatim clause: “…${esc(t.snippet)}…”</em>` : ""}
          </div>
        `
          )
          .join("")
      : `<div class="proof-banner ok" style="margin-bottom:0;">✓ ZERO CLAUSE FLAGS — Tight ${(c.spread * 100).toFixed(1)}¢ spread, $${c.liquidityUsd.toLocaleString()} resting depth, and standard deterministic wording.</div>`;

  el.innerHTML = `
    <div class="insp-kicker">
      <span>TRAP SCORE ${c.trapRiskScore}/100 · ${c.trapCount} FLAGS</span>
      <span class="verdict-stamp ${b.cls}">${esc(b.label)}</span>
    </div>
    <h3 class="insp-title">${esc(c.question)}</h3>

    <div class="insp-block">
      <div class="insp-block-h">CLAUSE &amp; MICROSTRUCTURE FINDINGS</div>
      ${trapsHtml}
    </div>

    <div class="insp-block">
      <div class="insp-block-h">FULL VERBATIM RESOLUTION SPECIFICATION</div>
      <div style="background:var(--bg-paper);border:1px solid var(--rule);border-radius:6px;padding:10px 12px;max-height:210px;overflow-y:auto;font-size:12px;color:var(--ink-700);white-space:pre-line;">${esc(c.description || "No custom resolution text supplied by market creator.")}</div>
    </div>

    <div class="insp-cta-row">
      <a href="/?q=${encodeURIComponent(c.eventSlug)}&view=bench" class="btn-ink">Dispatch Trap Devil AI →</a>
      <a href="${esc(c.polymarketUrl)}" target="_blank" rel="noopener" class="btn-ghost">Polymarket ↗</a>
    </div>
  `;
}

async function loadTraps({ refresh = false } = {}) {
  const t0 = performance.now();
  const res = await fetch(`/v1/traps?limit=24${refresh ? "&refresh=1" : ""}`);
  const data = await res.json();
  document.getElementById("trapLatency").textContent = `${Math.round(performance.now() - t0)}ms`;
  if (!data.ok) return;

  state.contracts = data.contracts || [];
  renderKpis();
  if (!state.selected || !state.contracts.some((x) => x.marketId === state.selected.marketId)) {
    state.selected = state.contracts[0] || null;
  }
  renderList();
  renderInspector();
}

document.getElementById("trapAuditForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = document.getElementById("trapAuditInput").value.trim();
  if (!q) return;
  const btn = document.getElementById("trapAuditBtn");
  const t0 = performance.now();
  btn.disabled = true;
  btn.textContent = "Auditing…";
  try {
    const res = await fetch(`/v1/inspect?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    document.getElementById("trapLatency").textContent = `${Math.round(performance.now() - t0)}ms`;
    if (!data.ok) throw new Error(data.error || "Audit failed");
    const scored = { ...data.market, ...scoreContractTrapRisk(data.market) };
    state.selected = scored;
    const idx = state.contracts.findIndex((x) => x.marketId === scored.marketId);
    if (idx >= 0) state.contracts[idx] = scored;
    else state.contracts.unshift(scored);
    state.filter = "all";
    document.querySelectorAll("#trapFilterRow .dom-pill").forEach((p) => {
      p.classList.toggle("is-active", p.getAttribute("data-filter") === "all");
    });
    renderKpis();
    renderList();
    renderInspector();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Audit Contract Rules";
  }
});

document.querySelectorAll("#trapFilterRow .dom-pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#trapFilterRow .dom-pill").forEach((p) => p.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.filter = btn.getAttribute("data-filter");
    renderList();
  });
});

document.getElementById("refreshTrapsBtn").addEventListener("click", () => loadTraps({ refresh: true }));

Promise.all([initSharedSpine(), loadTraps()]);
