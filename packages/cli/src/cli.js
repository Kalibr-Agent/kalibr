import { core } from "./core-bridge.js";
import { runInit } from "./init.js";
import { startStdioMcp } from "./mcp.js";

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fmtEdge(bps) {
  const pct = (bps / 100).toFixed(1);
  return bps >= 0 ? `+${pct}%` : `${pct}%`;
}

export async function runCli(argv, io = { log: console.log }) {
  const { positional, flags } = parseFlags(argv);
  const cmd = positional[0] || "help";

  if (cmd === "mcp") {
    startStdioMcp();
    return;
  }

  if (cmd === "scan") {
    const query = positional.slice(1).join(" ").trim();
    if (!query) throw new Error('Usage: kalibr scan "<polymarket-url-or-question>" [--bankroll 1000] [--json]');
    const res = await core.resolveAndCalibratePolymarket(query);
    const m = res.market;
    const bankroll = Number(flags.bankroll || 1000);
    const kelly = core.computeKellySizing({
      fairProb: m.fairProb,
      crowdProb: m.crowdProb,
      spread: m.spread,
      bankrollUsd: bankroll,
    });

    if (flags.json) {
      io.log(JSON.stringify({ ...res, market: { ...m, kelly } }, null, 2));
      return;
    }

    io.log(`\nKALIBR ACTUARIAL CALIBRATION · ${m.domain.label.toUpperCase()}`);
    io.log(`Contract  : ${m.question}`);
    io.log(`URL       : ${m.polymarketUrl}`);
    io.log(`Crowd YES : ${(m.crowdProb * 100).toFixed(1)}%  |  KALIBR Fair : ${(m.fairProb * 100).toFixed(1)}%  |  Edge : ${fmtEdge(m.edgeBps)}`);
    io.log(`Verdict   : ${m.verdictCode} (${m.direction}) · Confidence ${Math.round(m.confidence * 100)}%`);
    io.log(`1/4 Kelly : $${kelly.recommendedStakeUsd} on $${bankroll} bankroll (${kelly.side} @ ${(kelly.entryPrice * 100).toFixed(1)}¢ · EV $${kelly.evPer100Usd}/$100)`);
    io.log(`Book      : 24h Vol $${m.volume24hUsd.toLocaleString()} · Depth $${m.liquidityUsd.toLocaleString()} · Spread ${(m.spread * 100).toFixed(1)}¢`);
    if (m.ruleTraps.length > 0) {
      io.log(`Rule Flags:`);
      for (const t of m.ruleTraps) {
        io.log(`  - [${t.severity}] ${t.title}: ${t.detail}`);
      }
    }
    return;
  }

  if (cmd === "radar") {
    const domain = String(flags.domain || "all");
    const limit = Number(flags.limit || 10);
    const markets = await core.fetchCuratedPolymarketRadar({ domainFilter: domain, limit });
    if (flags.json) {
      io.log(JSON.stringify(markets, null, 2));
      return;
    }
    io.log(`\nKALIBR LIVE MISPRICING RADAR (${domain.toUpperCase()} · ${markets.length} EVENTS)\n`);
    for (const m of markets) {
      io.log(
        `[${m.verdictCode.padEnd(13)}] Crowd ${(m.crowdProb * 100).toFixed(1).padStart(5)}% -> Fair ${(m.fairProb * 100).toFixed(1).padStart(5)}% (${fmtEdge(m.edgeBps).padStart(6)}) | ${m.question.slice(0, 68)}`
      );
    }
    return;
  }

  if (cmd === "arb") {
    const mode = String(flags.mode || "all");
    const limit = Number(flags.limit || 12);
    const books = await core.fetchNegRiskArbRadar({ mode, limit });
    if (flags.json) {
      io.log(JSON.stringify(books, null, 2));
      return;
    }
    io.log(`\nKALIBR NEGRISK & SUM-OF-ODDS SCANNER (${mode.toUpperCase()} · ${books.length} BOOKS)\n`);
    for (const b of books) {
      io.log(
        `[${b.arbVerdict.padEnd(20)}] Mid ${(b.sumMidProb * 100).toFixed(1).padStart(6)}% | Ask ${(b.sumBestAsk * 100).toFixed(1).padStart(6)}¢ | Bid ${(b.sumBestBid * 100).toFixed(1).padStart(6)}¢ | ${b.eventTitle.slice(0, 56)}`
      );
    }
    return;
  }

  if (cmd === "traps") {
    const domain = String(flags.domain || "all");
    const limit = Number(flags.limit || 12);
    const contracts = await core.fetchResolutionTrapRadar({ domainFilter: domain, limit });
    if (flags.json) {
      io.log(JSON.stringify(contracts, null, 2));
      return;
    }
    io.log(`\nKALIBR RESOLUTION FINE-PRINT & UMA TRAP RADAR (${contracts.length} CONTRACTS)\n`);
    for (const c of contracts) {
      io.log(
        `[${c.trapVerdict.padEnd(18)} ${String(c.trapRiskScore).padStart(2)}/100] ${c.trapCount} flags | ${c.question.slice(0, 64)}`
      );
    }
    return;
  }

  if (cmd === "cross") {
    const filter = String(flags.filter || "all");
    const limit = Number(flags.limit || 14);
    const pairs = await core.fetchCrossVenueRadar({ filter, limit });
    if (flags.json) {
      io.log(JSON.stringify(pairs, null, 2));
      return;
    }
    io.log(`\nKALIBR KALSHI <-> POLYMARKET CROSS-VENUE DESK (${pairs.length} PAIRS)\n`);
    for (const p of pairs) {
      io.log(
        `[${p.crossVerdict.padEnd(20)}] Poly ${(p.polyYesAsk * 100).toFixed(1).padStart(5)}¢ vs Kalshi ${(p.kalshiYesBid * 100).toFixed(1).padStart(5)}¢ | net ${(p.netArbBps / 100).toFixed(2)}% | ${p.outcomeLabel} (${p.eventTitle.slice(0, 34)})`
      );
    }
    return;
  }

  if (cmd === "verify") {
    const registry = String(flags.registry || "");
    const epoch = Number(positional[1] || flags.epoch || 0);
    if (!registry || !epoch) {
      throw new Error("Usage: kalibr verify <epochHour> --registry 0xForecastSealRegistry");
    }
    const seal = await core.readOnchainEpochSeal(registry, epoch);
    io.log(JSON.stringify({ found: Boolean(seal), seal }, null, 2));
    return;
  }

  if (cmd === "init") {
    const results = runInit({ dryRun: Boolean(flags["dry-run"]) });
    for (const r of results) {
      io.log(`[${r.status.toUpperCase()}] ${r.client} -> ${r.filePath}`);
    }
    return;
  }

  if (cmd === "doctor") {
    const head = await core.getChainHead().catch(() => null);
    const sample = await core.fetchCuratedPolymarketRadar({ limit: 2 }).catch(() => []);
    io.log(
      JSON.stringify(
        {
          node: process.version,
          polymarketGammaOk: sample.length > 0,
          robinhoodChain4663Head: head,
        },
        null,
        2
      )
    );
    return;
  }

  io.log(`KALIBR v0.3.0 — Autonomous AI Probability Calibration & Cross-Venue Edge CLI

Commands:
  kalibr scan "<url-or-question>" [--bankroll 1000] [--json]
  kalibr radar [--domain all|macro|ai|geopolitics|crypto|policy] [--limit 10]
  kalibr cross [--filter all|arb|basis|routing] [--limit 14]
  kalibr arb [--mode all|closed|open] [--limit 12]
  kalibr traps [--domain all|macro|ai|geopolitics|crypto|policy] [--limit 12]
  kalibr init [--dry-run]
  kalibr doctor
  kalibr verify <epochHour> --registry <0xAddress>
  kalibr mcp
`);
}
