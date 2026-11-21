/**
 * Deterministic Canonical Forecast Leaf & Sorted-Pair Keccak-256 Merkle Tree.
 *
 * Matches `ForecastSealRegistry.sol` on Robinhood Chain (4663) byte-for-byte:
 *  - Leaf hash: keccak256(utf8("kalibr:forecast:v1:" + canonicalJson(record)))
 *  - Internal node: keccak256(abi.encodePacked(min(a, b), max(a, b)))
 */

import { keccak256, hexToBytes } from "./keccak.js";

export const LEAF_DOMAIN_PREFIX = "kalibr:forecast:v1:";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") +
    "}"
  );
}

export function normalizeForecastLeaf(raw) {
  return {
    epochHour: Math.floor(Number(raw.epochHour)),
    chainId: Number(raw.chainId ?? 4663),
    marketId: String(raw.marketId || ""),
    eventSlug: String(raw.eventSlug || "").toLowerCase(),
    question: String(raw.question || "").trim(),
    crowdProbBps: Math.round(Number(raw.crowdProbBps ?? 0)),
    fairProbBps: Math.round(Number(raw.fairProbBps ?? 0)),
    edgeBps: Math.round(Number(raw.edgeBps ?? 0)),
    direction: String(raw.direction || "NO_EDGE"),
    confidenceBps: Math.round(Number(raw.confidenceBps ?? 0)),
    modelSource: String(raw.modelSource || "actuarial-v1"),
  };
}

export function hashForecastLeaf(record) {
  const normalized = normalizeForecastLeaf(record);
  const canonical = LEAF_DOMAIN_PREFIX + canonicalJson(normalized);
  return {
    normalized,
    canonical,
    leafHash: keccak256(canonical).toLowerCase(),
  };
}

export function hashSortedPair(hexA, hexB) {
  const a = hexA.toLowerCase();
  const b = hexB.toLowerCase();
  const [first, second] = a <= b ? [a, b] : [b, a];
  const bytesA = hexToBytes(first);
  const bytesB = hexToBytes(second);
  const combined = new Uint8Array(64);
  combined.set(bytesA, 0);
  combined.set(bytesB, 32);
  return keccak256(combined).toLowerCase();
}

export function buildMerkleTree(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("buildMerkleTree requires at least 1 forecast leaf");
  }

  const prepared = items
    .map((item) => {
      if (typeof item === "string" && /^0x[0-9a-fA-F]{64}$/.test(item)) {
        return { leafHash: item.toLowerCase(), normalized: null, canonical: null };
      }
      return hashForecastLeaf(item);
    })
    .sort((a, b) => (a.leafHash < b.leafHash ? -1 : a.leafHash > b.leafHash ? 1 : 0))
    .map((entry, index) => ({ ...entry, index }));

  const layers = [prepared.map((p) => p.leafHash)];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i];
      const right = i + 1 < cur.length ? cur[i + 1] : cur[i];
      next.push(hashSortedPair(left, right));
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];

  function getProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= prepared.length) {
      throw new RangeError(`Leaf index out of range: ${leafIndex}`);
    }
    const proof = [];
    let idx = leafIndex;
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level];
      const pairIdx = idx % 2 === 0 ? (idx + 1 < layer.length ? idx + 1 : idx) : idx - 1;
      proof.push(layer[pairIdx]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return {
    root,
    leaves: prepared.map((p, idx) => ({
      ...p,
      proof: getProof(idx),
    })),
    layers,
    getProof,
  };
}

export function verifyMerkleProof(leafOrHash, proof, expectedRoot) {
  if (!expectedRoot || !/^0x[0-9a-fA-F]{64}$/.test(expectedRoot)) return false;
  let computed =
    typeof leafOrHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(leafOrHash)
      ? leafOrHash.toLowerCase()
      : hashForecastLeaf(leafOrHash).leafHash;

  for (const sibling of proof || []) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(sibling)) return false;
    computed = hashSortedPair(computed, sibling.toLowerCase());
  }
  return computed === expectedRoot.toLowerCase();
}
