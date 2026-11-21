/**
 * Zero-dependency Robinhood Chain (4663) JSON-RPC Reader.
 * Reads block height, ForecastSealRegistry seals, read-only ERC-20 balanceOf tiers,
 * and 0x...dEaD burn transaction receipts without requiring any wallet connection.
 */

import { functionSelector } from "./keccak.js";

export const ROBINHOOD_CHAIN_ID = 4663;
export const DEFAULT_RH_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const DEAD_BURN_ADDRESS = "0x000000000000000000000000000000000000dead";
export const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const SEL_BALANCE_OF = functionSelector("balanceOf(address)");
const SEL_GET_SEAL = functionSelector("getSeal(uint64)");
const SEL_LATEST_EPOCH = functionSelector("latestEpoch()");
const SEL_TOTAL_EPOCHS = functionSelector("totalEpochsSealed()");

export function isValidEvmAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

function padAddressWord(addr) {
  return addr.trim().toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function padUint64Word(num) {
  return BigInt(num).toString(16).padStart(64, "0");
}

export async function rpcCall(method, params = [], { rpcUrl = DEFAULT_RH_RPC_URL, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`Robinhood Chain RPC HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "RPC error");
  return data.result;
}

export async function getChainHead({ rpcUrl = DEFAULT_RH_RPC_URL, fetchImpl = fetch } = {}) {
  const hex = await rpcCall("eth_blockNumber", [], { rpcUrl, fetchImpl });
  return parseInt(hex, 16);
}

export async function readErc20Balance(tokenAddress, walletAddress, opts = {}) {
  if (!isValidEvmAddress(tokenAddress) || !isValidEvmAddress(walletAddress)) return 0n;
  const data = SEL_BALANCE_OF + padAddressWord(walletAddress);
  const hex = await rpcCall("eth_call", [{ to: tokenAddress, data }, "latest"], opts);
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

export async function resolveHolderTier(
  walletAddress,
  {
    tokenAddress = "",
    holdForecaster = 1_000_000n,
    holdSyndicate = 5_000_000n,
    decimals = 18,
    rpcUrl = DEFAULT_RH_RPC_URL,
    fetchImpl = fetch,
  } = {}
) {
  if (!isValidEvmAddress(walletAddress)) {
    return { tier: "visitor", tierLevel: 0, balanceTokens: 0, wallet: null };
  }
  const cleanWallet = walletAddress.trim().toLowerCase();
  if (!isValidEvmAddress(tokenAddress)) {
    return { tier: "visitor", tierLevel: 0, balanceTokens: 0, wallet: cleanWallet, tokenPending: true };
  }

  const rawBal = await readErc20Balance(tokenAddress, cleanWallet, { rpcUrl, fetchImpl });
  const unit = 10n ** BigInt(decimals);
  const wholeTokens = Number(rawBal / unit);

  if (rawBal >= holdSyndicate * unit) {
    return { tier: "syndicate", tierLevel: 2, balanceTokens: wholeTokens, wallet: cleanWallet };
  }
  if (rawBal >= holdForecaster * unit) {
    return { tier: "forecaster", tierLevel: 1, balanceTokens: wholeTokens, wallet: cleanWallet };
  }
  return { tier: "visitor", tierLevel: 0, balanceTokens: wholeTokens, wallet: cleanWallet };
}

export async function readOnchainEpochSeal(registryAddress, epochHour, opts = {}) {
  if (!isValidEvmAddress(registryAddress)) return null;
  const data = SEL_GET_SEAL + padUint64Word(epochHour);
  const hex = await rpcCall("eth_call", [{ to: registryAddress, data }, "latest"], opts);
  if (!hex || hex.length < 2 + 64 * 4) return null;
  const body = hex.slice(2);
  const merkleRoot = "0x" + body.slice(0, 64).toLowerCase();
  const sealedAt = Number(BigInt("0x" + body.slice(64, 128)));
  const marketCount = Number(BigInt("0x" + body.slice(128, 192)));
  const mispricedCount = Number(BigInt("0x" + body.slice(192, 256)));
  if (sealedAt === 0) return null;
  return { epochHour: Number(epochHour), merkleRoot, sealedAt, marketCount, mispricedCount };
}

export async function readRegistryStats(registryAddress, opts = {}) {
  if (!isValidEvmAddress(registryAddress)) {
    return { configured: false, latestEpoch: 0, totalEpochsSealed: 0 };
  }
  const [latestHex, totalHex] = await Promise.all([
    rpcCall("eth_call", [{ to: registryAddress, data: SEL_LATEST_EPOCH }, "latest"], opts),
    rpcCall("eth_call", [{ to: registryAddress, data: SEL_TOTAL_EPOCHS }, "latest"], opts),
  ]);
  return {
    configured: true,
    registryAddress,
    latestEpoch: latestHex && latestHex !== "0x" ? Number(BigInt(latestHex)) : 0,
    totalEpochsSealed: totalHex && totalHex !== "0x" ? Number(BigInt(totalHex)) : 0,
  };
}

/**
 * Verifies a non-custodial ERC-20 transfer to 0x000...dEaD on Robinhood Chain (4663)
 * for Priority Seal queue-jumping (zero contract approvals, zero custody).
 */
export async function verifyDeadBurnTx(
  txHash,
  { tokenAddress = "", minBurnTokens = 100_000n, decimals = 18, rpcUrl = DEFAULT_RH_RPC_URL, fetchImpl = fetch } = {}
) {
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) {
    throw new Error("Invalid Robinhood Chain transaction hash.");
  }
  if (!isValidEvmAddress(tokenAddress)) {
    throw new Error("$KALIBR token address is not bound yet.");
  }

  const receipt = await rpcCall("eth_getTransactionReceipt", [txHash.trim()], { rpcUrl, fetchImpl });
  if (!receipt || receipt.status !== "0x1") {
    throw new Error("Transaction not confirmed or reverted on Robinhood Chain (4663).");
  }

  const targetToken = tokenAddress.toLowerCase();
  const deadWord = padAddressWord(DEAD_BURN_ADDRESS);
  let burnedRaw = 0n;
  let sender = receipt.from ? receipt.from.toLowerCase() : null;

  for (const log of receipt.logs || []) {
    if ((log.address || "").toLowerCase() !== targetToken) continue;
    const topics = log.topics || [];
    if ((topics[0] || "").toLowerCase() !== TRANSFER_TOPIC0) continue;
    const toWord = (topics[2] || "").toLowerCase().replace(/^0x/, "");
    if (toWord === deadWord || toWord === "0".repeat(64)) {
      burnedRaw += BigInt(log.data || "0x0");
      if (topics[1]) sender = "0x" + topics[1].slice(-40).toLowerCase();
    }
  }

  const minRaw = minBurnTokens * 10n ** BigInt(decimals);
  if (burnedRaw < minRaw) {
    throw new Error(`Burn transfer below required ${minBurnTokens.toString()} $KALIBR threshold.`);
  }

  return {
    verified: true,
    txHash: txHash.trim().toLowerCase(),
    burner: sender,
    burnedTokens: Number(burnedRaw / 10n ** BigInt(decimals)),
    blockNumber: parseInt(receipt.blockNumber, 16),
  };
}
