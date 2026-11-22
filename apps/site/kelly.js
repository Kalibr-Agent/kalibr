import { computePortfolioKellySlate } from "./core/polymarket.js";
import { initSharedSpine, esc, fmtPct, fmtSignedEdge, fmtUsdCompact, getStoredSlateSlugs } from "./spine.js";

const state = {
  bankrollUsd: 2500,
  maxCap: 0.55,
  allMarkets: [],
  selectedSlugs: getStoredSlateSlugs(),
  lastSlate: null,
};

function persistSlugs() {
  localStorage.setItem("kalibr_slate_slugs", JSON.stringify(state.selectedSlugs));
}

function renderAll() {
  const selectedMarkets = state.selectedSlugs
    .map((slug) => state.allMarkets.find((m) => m.eventSlug === slug))
    .filter(Boolean);

  const slate = computePortfolioKellySlate(selectedMarkets, {
    bankrollUsd: state.bankrollUsd,
    maxTotalAllocationPct: state.maxCap,
  });
  state.lastSlate = slate;

  document.getElementById("slateBankrollLabel").textContent = `$${state.bankrollUsd.toLocaleString()}`;
  document.getElementById("kpiKellyDeployed").textContent = `$${slate.totalAllocatedUsd.toLocaleString()}`;
  document.getElementById("kpiKellyDeployedSub").textContent = `${slate.totalAllocatedPct}% across ${slate.legCount} legs`;
  document.getElementById("kpiKellyReserve").textContent = `$${slate.reserveCashUsd.toLocaleString()}`;
  document.getElementById("kpiKellyReserveSub").textContent = `${slate.reserveCashPct}% dry-powder USDC`;
  document.getElementById("kpiKellyEv").textContent = `${slate.totalExpectedProfitUsd >= 0 ? "+" : ""}$${slate.totalExpectedProfitUsd.toLocaleString()}`;

  const minHaircut = slate.allocations.reduce((acc, a) => Math.min(acc, a.correlationHaircut), 1.0);
  document.getElementById("kpiKellyHaircut").textContent = `${minHaircut.toFixed(2)}×`;

  const slateEl = document.getElementById("activeSlateList");
  if (!slate.allocations.length) {
    slateEl.innerHTML = `<div class="skeleton-card">Your slate is empty. Click '+ Add' on any live mispriced contract on the right.</div>`;
  } else {
    slateEl.innerHTML = slate.allocations
      .map(
        (leg) => `
        <article class="slate-leg-card">
          <div class="m-card-top" style="margin-bottom:0;">
            <div class="m-meta-tags">
              <span class="tag-domain">${esc(leg.domain?.label || "World Event")}</span>
              ${
                leg.sameDomainCount > 1
                  ? `<span class="haircut-badge">CORRELATED (${leg.sameDomainCount} in domain → ${leg.correlationHaircut}× haircut)</span>`
                  : ""
              }
            </div>
            <span class="verdict-stamp ${leg.side === "YES" ? "v-yes" : "v-no"}">
              BUY ${esc(leg.side)} · ${fmtSignedEdge(leg.edgeBps)}
            </span>
          </div>
          <h3 class="m-question" style="margin:0;">${esc(leg.question)}</h3>
          <div class="slate-leg-metrics">
            <div>
              <strong>$${leg.stakeUsd.toLocaleString()}</strong>
              <span>ALLOCATED (${leg.finalAllocationPct}%)</span>
            </div>
            <div>
              <strong>${(leg.entryPrice * 100).toFixed(1)}¢</strong>
              <span>EXEC LIMIT (${leg.side})</span>
            </div>
            <div>
              <strong>${fmtPct(leg.crowdProb)} → ${fmtPct(leg.fairProb)}</strong>
              <span>CROWD → FAIR</span>
            </div>
            <div>
              <strong style="color:var(--jade-700)">${leg.expectedProfitUsd >= 0 ? "+" : ""}$${leg.expectedProfitUsd}</strong>
              <span>EXPECTED EV</span>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="display:flex;gap:8px;">
              <a href="${esc(leg.polymarketUrl)}" target="_blank" rel="noopener" class="btn-ghost" style="padding:4px 10px;font-size:11px;">Polymarket ↗</a>
              <a href="/?q=${encodeURIComponent(leg.eventSlug)}&view=bench" class="btn-ghost" style="padding:4px 10px;font-size:11px;">3-Agent Bench →</a>
            </div>
            <button type="button" class="btn-ghost remove-leg-btn" data-slug="${esc(leg.eventSlug)}" style="padding:4px 10px;font-size:11px;color:var(--verm-700);">Remove ✕</button>
          </div>
        </article>
      `
      )
      .join("");

    slateEl.querySelectorAll(".remove-leg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const slug = btn.getAttribute("data-slug");
        state.selectedSlugs = state.selectedSlugs.filter((s) => s !== slug);
        persistSlugs();
        renderAll();
      });
    });
  }

  const poolEl = document.getElementById("candidatePoolList");
  const candidates = state.allMarkets.filter((m) => !state.selectedSlugs.includes(m.eventSlug));
  poolEl.innerHTML = candidates
    .slice(0, 12)
    .map(
      (m) => `
      <div style="background:var(--bg-paper);border:1px solid var(--rule);border-radius:6px;padding:9px 11px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div style="min-width:0;">
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--ink-500);">
            ${esc(m.domain?.label || "Event")} · Crowd ${fmtPct(m.crowdProb)} → Fair ${fmtPct(m.fairProb)} (${fmtSignedEdge(m.edgeBps)})
          </div>
          <div style="font-size:12.5px;font-weight:600;color:var(--ink-900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${esc(m.question)}
          </div>
        </div>
        <button type="button" class="btn-ink add-cand-btn" data-slug="${esc(m.eventSlug)}" style="padding:5px 10px;font-size:11px;">+ Add</button>
      </div>
    `
    )
    .join("");

  poolEl.querySelectorAll(".add-cand-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slug = btn.getAttribute("data-slug");
      if (slug && !state.selectedSlugs.includes(slug) && state.selectedSlugs.length < 8) {
        state.selectedSlugs.push(slug);
        persistSlugs();
        renderAll();
      }
    });
  });
}

async function initKellyPage() {
  const res = await fetch("/v1/radar?domain=all&limit=22");
  const data = await res.json();
  if (!data.ok) return;
  state.allMarkets = data.markets || [];

  // Keep valid stored slugs; if none, auto-seed top 3 actionable live edges so visitor sees instant value
  state.selectedSlugs = state.selectedSlugs.filter((slug) => state.allMarkets.some((m) => m.eventSlug === slug));
  if (state.selectedSlugs.length === 0) {
    const actionable = state.allMarkets.filter((m) => m.verdictCode.startsWith("MISPRICED"));
    state.selectedSlugs = (actionable.length ? actionable : state.allMarkets).slice(0, 3).map((m) => m.eventSlug);
    persistSlugs();
  }
  renderAll();
}

document.getElementById("slateBankrollSlider").addEventListener("input", (e) => {
  state.bankrollUsd = Number(e.target.value);
  document.querySelectorAll("#bankrollPresets .preset-pill").forEach((p) => {
    p.classList.toggle("is-active", Number(p.getAttribute("data-val")) === state.bankrollUsd);
  });
  renderAll();
});

document.querySelectorAll("#bankrollPresets .preset-pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.bankrollUsd = Number(btn.getAttribute("data-val"));
    document.getElementById("slateBankrollSlider").value = String(state.bankrollUsd);
    document.querySelectorAll("#bankrollPresets .preset-pill").forEach((p) => p.classList.remove("is-active"));
    btn.classList.add("is-active");
    renderAll();
  });
});

document.querySelectorAll("#capPresets .preset-pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.maxCap = Number(btn.getAttribute("data-cap"));
    document.querySelectorAll("#capPresets .preset-pill").forEach((p) => p.classList.remove("is-active"));
    btn.classList.add("is-active");
    renderAll();
  });
});

document.getElementById("resetTop3Btn").addEventListener("click", () => {
  const actionable = state.allMarkets.filter((m) => m.verdictCode.startsWith("MISPRICED"));
  state.selectedSlugs = (actionable.length ? actionable : state.allMarkets).slice(0, 3).map((m) => m.eventSlug);
  persistSlugs();
  renderAll();
});

document.getElementById("copySlateMarkdownBtn").addEventListener("click", async (e) => {
  const s = state.lastSlate;
  if (!s) return;
  const lines = [
    `# KALIBR Quarter-Kelly Slate ($${s.bankrollUsd.toLocaleString()} Bankroll)`,
    `- Deployed: $${s.totalAllocatedUsd.toLocaleString()} (${s.totalAllocatedPct}%) | Reserve: $${s.reserveCashUsd.toLocaleString()} | Expected EV: +$${s.totalExpectedProfitUsd}`,
    "",
    ...s.allocations.map(
      (a, idx) =>
        `${idx + 1}. **BUY ${a.side}** — ${a.question} | Stake: **$${a.stakeUsd}** (${a.finalAllocationPct}%) @ ${(a.entryPrice * 100).toFixed(1)}¢ | EV: +$${a.expectedProfitUsd}`
    ),
  ];
  await navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  const btn = e.currentTarget;
  const prev = btn.textContent;
  btn.textContent = "Copied Slate ✓";
  setTimeout(() => {
    btn.textContent = prev;
  }, 1300);
});

Promise.all([initSharedSpine(), initKellyPage()]);
