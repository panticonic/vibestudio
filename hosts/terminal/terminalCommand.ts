import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatRpcFailure } from "@vibestudio/rpc";
import { isConnectPairingInput } from "@vibestudio/shared/connect";
import type {
  TerminalBrowserExit,
  TerminalBrowserServerInfo,
} from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import type { CliCommand, ParsedInvocation } from "../../src/cli/commandTable.js";
import { cliConfigRoot } from "../../src/cli/configPaths.js";
import {
  credentialPath,
  loadCliCredentials,
  loadCliIdentity,
  requireDeviceCliIdentity,
  requireDeviceCliCredentials,
  saveCliCredentials,
  type CliDeviceCredentials,
  type CliDeviceIdentity,
} from "../../src/cli/credentialStore.js";
import { pairLocalCli } from "../../src/cli/localPairing.js";
import {
  AuthError,
  CliError,
  ConnectionError,
  UsageError,
  printError,
  redactCliSecrets,
} from "../../src/cli/output.js";
import {
  pairRemoteServer,
  selectRemoteWorkspace,
  serverEndpoint,
} from "../../src/cli/remoteClient.js";
import { refreshShell } from "../../src/cli/rpcClient.js";
import { EXIT_INTERRUPTED } from "./terminalLaunchGate.js";
import { createLaunchProgress, runStep } from "./launchProgress.js";
import { localServerPaths, startLocalServer, type LocalServer } from "./localServer.js";
import { runTerminalSessions } from "./terminalSessions.js";
import { routeProcessWarnings, tolerateTerminalHangup } from "./ttyRestore.js";
import { LaunchTermination } from "../../src/dev/launchTermination.js";
import {
  hasOwnershipFailure,
  runOwnedCleanupSteps,
  runWithOwnedCleanup,
} from "../../scripts/lib/owned-cleanup.mjs";

export interface TerminalCommandContext {
  /** Exact application root of this installation (contains `dist/server.mjs`). */
  appRoot: string;
}

const DETAILS = `How it connects:
  * Paired with a server (\`vibestudio remote pair\`): opens the terminal browser
    against it, locally or over an encrypted Iroh link.
  * Paired with this machine's local server, or not paired at all: starts the
    local server in the background, pairs this terminal with it on first use,
    and stops it again when you quit. Its state lives in the Vibestudio config
    directory, so conversations survive restarts; its output goes to a log
    file, never to your terminal.

The terminal browser shows your Personal workspace (another one with
--workspace, or switch inside it with Ctrl-B w). Like the desktop app, the
browser itself is installed in your System workspace; before it takes over
the screen, its startup approvals are asked here as questions; answer them or
pass --yes.

Diagnostics of the command itself go to logs/terminal.log in the Vibestudio
config directory.

To use a different server, run \`vibestudio remote logout\` and pair again.`;

/** `vibestudio terminal`: start or attach to a server and open the terminal browser. */
export function createTerminalCommand(context: TerminalCommandContext): CliCommand {
  return {
    group: "terminal",
    name: "",
    summary: "Open the terminal browser (starts a local server when needed)",
    usage:
      'vibestudio terminal ["<pairing-link>" [--label <name>]] [--workspace <name>] [--yes] [--keep-server]',
    flags: [
      {
        name: "workspace",
        takesValue: true,
        description: "Show this workspace (default: your Personal workspace)",
      },
      {
        name: "yes",
        takesValue: false,
        description: "Approve each startup approval once without asking",
      },
      {
        name: "keep-server",
        takesValue: false,
        description: "Leave a server this command started running after you quit",
      },
      {
        name: "label",
        takesValue: true,
        description: "Device label when pairing with a link (default: Terminal on <host>)",
      },
    ],
    details: DETAILS,
    run: (inv) => runTerminalCommand(inv, context),
  };
}

async function runTerminalCommand(
  inv: ParsedInvocation,
  context: TerminalCommandContext
): Promise<number> {
  // First, before any await: the terminal is the user's, so this command's own
  // warnings — including those raised while the CLI loaded, which Node emits
  // on the next tick — go to its log.
  const releaseWarnings = routeProcessWarnings(appendTerminalLog);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  // A hang-up stops the server this command owns (the supervisor forwards
  // SIGHUP); the dead terminal must not crash the command while it joins it.
  tolerateTerminalHangup();
  let server: LocalServer | null = null;
  const termination = new LaunchTermination();
  try {
    return await runWithOwnedCleanup(
      async () => {
        try {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new UsageError(
              "vibestudio terminal needs an interactive terminal: stdin and stdout must both be a TTY."
            );
          }
          const options = parseOptions(inv);
          const existing = await pairFromLink(options, out, termination.signal);
          const reusable =
            existing && !(await needsLocalServer(existing, termination.signal)) ? existing : null;
          // Starting a local server adds two steps to the two that every launch has.
          const progress = createLaunchProgress({ write: out, total: reusable ? 2 : 4 });
          let credentials: CliDeviceCredentials;
          if (reusable) {
            credentials =
              reusable.phase === "workspace"
                ? reusable
                : await selectRemoteWorkspace(
                    reusable,
                    { privateRole: reusable.transport === "local" ? "system" : "personal" },
                    { signal: termination.signal }
                  );
            saveCliCredentials(credentials);
          } else {
            const paths = localServerPaths();
            const reconnecting = existing !== null;
            out(`  state: ${cliConfigRoot()}`);
            out(`  log:   ${paths.logFile}`);
            // Ctrl-C before the browser starts stops the server we own and ends startup.
            const started = await runStep(
              progress,
              reconnecting
                ? "Starting the local Vibestudio server"
                : "Not paired with a server yet: starting a local Vibestudio server",
              () =>
                startLocalServer({
                  hostArtifactRoot:
                    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] ??
                    path.join(context.appRoot, "dist"),
                  appRoot: process.env["VIBESTUDIO_APP_ROOT"] ?? context.appRoot,
                  env: process.env,
                  retain: options.keepServer,
                  signal: termination.signal,
                })
            );
            server = started;
            credentials = await runStep(
              progress,
              reconnecting ? "Reconnecting to the local server" : "Pairing this terminal",
              () => pairWithLocalServer(started, termination.signal)
            );
          }
          const serverInfo = describeServer(credentials, server);
          const exit = await runTerminalSessions({
            credentials,
            ...(options.workspace ? { workspace: options.workspace } : {}),
            server: serverInfo,
            ...(server && !server.retained ? { serverExited: server.exited } : {}),
            yes: options.yes,
            stdin: process.stdin,
            stdout: process.stdout,
            progress,
            signal: termination.signal,
          });
          return reportTerminalExit(exit, server?.logFile);
        } catch (error) {
          if (termination.requested && isTerminalCancellation(error, termination.signal)) {
            process.stderr.write("Interrupted.\n");
            return termination.requested === "SIGINT"
              ? EXIT_INTERRUPTED
              : 128 + (os.constants.signals[termination.requested] ?? 0);
          }
          return printTerminalError(error, server?.logFile);
        }
      },
      () =>
        runOwnedCleanupSteps(
          [
            async () => {
              if (server) await retireServer(server, out);
            },
            async () => releaseWarnings(),
          ],
          "Terminal command retirement failed"
        ),
      "Terminal command and retirement failed"
    );
  } finally {
    termination.dispose();
  }
}

/** Cancellation is an operation outcome, not permission to discard a failure
 * that happened before it or an error from retiring the owned resources. */
export function isTerminalCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted || hasOwnershipFailure(error)) return false;
  const seen = new Set<unknown>();
  while (!seen.has(error)) {
    seen.add(error);
    if (error === signal.reason) return true;
    if (!(error instanceof Error) || error instanceof AggregateError) return false;
    error = error.cause;
  }
  return false;
}

/** Where `vibestudio terminal` writes its own diagnostics. */
function terminalLogFile(): string {
  return path.join(cliConfigRoot(), "logs", "terminal.log");
}

function appendTerminalLog(text: string): void {
  const file = terminalLogFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, text, { mode: 0o600 });
}

interface TerminalOptions {
  link?: string;
  label: string;
  workspace?: string;
  yes: boolean;
  keepServer: boolean;
}

function parseOptions(inv: ParsedInvocation): TerminalOptions {
  const [link, ...extra] = inv.positionals;
  if (extra.length > 0 || (link !== undefined && !isConnectPairingInput(link))) {
    throw new UsageError(
      `Unexpected argument: ${extra[0] ?? link}. The only argument is a Vibestudio pairing link.`
    );
  }
  const workspace =
    typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"].trim() : undefined;
  const label = typeof inv.flags["label"] === "string" ? inv.flags["label"].trim() : undefined;
  if (label && !link) throw new UsageError("--label is only used when pairing with a link");
  return {
    ...(link ? { link } : {}),
    label: label || `Terminal on ${os.hostname()}`,
    ...(workspace ? { workspace } : {}),
    yes: inv.flags["yes"] === true,
    keepServer: inv.flags["keep-server"] === true,
  };
}

/** The stored device credential, after pairing with `link` when one was given. */
async function pairFromLink(
  options: TerminalOptions,
  progress: (line: string) => void,
  signal?: AbortSignal
): Promise<CliDeviceIdentity | null> {
  if (options.link) {
    progress("Pairing with the server from your link…");
    const credentials = await pairRemoteServer({
      link: options.link,
      label: options.label,
      platform: "terminal",
      ...(signal ? { signal } : {}),
    });
    saveCliCredentials(credentials);
    progress(`Paired. Credentials: ${credentialPath()}`);
    return credentials;
  }
  const loaded = loadCliIdentity();
  return loaded ? requireDeviceCliIdentity(loaded, "vibestudio terminal") : null;
}

/**
 * A loopback credential whose server is not running belongs to this machine's
 * local server: start it. Any other failure (a rejected credential) is the
 * user's to resolve, so it is reported rather than worked around.
 */
async function needsLocalServer(
  credentials: CliDeviceIdentity,
  signal?: AbortSignal
): Promise<boolean> {
  if (credentials.transport !== "local") return false;
  try {
    await refreshShell(credentials, { signal });
    return false;
  } catch (error) {
    if (error instanceof ConnectionError) return true;
    if (error instanceof AuthError) {
      throw new AuthError(
        `The server at ${new URL(credentials.url).origin} rejected this terminal's credential ` +
          `(${error.message}). Run \`vibestudio remote logout\` and start again.`
      );
    }
    throw error;
  }
}

async function pairWithLocalServer(
  server: LocalServer,
  signal?: AbortSignal
): Promise<CliDeviceCredentials> {
  const paired = await pairLocalCli(server.ready, {
    label: `Terminal on ${os.hostname()}`,
    ...(signal ? { signal } : {}),
  });
  if (paired.status === "invite-required") {
    throw new AuthError(
      "This machine's local server already belongs to an account, and this terminal is not " +
        "paired with it. On a device that is paired, run `vibestudio remote pair-device`, " +
        'then run `vibestudio terminal "<pairing-link>"` here.'
    );
  }
  const loaded = loadCliCredentials();
  if (!loaded) throw new CliError("Local pairing did not save a credential");
  return requireDeviceCliCredentials(loaded, "vibestudio terminal");
}

function describeServer(
  credentials: CliDeviceCredentials,
  server: LocalServer | null
): TerminalBrowserServerInfo {
  const endpoint = serverEndpoint(credentials);
  if (!server) return { kind: "attached", endpoint };
  return {
    kind: server.retained ? "attached" : "owned",
    endpoint,
    logFile: server.logFile,
  };
}

/** Tell the user how the browser ended; returns the command's exit status. */
export function reportTerminalExit(exit: TerminalBrowserExit, logFile?: string): number {
  if (exit.kind === "connection-lost") {
    process.stderr.write(
      `The terminal lost its server: ${redactCliSecrets(exit.cause)}\n` +
        (logFile ? `Server log: ${logFile}\n` : "") +
        "Run the command again to reconnect.\n"
    );
    return 1;
  }
  return 0;
}

/** Print a startup or session failure without a stack trace; returns the exit status. */
export function printTerminalError(error: unknown, logFile?: string): number {
  return printError(withServerLog(error, logFile), { json: false });
}

export async function retireServer(
  server: LocalServer,
  progress: (line: string) => void
): Promise<void> {
  if (server.retained) {
    progress(
      `The local server keeps running (pid ${server.pid}); \`vibestudio terminal\` attaches ` +
        `to it next time. Stop it with: kill ${server.pid}\nServer log: ${server.logFile}`
    );
    return;
  }
  progress("Stopping the local server…");
  try {
    await server.stop();
    progress("Local server stopped.");
  } catch (error) {
    process.stderr.write(
      `The local server did not stop cleanly: ${error instanceof Error ? error.message : String(error)}\n` +
        `Server log: ${server.logFile}\n`
    );
    throw new Error("The local server could not be retired", { cause: error });
  }
}

function withServerLog(error: unknown, logFile: string | undefined): unknown {
  // An interruption is the person's own choice, not a failure with a log to read.
  if (error instanceof CliError && error.exitCode === EXIT_INTERRUPTED) return error;
  if (!logFile || (error instanceof Error && error.message.includes(logFile))) return error;
  return new CliError(
    `${formatRpcFailure(error)}\nServer log: ${logFile}`,
    error instanceof CliError ? error.exitCode : 1
  );
}
