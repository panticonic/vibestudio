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
 *
 * The client is also the account's desktop device driver: it opens real client
 * windows and answers the operations the client system tests send through the
 * server's `deviceDriver` service (`pnpm system-test run --device desktop`).
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { startEphemeralLinuxSecretService } from "./lib/linux-secret-service.mjs";
import { ownedEntry, retireOnAbort } from "./lib/owned-entry.mjs";
import { mintDevicePairingLink } from "./lib/device-pairing-link.mjs";

const repoRoot = process.cwd();

function parseArguments(argv) {
  let instanceId;
  let ttlMs = 3_600_000;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--instance") instanceId = argv[(index += 1)];
    else if (arg === "--ttl-ms") ttlMs = Number(argv[(index += 1)]);
    else if (arg === "-h" || arg === "--help") return { help: true };
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!instanceId) throw new Error("usage: development-client-executor.mjs --instance ID");
  return { instanceId, ttlMs };
}

async function main({ signal: ownerSignal, ownership, scratchRoot: tempRoot }) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(`Attach an Electron client-device executor to a running instance.

Usage:
  node scripts/development-client-executor.mjs --instance ID [--ttl-ms MS]

Pairs this device to the instance account. Workspace selection is independent.

Runs until stopped. Requires xvfb-run, dbus-daemon, and gnome-keyring-daemon.`);
    return;
  }
  const mainEntry = path.join(repoRoot, "dist", "main.cjs");
  ownerSignal.throwIfAborted();
  if (!fs.existsSync(mainEntry)) {
    throw new Error(`Electron main entry not found at ${mainEntry}. Run pnpm build first.`);
  }

  let secretService;
  try {
    const deepLink = await mintDevicePairingLink(
      repoRoot,
      parsed.instanceId,
      parsed.ttlMs,
      ownership,
      ownerSignal
    );
    ownerSignal.throwIfAborted();
    console.log(`[client-executor] minted a device invite on ${parsed.instanceId}`);
    secretService = await startEphemeralLinuxSecretService(ownership, tempRoot, {
      signal: ownerSignal,
    });
    ownerSignal.throwIfAborted();

    const userDataDir = path.join(tempRoot, "electron-user-data");
    const electron = path.join(repoRoot, "node_modules", "electron", "dist", "electron");
    // The desktop device writes launchers under XDG_DATA_HOME and keeps its
    // state under XDG_CONFIG_HOME; both belong to this executor, not to the
    // developer's profile.
    const home = path.join(tempRoot, "home");
    await fsp.mkdir(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      NODE_ENV: "development",
      VIBESTUDIO_APP_ROOT: repoRoot,
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_DISABLE_SANDBOX: "1",
      ...secretService.env,
    };
    // Instance routing belongs to the server this client pairs *into*; an
    // inherited one would send it to a different workspace entirely.
    delete env.VIBESTUDIO_INSTANCE_ROOT;
    delete env.VIBESTUDIO_INSTANCE;
    delete env.VIBESTUDIO_WORKSPACE;

    const client = ownership.spawn(
      "xvfb-run",
      [
        "-a",
        electron,
        "--no-sandbox",
        // xvfb-run provides X11 even when the parent desktop uses Wayland.
        "--ozone-platform=x11",
        ...secretService.electronArgs,
        `--user-data-dir=${userDataDir}`,
        repoRoot,
        deepLink,
        // Consume the launch link without a chooser, and register an executor
        // instead of starting presentation.
        "--dev-iroh-remote",
        "--development-client-executor",
      ],
      {
        kill: "immediate",
        label: "electron-client",
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const { child } = client;
    retireOnAbort(ownership, ownerSignal, client);
    let ready = false;
    const watch = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line || /ERROR:|WARNING:|libunity|Vulkan|EGL|dbus/u.test(line)) continue;
        console.log(`[client-executor] ${line}`);
        if (!ready && line.includes("executor-only client ready")) {
          ready = true;
          console.log(
            `[client-executor] desktop device ready (registered with instance ${parsed.instanceId})`
          );
        }
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    const code = await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    await client.join();
    ownerSignal.throwIfAborted();
    if (!ready) throw new Error(`The client executor exited before registering (code ${code})`);
  } catch (error) {
    // Work interrupted by a stop request fails because it was stopped; the
    // request, not that failure, is what ended this run.
    ownerSignal.throwIfAborted();
    throw error;
  } finally {
    await secretService?.dispose();
  }
}

await ownedEntry(main, { appRoot: repoRoot, scratchPrefix: "vibestudio-client-executor-" });
