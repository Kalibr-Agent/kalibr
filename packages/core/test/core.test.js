import test from "node:test";
import assert from "node:assert/strict";
import {
  keccak256,
  buildMerkleTree,
  verifyMerkleProof,
  hashForecastLeaf,
  parsePolymarketQuery,
  calibrateMarket,
  computeKellySizing,
  analyzeNegRiskEvent,
  scoreContractTrapRisk,
  computePortfolioKellySlate,
  computeCrossVenuePair,
  verifyVerbatimFigures,
  computeBrierScore,
} from "../src/index.js";

test("Keccak-256 matches canonical Ethereum test vector", () => {
  assert.equal(
    keccak256(""),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  );
  assert.equal(
    keccak256("abc"),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
  );
});

test("Sorted-pair Merkle tree verifies valid proofs and rejects 1-bps tampering", () => {
  const sampleLeaves = [
    {
      epochHour: 1763740800,
      chainId: 4663,
      marketId: "m-fed-25",
      eventSlug: "fed-decision-in-december",
      question: "Will the Fed cut rates by 25 bps in December?",
      crowdProbBps: 5800,
      fairProbBps: 7150,
      edgeBps: 1350,
      direction: "BUY_YES",
      confidenceBps: 8100,
      modelSource: "kalibr-openai-3agent",
    },
    {
      epochHour: 1763740800,
      chainId: 4663,
      marketId: "m-ai-gpt",
      eventSlug: "openai-next-frontier-release",
      question: "Will OpenAI ship its next frontier model before Q1?",
      crowdProbBps: 7400,
      fairProbBps: 5900,
      edgeBps: -1500,
      direction: "BUY_NO",
      confidenceBps: 7700,
      modelSource: "kalibr-openai-3agent",
    },
    {
      epochHour: 1763740800,
      chainId: 4663,
      marketId: "m-btc-120k",
      eventSlug: "bitcoin-above-120k",
      question: "Will Bitcoin trade above $120,000 before year-end?",
      crowdProbBps: 4200,
      fairProbBps: 4320,
      edgeBps: 120,
      direction: "NO_EDGE",
      confidenceBps: 8400,
      modelSource: "kalibr-actuarial-v1",
    },
  ];

  const tree = buildMerkleTree(sampleLeaves);
  assert.match(tree.root, /^0x[0-9a-f]{64}$/);

  for (const entry of tree.leaves) {
    assert.equal(verifyMerkleProof(entry.normalized, entry.proof, tree.root), true);
    const tampered = { ...entry.normalized, fairProbBps: entry.normalized.fairProbBps + 1 };
    assert.equal(verifyMerkleProof(tampered, entry.proof, tree.root), false);
    assert.notEqual(hashForecastLeaf(tampered).leafHash, entry.leafHash);
  }
});

test("Polymarket URL parser, actuarial calibrator, rule traps, and verbatim verifier work deterministically", () => {
  const parsed = parsePolymarketQuery("https://polymarket.com/event/fed-decision-in-december?tid=123");
  assert.equal(parsed.type, "slug");
  assert.equal(parsed.slug, "fed-decision-in-december");

  const syntheticEvent = {
    id: "ev-1",
    slug: "openai-model-release",
    title: "OpenAI Frontier Release Window",
    tags: [{ slug: "ai", label: "AI" }],
    markets: [
      {
        id: "mkt-1",
        slug: "openai-model-release",
        question: "Will OpenAI publicly release GPT-6 general availability by December 31, 2026?",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.76", "0.24"]',
        bestBid: 0.75,
        bestAsk: 0.79,
        spread: 0.04,
        volume24hr: 480000,
        liquidityNum: 195000,
        oneDayPriceChange: -0.11,
        endDate: new Date(Date.now() + 220 * 86_400_000).toISOString(),
        description:
          "This market resolves YES only upon general availability public release, not an official announcement or preview, by 11:59 PM ET based on consensus of credible reporting.",
      },
    ],
  };

  const cal = calibrateMarket(syntheticEvent);
  assert.ok(cal);
  assert.equal(cal.domain.id, "ai");
  assert.ok(cal.fairProb > cal.crowdProb, "Favorite after -11% impulse shock + long lockup should calibrate higher");
  assert.ok(cal.ruleTraps.some((t) => t.code === "ANNOUNCEMENT_VS_RELEASE"));
  assert.ok(cal.ruleTraps.some((t) => t.code === "SUBJECTIVE_UMA_CONSENSUS"));
  assert.ok(cal.ruleTraps.some((t) => t.code === "WIDE_CLOB_SPREAD"));

  const kelly = computeKellySizing({ fairProb: 0.82, crowdProb: 0.72, spread: 0.02, bankrollUsd: 2000 });
  assert.equal(kelly.side, "YES");
  assert.ok(kelly.recommendedStakeUsd > 0);

  const ver = verifyVerbatimFigures(["Crowd price is 76.0% on $480,000 24h volume", "Fake volume $99,999,999"], cal);
  assert.equal(ver.checks[0].verified, true);
  assert.equal(ver.checks[1].verified, false);

  const brier = computeBrierScore([
    { fairProb: 0.8, crowdProb: 0.6, outcome: 1 },
    { fairProb: 0.2, crowdProb: 0.45, outcome: 0 },
  ]);
  assert.ok(brier.kalibrBrier < brier.crowdBrier);
  assert.ok(brier.skillImprovementPct > 50);
});

test("NegRisk parity analyzer, trap scorer, and multi-leg correlation Kelly slate work deterministically", () => {
  const closedNegRisk = {
    id: "ev-fed",
    slug: "fed-december-rates",
    title: "Fed December Rate Decision",
    negRisk: true,
    negRiskAugmented: false,
    volume24hr: 950000,
    liquidity: 420000,
    tags: [{ slug: "macro", label: "Macro" }],
    markets: [
      { id: "m1", groupItemTitle: "25 bps cut", outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', bestBid: 0.61, bestAsk: 0.62 },
      { id: "m2", groupItemTitle: "No change", outcomes: '["Yes","No"]', outcomePrices: '["0.31","0.69"]', bestBid: 0.30, bestAsk: 0.31 },
      { id: "m3", groupItemTitle: "50 bps cut", outcomes: '["Yes","No"]', outcomePrices: '["0.06","0.94"]', bestBid: 0.05, bestAsk: 0.06 },
    ],
  };

  const arb = analyzeNegRiskEvent(closedNegRisk);
  assert.ok(arb);
  assert.equal(arb.partitionType, "CLOSED_PARTITION");
  assert.equal(arb.arbVerdict, "DUTCH_BOOK_ASK_ARB");
  assert.ok(arb.dutchBookAskEdgeBps > 0);

  const slate = computePortfolioKellySlate(
    [
      { marketId: "1", eventSlug: "fed-1", question: "Fed Cut?", polymarketUrl: "https://polymarket.com", domain: { id: "macro", label: "Macro" }, crowdProb: 0.50, fairProb: 0.64, edgeBps: 1400, spread: 0.01 },
      { marketId: "2", eventSlug: "cpi-2", question: "CPI < 2.6%?", polymarketUrl: "https://polymarket.com", domain: { id: "macro", label: "Macro" }, crowdProb: 0.45, fairProb: 0.58, edgeBps: 1300, spread: 0.01 },
    ],
    { bankrollUsd: 4000, maxTotalAllocationPct: 0.55 }
  );
  assert.equal(slate.legCount, 2);
  assert.ok(slate.allocations[0].correlationHaircut < 1.0, "Same-domain legs receive 1/sqrt(k) correlation haircut");
  assert.ok(slate.totalAllocatedUsd > 0 && slate.totalAllocatedUsd <= 2200);

  const trapInfo = scoreContractTrapRisk({
    ruleTraps: [
      { code: "THIN_ORDERBOOK_DEPTH", severity: "HIGH" },
      { code: "SUBJECTIVE_UMA_CONSENSUS", severity: "MEDIUM" },
    ],
  });
  assert.equal(trapInfo.trapVerdict, "HIGH_DISPUTE_RISK");
  assert.ok(trapInfo.trapRiskScore >= 50);

  const exactArb = computeCrossVenuePair({
    pairId: "gop-nom-2028",
    eventTitle: "2028 Republican Nominee",
    outcomeLabel: "Marco Rubio",
    domain: { id: "policy", label: "Policy" },
    ruleAlignment: "EXACT_PARITY",
    kalshiTicker: "KXPRESNOMR-28-MRUB",
    kalshiEventTicker: "KXPRESNOMR-28",
    polymarketSlug: "republican-presidential-nominee-2028",
    polyYesBid: 0.19,
    polyYesAsk: 0.191,
    kalshiYesBid: 0.24,
    kalshiYesAsk: 0.25,
  });
  assert.equal(exactArb.crossVerdict, "EXECUTABLE_NET_ARB");
  assert.ok(exactArb.netArbBps > 300);

  const blockedBasis = computeCrossVenuePair({
    pairId: "millennium-prize-next",
    eventTitle: "Next Millennium Prize",
    outcomeLabel: "Riemann Hypothesis",
    domain: { id: "ai", label: "AI & Tech" },
    ruleAlignment: "BASIS_MISMATCH",
    kalshiTicker: "KXMILLENNIUMNEXT-45-RH",
    kalshiEventTicker: "KXMILLENNIUMNEXT-45",
    polymarketSlug: "which-millennium-prize-problem-will-ai-solve-next",
    polyYesBid: 0.77,
    polyYesAsk: 0.771,
    kalshiYesBid: 0.94,
    kalshiYesAsk: 0.95,
  });
  assert.equal(blockedBasis.crossVerdict, "BASIS_TRAP_BLOCKED");
});
