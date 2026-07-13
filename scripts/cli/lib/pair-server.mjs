import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printConnectBanner, resolveSignalingUrl } from "./connect-utils.mjs";
import { parseHubReadyPayload } from "./hub-ready.mjs";
import { createServerInvocation, serverEntryArg } from "./server-entry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Loopback host the co-located server binds. Remote reach is WebRTC (the QR
// carries room/fp/sig); there is no LAN/Tailscale/public-URL origin anymore.
const LOOPBACK_HOST = "127.0.0.1";
const SIGNAL_ENV = ["VIBESTUDIO_WEBRTC_SIGNAL_URL"];

/**
 * Signal the complete server process tree. POSIX children are spawned as
 * process-group leaders, so targeting the negative pid reaches package-manager
 * and workerd descendants as one lifecycle unit. ESRCH falls back to the
 * ChildProcess API for injected/non-detached children and test doubles.
 */
export function signalProcessTree(
  childProcess,
  signal,
  { platform = process.platform, killProcess = process.kill } = {}
) {
  if (!childProcess) return false;
  if (platform !== "win32" && Number.isInteger(childProcess.pid) && childProcess.pid > 0) {
    try {
      killProcess(-childProcess.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return childProcess.kill?.(signal) ?? false;
}

/** Signal only the supervised hub. The hub owns ordered workspace-child and
 * workerd shutdown; broadcasting a graceful signal to the whole process group
 * races that ordering. When ChildProcess.kill() already marked the handle as
 * killed, address the same pid directly so a repeated Ctrl-C still reaches the
 * hub's explicit escalation handler. */
export function signalHubGracefully(childProcess, signal, { killProcess = process.kill } = {}) {
  if (!childProcess) return false;
  if (childProcess.killed && Number.isInteger(childProcess.pid) && childProcess.pid > 0) {
    try {
      killProcess(childProcess.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      return false;
    }
  }
  return childProcess.kill?.(signal) ?? false;
}

/** Reap descendants after an abnormal hub exit without signaling the already
 * exited ChildProcess handle (which is meaningless and can recursively emit
 * `exit` in process adapters/test doubles). */
function reapExitedProcessGroup(childProcess) {
  if (
    process.platform === "win32" ||
    !Number.isInteger(childProcess?.pid) ||
    childProcess.pid <= 0
  ) {
    return false;
  }
  try {
    process.kill(-childProcess.pid, "SIGKILL");
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

export function parsePairArgs(argv, config) {
  const options = {
    port: parsePort(
      firstDefined(config.portEnv.map((key) => process.env[key])) ?? "3030",
      config.portEnv[0] ?? "VIBESTUDIO_PAIR_PORT"
    ),
    appRoot: null,
    dev: process.env[config.devEnv] === "1",
    autoApprove: false,
    help: false,
    signalUrl: undefined,
    signalSource: "default",
    readyFile: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      throw new Error("Raw server flag forwarding is unsupported");
    } else if (arg === "--port") {
      options.port = parsePort(argv[++i], arg);
    } else if (
      arg === "--host" ||
      arg === "--protocol" ||
      arg === "--public-url" ||
      arg === "--require-public-url"
    ) {
      throw new Error(
        `${arg} is no longer supported; remote reach is WebRTC and the server binds loopback only`
      );
    } else if (arg === "--workspace" || arg === "--workspace-dir") {
      throw new Error(`${arg} is no longer supported; choose a workspace after pairing`);
    } else if (arg === "--app-root") {
      options.appRoot = argv[++i] ?? "";
    } else if (arg === "--signal-url") {
      options.signalUrl = argv[++i] ?? "";
      options.signalSource = "flag";
    } else if (arg === "--ready-file") {
      options.readyFile = argv[++i] ?? "";
      if (!options.readyFile) throw new Error("--ready-file requires a path");
    } else if (arg === "--dev") {
      options.dev = true;
    } else if (arg === "--auto-approve") {
      options.autoApprove = true;
    } else if (arg === "--no-init") {
      throw new Error(
        "--no-init is no longer supported; choose or create a workspace after pairing"
      );
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help) {
    if (options.autoApprove && !options.dev) {
      throw new Error("--auto-approve is development-only; pass --dev as well");
    }
    const resolved = resolveSignalingEndpoint(options.signalUrl);
    options.signalUrl = resolved.url;
    options.signalSource = resolved.source;
  }
  return options;
}

export function printPairHelp(config) {
  console.log(`${config.commandName}

Starts the co-located Vibestudio server (bound to loopback) and prints a pairing
QR/deep link. The device reaches the server over an encrypted WebRTC pipe — the
link carries the signaling room, the server's DTLS fingerprint, and a one-time
pairing code, not a server URL.

Usage:
${config.usage.map((line) => `  ${line}`).join("\n")}

Options:
  --port <port>
      Stable gateway port for the loopback server. Defaults through ${config.portEnv.join(", ")} or 3030.
  --app-root <path>
      Application root passed to the server.
  --signal-url <url>
      WebRTC signaling endpoint. Resolution: flag > ${SIGNAL_ENV[0]} > hosted default.
      Use wss:// or https:// for remote endpoints; ws:// and http:// are only
      accepted for loopback development.
  --ready-file <path>
      Write the structured hub-ready payload to this path. Useful for unattended
      pairing; protect and delete it because initial root invites are one-time secrets.
  --dev
      Use a disposable dev workspace copied fresh from the template and deleted
      when the server exits.
  --auto-approve
      In --dev mode, use the host's existing approval-queue auto-approver. This
      covers tool, credential-use, userland, and startup decisions and is
      intended for unattended system tests only. Prompts that require a human
      to supply a secret or client-config value are denied immediately.
  --help
      Show this help message.

${config.additionalHelp ? `${config.additionalHelp}\n\n` : ""}\
This command starts the server hub (${serverEntryArg()}). Workspaces are chosen
by clients after pairing.
`);
}

export function runPairServer(config, argv = process.argv.slice(2), hooks = {}) {
  const options = parsePairArgs(argv, config);
  if (options.help) {
    printPairHelp(config);
    return;
  }

  // A source-mode server still imports infrastructure package dist exports,
  // loads internal Durable Objects from a compact bundle, and auto-spawns the
  // compiled headless host. Rebuild all three at one boundary so live server
  // source can never silently run against stale transport/runtime binaries.
  if (serverEntryArg() === "src/server/index.ts") {
    if (hooks.prepareSourceServer) {
      hooks.prepareSourceServer({ repoRoot });
    } else {
      const prepared = spawnSync(
        process.execPath,
        [path.join(repoRoot, "build.mjs"), "--source-server-prereqs"],
        {
          cwd: repoRoot,
          env: process.env,
          stdio: "inherit",
        }
      );
      if (prepared.error) throw prepared.error;
      if (prepared.status !== 0) {
        throw new Error(
          `Could not build live source-server prerequisites (exit ${prepared.status ?? "unknown"})`
        );
      }
    }
  }

  let serverArgs = hooks.buildServerArgs
    ? hooks.buildServerArgs(options, LOOPBACK_HOST)
    : buildServerArgs(options, config);
  let ownedReadyDir = null;
  let readyFile = readyFileFromServerArgs(serverArgs);
  if (!readyFile) {
    ownedReadyDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-pair-"));
    readyFile = path.join(ownedReadyDir, "ready.json");
    serverArgs = [...serverArgs, "--ready-file", readyFile];
  }

  hooks.beforeStart?.({ options, serverArgs });

  console.log(`[${config.logPrefix}] Loopback host: ${LOOPBACK_HOST}`);
  console.log(`[${config.logPrefix}] Gateway port: ${options.port}`);
  console.log(`[${config.logPrefix}] Signaling: ${options.signalUrl} (${options.signalSource})`);
  if (options.dev) {
    console.log(`[${config.logPrefix}] Dev workspace: fresh template copy, deleted on exit`);
  }
  if (config.startupHint) console.log(`${config.startupHint}\n`);

  let child = null;
  let restarting = false;
  let buffer = "";
  let stderrBuffer = "";
  const stderrLines = [];
  let hasSpawned = false;
  const baseEnv = {
    ...process.env,
    VIBESTUDIO_HOST: LOOPBACK_HOST,
    VIBESTUDIO_GATEWAY_PORT: String(options.port),
    VIBESTUDIO_WEBRTC_SIGNAL_URL: options.signalUrl,
    ...(options.dev
      ? {
          NODE_ENV: "development",
          VIBESTUDIO_WORKSPACE_EPHEMERAL: "1",
          // `remote serve --dev` promises a disposable copy. pnpm's desktop
          // dev loop intentionally mirrors commits back to the template, but
          // unattended/system-test hosts must never mutate the source checkout.
          VIBESTUDIO_DISABLE_DEV_TEMPLATE_MIRROR: "1",
        }
      : {}),
    ...(options.autoApprove ? { VIBESTUDIO_AUTO_APPROVE: "1" } : {}),
  };
  const env = hooks.buildEnv ? hooks.buildEnv(baseEnv, { options, serverArgs }) : baseEnv;

  // The hub ready file is the only pairing contract. Each complete invite owns
  // its own room/code/link; the CLI never reconstructs or scrapes credentials.
  let desktopInvite = null;
  let mobileInvite = null;
  let bannerPrinted = false;
  let readyPoll = null;
  let readyPollStartedAt = 0;
  let readinessWarningPrinted = false;
  // Our own SIGINT/SIGTERM forwarders, tracked so we can DEINSTALL them before
  // re-raising a child's fatal signal (otherwise the forwarder catches the
  // re-raised signal and the parent lingers / exits 0 instead of dying by signal).
  const signalForwarders = new Map();
  let shutdownSignal = null;

  const deinstallSignalForwarders = () => {
    for (const [sig, handler] of signalForwarders) process.removeListener(sig, handler);
    signalForwarders.clear();
  };

  const cleanupReadyState = () => {
    if (readyPoll !== null) {
      clearInterval(readyPoll);
      readyPoll = null;
    }
    if (ownedReadyDir) {
      try {
        fs.rmSync(ownedReadyDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  };

  const spawnChild = () => {
    buffer = "";
    stderrBuffer = "";
    if (hasSpawned) {
      desktopInvite = null;
      mobileInvite = null;
      bannerPrinted = false;
      readinessWarningPrinted = false;
      if (ownedReadyDir) {
        try {
          fs.unlinkSync(readyFile);
        } catch {
          // It may not have been written yet.
        }
      }
    }
    hasSpawned = true;
    const invocation = createServerInvocation(serverArgs);
    child = hooks.spawnServer
      ? hooks.spawnServer({ serverArgs, env, repoRoot, invocation })
      : spawn(invocation.command, invocation.args, {
          cwd: repoRoot,
          stdio: ["inherit", "pipe", "inherit"],
          env,
          // Keep the child out of the wrapper terminal's foreground process
          // group on POSIX. Otherwise Ctrl-C reaches child and wrapper at the
          // same instant, so workerd can stop before the hub's ordered
          // lifecycle drain. The wrapper remains the sole signal forwarder.
          detached: process.platform !== "win32",
        });
    wireChild(child);
    startReadyPoll();
    return child;
  };

  const applyReadyPayload = (payload) => {
    const ready = parseHubReadyPayload(payload);
    if (ready.rootInvites === null) {
      if (!bannerPrinted) {
        bannerPrinted = true;
        console.log(
          `[${config.logPrefix}] Root account already exists; create invites from a paired device.`
        );
      }
      return;
    }
    desktopInvite = ready.rootInvites.desktop;
    mobileInvite = ready.rootInvites.mobile;
    tryPrintBanner();
  };

  const startReadyPoll = () => {
    if (readyPoll !== null) clearInterval(readyPoll);
    readyPollStartedAt = Date.now();
    readyPoll = setInterval(() => {
      if (!readinessWarningPrinted && Date.now() - readyPollStartedAt >= 60_000) {
        readinessWarningPrinted = true;
        const missing = [
          !fs.existsSync(readyFile) && "hub ready file",
          !desktopInvite && "desktop root invite",
          !mobileInvite && "mobile root invite",
        ].filter(Boolean);
        console.warn(
          `[${config.logPrefix}] Still waiting for pairing material (${missing.join(", ")}). Run \`vibestudio remote doctor\` to check signaling and native WebRTC support.`
        );
      }
      try {
        const stat = fs.statSync(readyFile);
        if (stat.mtimeMs < readyPollStartedAt - 1) return;
        const text = fs.readFileSync(readyFile, "utf8");
        applyReadyPayload(JSON.parse(text));
        if (bannerPrinted) {
          clearInterval(readyPoll);
          readyPoll = null;
        }
      } catch (error) {
        if (fs.existsSync(readyFile)) {
          console.error(
            `[${config.logPrefix}] Invalid hub ready file: ${error instanceof Error ? error.message : String(error)}`
          );
          clearInterval(readyPoll);
          readyPoll = null;
          signalHubGracefully(child, "SIGTERM");
        }
      }
    }, 100);
  };

  const tryPrintBanner = () => {
    if (bannerPrinted) return;
    if (!desktopInvite || !mobileInvite) return;
    printConnectBanner({
      title: config.bannerTitle,
      invite: desktopInvite,
      qrInvite: mobileInvite,
      deepLinkLabel: config.deepLinkLabel,
      instructions: config.instructions,
    });
    bannerPrinted = true;
  };

  const control = {
    get child() {
      return child;
    },
    get options() {
      return options;
    },
    get serverArgs() {
      return serverArgs;
    },
    get env() {
      return env;
    },
    async restart(beforeRestart) {
      if (restarting) return false;
      restarting = true;
      try {
        await beforeRestart?.();
        await new Promise((resolve) => {
          const current = child;
          if (!current) {
            resolve(undefined);
            return;
          }
          current.once("exit", () => resolve(undefined));
          signalHubGracefully(current, "SIGTERM");
        });
        restarting = false;
        spawnChild();
        return true;
      } catch (error) {
        restarting = false;
        hooks.onRestartError?.(error, control);
        return false;
      }
    },
  };

  const handleLine = (line) => {
    const handled = hooks.onServerLine?.(line, control);
    if (handled) return;
    if (hooks.onServerLine) process.stdout.write(`${line}\n`);

    // Pairing state is consumed exclusively from the structured ready file.
    // Server output remains diagnostic text, never a second protocol.
  };

  const wireChild = (childProcess) => {
    childProcess.stdout?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk) => {
      if (!hooks.onServerLine) process.stdout.write(chunk);
      buffer += chunk;
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line);
      }
    });
    childProcess.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrBuffer += chunk;
      let newlineIdx;
      while ((newlineIdx = stderrBuffer.indexOf("\n")) !== -1) {
        const line = stderrBuffer.slice(0, newlineIdx);
        stderrBuffer = stderrBuffer.slice(newlineIdx + 1);
        stderrLines.push(line);
        if (stderrLines.length > 50) stderrLines.shift();
      }
    });

    childProcess.on("exit", (code, signal) => {
      if (restarting) return;
      // A clean hub has already drained its children. An abnormal exit may
      // leave descendants in the detached hub group, so reap only that crash
      // path; signaling an already-clean test/process handle can itself emit a
      // second exit event.
      if (signal !== null || code !== 0) {
        try {
          reapExitedProcessGroup(childProcess);
        } catch (error) {
          console.warn(
            `[${config.logPrefix}] Failed to reap crashed server process group: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      cleanupReadyState();
      deinstallSignalForwarders();
      if (stderrBuffer) stderrLines.push(stderrBuffer);
      if (hooks.onChildExit?.({ code, signal, stderrLines }, control)) return;
      if (signal) {
        // Re-raise so our exit status reflects the child's fatal signal. Deinstall
        // our forwarders first (documented default-action pattern) so the signal
        // performs its default terminate action instead of being swallowed.
        process.kill(process.pid, signal);
      } else {
        process.exit(code ?? 0);
      }
    });
  };

  spawnChild();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      cleanupReadyState();
      const repeated = shutdownSignal !== null;
      shutdownSignal ??= sig;
      console.log(
        `[${config.logPrefix}] ${repeated ? "Repeating" : "Requesting"} ordered hub shutdown (${sig})`
      );
      // The spawned command is the hub itself (server-entry.mjs deliberately
      // avoids package-manager/shell ancestors). A repeated signal reaches the
      // hub's child-tree escalation path; no elapsed-time cutoff substitutes
      // for actual process ownership.
      signalHubGracefully(child, sig);
    };
    signalForwarders.set(sig, handler);
    process.on(sig, handler);
  }
}

function buildServerArgs(options, config = {}) {
  const args = [
    serverEntryArg(),
    "--host",
    LOOPBACK_HOST,
    "--gateway-port",
    String(options.port),
    "--serve-panels",
  ];

  if (options.dev) args.push("--ephemeral");
  if (options.appRoot) args.push("--app-root", options.appRoot);
  if (options.readyFile) args.push("--ready-file", path.resolve(options.readyFile));
  if (config.requireMobileReady) args.push("--require-mobile-ready");
  if (config.requireElectronReady) args.push("--require-electron-ready");
  return args;
}

function readyFileFromServerArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--ready-file") return args[i + 1] ?? null;
    if (arg.startsWith("--ready-file=")) return arg.slice("--ready-file=".length) || null;
  }
  return null;
}

function firstDefined(values) {
  return values.find((value) => value !== undefined && value !== "");
}

function resolveSignalingEndpoint(raw) {
  return resolveSignalingUrl({
    flag: raw,
    env: process.env,
    envKeys: SIGNAL_ENV,
  });
}
