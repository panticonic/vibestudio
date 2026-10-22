import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { printConnectBanner } from "./connect-banner.mjs";
import { parseHubReadyPayload, rootBootstrapPairingInvite } from "./hub-ready.mjs";
import { createServerInvocation, serverEntryArg } from "./server-entry.mjs";
import { hostArtifactRootForServerEntry } from "../../host-build-generations.mjs";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership } from "@vibestudio/shared/ownership";
import { prepareWorkspaceRelease } from "../../prepare-workspace-release.mjs";
import { flagValue } from "./args.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Loopback host the co-located gateway binds. Remote reach is the Iroh endpoint.
const LOOPBACK_HOST = "127.0.0.1";

const TEMPLATE_RELEASE_ARTIFACT = "workspace-template-release.json";

/** True when this host build already carries exact Base/Personal/System template pins. */
export function hostBuildHasWorkspaceTemplatePins(appRoot) {
  for (const dir of ["resources", "build-resources"]) {
    const candidate = path.join(appRoot, dir, TEMPLATE_RELEASE_ARTIFACT);
    if (!fs.existsSync(candidate)) continue;
    try {
      if (JSON.parse(fs.readFileSync(candidate, "utf8")).workspaceTemplates) return true;
    } catch {
      // A malformed artifact is the server's to report, not ours to swallow.
      return true;
    }
  }
  return false;
}

/**
 * Name the exact templates a workspace is created from.
 *
 * A packaged app carries them in its release artifact. A source checkout does
 * not, so pairing would succeed and then the first `hubControl.ensureUserWorkspaces`
 * would fail before workspace creation—after the one-time invite was already
 * spent. Resolve the
 * configured development templates instead, exactly as the desktop dev launcher does,
 * so `remote serve` works the same way in both.
 */
function developmentWorkspaceTemplateEnv(appRoot, checkpointTarget) {
  if (process.env["VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES"]) return {};
  if (process.env.VIBESTUDIO_SERVER_ENTRY !== "live" && hostBuildHasWorkspaceTemplatePins(appRoot))
    return {};
  const resolver = path.join(repoRoot, "scripts", "resolve-development-templates.ts");
  if (!fs.existsSync(resolver)) return {};
  const resolved = spawnSync(
    process.execPath,
    ["--import", "tsx", resolver, "--checkpoint-root", checkpointTarget],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (resolved.error) throw resolved.error;
  if (resolved.status !== 0) {
    throw new Error(
      `Could not resolve development templates for pairing (exit ${resolved.status ?? "unknown"}).` +
        `${resolved.stderr ? `\n${resolved.stderr}` : ""}`
    );
  }
  const selection = JSON.parse(resolved.stdout.trim());
  // No development templates are selected; the workspace runtime uses its pinned release.
  if (!selection) return {};
  return {
    VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(selection.pins),
    VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(selection.pins.system),
    VIBESTUDIO_WORKSPACE_SOURCES: JSON.stringify(
      Object.keys(selection.pins).map((name) => ({
        pin: selection.pins[name],
        checkout: selection.checkouts[name],
      }))
    ),
  };
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
    help: false,
    relayUrls: [],
    readyFile: null,
    bootstrapWorkspace: null,
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
        `${arg} is no longer supported; remote reach is Iroh and the gateway binds loopback only`
      );
    } else if (arg === "--workspace" || arg === "--workspace-dir") {
      throw new Error(`${arg} is no longer supported; choose a workspace after pairing`);
    } else if (arg === "--app-root") {
      options.appRoot = flagValue(argv, ++i, arg);
    } else if (arg === "--ready-file") {
      const readyFile = flagValue(argv, ++i, arg);
      if (!readyFile) throw new Error("--ready-file requires a path");
      options.readyFile = path.resolve(readyFile);
    } else if (arg === "--bootstrap-workspace") {
      const workspace = flagValue(argv, ++i, arg);
      if (!workspace) throw new Error("--bootstrap-workspace requires a name");
      options.bootstrapWorkspace = workspace;
    } else if (arg === "--relay-url") {
      const relay = flagValue(argv, ++i, arg);
      const url = new URL(relay);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new Error("--relay-url requires a canonical HTTPS relay URL");
      }
      options.relayUrls.push(url.toString());
    } else if (arg === "--dev") {
      options.dev = true;
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
    if (options.dev && options.bootstrapWorkspace) {
      throw new Error("--dev and --bootstrap-workspace are mutually exclusive");
    }
    if (new Set(options.relayUrls).size !== options.relayUrls.length) {
      throw new Error("--relay-url values must be unique");
    }
  }
  return options;
}

export function printPairHelp(config) {
  console.log(`${config.commandName}

Starts the co-located Vibestudio server (bound to loopback) and prints a pairing
QR/deep link. The device reaches the server over an end-to-end encrypted Iroh
connection. The link carries the server Endpoint ID, ordered relay set, and a
one-time pairing code, not a public server URL.

Usage:
${config.usage.map((line) => `  ${line}`).join("\n")}

Options:
  --port <port>
      Stable gateway port for the loopback server. Defaults through ${config.portEnv.join(", ")} or 3030.
  --app-root <path>
      Application root passed to the server.
  --relay-url <url>
      Add one production Iroh relay URL. Repeat to define the ordered relay set.
      When omitted, VIBESTUDIO_IROH_RELAYS or the shipped relay set is used.
  --ready-file <path>
      Write the structured hub-ready payload to this path. Useful for unattended
      pairing; suppresses the QR/link on stdout. Protect and delete the file
      because initial root invites are one-time secrets.
  --bootstrap-workspace <name>
      Register a named source workspace and preserve its state across server restarts.
  --dev
      Serve from a fresh template copy and never mirror commits back to the
      source checkout. Clients create their own workspaces when they pair.
  --help
      Show this help message.

${config.additionalHelp ? `${config.additionalHelp}\n\n` : ""}\
This command starts the server hub (compiled host generation). Workspaces are chosen
by clients after pairing.
`);
}

export async function runPairServer(config, argv = process.argv.slice(2), hooks = {}) {
  const options = parsePairArgs(argv, config);
  if (options.help) {
    printPairHelp(config);
    return;
  }
  // The hub, its handoff directory and its preparation scratch belong to this
  // process's ownership: its reaper retires them even if this wrapper is killed.
  const ownership = await Ownership.open({ profileDir: getProfileDataPath(), lifetime: "leased" });
  try {
    await serve(ownership, config, options, hooks);
  } catch (error) {
    // The server never took over: nothing else will release the ownership.
    try {
      await ownership.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, ...(releaseError instanceof AggregateError ? releaseError.errors : [releaseError])],
        "Server startup failed and its resources did not retire cleanly",
        { cause: error }
      );
    }
    throw error;
  }
}

async function serve(ownership, config, options, hooks) {
  // A source-mode server still imports infrastructure package dist exports,
  // loads internal Durable Objects from a compact bundle, and auto-spawns the
  // compiled headless host. Rebuild all three at one boundary so live server
  // source can never silently run against stale transport/runtime binaries.
  // Resolved after any rebuild below: a live source entry names the current
  // source generation, and that generation is published by the rebuild. Asking
  // for it first reads a file that does not exist yet.
  let hostArtifactRoot = null;
  if (process.env.VIBESTUDIO_SERVER_ENTRY === "live") {
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
    // The rebuild above published the generation this entry runs from.
    hostArtifactRoot = hostArtifactRootForServerEntry(repoRoot, serverEntryArg(repoRoot));
  }

  let serverArgs = buildServerArgs(options);
  let ownedReadyDir = null;
  const checkpointRoot = await ownership.scratch("pair-prep-");
  let readyFile = readyFileFromServerArgs(serverArgs);
  if (!readyFile) {
    ownedReadyDir = await ownership.scratch("pair-");
    readyFile = path.join(ownedReadyDir, "ready.json");
    serverArgs = [...serverArgs, "--ready-file", readyFile];
  }
  // With an explicit ready path, the caller has selected a protected machine
  // handoff. Do not duplicate its rotating secret onto stdout (and, for a
  // managed service, into journald). Foreground sessions without one still get
  // the human QR/link banner from their wrapper-owned temporary handoff.
  const printPairingBanner = ownedReadyDir !== null;
  // A caller-owned ready path survives process lifetimes. Remove the previous
  // process's payload before spawning so a management command can never expose
  // a stale invite while the replacement hub is still starting.
  try {
    fs.unlinkSync(readyFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await hooks.beforeStart?.({ options, serverArgs });

  console.log(`[${config.logPrefix}] Loopback host: ${LOOPBACK_HOST}`);
  console.log(`[${config.logPrefix}] Gateway port: ${options.port}`);
  console.log(
    `[${config.logPrefix}] Iroh relays: ${
      options.relayUrls.length > 0 ? options.relayUrls.join(", ") : "configured default"
    }`
  );
  if (options.dev) {
    console.log(`[${config.logPrefix}] Dev mode: fresh template copy, source checkout untouched`);
  }
  if (config.startupHint) console.log(`${config.startupHint}\n`);

  let child = null;
  // The ownership record of `child`, absent when a test hook supplied it.
  let ownedServer = null;
  let restarting = false;
  let buffer = "";
  let stderrBuffer = "";
  const stderrLines = [];
  let hasSpawned = false;
  const workspaceTemplateEnv = hooks.developmentWorkspaceTemplateEnv
    ? hooks.developmentWorkspaceTemplateEnv({ repoRoot, options })
    : developmentWorkspaceTemplateEnv(
        options.appRoot ?? repoRoot,
        path.join(checkpointRoot, "base")
      );
  const baseEnv = {
    ...process.env,
    ...workspaceTemplateEnv,
    VIBESTUDIO_HOST_ARTIFACT_ROOT:
      hostArtifactRoot ?? hostArtifactRootForServerEntry(repoRoot, serverEntryArg(repoRoot)),
    VIBESTUDIO_GATEWAY_PORT: String(options.port),
    ...(options.relayUrls.length > 0
      ? { VIBESTUDIO_IROH_RELAYS: options.relayUrls.join(",") }
      : {}),
    ...(options.dev
      ? {
          NODE_ENV: "development",
          // `remote serve --dev` promises a disposable copy. pnpm's desktop
          // dev loop intentionally mirrors commits back to the template, but
          // unattended/system-test hosts must never mutate the source checkout.
          VIBESTUDIO_DISABLE_DEV_TEMPLATE_MIRROR: "1",
        }
      : {}),
  };
  const env = hooks.buildEnv ? hooks.buildEnv(baseEnv, { options, serverArgs }) : baseEnv;

  // The hub ready file is the only pairing contract. One complete invite owns
  // the endpoint reach, code, and both presentation links; the CLI never reconstructs it.
  let rootInvite = null;
  let lastPrintedInviteCode = null;
  let rootStatusPrinted = false;
  let readyPoll = null;
  let readyPollStartedAt = 0;
  let readinessWarningPrinted = false;
  // Our own SIGINT/SIGTERM forwarders, tracked so we can DEINSTALL them before
  // re-raising a child's fatal signal (otherwise the forwarder catches the
  // re-raised signal and the parent lingers / exits 0 instead of dying by signal).
  const signalForwarders = new Map();
  let shutdownSignal = null;
  let preparation, preparationFailure;
  let ending = false;

  const deinstallSignalForwarders = () => {
    for (const [sig, handler] of signalForwarders) process.removeListener(sig, handler);
    signalForwarders.clear();
  };

  const stopReadyPoll = () => {
    if (readyPoll !== null) {
      clearTimeout(readyPoll);
      readyPoll = null;
    }
  };

  const spawnChild = () => {
    buffer = "";
    stderrBuffer = "";
    if (hasSpawned) {
      rootInvite = null;
      lastPrintedInviteCode = null;
      rootStatusPrinted = false;
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
    if (hooks.spawnServer) {
      child = hooks.spawnServer({ serverArgs, env, repoRoot, invocation });
    } else {
      // Owned groups run outside the wrapper terminal's foreground process
      // group on POSIX. Otherwise Ctrl-C reaches child and wrapper at the
      // same instant, so workerd can stop before the hub's ordered lifecycle
      // drain. The wrapper remains the sole signal forwarder. If this wrapper
      // dies, the reaper stops the hub gracefully and kills what it leaves.
      ownedServer = ownership.spawn(invocation.command, invocation.args, {
        kill: "graceful",
        label: "hub",
        cwd: repoRoot,
        env,
        stdio: ["inherit", "pipe", "inherit"],
      });
      child = ownedServer.child;
    }
    wireChild(child);
    startReadyPoll();
    return child;
  };

  const applyReadyPayload = (payload) => {
    const ready = parseHubReadyPayload(payload);
    if (ready.rootInvite === null) {
      rootInvite = null;
      if (!rootStatusPrinted) {
        rootStatusPrinted = true;
        console.log(
          `[${config.logPrefix}] Root account already exists; create invites from a paired device.`
        );
      }
      return false;
    }
    rootStatusPrinted = false;
    rootInvite = rootBootstrapPairingInvite(ready.rootInvite);
    tryPrintBanner();
    return true;
  };

  const startReadyPoll = () => {
    if (readyPoll !== null) clearTimeout(readyPoll);
    readyPollStartedAt = Date.now();
    const poll = () => {
      readyPoll = null;
      // Keep polling until the first valid ready payload. A null root invite is
      // the only terminal state; a live invite stays watched for hourly rotation.
      let keepWatching = true;
      if (!readinessWarningPrinted && Date.now() - readyPollStartedAt >= 60_000) {
        readinessWarningPrinted = true;
        const missing = [
          !fs.existsSync(readyFile) && "hub ready file",
          !rootInvite && "root invite",
        ].filter(Boolean);
        console.warn(
          `[${config.logPrefix}] Still waiting for pairing material (${missing.join(", ")}). Run \`vibestudio remote doctor\` to check relay configuration and the Iroh native binding.`
        );
      }
      try {
        const stat = fs.statSync(readyFile);
        if (stat.mtimeMs >= readyPollStartedAt - 1) {
          const text = fs.readFileSync(readyFile, "utf8");
          keepWatching = applyReadyPayload(JSON.parse(text));
        }
      } catch (error) {
        // The hub replaces the ready file atomically. A poll can stat the old
        // inode immediately before the rename and then try to open the path in
        // the tiny interval where it does not exist. That is readiness still in
        // progress, not a malformed contract; the replacement will be read on
        // the next tick.
        if (error?.code === "ENOENT") {
          readyPoll = setTimeout(poll, rootInvite ? 1_000 : 100);
          return;
        }
        if (fs.existsSync(readyFile)) {
          console.error(
            `[${config.logPrefix}] Invalid hub ready file: ${error instanceof Error ? error.message : String(error)}`
          );
          signalHubGracefully(child, "SIGTERM");
          return;
        }
      }
      if (keepWatching) readyPoll = setTimeout(poll, 1_000);
    };
    readyPoll = setTimeout(poll, 100);
  };

  const tryPrintBanner = () => {
    if (!rootInvite) return;
    if (!printPairingBanner) return;
    if (lastPrintedInviteCode === rootInvite.code) return;
    printConnectBanner({
      title: config.bannerTitle,
      invite: rootInvite,
      qrInvite: rootInvite,
      deepLinkLabel: config.deepLinkLabel,
      instructions: config.instructions,
    });
    lastPrintedInviteCode = rootInvite.code;
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
        // The old hub is gone; retire whatever its group still holds first.
        await ownedServer?.join();
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

    childProcess.on("exit", async (code, signal) => {
      if (restarting) return;
      ending = true;
      try {
        await preparation?.stop();
      } catch (error) {
        console.error(error);
        code = 1;
      }
      stopReadyPoll();
      // The hub has exited: the ownership kills whatever its group still holds
      // (descendants of a crash) and removes the handoff and scratch directories.
      try {
        await ownership.release();
      } catch (error) {
        console.error(error);
        code = 1;
      }
      if (preparationFailure) code = 1;
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

  if (process.env.VIBESTUDIO_SERVER_ENTRY === "live") {
    try {
      const preparationRoot = checkpointRoot;
      preparation = (hooks.prepareWorkspaceRelease ?? prepareWorkspaceRelease)({
        ownership,
        executable: process.execPath,
        entry: path.join(env.VIBESTUDIO_HOST_ARTIFACT_ROOT, "prepare-workspace-templates.mjs"),
        appRoot: options.appRoot ?? repoRoot,
        output: path.join(preparationRoot, "release"),
        scratch: path.join(preparationRoot, "scratch"),
        env,
      });
      await preparation.completed;
    } catch (error) {
      await preparation?.stop();
      throw error;
    }
  }
  try {
    spawnChild();
    void preparation?.completed.catch((error) => {
      if (ending) return;
      preparationFailure = error;
      console.error(error);
      signalHubGracefully(child, "SIGTERM");
    });
  } catch (error) {
    await preparation?.stop();
    stopReadyPoll();
    throw error;
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
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

function buildServerArgs(options) {
  const args = [serverEntryArg(repoRoot), "--gateway-port", String(options.port)];

  if (options.bootstrapWorkspace) {
    args.push("--bootstrap-workspace", options.bootstrapWorkspace);
  }
  args.push("--app-root", options.appRoot ?? repoRoot);
  if (options.readyFile) args.push("--ready-file", path.resolve(options.readyFile));
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
