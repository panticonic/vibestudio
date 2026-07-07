#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const signalingDir = path.join(repoRoot, "apps", "signaling");
const wrangler = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

function parseArgs(argv) {
  const options = { url: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") options.url = argv[++i] ?? "";
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`vibestudio remote setup-signaling

Usage:
  vibestudio remote setup-signaling [--url <wss-url>] [--dry-run]

Deploys apps/signaling with wrangler. If --url is supplied, it is persisted to
~/.config/vibestudio/config.json as { "signalingUrl": "..." }.
`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`)));
  });
}

function writeConfig(url) {
  if (!url) return;
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "vibestudio")
    : path.join(os.homedir(), ".config", "vibestudio");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "config.json");
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  current.signalingUrl = url;
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  console.log(`[remote-setup-signaling] wrote ${file}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.dryRun) {
    console.log(`[remote-setup-signaling] ${wrangler} deploy`);
  } else {
    await run(wrangler, ["deploy"], signalingDir);
  }
  writeConfig(options.url);
}

main().catch((error) => {
  console.error(`[remote-setup-signaling] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
