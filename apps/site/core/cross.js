/**
 * Kalshi CFTC Trade API v2 ↔ Polymarket CLOB Cross-Venue Spread & Rule-Mismatch Engine.
 *
 * Zero external dependencies — runs in Browser, Cloudflare Worker, and Node >=20 CLI.
 * Models Kalshi's quadratic taker fee schedule `0.07 * P * (1 - P)` vs Polymarket 0 bps CLOB,
 * and enforces a deterministic Rule-Mismatch Guard before certifying cross-book arbitrage.
 */

import { GAMMA_API_BASE, clamp, safeJsonArray } from "./polymarket.js";

export const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

/**
 * Curated high-liquidity twin event pairs between Kalshi and Polymarket,
 * with outcome-normalizer keys and explicit settlement basis metadata.
 */
export const CROSS_VENUE_SERIES_PAIRS = [
  {
    pairId: "fed-dec-2026",
    domain: { id: "macro", label: "Macro & Fed" },
    kalshiEventTicker: "KXFEDDECISION-26DEC",
    polymarketSlug: "fed-decision-in-december-20260729232808632",
    title: "Fed Interest Rate Decision — December 2026",
    ruleAlignment: "EXACT_PARITY",
    basisNote: "Both venues settle strictly on the official December 2026 FOMC target federal funds rate statement.",
    outcomeMap: [
      { key: "cut_50", label: "Cut 50+ bps", kalshiMatch: /cut\s*>25/i, polyMatch: /50\+\s*bps\s*decrease/i },
      { key: "cut_25", label: "Cut 25 bps", kalshiMatch: /^cut\s*25bps$/i, polyMatch: /^25\s*bps\s*decrease$/i },
      { key: "hold", label: "Maintain Rate (0 bps)", kalshiMatch: /maintains\s*rate/i, polyMatch: /no\s*change/i },
      { key: "hike_25", label: "Hike 25 bps", kalshiMatch: /^hike\s*25bps$/i, polyMatch: /^25\s*bps\s*increase$/i },
      { key: "hike_50", label: "Hike 50+ bps", kalshiMatch: /hike\s*>25/i, polyMatch: /50\+\s*bps\s*increase/i },
    ],
  },
  {
    pairId: "fed-jan-2027",
    domain: { id: "macro", label: "Macro & Fed" },
    kalshiEventTicker: "KXFEDDECISION-27JAN",
    polymarketSlug: "fed-decision-in-january-20260729233815502",
    title: "Fed Interest Rate Decision — January 2027",
    ruleAlignment: "EXACT_PARITY",
    basisNote: "Both venues settle on the official January 2027 FOMC rate target decision.",
    outcomeMap: [
      { key: "cut_50", label: "Cut 50+ bps", kalshiMatch: /cut\s*>25/i, polyMatch: /50\+\s*bps\s*decrease/i },
      { key: "cut_25", label: "Cut 25 bps", kalshiMatch: /^cut\s*25bps$/i, polyMatch: /^25\s*bps\s*decrease$/i },
      { key: "hold", label: "Maintain Rate (0 bps)", kalshiMatch: /maintains\s*rate/i, polyMatch: /no\s*change/i },
      { key: "hike_25", label: "Hike 25 bps", kalshiMatch: /^hike\s*25bps$/i, polyMatch: /^25\s*bps\s*increase$/i },
      { key: "hike_50", label: "Hike 50+ bps", kalshiMatch: /hike\s*>25/i, polyMatch: /50\+\s*bps\s*increase/i },
    ],
  },
  {
    pairId: "us-pres-2028",
    domain: { id: "policy", label: "US & World Policy" },
    kalshiEventTicker: "KXPRESPERSON-28",
    polymarketSlug: "presidential-election-winner-2028",
    title: "2028 U.S. Presidential Election Winner",
    ruleAlignment: "EXACT_PARITY",
    basisNote: "Both settle on the certified winner of the November 2028 U.S. presidential election (minor inauguration vs certification timing nuance <0.2%).",
    dynamicNameMatch: true,
  },
  {
    pairId: "gop-nom-2028",
    domain: { id: "policy", label: "US & World Policy" },
    kalshiEventTicker: "KXPRESNOMR-28",
    polymarketSlug: "republican-presidential-nominee-2028",
    title: "2028 Republican Presidential Nominee",
    ruleAlignment: "EXACT_PARITY",
    basisNote: "Both venues settle on the official 2028 Republican National Convention presidential nominee.",
    dynamicNameMatch: true,
  },
  {
    pairId: "dem-nom-2028",
    domain: { id: "policy", label: "US & World Policy" },
    kalshiEventTicker: "KXPRESNOMD-28",
    polymarketSlug: "democratic-presidential-nominee-2028",
    title: "2028 Democratic Presidential Nominee",
    ruleAlignment: "EXACT_PARITY",
    basisNote: "Both venues settle on the official 2028 Democratic National Convention presidential nominee.",
    dynamicNameMatch: true,
  },
  {
    pairId: "millennium-prize-next",
    domain: { id: "ai", label: "AI & Tech" },
    kalshiEventTicker: "KXMILLENNIUMNEXT-45",
    polymarketSlug: "which-millennium-prize-problem-will-ai-solve-next",
    title: "Next Millennium Prize Problem Solved (AI vs Any Solver)",
    ruleAlignment: "BASIS_MISMATCH",
    basisNote: "RULE MISMATCH TRAP: Polymarket requires an AI model to solve the problem by Dec 31, 2027; Kalshi settles on ANY human or AI proof accepted before 2045.",
    outcomeMap: [
      { key: "riemann", label: "Riemann Hypothesis", kalshiMatch: /riemann/i, polyMatch: /riemann/i },
      { key: "p_vs_np", label: "P versus NP", kalshiMatch: /p\s*versus\s*np/i, polyMatch: /p\s*versus\s*np/i },
      { key: "yang_mills", label: "Yang-Mills Mass Gap", kalshiMatch: /yang/i, polyMatch: /yang/i },
      { key: "bsd", label: "Birch & Swinnerton-Dyer", kalshiMatch: /birch/i, polyMatch: /birch/i },
      { key: "hodge", label: "Hodge Conjecture", kalshiMatch: /hodge/i, polyMatch: /hodge/i },
    ],
  },
];

function normalizePersonKey(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Kalshi quadratic taker fee per $1.00 contract: `0.07 * P * (1 - P)`
 * (Kalshi maker limit orders carry 0.00-0.0175 fee depending on tier; we model full 0.07 quadratic taker fee).
 */
export function estimateKalshiTakerFee(priceProb) {
  const p = clamp(Number(priceProb) || 0.5, 0.005, 0.995);
  return Number((0.07 * p * (1 - p)).toFixed(4));
}

/**
 * Computes executable cross-venue arbitrage, maker arb, directional cheapness, and Rule-Mismatch Guard status.
 */
export function computeCrossVenuePair({
  pairId,
  eventTitle,
  outcomeLabel,
  domain,
  ruleAlignment = "EXACT_PARITY",
  basisNote = "",
  kalshiTicker,
  kalshiEventTicker,
  polymarketSlug,
  polyYesBid,
  polyYesAsk,
  polyVolume24hUsd = 0,
  kalshiYesBid,
  kalshiYesAsk,
  kalshiVolumeUsd = 0,
  polyRulesSnippet = "",
  kalshiRulesSnippet = "",
}) {
  const pBid = clamp(Number(polyYesBid) || 0, 0.001, 0.999);
  const pAsk = clamp(Number(polyYesAsk) || pBid, 0.001, 0.999);
  const kBid = clamp(Number(kalshiYesBid) || 0, 0.001, 0.999);
  const kAsk = clamp(Number(kalshiYesAsk) || kBid, 0.001, 0.999);

  const polyMid = Number(((pBid + pAsk) / 2).toFixed(4));
  const kalshiMid = Number(((kBid + kAsk) / 2).toFixed(4));
  const midGapProb = Number((kalshiMid - polyMid).toFixed(4));
  const midGapBps = Math.round(midGapProb * 10_000);
  const absMidGapBps = Math.abs(midGapBps);

  // Strategy A: Buy YES on Polymarket (@ pAsk) + Buy NO on Kalshi (@ 1 - kBid)
  const kalshiNoAsk = Number((1 - kBid).toFixed(4));
  const grossCostPolyYesKalshiNo = Number((pAsk + kalshiNoAsk).toFixed(4));
  const feeA = estimateKalshiTakerFee(kalshiNoAsk);
  const netCostA = Number((grossCostPolyYesKalshiNo + feeA).toFixed(4));

  // Strategy B: Buy YES on Kalshi (@ kAsk) + Buy NO on Polymarket (@ 1 - pBid)
  const polyNoAsk = Number((1 - pBid).toFixed(4));
  const grossCostKalshiYesPolyNo = Number((kAsk + polyNoAsk).toFixed(4));
  const feeB = estimateKalshiTakerFee(kAsk);
  const netCostB = Number((grossCostKalshiYesPolyNo + feeB).toFixed(4));

  const useA = netCostA <= netCostB;
  const bestRoute = useA ? "BUY_POLY_YES_KALSHI_NO" : "BUY_KALSHI_YES_POLY_NO";
  const bestGrossCost = useA ? grossCostPolyYesKalshiNo : grossCostKalshiYesPolyNo;
  const bestNetCost = useA ? netCostA : netCostB;
  const bestKalshiFee = useA ? feeA : feeB;

  const grossArbBps = Math.round((1.0 - bestGrossCost) * 10_000);
  const netArbBps = Math.round((1.0 - bestNetCost) * 10_000);

  let crossVerdict = "TIGHT_CROSS_PARITY";
  let signalTone = "flat";
  let actionSummary = "Kalshi and Polymarket orderbooks trade within tight execution parity.";

  if (ruleAlignment !== "EXACT_PARITY" && absMidGapBps >= 120) {
    crossVerdict = "BASIS_TRAP_BLOCKED";
    signalTone = "neg";
    actionSummary = `Raw ${(absMidGapBps / 100).toFixed(1)}% spread BLOCKED by Rule-Mismatch Guard — settlement scope differs across venues.`;
  } else if (ruleAlignment === "EXACT_PARITY" && netArbBps >= 15) {
    crossVerdict = "EXECUTABLE_NET_ARB";
    signalTone = "pos";
    actionSummary =
      bestRoute === "BUY_POLY_YES_KALSHI_NO"
        ? `Buy Poly YES (${(pAsk * 100).toFixed(1)}¢) + Kalshi NO (${(kalshiNoAsk * 100).toFixed(1)}¢) + ${(bestKalshiFee * 100).toFixed(2)}¢ fee = ${(bestNetCost * 100).toFixed(2)}¢ for $1.00 (+${(netArbBps / 100).toFixed(2)}% net arb).`
        : `Buy Kalshi YES (${(kAsk * 100).toFixed(1)}¢) + Poly NO (${(polyNoAsk * 100).toFixed(1)}¢) + ${(bestKalshiFee * 100).toFixed(2)}¢ fee = ${(bestNetCost * 100).toFixed(2)}¢ for $1.00 (+${(netArbBps / 100).toFixed(2)}% net arb).`;
  } else if (ruleAlignment === "EXACT_PARITY" && grossArbBps >= 15) {
    crossVerdict = "MAKER_LIMIT_ARB";
    signalTone = "pos";
    actionSummary = `Gross complete-set cost is ${(bestGrossCost * 100).toFixed(2)}¢ (+${(grossArbBps / 100).toFixed(2)}% maker arb when posting 0¢-fee limit order on Kalshi).`;
  } else if (absMidGapBps >= 120) {
    crossVerdict = "VENUE_PRICE_ROUTING";
    signalTone = "info";
    const cheaperYes = polyMid < kalshiMid ? "Polymarket" : "Kalshi";
    actionSummary = `Directional routing edge: YES trades ${(absMidGapBps / 100).toFixed(1)}% cheaper on ${cheaperYes} (${(Math.min(polyMid, kalshiMid) * 100).toFixed(1)}¢ vs ${(Math.max(polyMid, kalshiMid) * 100).toFixed(1)}¢).`;
  }

  return {
    id: `${pairId}:${normalizePersonKey(outcomeLabel).replace(/\s+/g, "-")}`,
    pairId,
    eventTitle,
    outcomeLabel,
    domain,
    ruleAlignment,
    basisNote,
    kalshiTicker,
    kalshiEventTicker,
    kalshiUrl: `https://kalshi.com/markets/${String(kalshiEventTicker || "").split("-")[0].toLowerCase()}`,
    polymarketSlug,
    polymarketUrl: `https://polymarket.com/event/${polymarketSlug}`,
    polyYesBid: pBid,
    polyYesAsk: pAsk,
    polyMid,
    kalshiYesBid: kBid,
    kalshiYesAsk: kAsk,
    kalshiMid,
    kalshiNoAsk,
    polyNoAsk,
    midGapBps,
    absMidGapBps,
    bestRoute,
    bestGrossCost,
    bestKalshiFee,
    bestNetCost,
    grossArbBps,
    netArbBps,
    crossVerdict,
    signalTone,
    actionSummary,
    polyVolume24hUsd: Math.round(polyVolume24hUsd),
    kalshiVolumeUsd: Math.round(kalshiVolumeUsd),
    polyRulesSnippet,
    kalshiRulesSnippet,
  };
}

/**
 * Fetches live orderbooks from BOTH Kalshi Trade API v2 and Polymarket Gamma API in parallel,
 * pairing outcomes and sorting executable cross-venue arbs & basis traps to the top.
 */
export async function fetchCrossVenueRadar({ limit = 28, filter = "all", fetchImpl = fetch } = {}) {
  const pairTasks = CROSS_VENUE_SERIES_PAIRS.map(async (spec) => {
    try {
      const [kRes, pRes] = await Promise.all([
        fetchImpl(`${KALSHI_API_BASE}/events/${encodeURIComponent(spec.kalshiEventTicker)}?with_nested_markets=true`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        }),
        fetchImpl(`${GAMMA_API_BASE}/events?slug=${encodeURIComponent(spec.polymarketSlug)}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        }),
      ]);
      if (!kRes.ok || !pRes.ok) return [];
      const kData = await kRes.json();
      const pArr = await pRes.json();
      const kEvent = kData?.event;
      const pEvent = Array.isArray(pArr) ? pArr[0] : null;
      if (!kEvent || !pEvent) return [];

      const kMarkets = (kEvent.markets || []).filter((m) => m && m.status === "active");
      const pMarkets = (pEvent.markets || []).filter((m) => m && m.closed !== true && m.active !== false);
      const matchedRows = [];

      if (spec.dynamicNameMatch) {
        const kByName = new Map();
        for (const km of kMarkets) {
          const nm = normalizePersonKey(km.yes_sub_title || km.subtitle || km.title);
          if (nm) kByName.set(nm, km);
        }

        for (const pm of pMarkets) {
          const label = pm.groupItemTitle || pm.question || "";
          const nm = normalizePersonKey(label);
          const km = kByName.get(nm);
          if (!km) continue;

          const pPrices = safeJsonArray(pm.outcomePrices).map(Number);
          const pAsk = Number(pm.bestAsk) > 0 ? Number(pm.bestAsk) : pPrices[0] || 0;
          const pBid = Number(pm.bestBid) > 0 ? Number(pm.bestBid) : Math.max(0.001, pAsk - 0.005);
          const kBid = Number(km.yes_bid_dollars || 0);
          const kAsk = Number(km.yes_ask_dollars || 0);
          if (pAsk < 0.015 && kAsk < 0.015) continue;
          if (kAsk <= 0 || pAsk <= 0) continue;

          matchedRows.push(
            computeCrossVenuePair({
              pairId: spec.pairId,
              eventTitle: spec.title,
              outcomeLabel: label,
              domain: spec.domain,
              ruleAlignment: spec.ruleAlignment,
              basisNote: spec.basisNote,
              kalshiTicker: km.ticker,
              kalshiEventTicker: spec.kalshiEventTicker,
              polymarketSlug: spec.polymarketSlug,
              polyYesBid: pBid,
              polyYesAsk: pAsk,
              polyVolume24hUsd: Number(pm.volume24hr || pEvent.volume24hr || 0),
              kalshiYesBid: kBid,
              kalshiYesAsk: kAsk,
              kalshiVolumeUsd: Number(km.volume_fp || km.open_interest_fp || 0),
              polyRulesSnippet: String(pm.description || pEvent.description || "").slice(0, 260),
              kalshiRulesSnippet: String(km.rules_primary || "").slice(0, 260),
            })
          );
        }
      } else {
        for (const om of spec.outcomeMap || []) {
          const km = kMarkets.find((m) => om.kalshiMatch.test(String(m.yes_sub_title || m.subtitle || m.title || "")));
          const pm = pMarkets.find((m) => om.polyMatch.test(String(m.groupItemTitle || m.question || "")));
          if (!km || !pm) continue;

          const pPrices = safeJsonArray(pm.outcomePrices).map(Number);
          const pAsk = Number(pm.bestAsk) > 0 ? Number(pm.bestAsk) : pPrices[0] || 0;
          const pBid = Number(pm.bestBid) > 0 ? Number(pm.bestBid) : Math.max(0.001, pAsk - 0.005);
          const kBid = Number(km.yes_bid_dollars || 0);
          const kAsk = Number(km.yes_ask_dollars || 0);
          if (pAsk < 0.01 && kAsk < 0.01) continue;
          if (kAsk <= 0 || pAsk <= 0) continue;

          matchedRows.push(
            computeCrossVenuePair({
              pairId: spec.pairId,
              eventTitle: spec.title,
              outcomeLabel: om.label,
              domain: spec.domain,
              ruleAlignment: spec.ruleAlignment,
              basisNote: spec.basisNote,
              kalshiTicker: km.ticker,
              kalshiEventTicker: spec.kalshiEventTicker,
              polymarketSlug: spec.polymarketSlug,
              polyYesBid: pBid,
              polyYesAsk: pAsk,
              polyVolume24hUsd: Number(pm.volume24hr || pEvent.volume24hr || 0),
              kalshiYesBid: kBid,
              kalshiYesAsk: kAsk,
              kalshiVolumeUsd: Number(km.volume_fp || km.open_interest_fp || 0),
              polyRulesSnippet: String(pm.description || pEvent.description || "").slice(0, 260),
              kalshiRulesSnippet: String(km.rules_primary || "").slice(0, 260),
            })
          );
        }
      }

      return matchedRows;
    } catch {
      return [];
    }
  });

  const nested = await Promise.all(pairTasks);
  let all = nested.flat();

  if (filter === "arb") {
    all = all.filter((r) => r.crossVerdict === "EXECUTABLE_NET_ARB" || r.crossVerdict === "MAKER_LIMIT_ARB");
  } else if (filter === "basis") {
    all = all.filter((r) => r.crossVerdict === "BASIS_TRAP_BLOCKED");
  } else if (filter === "routing") {
    all = all.filter((r) => r.crossVerdict === "VENUE_PRICE_ROUTING");
  }

  const rank = (v) => {
    if (v === "EXECUTABLE_NET_ARB") return 5;
    if (v === "MAKER_LIMIT_ARB") return 4;
    if (v === "BASIS_TRAP_BLOCKED") return 3;
    if (v === "VENUE_PRICE_ROUTING") return 2;
    return 1;
  };

  all.sort((a, b) => {
    const rw = rank(b.crossVerdict) - rank(a.crossVerdict);
    if (rw !== 0) return rw;
    if (a.crossVerdict === "EXECUTABLE_NET_ARB" || a.crossVerdict === "MAKER_LIMIT_ARB") {
      return b.grossArbBps - a.grossArbBps;
    }
    return b.absMidGapBps - a.absMidGapBps;
  });

  if (filter === "all") {
    const perPair = new Map();
    all = all.filter((row) => {
      const n = perPair.get(row.pairId) || 0;
      if (n >= 5) return false;
      perPair.set(row.pairId, n + 1);
      return true;
    });
  }

  return all.slice(0, limit);
}
