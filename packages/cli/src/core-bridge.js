import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const vendorEntry = path.join(HERE, "_vendor", "index.js");
const workspaceEntry = path.resolve(HERE, "../../core/src/index.js");

const target = fs.existsSync(vendorEntry) ? vendorEntry : workspaceEntry;
export const core = await import(pathToFileURL(target).href);
