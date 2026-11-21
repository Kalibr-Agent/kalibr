# KALIBR (`$KALIBR`)

> **Crowd prices emotion. Calibration prices probability.**

Autonomous AI probability calibration agents, live Polymarket mispricing & fine-print resolution rule-trap scanner, Quarter-Kelly position sizer, zero-dependency CLI + MCP server (`npx kalibr`), and pre-resolution **Keccak-256 Merkle forecast seals** (`ForecastSealRegistry.sol`) on **Robinhood Chain (`4663`)**.

## Quickstart (Zero-Dependency CLI & Stdio MCP)

Requires Node.js `>=20`. Zero external npm dependencies, zero signup, zero wallet connection required.

```bash
# Scan any Polymarket event URL or world event question
npx github:Kalibr-Agent/kalibr scan "https://polymarket.com/event/fed-decision-in-december"

# Live mispriced non-sports world events radar
npx github:Kalibr-Agent/kalibr radar --domain macro

# Wire Cursor, Claude Code & Claude Desktop over stdio MCP
npx github:Kalibr-Agent/kalibr init
```

## Architecture

- **`packages/core` (`@kalibr/core`)** — Pure zero-dependency Polymarket Gamma/CLOB ingestion, multi-bracket sibling sum coherence, actuarial favorite-longshot & lockup-yield de-biasing, fine-print resolution rule-trap scanner, Quarter-Kelly sizer, verbatim upstream JSON figure verifier, Brier Score engine, and sorted-pair Ethereum Keccak-256 Merkle trees.
- **`packages/cli` (`kalibr`)** — Standalone CLI (`scan`, `radar`, `verify`, `init`, `doctor`, `mcp`) with `_npx` transient PATH protection and `.kalibr-bak` config backups.
- **`contracts/src/ForecastSealRegistry.sol`** — Non-custodial Solidity `0.8.24` pre-resolution Merkle commitment contract compiled for Sourcify `exact_match` on Robinhood Chain (`4663`). Zero `payable`, zero `approve`, zero `transferFrom`.
- **`apps/worker` & `apps/site`** — Cloudflare Worker + D1 + hourly sealer cron + real 3-agent OpenAI/Anthropic calibration panel + Streamable HTTP `/mcp` + Swiss Probability Atelier UI (`0-wallet`).

## Claim & Status Matrix

- **Live:** Polymarket Gamma & CLOB live ingestion (`packages/core/src/polymarket.js`)
- **Live:** Actuarial `<1.2s` calibration, Quarter-Kelly sizer & fine-print resolution rule-trap audit (`calibrateMarket`, `auditResolutionRules`)
- **Live:** 3-Agent adversarial LLM panel (`Base-Rate Analyst`, `Resolution Trap Devil`, `Chief Superforecaster`) with verbatim upstream JSON verification (`apps/worker/src/llm.js`)
- **Live:** Sorted-pair Keccak-256 Merkle forecast sealing & client-side tamper-evident browser verifier (`ForecastSealRegistry.sol`, `apps/site/app.js`)
- **Live:** Streamable HTTP `/mcp` + stdio MCP CLI (`packages/cli/src/mcp.js`)

## Known Limits

- Actuarial `<1.2s` priors calibrate microstructure distortions (CLOB bid-ask skew, favorite-longshot bias, capital lockup drag, 24h headline churn, and sibling bracket overround); novel breaking news requires dispatching the 3-Agent LLM panel.
- Pre-resolution Merkle seals prove that KALIBR committed exact probabilities at `sealedAt` before event resolution; missed worker cron runs leave `sealedAt == 0` rather than backfilling.
- Independent software reading public market data and Robinhood Chain RPC. Not affiliated with Polymarket, Pons, or Robinhood. Not financial advice.

## License

MIT
