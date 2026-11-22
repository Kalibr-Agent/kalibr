export const SITE_CONFIG = {
  tokenCa: "0x002E44f3c1856a71acAF9FB3067e96a4348607c4",
  sealRegistry: "0xcbbc1f359ff98ec0c6a5d7ee02380f957b650bc2",
  xUrl: "https://x.com/kalibragent",
  ponsUrl: "https://ponsfamily.com/launchpad/0x002E44f3c1856a71acAF9FB3067e96a4348607c4",
};

export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtPct(prob) {
  return `${(Number(prob || 0) * 100).toFixed(1)}%`;
}

export function fmtSignedEdge(edgeBps) {
  const pct = Number(edgeBps || 0) / 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function fmtUsdCompact(num) {
  const n = Number(num || 0);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

export function getStoredSlateSlugs() {
  try {
    const raw = JSON.parse(localStorage.getItem("kalibr_slate_slugs") || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}

export function addSlugToSlate(slug) {
  if (!slug) return;
  const cur = getStoredSlateSlugs();
  if (!cur.includes(slug)) {
    const next = [slug, ...cur].slice(0, 8);
    localStorage.setItem("kalibr_slate_slugs", JSON.stringify(next));
  }
}

export async function initSharedSpine({ onStatusLoaded } = {}) {
  let wallet = localStorage.getItem("kalibr_wallet") || "";
  const walletInput = document.getElementById("walletInput");
  if (walletInput && wallet) walletInput.value = wallet;

  async function refreshStatus() {
    try {
      const qs = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
      const [statusRes, radarRes] = await Promise.all([
        fetch(`/v1/status${qs}`),
        fetch("/v1/radar?domain=all&limit=18"),
      ]);
      const data = await statusRes.json();
      const radarData = await radarRes.json().catch(() => null);

      if (radarData?.ok && document.getElementById("statMispriced")) {
        document.getElementById("statMispriced").textContent = String(radarData.mispricedCount ?? 0);
      }

      if (!data.ok) return;

      const sealedOddsEl = document.getElementById("statSealedForecasts");
      if (sealedOddsEl) sealedOddsEl.textContent = String(data.stats?.sealedForecasts ?? 0);

      const epochsEl = document.getElementById("statEpochs");
      if (epochsEl) epochsEl.textContent = String(data.stats?.sealedEpochs ?? 0);

      const blockEl = document.getElementById("statHeadBlock");
      if (blockEl) {
        blockEl.textContent = data.headBlock ? `#${Number(data.headBlock).toLocaleString()}` : "LIVE";
      }

      const activeCa = data.tokenAddress || SITE_CONFIG.tokenCa;
      const caEl = document.getElementById("caDisplay");
      if (caEl && activeCa) caEl.textContent = `$KALIBR: ${activeCa}`;

      const tier = data.caller?.tier || "visitor";
      const badge = document.getElementById("callerTierBadge");
      if (badge) {
        badge.textContent = tier.toUpperCase();
        badge.className = `pass-badge tier-${tier}`;
      }
      const statusLine = document.getElementById("walletStatusLine");
      if (statusLine) {
        statusLine.textContent = data.caller?.wallet
          ? `${Number(data.caller.balanceTokens || 0).toLocaleString()} $KALIBR · ${data.caller.limits.aiPerDay} AI panels/day`
          : `Unlimited <1.2s scans · ${data.caller?.limits?.aiPerDay || 15} AI panels/day`;
      }

      if (typeof onStatusLoaded === "function") {
        onStatusLoaded(data, radarData);
      }
    } catch {
      // Non-fatal telemetry error
    }
  }

  const walletForm = document.getElementById("walletCheckForm");
  if (walletForm && walletInput) {
    walletForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      wallet = walletInput.value.trim();
      if (wallet) localStorage.setItem("kalibr_wallet", wallet);
      else localStorage.removeItem("kalibr_wallet");
      await refreshStatus();
    });
  }

  const copyCaBtn = document.getElementById("copyCaBtn");
  if (copyCaBtn) {
    copyCaBtn.addEventListener("click", async () => {
      const caEl = document.getElementById("caDisplay");
      if (!caEl) return;
      const raw = caEl.textContent.replace(/^\$KALIBR:\s*/i, "").trim();
      await navigator.clipboard.writeText(raw).catch(() => {});
      const prev = caEl.textContent;
      caEl.textContent = "COPIED TO CLIPBOARD ✓";
      setTimeout(() => {
        caEl.textContent = prev;
      }, 1200);
    });
  }

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

  await refreshStatus();
}
