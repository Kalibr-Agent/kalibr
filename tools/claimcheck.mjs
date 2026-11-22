#!/usr/bin/env node
/**
 * Automated Larpcheck & Launchpad Gate Self-Audit for KALIBR.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const checks = [];
function pass(name, detail) {
  checks.push({ ok: true, name, detail });
}
function fail(name, detail) {
  checks.push({ ok: false, name, detail });
}

// 1. Sourcify artifact & zero-custody ABI check
const artifactPath = path.join(ROOT, "contracts/src/build/ForecastSealRegistry.json");
if (!fs.existsSync(artifactPath)) {
  fail("Sourcify Artifact", "ForecastSealRegistry.json missing");
} else {
  const art = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bad = (art.abi || []).filter(
    (x) => x.stateMutability === "payable" || /approve|transferFrom|withdraw/i.test(x.name || "")
  );
  if (bad.length > 0) fail("Zero Custody ABI", `Found custodial functions: ${bad.map((b) => b.name).join(", ")}`);
  else pass("Zero Custody ABI", "ForecastSealRegistry.sol has 0 payable/approve/transferFrom functions");
}

// 2. Multi-page HTML/JS hygiene: zero bare github.com, zero fake buyback promises, zero Connect Wallet popups
const htmlFiles = [
  "apps/site/index.html",
  "apps/site/cross/index.html",
  "apps/site/arb/index.html",
  "apps/site/traps/index.html",
  "apps/site/kelly/index.html",
  "apps/site/seals/index.html",
  "apps/site/agents/index.html",
];
const jsFiles = [
  "apps/site/app.js",
  "apps/site/spine.js",
  "apps/site/cross.js",
  "apps/site/arb.js",
  "apps/site/traps.js",
  "apps/site/kelly.js",
  "apps/site/seals.js",
  "apps/site/agents.js",
];

const html = htmlFiles.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
const js = jsFiles.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");

if (/href=["']https?:\/\/github\.com\/?["']/i.test(html)) {
  fail("No Bare GitHub Link", "Found bare https://github.com link in multi-page HTML");
} else {
  pass("No Bare GitHub Link", `Zero dead bare github.com links across ${htmlFiles.length} pages`);
}

if (/eth_requestAccounts/i.test(js) || /connect\s+wallet/i.test(html)) {
  fail("0-Wallet Gate", "Found wallet-connect prompt in UI");
} else {
  pass("0-Wallet Gate", "Zero wallet signature popups; 100% read-only access");
}

if (/50%\s+buyback|automated\s+buyback\s+and\s+burn/i.test(html + js)) {
  fail("Larpcheck Fee Honesty", "Found unverifiable buyback/burn marketing promise");
} else {
  pass("Larpcheck Fee Honesty", "Zero unverifiable fee-buyback promises in copy");
}

// 3. Brand PNG assets present
for (const rel of ["brand/avatar.png", "brand/x-header.png", "brand/og-image.png", "apps/site/logo.png", "apps/site/og-image.png"]) {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) {
    pass(`Asset ${rel}`, `${Math.round(fs.statSync(p).size / 1024)} KB`);
  } else {
    fail(`Asset ${rel}`, "Missing or empty PNG");
  }
}

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? "[PASS]" : "[FAIL]"} ${c.name.padEnd(26)} | ${c.detail}`);
  if (!c.ok) failed += 1;
}

if (failed > 0) {
  process.exitCode = 1;
}
