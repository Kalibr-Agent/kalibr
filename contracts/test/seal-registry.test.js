import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD_JSON = path.resolve(HERE, "../src/build/ForecastSealRegistry.json");

test("ForecastSealRegistry compiles cleanly for Sourcify 0.8.24 with zero payable or approval functions", () => {
  assert.equal(fs.existsSync(BUILD_JSON), true, "Compiled artifact must exist");
  const artifact = JSON.parse(fs.readFileSync(BUILD_JSON, "utf8"));
  assert.ok(artifact.abi && Array.isArray(artifact.abi), "ABI must exist");
  assert.ok(artifact.bytecode && artifact.bytecode.startsWith("0x"), "Bytecode must be non-empty");

  const byteLen = (artifact.bytecode.length - 2) / 2;
  assert.ok(byteLen < 24_576, `EIP-170 contract size ${byteLen} bytes must be < 24576`);

  const fns = artifact.abi.filter((x) => x.type === "function");
  const fnNames = fns.map((f) => f.name);
  assert.ok(fnNames.includes("sealEpoch"));
  assert.ok(fnNames.includes("verifyForecastLeaf"));
  assert.ok(fnNames.includes("getSeal"));
  assert.ok(fnNames.includes("bindToken"));
  assert.ok(fnNames.includes("tierOf"));

  for (const fn of fns) {
    assert.notEqual(fn.stateMutability, "payable", `Function ${fn.name} must not be payable`);
    assert.ok(!/approve|transferFrom|withdraw/i.test(fn.name), `Zero custody invariant violated by ${fn.name}`);
  }
});
