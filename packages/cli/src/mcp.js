import readline from "node:readline";
import { core } from "./core-bridge.js";

const STDIO_TOOLS = [
  {
    name: "scan_polymarket_edge",
    description:
      "Instant <1.2s actuarial probability calibration, Quarter-Kelly sizing, multi-bracket coherence, and fine-print rule-trap audit for any Polymarket URL, slug, or event question.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Polymarket URL, slug, or world event question" },
        bankrollUsd: { type: "number", description: "Optional bankroll in USD for Quarter-Kelly sizing (default 1000)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_mispriced_radar",
    description:
      "Fetch live non-sports world events on Polymarket ranked by Crowd vs KALIBR Fair Probability divergence.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", enum: ["all", "macro", "ai", "geopolitics", "crypto", "policy"] },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "verify_merkle_proof_offline",
    description:
      "Offline Keccak-256 verification of any KALIBR sealed forecast leaf and sorted-pair Merkle proof against a committed epoch root.",
    inputSchema: {
      type: "object",
      properties: {
        leafHash: { type: "string" },
        proof: { type: "array", items: { type: "string" } },
        merkleRoot: { type: "string" },
      },
      required: ["leafHash", "proof", "merkleRoot"],
    },
  },
];

export async function handleMcpMessage(msg) {
  const { id, method, params } = msg || {};
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "kalibr", version: "0.1.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: STDIO_TOOLS } };

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let data;
      if (name === "scan_polymarket_edge") {
        const res = await core.resolveAndCalibratePolymarket(args.query);
        const kelly = core.computeKellySizing({
          fairProb: res.market.fairProb,
          crowdProb: res.market.crowdProb,
          spread: res.market.spread,
          bankrollUsd: Number(args.bankrollUsd || 1000),
        });
        data = { ...res, market: { ...res.market, kelly } };
      } else if (name === "list_mispriced_radar") {
        const markets = await core.fetchCuratedPolymarketRadar({
          domainFilter: args.domain || "all",
          limit: Math.min(25, Math.max(1, Number(args.limit || 10))),
        });
        data = { count: markets.length, markets };
      } else if (name === "verify_merkle_proof_offline") {
        const verified = core.verifyMerkleProof(args.leafHash, args.proof || [], args.merkleRoot);
        data = { verified, leafHash: args.leafHash, merkleRoot: args.merkleRoot };
      } else {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] },
      };
    }
  }
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "Method not found" } };
}

export function startStdioMcp() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      const out = await handleMcpMessage(parsed);
      if (out) process.stdout.write(JSON.stringify(out) + "\n");
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"
      );
    }
  });
}
