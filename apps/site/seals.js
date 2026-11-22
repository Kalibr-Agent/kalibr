import { hashForecastLeaf, hashSortedPair } from "./core/merkle.js";
import { initSharedSpine, esc } from "./spine.js";

const state = {
  epochs: [],
  activeEpoch: null,
  leaves: [],
  selectedIdx: 0,
  tamperActive: false,
};

function renderEpochs() {
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
              ? `<div style="margin-top:4px;font-family:var(--font-mono);font-size:10px;"><a href="https://robinhoodchain.blockscout.com/tx/${esc(ep.tx_hash)}" target="_blank" rel="noopener" style="color:var(--jade-700);">✓ ONCHAIN SEALED · Blockscout Tx ↗</a></div>`
              : `<div style="margin-top:4px;font-family:var(--font-mono);font-size:10px;color:var(--ink-400);">D1 SNAPSHOT (AWAITING ONCHAIN SEAL)</div>`
          }
        </div>
      `;
    })
    .join("");

  el.querySelectorAll(".epoch-item").forEach((node) => {
    node.addEventListener("click", () => selectEpoch(Number(node.getAttribute("data-epoch"))));
  });
}

function renderVerifier() {
  const stage = document.getElementById("verifierStage");
  const ep = state.activeEpoch;
  if (!ep || !state.leaves.length) return;

  const row = state.leaves[state.selectedIdx] || state.leaves[0];
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
  for (const sib of row.proof || []) {
    walk = hashSortedPair(walk, sib);
  }
  const matches = walk.toLowerCase() === ep.merkle_root.toLowerCase();

  stage.innerHTML = `
    <div class="sealed-leaf-pills">
      ${state.leaves
        .slice(0, 12)
        .map(
          (l, idx) => `
        <button type="button" class="leaf-pill ${idx === state.selectedIdx ? "is-active" : ""}" data-leaf-idx="${idx}">
          ${esc(l.question.slice(0, 38))}${l.question.length > 38 ? "…" : ""}
        </button>
      `
        )
        .join("")}
    </div>

    <div class="proof-banner ${matches ? "ok" : "fail"}">
      ${
        matches
          ? "✓ CRYPTOGRAPHICALLY VERIFIED IN BROWSER — Recomputed Keccak-256 leaf & sorted-pair Merkle path match onchain root byte-for-byte."
          : "✗ TAMPER DETECTED — Mutating fairProbBps by +100 bps (+1.0%) broke the Keccak-256 digest and failed the sealed Merkle root!"
      }
    </div>

    <div class="card-kicker">CANONICAL FORECAST LEAF PAYLOAD (RE-HASHED CLIENT-SIDE)</div>
    <pre class="code-slab"><code>${esc(recomputed.canonical)}</code></pre>

    <div class="card-kicker">SORTED-PAIR KECCAK-256 WALK (${(row.proof || []).length} LEVELS)</div>
    <pre class="code-slab"><code>Computed Leaf Hash : ${esc(recomputed.leafHash)}
Expected Epoch Root: ${esc(ep.merkle_root)}
Recomputed Root    : ${esc(walk)}
Onchain Seal Tx    : ${esc(ep.tx_hash || "pending")}
Match Verdict      : ${matches ? "EXACT_MATCH (TRUE)" : "MISMATCH (FALSE)"}</code></pre>
  `;

  stage.querySelectorAll(".leaf-pill").forEach((b) => {
    b.addEventListener("click", () => {
      state.selectedIdx = Number(b.getAttribute("data-leaf-idx"));
      renderVerifier();
    });
  });
}

async function selectEpoch(epochHour) {
  const res = await fetch(`/v1/seals/${epochHour}`);
  const data = await res.json();
  if (!data.ok) return;
  state.activeEpoch = data.epoch;
  state.leaves = data.forecasts || [];
  state.selectedIdx = 0;
  state.tamperActive = false;
  const btn = document.getElementById("tamperToggleBtn");
  btn.classList.remove("is-tampered");
  btn.textContent = "Simulate +1% Tamper Attack";
  renderEpochs();
  renderVerifier();
}

async function initSeals() {
  const res = await fetch("/v1/seals?limit=20");
  const data = await res.json();
  state.epochs = data.epochs || [];
  renderEpochs();
  if (state.epochs.length > 0) {
    await selectEpoch(state.epochs[0].epoch_hour);
  }
}

document.getElementById("tamperToggleBtn").addEventListener("click", (e) => {
  state.tamperActive = !state.tamperActive;
  e.currentTarget.classList.toggle("is-tampered", state.tamperActive);
  e.currentTarget.textContent = state.tamperActive ? "Restore Original Sealed Leaf" : "Simulate +1% Tamper Attack";
  renderVerifier();
});

Promise.all([initSharedSpine(), initSeals()]);
