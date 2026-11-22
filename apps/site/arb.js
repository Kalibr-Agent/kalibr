import { initSharedSpine, esc, fmtPct, fmtUsdCompact } from "./spine.js";

const state = {
  mode: "all",
  books: [],
  selectedBook: null,
  basketUsd: 1000,
};

function verdictBadge(book) {
  switch (book.arbVerdict) {
    case "DUTCH_BOOK_ASK_ARB":
      return { cls: "v-yes", label: `DUTCH BOOK · ASK ${(book.sumBestAsk * 100).toFixed(1)}¢` };
    case "MINT_SET_BID_ARB":
      return { cls: "v-yes", label: `MINT-SET ARB · BID ${(book.sumBestBid * 100).toFixed(1)}¢` };
    case "RETAIL_OVERROUND":
      return { cls: "v-no", label: `OVERROUND · Σ ${(book.sumMidProb * 100).toFixed(1)}%` };
    case "UNDERPRICED_PARTITION":
      return { cls: "v-yes", label: `UNDER-PARITY · Σ ${(book.sumMidProb * 100).toFixed(1)}%` };
    case "OPEN_FIELD_OVERROUND":
      return { cls: "v-no", label: `OPEN FIELD >100% (${(book.sumMidProb * 100).toFixed(1)}%)` };
    case "DARK_HORSE_IMPLIED":
      return { cls: "v-info", label: `UNLISTED FIELD ${(book.unlistedFieldProb * 100).toFixed(1)}%` };
    default:
      return { cls: "v-flat", label: `TIGHT PARITY · Σ ${(book.sumMidProb * 100).toFixed(1)}%` };
  }
}

function renderParityBar(book) {
  // Scale 0% .. 130%, so 100% sits at 76.92%
  const widthPct = Math.min(100, Math.max(4, (book.sumMidProb / 1.3) * 100));
  return `
    <div class="parity-box">
      <div class="parity-readout">
        <span>Σ MID: <strong>${(book.sumMidProb * 100).toFixed(1)}%</strong></span>
        <span>Σ BID: <strong>${(book.sumBestBid * 100).toFixed(1)}¢</strong> · Σ ASK: <strong>${(book.sumBestAsk * 100).toFixed(1)}¢</strong></span>
      </div>
      <div class="parity-track">
        <div class="parity-fill ${esc(book.signalTone)}" style="width:${widthPct.toFixed(2)}%"></div>
        <div class="parity-100-marker" title="100.0% Settlement Parity ($1.00)"></div>
      </div>
      <div class="parity-scale-nums">
        <span>0%</span><span>50%</span><span>100% PARITY</span><span>130%</span>
      </div>
    </div>
  `;
}

function renderKpis(allBooks) {
  document.getElementById("kpiArbTotal").textContent = String(allBooks.length);
  document.getElementById("kpiArbExecutable").textContent = String(
    allBooks.filter((b) => b.arbVerdict === "DUTCH_BOOK_ASK_ARB" || b.arbVerdict === "MINT_SET_BID_ARB" || b.arbVerdict === "UNDERPRICED_PARTITION").length
  );
  document.getElementById("kpiArbOverround").textContent = String(
    allBooks.filter((b) => b.arbVerdict === "RETAIL_OVERROUND" || b.arbVerdict === "OPEN_FIELD_OVERROUND").length
  );
  document.getElementById("kpiArbOpenField").textContent = String(
    allBooks.filter((b) => b.arbVerdict === "DARK_HORSE_IMPLIED").length
  );
}

function renderCards() {
  const el = document.getElementById("arbCardsList");
  if (!state.books.length) {
    el.innerHTML = `<div class="skeleton-card">No active multi-outcome NegRisk orderbooks matched this filter.</div>`;
    return;
  }

  el.innerHTML = state.books
    .map((b) => {
      const v = verdictBadge(b);
      const selected = state.selectedBook && state.selectedBook.eventSlug === b.eventSlug;
      return `
        <article class="m-card ${selected ? "is-selected" : ""}" data-slug="${esc(b.eventSlug)}">
          <div class="m-card-top">
            <div class="m-meta-tags">
              <span class="tag-domain">${esc(b.domain?.label || "World Event")}</span>
              <span class="tag-ai-live">${b.isAugmented ? "AUGMENTED FIELD" : "CLOSED PARTITION"} · ${b.bracketCount} OUTCOMES</span>
            </div>
            <span class="verdict-stamp ${v.cls}">${esc(v.label)}</span>
          </div>
          <h3 class="m-question">${esc(b.eventTitle)}</h3>
          ${renderParityBar(b)}
          <p style="margin:0 0 10px;font-size:12.5px;color:var(--ink-700);">${esc(b.actionSummary)}</p>
          <div class="m-card-foot">
            <div class="m-foot-metrics">
              <span>24H VOL: <strong>${fmtUsdCompact(b.volume24hUsd)}</strong></span>
              <span>BOOK DEPTH: <strong>${fmtUsdCompact(b.liquidityUsd)}</strong></span>
              <span>DEVIATION: <strong>${b.overroundBps >= 0 ? "+" : ""}${(b.overroundBps / 100).toFixed(1)}%</strong></span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  el.querySelectorAll(".m-card").forEach((card) => {
    card.addEventListener("click", () => {
      const slug = card.getAttribute("data-slug");
      const hit = state.books.find((x) => x.eventSlug === slug);
      if (hit) {
        state.selectedBook = hit;
        renderCards();
        renderInspector();
      }
    });
  });
}

function renderInspector() {
  const el = document.getElementById("arbInspector");
  const b = state.selectedBook;
  if (!b) {
    el.innerHTML = `<div class="inspector-empty">Select a multi-outcome NegRisk book on the left to inspect complete-set basket math.</div>`;
    return;
  }

  const v = verdictBadge(b);
  const shares = state.basketUsd;
  const buyAllAskCost = Math.round(shares * b.sumBestAsk * 100) / 100;
  const mintSellBidProceeds = Math.round(shares * b.sumBestBid * 100) / 100;
  const dutchPnl = Number((shares - buyAllAskCost).toFixed(2));
  const mintPnl = Number((mintSellBidProceeds - shares).toFixed(2));

  const rowsHtml = (b.brackets || [])
    .map((br) => {
      const skewSign = br.bracketSkewBps >= 0 ? "+" : "";
      const bidAsk =
        br.bestBid !== null && br.bestAsk !== null
          ? `${(br.bestBid * 100).toFixed(1)}¢/${(br.bestAsk * 100).toFixed(1)}¢`
          : `${fmtPct(br.crowdProb)}`;
      return `
        <tr>
          <td>${esc(br.label.slice(0, 26))}${br.label.length > 26 ? "…" : ""}</td>
          <td class="num">${fmtPct(br.crowdProb)}</td>
          <td class="num">${b.isAugmented ? "—" : fmtPct(br.normalizedFairProb)}</td>
          <td class="num">${esc(bidAsk)}</td>
          <td class="num" style="color:${br.bracketSkewBps < -40 ? "var(--verm-700)" : br.bracketSkewBps > 40 ? "var(--jade-700)" : "var(--ink-500)"}">
            ${b.isAugmented ? "—" : `${skewSign}${(br.bracketSkewBps / 100).toFixed(1)}%`}
          </td>
        </tr>
      `;
    })
    .join("");

  el.innerHTML = `
    <div class="insp-kicker">
      <span>${b.isAugmented ? "AUGMENTED OPEN FIELD" : "CLOSED CTF PARTITION"} · ${b.bracketCount} BRACKETS</span>
      <span class="verdict-stamp ${v.cls}">${esc(v.label)}</span>
    </div>
    <h3 class="insp-title">${esc(b.eventTitle)}</h3>
    ${renderParityBar(b)}
    <p style="margin:0 0 10px;font-size:12px;color:var(--ink-700);">${esc(b.actionSummary)}</p>

    <div class="insp-block">
      <div class="insp-block-h">COMPLETE-SET SIMULATOR ($1.00 PAYOUT PER SET)</div>
      <div class="kelly-widget">
        <div class="kelly-slider-row">
          <span>COMPLETE SETS</span>
          <strong>${shares.toLocaleString()} SETS ($${shares.toLocaleString()} PAR)</strong>
        </div>
        <input type="range" id="arbBasketSlider" min="100" max="10000" step="100" value="${state.basketUsd}" />
        <div class="kelly-stats">
          <div class="kelly-stat-box">
            <strong>$${buyAllAskCost.toLocaleString()}</strong>
            <span>BUY ALL ASKS</span>
          </div>
          <div class="kelly-stat-box">
            <strong>$${mintSellBidProceeds.toLocaleString()}</strong>
            <span>MINT &amp; HIT BIDS</span>
          </div>
          <div class="kelly-stat-box">
            <strong style="color:${Math.max(dutchPnl, mintPnl) > 0 && !b.isAugmented ? "var(--jade-700)" : "var(--ink-900)"}">
              ${b.isAugmented ? `${(b.unlistedFieldProb * 100).toFixed(1)}%` : `${Math.max(dutchPnl, mintPnl) >= 0 ? "+" : ""}$${Math.max(dutchPnl, mintPnl)}`}
            </strong>
            <span>${b.isAugmented ? "IMPLIED OTHER" : "BEST ARB P&L"}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="insp-block">
      <div class="insp-block-h">TOP OUTCOME BRACKETS &amp; NORMALIZED FAIR SHARE</div>
      <table class="bracket-table">
        <thead>
          <tr>
            <th>Outcome</th>
            <th class="num">Crowd</th>
            <th class="num">Norm</th>
            <th class="num">Bid/Ask</th>
            <th class="num">Skew</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>

    <div class="insp-cta-row">
      <a href="/?q=${encodeURIComponent(b.eventSlug)}&view=bench" class="btn-ink">3-Agent Bench →</a>
      <a href="${esc(b.polymarketUrl)}" target="_blank" rel="noopener" class="btn-ghost">Polymarket ↗</a>
    </div>
  `;

  const slider = document.getElementById("arbBasketSlider");
  if (slider) {
    slider.addEventListener("input", (e) => {
      state.basketUsd = Number(e.target.value);
      renderInspector();
    });
  }
}

async function loadArb({ refresh = false } = {}) {
  const t0 = performance.now();
  const res = await fetch(`/v1/arb?mode=${encodeURIComponent(state.mode)}&limit=24${refresh ? "&refresh=1" : ""}`);
  const data = await res.json();
  document.getElementById("arbLatency").textContent = `${Math.round(performance.now() - t0)}ms`;
  if (!data.ok) return;

  state.books = data.books || [];
  if (state.mode === "all") renderKpis(state.books);

  if (!state.selectedBook || !state.books.some((b) => b.eventSlug === state.selectedBook.eventSlug)) {
    state.selectedBook = state.books[0] || null;
  }
  renderCards();
  renderInspector();
}

document.querySelectorAll("#arbModeRow .dom-pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#arbModeRow .dom-pill").forEach((x) => x.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.mode = btn.getAttribute("data-mode");
    loadArb();
  });
});

document.getElementById("refreshArbBtn").addEventListener("click", () => loadArb({ refresh: true }));

Promise.all([initSharedSpine(), loadArb()]);
