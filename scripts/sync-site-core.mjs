#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_SRC = path.resolve(HERE, "../packages/core/src");
const SITE_CORE = path.resolve(HERE, "../apps/site/core");

fs.mkdirSync(SITE_CORE, { recursive: true });
for (const file of ["keccak.js", "merkle.js", "polymarket.js", "rpc.js", "index.js"]) {
  fs.copyFileSync(path.join(CORE_SRC, file), path.join(SITE_CORE, file));
}
console.log("[kalibr] Synced @kalibr/core modules to apps/site/core/");
