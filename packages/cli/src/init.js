/**
 * Multi-client MCP bootstrapper (`kalibr init`).
 * Safely wires Cursor, Claude Code, Codex, and Claude Desktop with `.kalibr-bak` backups
 * and transient `_npx` PATH protection.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isTransientRunnerDir(dirPath) {
  const norm = String(dirPath || "").replace(/\\/g, "/").toLowerCase();
  return norm.includes("/_npx/") || norm.includes("/node_modules/.bin");
}

export function findGlobalBinary(binName = "kalibr", envPath = process.env.PATH || "", platform = process.platform) {
  const sep = platform === "win32" ? ";" : ":";
  const exts = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const dirs = envPath.split(sep).map((d) => d.trim()).filter(Boolean);

  for (const dir of dirs) {
    if (isTransientRunnerDir(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, binName + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }
  return null;
}

export function buildMcpCommandSpec({
  pkgSpec = "github:Kalibr-Agent/kalibr",
  globalInstalled = false,
  platform = process.platform,
  forGuiApp = false,
} = {}) {
  if (globalInstalled && !forGuiApp) {
    return platform === "win32"
      ? { command: "cmd", args: ["/c", "kalibr", "mcp"] }
      : { command: "kalibr", args: ["mcp"] };
  }
  if (platform === "win32" && forGuiApp) {
    return { command: "cmd", args: ["/c", "npx", "-y", pkgSpec, "mcp"] };
  }
  return { command: "npx", args: ["-y", pkgSpec, "mcp"] };
}

function backupOnce(filePath) {
  const bak = `${filePath}.kalibr-bak`;
  if (fs.existsSync(filePath) && !fs.existsSync(bak)) {
    fs.copyFileSync(filePath, bak);
    return bak;
  }
  return null;
}

export function upsertJsonMcpConfig(filePath, serverKey, spec, dryRun = false) {
  let current = {};
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    try {
      current = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return { status: "skipped", filePath, reason: "Malformed JSON left untouched" };
    }
  }
  if (!current.mcpServers || typeof current.mcpServers !== "object") {
    current.mcpServers = {};
  }
  const prev = current.mcpServers[serverKey];
  if (prev && prev.command === spec.command && JSON.stringify(prev.args || []) === JSON.stringify(spec.args || [])) {
    return { status: "unchanged", filePath };
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    backupOnce(filePath);
    current.mcpServers[serverKey] = spec;
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
  }
  return { status: dryRun ? "would_update" : "updated", filePath };
}

export function runInit({ homeDir = os.homedir(), dryRun = false, platform = process.platform } = {}) {
  const globalBin = findGlobalBinary("kalibr", process.env.PATH || "", platform);
  const cliSpec = buildMcpCommandSpec({ globalInstalled: Boolean(globalBin), platform, forGuiApp: false });
  const guiSpec = buildMcpCommandSpec({ globalInstalled: Boolean(globalBin), platform, forGuiApp: true });

  const targets = [
    { client: "Cursor", filePath: path.join(homeDir, ".cursor", "mcp.json"), spec: guiSpec },
    { client: "Claude Code", filePath: path.join(homeDir, ".claude.json"), spec: cliSpec },
  ];

  const claudeDesktopPath =
    platform === "win32"
      ? path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : platform === "darwin"
        ? path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : path.join(homeDir, ".config", "Claude", "claude_desktop_config.json");

  if (fs.existsSync(path.dirname(claudeDesktopPath))) {
    targets.push({ client: "Claude Desktop", filePath: claudeDesktopPath, spec: guiSpec });
  }

  return targets.map((t) => ({
    client: t.client,
    ...upsertJsonMcpConfig(t.filePath, "kalibr", t.spec, dryRun),
  }));
}
