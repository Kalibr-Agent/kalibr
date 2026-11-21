import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(HERE, "../src/_vendor");
const CORE_SRC = path.resolve(HERE, "../../core/src");

if (process.argv.includes("--clean")) {
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  process.exit(0);
}

fs.mkdirSync(VENDOR_DIR, { recursive: true });
for (const f of ["keccak.js", "merkle.js", "polymarket.js", "rpc.js", "index.js"]) {
  fs.copyFileSync(path.join(CORE_SRC, f), path.join(VENDOR_DIR, f));
}
console.log("[kalibr-cli] Vendored @kalibr/core into src/_vendor/");
