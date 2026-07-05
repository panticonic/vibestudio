import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSignalingEndpoint, printConnectBanner } from "./connect-utils.mjs";
import { createServerInvocation, serverEntryArg } from "./server-entry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Loopback host the co-located server binds. Remote reach is WebRTC (the QR
// carries room/fp/sig); there is no LAN/Tailscale/public-URL origin anymore.
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_SIGNAL_ENV = ["VIBESTUDIO_WEBRTC_SIGNAL_URL"];

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

export function parsePairArgs(argv, config) {
  const signalEnv = signalEnvFor(config);
  const configuredSignalUrl = firstDefined(signalEnv.map((key) => process.env[key]));
  const options = {
    port: parsePort(
      firstDefined(config.portEnv.map((key) => process.env[key])) ?? "3030",
      config.portEnv[0] ?? "VIBESTUDIO_PAIR_PORT"
    ),
    appRoot: null,
    dev: process.env[config.devEnv] === "1",
    help: false,
    signalUrl: configuredSignalUrl ?? null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      throw new Error("Forwarding raw server flags is no longer supported");
    } else if (arg === "--port" || arg === "--gateway-port") {
      options.port = parsePort(argv[++i], arg);
    } else if (arg === "--host" || arg === "--protocol" || arg === "--public-url" || arg === "--require-public-url") {
      throw new Error(
        `${arg} is no longer supported; remote reach is WebRTC and the server binds loopback only`
      );
    } else if (arg === "--workspace" || arg === "--workspace-dir") {
      throw new Error(`${arg} is no longer supported; choose a workspace after pairing`);
    } else if (arg === "--app-root") {
      options.appRoot = argv[++i] ?? "";
    } else if (arg === "--signal-url" || arg === "--signaling-url") {
      options.signalUrl = argv[++i] ?? "";
    } else if (arg === "--dev" || arg === "--ephemeral") {
      options.dev = true;
    } else if (arg === "--no-init") {
      throw new Error("--no-init is no longer supported; choose or create a workspace after pairing");
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help) {
    options.signalUrl = resolveSignalingEndpoint(options.signalUrl, signalEnv);
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
  --port, --gateway-port <port>
      Stable gateway port for the loopback server. Defaults through ${config.portEnv.join(", ")} or 3030.
  --app-root <path>
      Application root passed to the server.
  --signal-url, --signaling-url <url>
      WebRTC signaling endpoint. Defaults through ${signalEnvFor(config).join(", ")}.
      Use wss:// or https:// for remote endpoints; ws:// and http:// are only
      accepted for loopback development.
  --dev, --ephemeral
      Use a disposable dev workspace copied fresh from the template and deleted
      when the server exits.
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
  console.log(`[${config.logPrefix}] Signaling: ${options.signalUrl}`);
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
    ...(options.dev ? { NODE_ENV: "development", VIBESTUDIO_WORKSPACE_EPHEMERAL: "1" } : {}),
  };
  const env = hooks.buildEnv ? hooks.buildEnv(baseEnv, { options, serverArgs }) : baseEnv;

  // WebRTC pairing material advertised by the running server (the seam between
  // the server's WebRTC cert + per-invite rooms and this banner). `room`/`fp`/
  // `sig` come from the server; until all three plus a pairing code arrive the
  // banner waits. `deepLink`/`qrDeepLink` are the server's OWN per-invite links
  // (v=2: each invite has its own room, so codes must not be recombined with
  // another invite's room locally).
  let pairing = { room: null, fp: null, sig: null };
  let pairingCode = null;
  let qrPairingCode = null;
  let deepLink = null;
  let qrDeepLink = null;
  let bannerPrinted = false;
  let readyPoll = null;
  let readyPollStartedAt = 0;

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
      pairing = { room: null, fp: null, sig: null };
      pairingCode = null;
      qrPairingCode = null;
      deepLink = null;
      qrDeepLink = null;
      bannerPrinted = false;
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
        });
    wireChild(child);
    startReadyPoll();
    return child;
  };

  const applyReadyPayload = (payload) => {
    const advertised = payload?.pairing;
    if (advertised && typeof advertised === "object") {
      if (typeof advertised.room === "string" && advertised.room) pairing.room = advertised.room;
      if (typeof advertised.fp === "string" && advertised.fp) pairing.fp = advertised.fp;
      if (typeof advertised.sig === "string" && advertised.sig) pairing.sig = advertised.sig;
      if (typeof advertised.deepLink === "string" && advertised.deepLink) {
        deepLink = advertised.deepLink;
      }
      if (typeof advertised.qrDeepLink === "string" && advertised.qrDeepLink) {
        qrDeepLink = advertised.qrDeepLink;
      }
    }
    if (typeof payload?.pairingCode === "string" && payload.pairingCode) {
      pairingCode = payload.pairingCode;
    }
    if (typeof payload?.qrPairingCode === "string" && payload.qrPairingCode) {
      qrPairingCode = payload.qrPairingCode;
    } else if (typeof payload?.pairingCodes?.qr === "string" && payload.pairingCodes.qr) {
      qrPairingCode = payload.pairingCodes.qr;
    } else if (typeof payload?.pairingCodes?.mobile === "string" && payload.pairingCodes.mobile) {
      qrPairingCode = payload.pairingCodes.mobile;
    }
    tryPrintBanner();
  };

  const startReadyPoll = () => {
    if (readyPoll !== null) clearInterval(readyPoll);
    readyPollStartedAt = Date.now();
    readyPoll = setInterval(() => {
      try {
        const stat = fs.statSync(readyFile);
        if (stat.mtimeMs < readyPollStartedAt - 1) return;
        const text = fs.readFileSync(readyFile, "utf8");
        applyReadyPayload(JSON.parse(text));
        if (bannerPrinted) {
          clearInterval(readyPoll);
          readyPoll = null;
        }
      } catch {
        // The server writes readiness after startup settles; stdout remains a fallback.
      }
    }, 100);
  };

  const tryPrintBanner = () => {
    if (bannerPrinted) return;
    if (!pairing.room || !pairing.fp || !pairing.sig || !pairingCode) return;
    bannerPrinted = true;
    printConnectBanner({
      title: config.bannerTitle,
      pairing: { room: pairing.room, fp: pairing.fp, sig: pairing.sig, code: pairingCode },
      qrPairingCode,
      deepLink,
      qrDeepLink,
      deepLinkLabel: config.deepLinkLabel,
      instructions: config.instructions,
    });
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
          if (!current || current.killed) {
            resolve(undefined);
            return;
          }
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(termTimer);
            clearTimeout(killTimer);
            resolve(undefined);
          };
          const termTimer = setTimeout(() => {
            current.kill("SIGKILL");
          }, hooks.shutdownTimeoutMs ?? 5_000);
          const killTimer = setTimeout(finish, (hooks.shutdownTimeoutMs ?? 5_000) + 2_000);
          current.once("exit", finish);
          current.kill("SIGTERM");
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

    const roomMatch = line.match(/VIBESTUDIO_PAIRING_ROOM=(\S+)/);
    if (roomMatch) pairing.room = roomMatch[1];
    const fpMatch = line.match(/VIBESTUDIO_PAIRING_FP=(\S+)/);
    if (fpMatch) pairing.fp = fpMatch[1];
    const sigMatch = line.match(/VIBESTUDIO_PAIRING_SIG=(\S+)/);
    if (sigMatch) pairing.sig = sigMatch[1];
    const pairingMatch = line.match(/(?:VIBESTUDIO_PAIRING_CODE=|Pairing code:\s+)([A-Za-z0-9_-]+)/);
    if (pairingMatch) pairingCode = pairingMatch[1];
    const qrPairingMatch = line.match(
      /(?:VIBESTUDIO_QR_PAIRING_CODE=|QR pairing code:\s+)([A-Za-z0-9_-]+)/
    );
    if (qrPairingMatch) qrPairingCode = qrPairingMatch[1];

    tryPrintBanner();
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
      cleanupReadyState();
      if (stderrBuffer) stderrLines.push(stderrBuffer);
      if (hooks.onChildExit?.({ code, signal, stderrLines }, control)) return;
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
  };

  spawnChild();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      cleanupReadyState();
      child?.kill(sig);
    });
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
    "--print-credentials",
  ];

  if (options.dev) args.push("--ephemeral");
  if (options.appRoot) args.push("--app-root", options.appRoot);
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

function signalEnvFor(config) {
  return Array.isArray(config.signalEnv) && config.signalEnv.length > 0
    ? config.signalEnv
    : DEFAULT_SIGNAL_ENV;
}

function resolveSignalingEndpoint(raw, signalEnv) {
  if (!raw) {
    throw new Error(
      `Missing WebRTC signaling endpoint. Set ${signalEnv.join(
        " or "
      )} or pass --signal-url <wss://...>. Pairing cannot start without signaling because the server would not start its WebRTC answerer.`
    );
  }
  const parsed = parseSignalingEndpoint(raw);
  if (parsed.kind === "error") {
    throw new Error(`Invalid WebRTC signaling endpoint: ${parsed.reason}`);
  }
  return parsed.url;
}
