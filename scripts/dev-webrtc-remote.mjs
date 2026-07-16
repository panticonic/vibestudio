#!/usr/bin/env node
// Development harness for the remote transport. It keeps the server local, but
// launches Electron through a fresh WebRTC pairing so the desktop shell exercises
// the same encrypted remote pipe it would use for an actual remote server.

import fsp from "node:fs/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createPnpmInvocation } from "./cli/lib/package-manager.mjs";
import { createServerInvocation, serverEntryArg } from "./cli/lib/server-entry.mjs";
import {
  createConnectDeepLink,
  parseConnectLink,
  parseSignalingEndpoint,
} from "./cli/lib/connect-grammar.generated.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
const signalingDir = path.join(repoRoot, "apps", "signaling");
const defaultReadyFile = path.join(os.tmpdir(), `vibestudio-dev-webrtc-ready-${process.pid}.json`);

const children = new Set();
let cleanupStarted = false;
let ownedReadyFile = true;
let disposableServerHome = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = {
    autoApprove: false,
    electronArgs: [],
    ephemeral: false,
    gatewayPort: null,
    help: false,
    noBuild: false,
    noTypeCheck: false,
    readyFile: defaultReadyFile,
    signalPort: null,
    signalUrl: null,
    timeoutMs: 180_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--auto-approve") {
      options.autoApprove = true;
    } else if (arg === "--electron-arg") {
      options.electronArgs.push(requireValue(argv[++i], "--electron-arg"));
    } else if (arg === "--ephemeral") {
      options.ephemeral = true;
    } else if (arg === "--gateway-port") {
      options.gatewayPort = parsePort(argv[++i], "--gateway-port");
    } else if (arg === "--help") {
      options.help = true;
    } else if (arg === "--no-build") {
      options.noBuild = true;
    } else if (arg === "--no-type-check") {
      options.noTypeCheck = true;
    } else if (arg === "--ready-file") {
      options.readyFile = path.resolve(requireValue(argv[++i], "--ready-file"));
      ownedReadyFile = false;
    } else if (arg === "--signal-port") {
      options.signalPort = parsePort(argv[++i], "--signal-port");
    } else if (arg === "--signal-url") {
      options.signalUrl = requireValue(argv[++i], "--signal-url");
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.signalUrl && options.signalPort) {
    throw new Error("--signal-url cannot be combined with --signal-port");
  }
  validateSignalUrl(options.signalUrl, "--signal-url");
  return options;
}

function requireValue(value, label) {
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parsePort(value, label) {
  const parsed = parsePositiveInt(value, label);
  if (parsed > 65_535) throw new Error(`${label} must be between 1 and 65535`);
  return parsed;
}

function validateSignalUrl(value, label) {
  if (!value) return;
  const parsed = parseSignalingEndpoint(value);
  if (parsed.kind === "error") {
    throw new Error(`${label}: ${parsed.reason}`);
  }
}

function printHelp() {
  console.log(`vibestudio dev WebRTC remote harness

Usage:
  pnpm dev:webrtc [options]

Options:
  --ephemeral              Route a disposable dev workspace copied from template.
  --signal-url <url>       Use an existing signaling endpoint instead of local
                           wrangler dev. ws/http are accepted only for loopback.
  --signal-port <port>     Local wrangler dev port. Defaults to a free port.
  --gateway-port <port>    Local server gateway port. Defaults to a free port.
  --ready-file <path>      Server ready-file path. Defaults to an OS temp path.
  --timeout-ms <ms>        Startup timeout. Defaults to 180000.
  --auto-approve           Forward Vibestudio dev auto-approval to Electron.
  --electron-arg <arg>     Forward one raw arg to scripts/run-electron.mjs.
                           Repeat for multiple args.
  --no-build               Skip the initial node build.mjs step.
  --no-type-check          Do not start the background pnpm type-check.

The harness starts an isolated local hub, routes its default workspace child as
the WebRTC answerer, and launches Electron with the root-bootstrap
vibestudio://connect link plus --skip-remote-pairing. Stored credentials do not
take over this run, and fresh credentials from this dev pairing are not persisted.
`);
}

function prefixAndWrite(prefix, text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${prefix}] ${line}\n`);
  }
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.once("error", (error) => {
    prefixAndWrite(
      options.label ?? path.basename(command),
      `Failed to start ${command}: ${error.message}`,
      process.stderr
    );
  });
  if (child.stdout) {
    child.stdout.on("data", (chunk) =>
      prefixAndWrite(options.label ?? path.basename(command), chunk.toString(), process.stdout)
    );
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) =>
      prefixAndWrite(options.label ?? path.basename(command), chunk.toString(), process.stderr)
    );
  }
  return child;
}

async function waitForSpawn(child, command, args) {
  if (child.exitCode != null) {
    throw new Error(`${command} ${args.join(" ")} exited before spawn (code ${child.exitCode})`);
  }
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`${command} exited before startup (code ${code ?? signal ?? "unknown"})`));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return [child.exitCode, child.signalCode];
  }
  return once(child, "exit");
}

async function runCommand(command, args, options = {}) {
  const child = spawnManaged(command, args, {
    ...options,
    stdio: options.stdio ?? "inherit",
  });
  await waitForSpawn(child, command, args);
  const [code, signal] = await waitForExit(child);
  if (code !== 0) {
    throw new Error(`${options.label ?? command} failed (code ${code ?? signal ?? "unknown"})`);
  }
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local TCP port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function startSignaling(port) {
  if (!fs.existsSync(wranglerBin)) {
    throw new Error("Wrangler is not installed. Run `pnpm install` first.");
  }
  const child = spawnManaged(
    wranglerBin,
    ["dev", "--port", String(port), "--local", "--var", "ENVIRONMENT:test"],
    { cwd: signalingDir, label: "signaling" }
  );
  await waitForSpawn(child, wranglerBin, ["dev"]);
  for (let i = 0; i < 90; i++) {
    if (child.exitCode != null) {
      throw new Error(`wrangler dev (signaling) exited before healthy (code ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return child;
    } catch {
      // Not ready yet.
    }
    await sleep(1_000);
  }
  throw new Error("wrangler dev (signaling) did not become healthy");
}

function createServerArgs(options) {
  const args = [
    serverEntryArg(),
    "--app-root",
    repoRoot,
    "--ready-file",
    options.readyFile,
    "--host",
    "127.0.0.1",
    "--bind-host",
    "127.0.0.1",
  ];
  if (options.gatewayPort) args.push("--gateway-port", String(options.gatewayPort));
  if (options.ephemeral) args.push("--ephemeral");
  return args;
}

async function waitForServerReady(readyFile, serverChild, minMtimeMs, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (serverChild.exitCode != null) {
      throw new Error(`Server exited before readiness (code ${serverChild.exitCode})`);
    }
    try {
      const stat = await fsp.stat(readyFile);
      if (stat.mtimeMs + 100 < minMtimeMs) {
        await sleep(250);
        continue;
      }
      const content = await fsp.readFile(readyFile, "utf8");
      return JSON.parse(content);
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for server ready file: ${readyFile}`);
}

function startBackgroundTypeCheck() {
  const invocation = createPnpmInvocation(["type-check"]);
  const child = spawnManaged(invocation.command, invocation.args, {
    label: "type-check",
    env: { ...process.env, NODE_ENV: "development" },
  });
  child.once("exit", (code) => {
    if (code && !cleanupStarted) {
      console.error(`[type-check] exited with code ${code}`);
    }
  });
  return child;
}

async function terminateChild(child, signal = "SIGTERM") {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill(signal);
  const exited = waitForExit(child).then(() => true);
  const killed = sleep(5_000).then(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    return false;
  });
  await Promise.race([exited, killed]);
}

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const active = Array.from(children).reverse();
  await Promise.all(active.map((child) => terminateChild(child)));
  if (ownedReadyFile) {
    try {
      await fsp.unlink(defaultReadyFile);
    } catch {
      // It may not have been written yet.
    }
  }
  if (disposableServerHome) {
    await fsp.rm(disposableServerHome, { recursive: true, force: true });
    disposableServerHome = null;
  }
}

function installSignalHandlers() {
  const exits = new Map([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]);
  for (const [signal, code] of exits) {
    process.on(signal, () => {
      void cleanup().then(() => process.exit(code));
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  installSignalHandlers();

  if (!options.noBuild) {
    console.log("[dev-webrtc] Building development bundle");
    await runCommand(process.execPath, ["build.mjs"], {
      label: "build",
      env: { ...process.env, NODE_ENV: "development" },
    });
  }

  if (!options.noTypeCheck) {
    startBackgroundTypeCheck();
  }

  let signalUrl = options.signalUrl ?? process.env["VIBESTUDIO_DEV_WEBRTC_SIGNAL_URL"] ?? null;
  validateSignalUrl(signalUrl, "VIBESTUDIO_DEV_WEBRTC_SIGNAL_URL");
  if (!signalUrl) {
    const signalPort = options.signalPort ?? (await findFreePort());
    await startSignaling(signalPort);
    signalUrl = `ws://127.0.0.1:${signalPort}`;
  } else {
    console.log(`[dev-webrtc] Using signaling endpoint: ${signalUrl}`);
  }

  const serverArgs = createServerArgs(options);
  const serverInvocation = createServerInvocation(serverArgs);
  disposableServerHome = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-dev-webrtc-home-"));
  const serverXdgConfig = path.join(disposableServerHome, ".config");
  const serverEnv = {
    ...process.env,
    HOME: disposableServerHome,
    XDG_CONFIG_HOME: serverXdgConfig,
    NODE_ENV: "development",
    VIBESTUDIO_WEBRTC_SIGNAL_URL: signalUrl,
  };
  const serverChild = spawnManaged(serverInvocation.command, serverInvocation.args, {
    cwd: repoRoot,
    env: serverEnv,
    label: "server",
  });
  await waitForSpawn(serverChild, serverInvocation.command, serverInvocation.args);

  const timeoutMs = options.timeoutMs;
  const readyStartedAt = Date.now();
  const ready = await waitForServerReady(options.readyFile, serverChild, readyStartedAt, timeoutMs);
  const rootPairingLink = ready.rootInvite?.deepLink;
  if (typeof rootPairingLink !== "string" || rootPairingLink.length === 0) {
    throw new Error("Fresh dev hub did not publish a complete root invite");
  }
  const parsedPairing = parseConnectLink(rootPairingLink);
  if (parsedPairing.kind !== "ok") {
    throw new Error(`Server logged an invalid WebRTC pairing link: ${parsedPairing.reason}`);
  }
  const { kind: _kind, ...pairing } = parsedPairing;
  const deepLink = createConnectDeepLink(pairing);

  console.log("[dev-webrtc] Ready");
  console.log(
    `[dev-webrtc] Workspaces: ${(ready.workspaces ?? []).map((entry) => entry.name).join(", ") || "none"}`
  );
  console.log(`[dev-webrtc] Gateway:   ${ready.gatewayUrl ?? "unknown"}`);
  console.log(`[dev-webrtc] Signaling: ${signalUrl}`);
  console.log(`[dev-webrtc] Pairing:   room=${pairing.room} fp=${pairing.fp}`);
  console.log("[dev-webrtc] Launching Electron over WebRTC");

  const electronArgs = [
    "scripts/run-electron.mjs",
    "--skip-remote-pairing",
    "--dev-webrtc-remote",
    ...(options.autoApprove ? ["--auto-approve"] : []),
    deepLink,
    ...options.electronArgs,
  ];
  const electronChild = spawnManaged(process.execPath, electronArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      VIBESTUDIO_DISABLE_REMOTE_CRED_PERSISTENCE: "1",
    },
    label: "electron",
    stdio: "inherit",
  });
  await waitForSpawn(electronChild, process.execPath, electronArgs);
  const [code, signal] = await waitForExit(electronChild);
  await cleanup();
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
}

main().catch((error) => {
  console.error(`[dev-webrtc] ${error instanceof Error ? error.message : String(error)}`);
  void cleanup().then(() => process.exit(1));
});
