import test from "node:test";
import assert from "node:assert/strict";
import worker, { runHourlySealTick } from "../src/index.js";
import { sqliteD1 } from "../d1-sqlite.mjs";

test("Worker serves /v1/status, /mcp tools/list, seals live Polymarket epoch, and verifies Merkle proof", async () => {
  const db = sqliteD1(":memory:");
  const env = {
    DB: db,
    ADMIN_KEY: "test-admin",
    SITE_URL: "https://kalibr.app",
    RH_RPC_URL: "https://rpc.mainnet.chain.robinhood.com",
  };

  // 1. Check status
  const statusRes = await worker.fetch(new Request("https://kalibr.app/v1/status"), env, { waitUntil() {} });
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.chainId, 4663);
  assert.equal(statusBody.aiEngine.live, false);

  // 2. Check MCP tools/list
  const mcpRes = await worker.fetch(
    new Request("https://kalibr.app/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
    { waitUntil() {} }
  );
  assert.equal(mcpRes.status, 200);
  const mcpBody = await mcpRes.json();
  assert.equal(mcpBody.result.tools.length, 6);

  // 3. Run live Polymarket hourly seal tick and verify cryptographic proof endpoint
  const sealRes = await runHourlySealTick(env, { force: true });
  assert.equal(sealRes.ok, true);
  assert.match(sealRes.merkleRoot, /^0x[0-9a-f]{64}$/);
  assert.ok(sealRes.marketCount >= 1);

  const epochDetailRes = await worker.fetch(
    new Request(`https://kalibr.app/v1/seals/${sealRes.epochHour}`),
    env,
    { waitUntil() {} }
  );
  const epochDetail = await epochDetailRes.json();
  assert.equal(epochDetail.ok, true);
  const firstLeaf = epochDetail.forecasts[0];

  const proofRes = await worker.fetch(
    new Request(`https://kalibr.app/v1/proofs/${sealRes.epochHour}/${encodeURIComponent(firstLeaf.market_id)}`),
    env,
    { waitUntil() {} }
  );
  const proofBody = await proofRes.json();
  assert.equal(proofBody.ok, true);
  assert.equal(proofBody.verified, true);
  assert.equal(proofBody.merkleRoot, sealRes.merkleRoot);
});
