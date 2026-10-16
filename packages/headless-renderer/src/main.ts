#!/usr/bin/env node
/**
 * Entry point. Authentication is accepted only from the fork-IPC init message
 * `{type:"init", token, serverUrl, idleExitMs?}`. Public argv/env token paths
 * do not exist, so capability material never appears in process listings.
 */
import { resolveConfig, type ConfigOverrides } from "./config.js";
import { HeadlessHost } from "./headlessHost.js";
import { bindProcessLifetimeToParent } from "../../../scripts/owned-process-tree.mjs";

if (process.send) bindProcessLifetimeToParent();


interface IpcInit {
  type: "init";
  token: string;
  serverUrl: string;
  idleExitMs?: number;
  label?: string;
}

function parseArgs(argv: string[]): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index];
    switch (arg) {
      case "--label":
        overrides.label = next();
        break;
      case "--max-panels":
        overrides.maxPanels = Number.parseInt(next() ?? "", 10) || undefined;
        break;
      case "--idle-unload-min":
        overrides.idleUnloadMs = (Number.parseInt(next() ?? "", 10) || 0) * 60_000 || undefined;
        break;
      case "--idle-exit-min":
        overrides.idleExitMs = (Number.parseInt(next() ?? "", 10) || 0) * 60_000 || undefined;
        break;
      case "--chromium-path":
        overrides.chromiumPath = next();
        break;
      case "--lean-browser":
        overrides.leanBrowser = true;
        break;
      default:
        throw new Error(`headless-host: unknown argument ${arg}`);
    }
  }
  return overrides;
}

/**
 * A managed host (spawned with an IPC channel) always receives its server URL
 * and token in an `init` message. Wait for it; the parent going away first is
 * the only terminal outcome. Unmanaged launches configure from argv/env.
 */
async function awaitIpcInit(): Promise<IpcInit | null> {
  if (!process.send) return null;
  if (!process.connected) {
    throw new Error("headless-host: parent disconnected before sending its init message");
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const onMessage = (message: unknown): void => {
      const init = message as IpcInit;
      if (init && init.type === "init" && init.token && init.serverUrl) {
        cleanup();
        resolve(init);
      }
    };
    const onDisconnect = (): void => {
      cleanup();
      reject(new Error("headless-host: parent disconnected before sending its init message"));
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

async function main(): Promise<void> {
  const overrides = parseArgs(process.argv.slice(2));
  const ipcInit = await awaitIpcInit();
  if (ipcInit) {
    overrides.serverUrl = ipcInit.serverUrl;
    overrides.ipcToken = ipcInit.token;
    if (ipcInit.idleExitMs !== undefined) overrides.idleExitMs = ipcInit.idleExitMs;
    if (ipcInit.label) overrides.label = ipcInit.label;
  }
  const config = resolveConfig(overrides);
  config.lifecycle = {
    onRegistered: () => {
      process.send?.({ type: "registered", clientSessionId: config.clientSessionId });
    },
    onBridgeDiagnostic: (diagnostic) => {
      process.send?.({ type: "bridge", clientSessionId: config.clientSessionId, diagnostic });
    },
    onReady: () => {
      process.send?.({ type: "ready", clientSessionId: config.clientSessionId });
    },
  };
  const host = new HeadlessHost(config);

  const shutdown = (signal: string) => {
    void host.stop(signal);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  let startupError: unknown = null;
  try {
    await host.start();
    await host.done;
  } catch (error) {
    startupError = error;
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    // Report before cleanup: cleanup may itself wait on a failed native child,
    // while the parent needs the original startup cause to recover promptly.
    console.error(`[headless-host] fatal: ${detail}`);
    process.send?.({ type: "startup-error", error: detail });
  } finally {
    await host.stop("host lifetime ended");
  }
  if (startupError) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[headless-host] fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
