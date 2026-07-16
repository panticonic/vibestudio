#!/usr/bin/env node
// End-to-end CLI client smoke over the real hosted WebRTC remote path.

import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SIGNAL_URL,
  parseConnectLink,
  parseSignalingEndpoint,
} from "./cli/lib/connect-grammar.generated.mjs";
import { parseHubReadyPayload } from "./cli/lib/hub-ready.mjs";
import { createRemoteServeArgs, waitForRootInvite } from "./cli/lib/smoke-remote-server.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "dist", "cli", "client.mjs");
const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
const signalingDir = path.join(repoRoot, "apps", "signaling");

function parseArgs(argv) {
  const options = {
    help: false,
    localSignaling: false,
    signalUrl: null,
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help") options.help = true;
    else if (arg === "--local-signaling") options.localSignaling = true;
    else if (arg === "--signal-url") options.signalUrl = argv[++i] ?? "";
    else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++i]);
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.localSignaling && options.signalUrl) {
    throw new Error("--local-signaling cannot be combined with --signal-url");
  }
  if (options.signalUrl !== null) {
    const parsed = parseSignalingEndpoint(options.signalUrl);
    if (parsed.kind === "error") throw new Error(`--signal-url: ${parsed.reason}`);
    options.signalUrl = parsed.url;
  }
  return options;
}

function printHelp() {
  console.log(`vibestudio CLI remote smoke

Usage:
  node scripts/cli-remote-smoke.mjs [options]

Options:
  --signal-url <url>   Use a specific existing signaling service.
  --local-signaling    Start local Wrangler signaling instead of production.
  --timeout-ms <ms>    Overall smoke timeout. Defaults to 180000.
  --help               Show this help message.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function prefixOutput(prefix, chunk, stream) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line) stream.write(`[${prefix}] ${line}\n`);
  }
}

function spawnManaged(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => prefixOutput(options.label, chunk, process.stdout));
  child.stderr?.on("data", (chunk) => prefixOutput(options.label, chunk, process.stderr));
  return child;
}

async function startLocalSignaling(port) {
  const child = spawnManaged(
    wranglerBin,
    ["dev", "--port", String(port), "--local", "--var", "ENVIRONMENT:test"],
    { cwd: signalingDir, label: "signaling" }
  );
  for (let i = 0; i < 90; i += 1) {
    if (child.exitCode != null) {
      throw new Error(`local signaling exited before readiness (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return child;
    } catch {
      // Wait for Wrangler to bind.
    }
    await sleep(1_000);
  }
  throw new Error("local signaling did not become healthy");
}

async function verifySignaling(signalUrl) {
  const url = new URL(signalUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`signaling health failed: HTTP ${response.status}`);
}

async function waitForReadyFile(readyFile, child, deadlineMs) {
  while (Date.now() < deadlineMs) {
    if (child.exitCode != null) {
      throw new Error(`remote serve exited before readiness (code ${child.exitCode})`);
    }
    try {
      return parseHubReadyPayload(JSON.parse(await fsp.readFile(readyFile, "utf8")));
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`timed out waiting for remote serve readiness: ${readyFile}`);
}

function parseJsonOutput(stdout, label) {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .findLast((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error(`${label} emitted no JSON: ${stdout}`);
  return JSON.parse(line);
}

async function runCliJson(args, env, timeoutMs, label) {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    env,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseJsonOutput(stdout, label);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode != null || child.signalCode != null) finish(true);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 8_000)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, 8_000);
}

async function removeTempRoot(tempRoot) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fsp.rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = error?.code === "ENOTEMPTY" || error?.code === "EBUSY";
      if (!retryable || attempt === 19) throw error;
      await sleep(250);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const deadlineMs = Date.now() + options.timeoutMs;
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-cli-remote-smoke-"));
  const readyFile = path.join(tempRoot, "server-ready.json");
  const children = [];
  try {
    let signalUrl = options.signalUrl ?? DEFAULT_SIGNAL_URL;
    if (options.localSignaling) {
      const port = await findFreePort();
      const signaling = await startLocalSignaling(port);
      children.push(signaling);
      signalUrl = `ws://127.0.0.1:${port}`;
    } else {
      await verifySignaling(signalUrl);
    }
    console.log(`[cli-remote-smoke] signaling ${signalUrl}`);

    const gatewayPort = await findFreePort();
    const serverHome = path.join(tempRoot, "server-home");
    const serverConfig = path.join(tempRoot, "server-config");
    await Promise.all([
      fsp.mkdir(serverHome, { recursive: true }),
      fsp.mkdir(serverConfig, { recursive: true }),
    ]);
    const serverEnv = {
      ...process.env,
      HOME: serverHome,
      NODE_ENV: process.env.NODE_ENV ?? "development",
      VIBESTUDIO_LOG_LEVEL: "error",
      VIBESTUDIO_TEST_MODE: "1",
      XDG_CONFIG_HOME: serverConfig,
    };
    if (options.localSignaling || options.signalUrl) {
      serverEnv.VIBESTUDIO_WEBRTC_SIGNAL_URL = signalUrl;
    } else {
      delete serverEnv.VIBESTUDIO_WEBRTC_SIGNAL_URL;
    }

    const serverArgs = createRemoteServeArgs(repoRoot, readyFile, gatewayPort);
    const server = spawnManaged(process.execPath, serverArgs, {
      env: serverEnv,
      label: "server",
    });
    children.push(server);
    await waitForReadyFile(readyFile, server, deadlineMs);
    const invite = await waitForRootInvite({
      readyFile,
      timeoutMs: Math.max(1_000, deadlineMs - Date.now()),
    });
    const pairing = parseConnectLink(invite.pairUrl);
    if (pairing.kind !== "ok") throw new Error(`root invite was invalid: ${pairing.reason}`);
    if (!options.localSignaling && !options.signalUrl && pairing.sig !== DEFAULT_SIGNAL_URL) {
      throw new Error(
        `remote serve did not use hosted signaling (expected ${DEFAULT_SIGNAL_URL}, got ${pairing.sig})`
      );
    }

    const clientHome = path.join(tempRoot, "client-home");
    const clientConfig = path.join(tempRoot, "client-config");
    await Promise.all([
      fsp.mkdir(clientHome, { recursive: true }),
      fsp.mkdir(clientConfig, { recursive: true }),
    ]);
    const clientEnv = {
      ...process.env,
      HOME: clientHome,
      VIBESTUDIO_LOG_LEVEL: "error",
      XDG_CONFIG_HOME: clientConfig,
    };
    const pair = await runCliJson(
      ["remote", "pair", invite.pairUrl, "--label", "CLI remote smoke", "--json"],
      clientEnv,
      Math.max(1_000, deadlineMs - Date.now()),
      "remote pair"
    );
    if (typeof pair.credentialPath !== "string") {
      throw new Error(`remote pair returned no credential path: ${JSON.stringify(pair)}`);
    }
    const credential = JSON.parse(await fsp.readFile(pair.credentialPath, "utf8"));
    const pairedUrl = typeof pair.url === "string" ? new URL(pair.url) : null;
    if (
      !pairedUrl ||
      pairedUrl.protocol !== "webrtc:" ||
      typeof credential.workspacePairing?.room !== "string" ||
      pairedUrl.hostname !== credential.workspacePairing.room ||
      typeof credential.workspaceName !== "string" ||
      pairedUrl.pathname !== `/_workspace/${encodeURIComponent(credential.workspaceName)}` ||
      typeof credential.workspaceId !== "string" ||
      credential.workspaceId.length === 0 ||
      credential.url !== pair.url
    ) {
      throw new Error(`remote pair returned an unexpected URL: ${JSON.stringify(pair)}`);
    }

    const status = await runCliJson(
      ["remote", "status", "--json"],
      clientEnv,
      Math.max(1_000, deadlineMs - Date.now()),
      "remote status"
    );
    if (
      status.url !== pair.url ||
      status.workspaceId !== credential.workspaceId ||
      typeof status.serverId !== "string" ||
      !status.serverId ||
      typeof status.workspaceId !== "string" ||
      !status.workspaceId
    ) {
      throw new Error(`remote status did not confirm the paired server: ${JSON.stringify(status)}`);
    }
    console.log(
      `[cli-remote-smoke] PASS pair and status over WebRTC; ` +
        `url=${status.url}; serverId=${status.serverId}; workspaceId=${status.workspaceId}`
    );
  } finally {
    for (const child of children.reverse()) await stopChild(child);
    await removeTempRoot(tempRoot);
  }
}

main().catch((error) => {
  console.error(`[cli-remote-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
