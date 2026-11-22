import { initSharedSpine, esc } from "./spine.js";

document.getElementById("burnVerifyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const txHash = document.getElementById("burnTxInput").value.trim();
  const out = document.getElementById("burnVerifyResult");
  const btn = document.getElementById("burnVerifyBtn");
  if (!txHash) return;

  btn.disabled = true;
  btn.textContent = "Verifying Receipt…";
  out.textContent = "Reading onchain Transfer / ERC20.burn logs…";

  try {
    const res = await fetch("/v1/burns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Burn verification failed");
    localStorage.setItem("kalibr_wallet", data.burner);
    const walletInput = document.getElementById("walletInput");
    if (walletInput) walletInput.value = data.burner;

    out.innerHTML = `<div class="proof-banner ok" style="margin-top:8px;">✓ VERIFIED ONCHAIN BURN: ${Number(data.burnedTokens).toLocaleString()} $KALIBR burned in block #${Number(data.blockNumber).toLocaleString()} by ${esc(data.burner)}. Syndicate tier unlocked for 7 days!</div>`;
    await initSharedSpine();
  } catch (err) {
    out.innerHTML = `<div class="proof-banner fail" style="margin-top:8px;">✗ ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify Burn Receipt";
  }
});

initSharedSpine();
