#!/usr/bin/env node
/**
 * Attach an Electron client-device executor to a running Vibestudio instance.
 *
 * Self-development can build and launch an Electron client onto a *live*
 * device, which means a desktop client registered with that server as a
 * client-device executor. Every piece needed to do that unattended already
 * existed — `xvfb-run` for the display, an isolated secret service for the
 * device credential, `--dev-iroh-remote` to consume a launch pairing link
 * without a chooser window, and `--development-client-executor` for a client
 * that registers an executor and opens no UI — but nothing composed them
 * against a server that is already running. Without this, the client-device
 * scenarios can only run on a developer's own desktop.
 *
 * The launched client owns nothing of the developer's: its own HOME, XDG
 * directories, Chromium profile, D-Bus session, and keyring.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startEphemeralLinuxSecretService } from "./lib/linux-secret-service.mjs";

const repoRoot = process.cwd();

function parseArguments(argv) {
  let instanceId;
  let workspace = "dev";
  let ttlMs = 3_600_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--instance") instanceId = argv[(index += 1)];
    else if (arg === "--workspace") workspace = argv[(index += 1)];
    else if (arg === "--ttl-ms") ttlMs = Number(argv[(index += 1)]);
    else if (arg === "-h" || arg === "--help") return { help: true };
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!instanceId) throw new Error("usage: development-client-executor.mjs --instance ID");
  return { instanceId, workspace, ttlMs };
}

/** Mint one device invite from the running instance through its own CLI. */
function mintPairingLink(instanceId, workspace, ttlMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        "src/dev/runCli.ts",
        "--instance",
        instanceId,
        "remote",
        "pair-device",
        "--workspace",
        workspace,
        "--ttl-ms",
        String(ttlMs),
        "--json",
      ],
      { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Could not mint a device invite for ${instanceId}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        const deepLink = JSON.parse(line)?.pairing?.deepLink;
        if (typeof deepLink !== "string") throw new Error("no deep link in the invite");
        resolve(deepLink);
      } catch (error) {
        reject(
          new Error(`Device invite was not readable: ${error.message}: ${line.slice(0, 200)}`)
        );
      }
    });
  });
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(`Attach an Electron client-device executor to a running instance.

Usage:
  node scripts/development-client-executor.mjs --instance ID [--workspace NAME] [--ttl-ms MS]

Runs until stopped. Requires xvfb-run, dbus-daemon, and gnome-keyring-daemon.`);
    return;
  }
  const mainEntry = path.join(repoRoot, "dist", "main.cjs");
  if (!fs.existsSync(mainEntry)) {
    throw new Error(`Electron main entry not found at ${mainEntry}. Run pnpm build first.`);
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-client-executor-"));
  const children = [];
  const stop = () => {
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const deepLink = await mintPairingLink(parsed.instanceId, parsed.workspace, parsed.ttlMs);
    console.log(`[client-executor] minted a device invite for instance ${parsed.instanceId}`);
    const secrets = await startEphemeralLinuxSecretService(tempRoot, children);

    const userDataDir = path.join(tempRoot, "electron-user-data");
    const electron = path.join(repoRoot, "node_modules", "electron", "dist", "electron");
    const env = {
      ...process.env,
      NODE_ENV: "development",
      VIBESTUDIO_APP_ROOT: repoRoot,
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
      ...secrets.env,
    };
    // Instance routing belongs to the server this client pairs *into*; an
    // inherited one would send it to a different workspace entirely.
    delete env.VIBESTUDIO_INSTANCE_ROOT;
    delete env.VIBESTUDIO_INSTANCE;
    delete env.VIBESTUDIO_WORKSPACE;

    const child = spawn(
      "xvfb-run",
      [
        "-a",
        electron,
        "--no-sandbox",
        ...secrets.electronArgs,
        `--user-data-dir=${userDataDir}`,
        repoRoot,
        deepLink,
        // Consume the launch link without a chooser, and register an executor
        // instead of starting presentation.
        "--dev-iroh-remote",
        "--development-client-executor",
      ],
      { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    children.push(child);
    let ready = false;
    const watch = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line || /ERROR:|WARNING:|libunity|Vulkan|EGL|dbus/u.test(line)) continue;
        console.log(`[client-executor] ${line}`);
        if (!ready && line.includes("executor-only client ready")) {
          ready = true;
          console.log(`[client-executor] registered with instance ${parsed.instanceId}`);
        }
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    if (!ready) throw new Error(`The client executor exited before registering (code ${code})`);
  } finally {
    stop();
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
