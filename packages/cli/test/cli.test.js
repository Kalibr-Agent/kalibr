import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTransientRunnerDir, runInit } from "../src/init.js";
import { handleMcpMessage } from "../src/mcp.js";

test("CLI init guards against _npx transient paths and writes .kalibr-bak safely", () => {
  assert.equal(isTransientRunnerDir("/Users/me/.npm/_npx/abcd/node_modules/.bin"), true);
  assert.equal(isTransientRunnerDir("/usr/local/bin"), false);

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kalibr-init-"));
  const cursorCfg = path.join(tmpHome, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(cursorCfg), { recursive: true });
  fs.writeFileSync(cursorCfg, JSON.stringify({ mcpServers: { existing: { command: "node", args: ["a.js"] } } }));

  const res = runInit({ homeDir: tmpHome, dryRun: false, platform: "linux" });
  assert.ok(res.some((r) => r.client === "Cursor" && r.status === "updated"));
  assert.equal(fs.existsSync(`${cursorCfg}.kalibr-bak`), true);

  const merged = JSON.parse(fs.readFileSync(cursorCfg, "utf8"));
  assert.ok(merged.mcpServers.existing, "Must preserve existing MCP servers");
  assert.ok(merged.mcpServers.kalibr, "Must add kalibr MCP server");
});

test("Stdio MCP handles initialize and tools/list", async () => {
  const initRes = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(initRes.result.serverInfo.name, "kalibr");

  const listRes = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listRes.result.tools.length, 3);
});
