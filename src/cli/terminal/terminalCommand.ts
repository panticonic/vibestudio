import * as os from "node:os";
import * as path from "node:path";
import { formatRpcFailure } from "@vibestudio/rpc";
import { isConnectPairingInput } from "@vibestudio/shared/connect";
import type {
  TerminalBrowserExit,
  TerminalBrowserServerInfo,
} from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import type { CliCommand, ParsedInvocation } from "../commandTable.js";
import { cliConfigRoot } from "../configPaths.js";
import {
  assertCliProfileIsUnpaired,
  credentialPath,
  loadCliCredentials,
  requireDeviceCliCredentials,
  saveCliCredentials,
  type CliDeviceCredentials,
} from "../credentialStore.js";
import { pairLocalCli } from "../localPairing.js";
import {
  AuthError,
  CliError,
  ConnectionError,
  UsageError,
  printError,
  redactCliSecrets,
} from "../output.js";
import { pairRemoteServer } from "../remoteClient.js";
import { refreshShell } from "../rpcClient.js";
import { EXIT_INTERRUPTED } from "../terminalLaunchGate.js";
import { localServerPaths, startLocalServer, type LocalServer } from "./localServer.js";
import { runTerminalSessions } from "./terminalSessions.js";

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
--workspace, or switch inside it with Ctrl-Space w). Like the desktop app, the
browser itself is installed in your System workspace; before it takes over
the screen, its startup approvals are asked here as questions; answer them or
pass --yes.

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
  const progress = (line: string) => process.stdout.write(`${line}\n`);
  let server: LocalServer | null = null;
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new UsageError(
        "vibestudio terminal needs an interactive terminal: stdin and stdout must both be a TTY."
      );
    }
    const options = parseOptions(inv);
    let credentials = await pairFromLink(options, progress);
    if (!credentials || (await needsLocalServer(credentials))) {
      const paths = localServerPaths();
      progress(
        credentials
          ? "Starting the local Vibestudio server…"
          : "Not paired with a server yet: starting a local Vibestudio server…"
      );
      progress(`  state: ${cliConfigRoot()}`);
      progress(`  log:   ${paths.logFile}`);
      // Ctrl-C before the browser starts stops the server we own and ends startup.
      process.on("SIGINT", onInterrupt);
      server = await startLocalServer({
        hostArtifactRoot:
          process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] ?? path.join(context.appRoot, "dist"),
        appRoot: process.env["VIBESTUDIO_APP_ROOT"] ?? context.appRoot,
        env: process.env,
        retain: options.keepServer,
      });
      credentials = await pairWithLocalServer(server, credentials, progress);
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
    });
    return reportTerminalExit(exit, server?.logFile);
  } catch (error) {
    if (interrupted) {
      process.stderr.write("Interrupted.\n");
      return EXIT_INTERRUPTED;
    }
    return printTerminalError(error, server?.logFile);
  } finally {
    process.off("SIGINT", onInterrupt);
    if (server) await retireServer(server, progress);
  }
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
  progress: (line: string) => void
): Promise<CliDeviceCredentials | null> {
  if (options.link) {
    assertCliProfileIsUnpaired();
    progress("Pairing with the server from your link…");
    const credentials = await pairRemoteServer({
      link: options.link,
      label: options.label,
      platform: "terminal",
    });
    saveCliCredentials(credentials);
    progress(`Paired. Credentials: ${credentialPath()}`);
    return credentials;
  }
  const loaded = loadCliCredentials();
  return loaded ? requireDeviceCliCredentials(loaded, "vibestudio terminal") : null;
}

/**
 * A loopback credential whose server is not running belongs to this machine's
 * local server: start it. Any other failure (a rejected credential) is the
 * user's to resolve, so it is reported rather than worked around.
 */
async function needsLocalServer(credentials: CliDeviceCredentials): Promise<boolean> {
  if (credentials.transport !== "local") return false;
  try {
    await refreshShell(credentials);
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
  existing: CliDeviceCredentials | null,
  progress: (line: string) => void
): Promise<CliDeviceCredentials> {
  progress(existing ? "Reconnecting to the local server…" : "Pairing this terminal…");
  const paired = await pairLocalCli(server.ready, { label: `Terminal on ${os.hostname()}` });
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
  const endpoint =
    credentials.transport === "local"
      ? new URL(credentials.url).origin
      : `iroh:${credentials.workspacePairing.endpointId.slice(0, 12)}`;
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

async function retireServer(server: LocalServer, progress: (line: string) => void): Promise<void> {
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
    process.exitCode = 1;
  }
}

function withServerLog(error: unknown, logFile: string | undefined): unknown {
  if (!logFile || (error instanceof Error && error.message.includes(logFile))) return error;
  return new CliError(
    `${formatRpcFailure(error)}\nServer log: ${logFile}`,
    error instanceof CliError ? error.exitCode : 1
  );
}
