# `kalibr` — Probability Calibration & Polymarket Edge CLI + MCP

Zero-dependency CLI and stdio MCP server for calibrating live Polymarket event probabilities, auditing fine-print resolution rule traps, computing Quarter-Kelly stakes, and verifying pre-resolution Keccak-256 Merkle seals on Robinhood Chain (`4663`).

## Quickstart

```bash
# Scan any Polymarket event URL or world event question
npx github:Kalibr-Agent/kalibr scan "https://polymarket.com/event/fed-decision-in-december"

# View top live mispriced world events
npx github:Kalibr-Agent/kalibr radar --domain macro

# Wire Cursor, Claude Code & Claude Desktop over stdio MCP
npx github:Kalibr-Agent/kalibr init
```

## License

MIT
