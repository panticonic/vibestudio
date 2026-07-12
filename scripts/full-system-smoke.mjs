#!/usr/bin/env node
// Orchestrates the real-client smoke ladder for the remote/mobile overhaul:
// branded desktop pairing, desktop Playwright e2e, and Android emulator/mobile
// pairing. Each phase streams to the console and to test-results forensics.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultResultsRoot = path.join(repoRoot, "test-results", "full-system-smoke");

function parseArgs(argv) {
  const options = {
    skipBuild: false,
    skipDesktopPairing: false,
    skipDesktopE2e: false,
    skipAndroid: false,
    androidDevice: null,
    androidAvd: null,
    androidNoBuild: false,
    androidNoInstall: false,
    localSignaling: false,
    requireTurn: false,
    signalUrl: null,
    timeoutMs: 420_000,
    resultsDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--skip-desktop-pairing") options.skipDesktopPairing = true;
    else if (arg === "--skip-desktop-e2e") options.skipDesktopE2e = true;
    else if (arg === "--skip-android") options.skipAndroid = true;
    else if (arg === "--android-device") options.androidDevice = argv[++i] ?? null;
    else if (arg === "--android-avd") options.androidAvd = argv[++i] ?? null;
    else if (arg === "--android-no-build") options.androidNoBuild = true;
    else if (arg === "--android-no-install") options.androidNoInstall = true;
    else if (arg === "--local-signaling") options.localSignaling = true;
    else if (arg === "--require-turn") options.requireTurn = true;
    else if (arg === "--signal-url") options.signalUrl = argv[++i] ?? "";
    else if (arg === "--timeout-ms") options.timeoutMs = positiveInt(argv[++i], "--timeout-ms");
    else if (arg === "--results-dir") options.resultsDir = path.resolve(argv[++i] ?? "");
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.localSignaling && options.signalUrl) {
    throw new Error("--local-signaling cannot be combined with --signal-url");
  }
  return options;
}

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`vibestudio full-system smoke

Usage:
  pnpm smoke:full [options]

Phases:
  build                  pnpm build
  desktop-pairing        scripts/desktop-pairing-smoke.mjs
  desktop-e2e            pnpm test:e2e
  android-mobile         scripts/cli/mobile-smoke.mjs --platform android

Options:
  --skip-build              Reuse the current dist/ output.
  --skip-desktop-pairing    Skip the branded Electron WebRTC pairing smoke.
  --skip-desktop-e2e        Skip the Playwright desktop e2e suite.
  --skip-android            Skip Android emulator/mobile smoke.
  --android-device <serial> Target a specific adb serial.
  --android-avd <name>      Boot/use this AVD when no adb device is connected.
  --android-no-build        Reuse an existing internal APK.
  --android-no-install      Do not reinstall the APK before pairing.
  --signal-url <url>        Use a specific existing signaling service.
  --local-signaling         Use local Wrangler signaling for desktop and Android
                            instead of the hosted production service.
  --require-turn            Require TURN for the Android pairing phase. By
                            default it attempts normal host/STUN/TURN ICE.
  --timeout-ms <ms>         Phase timeout passed through to smoke scripts.
  --results-dir <path>      Forensics output directory.
  --help                    Show this message.

The command writes per-phase logs under test-results/full-system-smoke/ and
fails on the first broken phase. Desktop and Android pairing use the deployed
signaling service and the real remote-serve launcher by default. Pass
--local-signaling for an offline Miniflare/coturn run.
`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function prefixed(prefix, chunk, stream) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line) stream.write(`[${prefix}] ${line}\n`);
  }
}

function runPhase(phase, command, args, options = {}) {
  const logFile = path.join(options.resultsDir, `${phase}.log`);
  const startedAt = Date.now();
  console.log(`[full-smoke] phase=${phase} start`);
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`# ${phase}\n$ ${command} ${args.join(" ")}\n\n`);
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    child.stdout?.on("data", (chunk) => {
      log.write(chunk);
      prefixed(phase, chunk, process.stdout);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-8_000);
      log.write(chunk);
      prefixed(phase, chunk, process.stderr);
    });
    child.on("error", (error) => {
      log.end();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      log.write(`\n# exit code=${code} signal=${signal ?? ""} elapsedMs=${elapsedMs}\n`);
      log.end();
      if (code === 0) {
        console.log(`[full-smoke] phase=${phase} ok elapsedMs=${elapsedMs}`);
        resolve();
      } else {
        reject(
          new Error(
            `${phase} failed with code ${code}${signal ? ` signal ${signal}` : ""}. ` +
              `Log: ${logFile}${stderrTail ? `\n${stderrTail}` : ""}`
          )
        );
      }
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const resultsDir =
    options.resultsDir ?? path.join(defaultResultsRoot, `${timestamp()}-${process.pid}`);
  await ensureDir(resultsDir);
  await fsp.writeFile(
    path.join(resultsDir, "environment.json"),
    JSON.stringify(
      {
        cwd: repoRoot,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        hostname: os.hostname(),
        options,
      },
      null,
      2
    )
  );

  console.log(`[full-smoke] results=${resultsDir}`);

  if (!options.skipBuild) {
    await runPhase("build", "pnpm", ["build"], { resultsDir });
  }
  if (!options.skipDesktopPairing) {
    const args = [
      path.join(repoRoot, "scripts", "desktop-pairing-smoke.mjs"),
      "--timeout-ms",
      String(options.timeoutMs),
    ];
    if (options.localSignaling) args.push("--local-signaling");
    if (options.signalUrl) args.push("--signal-url", options.signalUrl);
    await runPhase("desktop-pairing", process.execPath, args, { resultsDir });
  }
  if (!options.skipDesktopE2e) {
    await runPhase("desktop-e2e", "pnpm", ["test:e2e"], { resultsDir });
  }
  if (!options.skipAndroid) {
    const args = [
      path.join(repoRoot, "scripts", "cli", "mobile-smoke.mjs"),
      "--platform",
      "android",
      "--timeout-ms",
      String(options.timeoutMs),
      "--pairing-timeout-ms",
      String(Math.max(180_000, Math.floor(options.timeoutMs / 2))),
    ];
    if (options.androidDevice) args.push("--device", options.androidDevice);
    if (options.androidAvd) args.push("--avd", options.androidAvd);
    if (options.androidNoBuild) args.push("--no-build");
    if (options.androidNoInstall) args.push("--no-install");
    if (options.localSignaling) args.push("--local-signaling");
    if (options.requireTurn) args.push("--require-turn");
    if (options.signalUrl) args.push("--signal-url", options.signalUrl);
    await runPhase("android-mobile", process.execPath, args, { resultsDir });
  }

  console.log(`[full-smoke] ok results=${resultsDir}`);
}

main().catch((error) => {
  console.error(`[full-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
