import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatRpcFailure } from "@vibestudio/rpc";
import { isConnectPairingInput } from "@vibestudio/shared/connect";
import { clientsMethods } from "@vibestudio/service-schemas/clients";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type {
  TerminalClientExit,
  TerminalClientServerInfo,
} from "@vibestudio/shell-core/terminal/terminalClientHost";
import type { ClientListing, ClientSelection } from "@vibestudio/workspace-contracts/clients";
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
import { RpcClient, refreshShell, shellCallerId } from "../../src/cli/rpcClient.js";
import { followChannel, toHistoryEntry } from "../../src/cli/channelCommands.js";
import { EXIT_INTERRUPTED } from "./clientLaunchGate.js";
import { deviceCall, terminalHostDescriptor } from "./clientDelivery.js";
import {
  buildIntentParams,
  parseParamFlags,
  resolveIntent,
  runBackgroundIntent,
} from "./clientIntents.js";
import {
  clientInvocation,
  linkClientShim,
  syncClientIndex,
  unlinkClientShim,
  type ShimContext,
} from "./clientShims.js";
import { TerminalHostState } from "./hostState.js";
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
  /** This CLI's release version, told to the server in the host descriptor. */
  hostVersion: string;
  /** Names the CLI itself defines; no client command or shim may take one. */
  isBuiltIn(name: string): boolean;
  /** Host state (shims, development mode, command table); the default lives in the config root. */
  hostState?: TerminalHostState;
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

const SERVER_FLAGS = [
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
] as const;

const CLIENT_FLAGS = [
  ...SERVER_FLAGS,
  {
    name: "param",
    takesValue: true,
    multiple: true,
    description: "An intent parameter, key=value (repeatable)",
  },
  {
    name: "develop",
    takesValue: false,
    description:
      "Development mode for this client on this device: adopt each rebuild at once (--develop=false ends it)",
  },
] as const;

/** `vibestudio terminal`: start or attach to a server and open the default client. */
export function createTerminalCommand(context: TerminalCommandContext): CliCommand {
  return {
    group: "terminal",
    name: "",
    summary: "Open the terminal browser (starts a local server when needed)",
    usage:
      'vibestudio terminal ["<pairing-link>" [--label <name>]] [--workspace <name>] [--yes] [--keep-server]',
    flags: [
      ...SERVER_FLAGS,
      {
        name: "label",
        takesValue: true,
        description: "Device label when pairing with a link (default: Terminal on <host>)",
      },
    ],
    details: DETAILS,
    run: (inv) => runClientCommand(inv, context, { kind: "default" }),
  };
}

const OPEN_DETAILS = `Opens a terminal client from your System workspace: the same launch as
\`vibestudio terminal\` (server, approvals, verified download), for any client
that runs in a terminal. List them with \`vibestudio clients list\`.

A client's background intents (for example \`ask\`) run on the server with no
client loaded on this machine; free text after the intent and piped input
become the intent's text parameter, and the result goes to stdout.

--develop marks the client for development mode on this device: a rebuild is
adopted at once by re-entering the client.`;

/** `vibestudio open <id> [intent]`: open any terminal client. */
export function createOpenCommand(context: TerminalCommandContext): CliCommand {
  return {
    group: "open",
    name: "",
    summary: "Open a terminal client by id, or run one of its background intents",
    usage:
      "vibestudio open <client> [intent] [words…] [--param key=value …] [--develop] [--workspace <name>] [--yes]",
    flags: [...CLIENT_FLAGS],
    details: OPEN_DETAILS,
    run: usageGuarded((inv) => {
      const [id, ...rest] = inv.positionals;
      if (!id) throw new UsageError("Name the client to open: vibestudio open <client> [intent]");
      return runClientCommand(inv, context, { kind: "client", id, rest });
    }),
  };
}

/** `vibestudio <command>` for a client that declares `integration.terminal.command`, or null. */
export function clientCommandFor(name: string, context: TerminalCommandContext): CliCommand | null {
  const state = context.hostState ?? new TerminalHostState();
  const id = context.isBuiltIn(name) ? null : state.commandClient(name);
  if (!id) return null;
  return {
    group: name,
    name: "",
    summary: `Open the ${id} client`,
    usage: `vibestudio ${name} [intent] [words…] [--param key=value …] [--develop] [--workspace <name>] [--yes]`,
    flags: [...CLIENT_FLAGS],
    details: OPEN_DETAILS,
    run: (inv) => runClientCommand(inv, context, { kind: "client", id, rest: inv.positionals }),
  };
}

/** `vibestudio clients list|link|unlink`. */
export function createClientsCommands(context: TerminalCommandContext): CliCommand[] {
  return [
    {
      group: "clients",
      name: "list",
      summary: "List the clients this terminal can run",
      usage: "vibestudio clients list [--workspace <name>] [--yes] [--keep-server]",
      flags: [...SERVER_FLAGS],
      run: (inv) => withServer(inv, context, (session) => listClients(session, context)),
    },
    {
      group: "clients",
      name: "link",
      summary: "Put a client's command in ~/.local/bin",
      usage: "vibestudio clients link <client> [--name <command>]",
      flags: [
        ...SERVER_FLAGS,
        {
          name: "name",
          takesValue: true,
          description: "Command name (default: the client's command)",
        },
      ],
      run: usageGuarded((inv) => {
        const [id, ...extra] = inv.positionals;
        if (!id || extra.length > 0) {
          throw new UsageError("Usage: vibestudio clients link <client> [--name <command>]");
        }
        const name = typeof inv.flags["name"] === "string" ? inv.flags["name"] : undefined;
        return withServer(inv, context, (session) => linkClient(session, context, id, name));
      }),
    },
    {
      group: "clients",
      name: "unlink",
      summary: "Remove a command that `clients link` wrote",
      usage: "vibestudio clients unlink <command>",
      run: usageGuarded(async (inv) => {
        const [name, ...extra] = inv.positionals;
        if (!name || extra.length > 0) {
          throw new UsageError("Usage: vibestudio clients unlink <command>");
        }
        const removed = unlinkClientShim(shimContext(context), name);
        process.stdout.write(
          removed ? `Removed ${name}.\n` : `Forgot ${name}; its file was already gone.\n`
        );
        return 0;
      }),
    },
  ];
}

/** A command's own usage errors are reported like any other: a message and the usage status, never a stack. */
function usageGuarded(
  run: (inv: ParsedInvocation) => Promise<number> | number
): (inv: ParsedInvocation) => Promise<number> {
  return async (inv) => {
    try {
      return await run(inv);
    } catch (error) {
      if (error instanceof UsageError) return printError(error, { json: false });
      throw error;
    }
  };
}

function shimContext(context: TerminalCommandContext): ShimContext {
  return { state: context.hostState ?? new TerminalHostState(), isBuiltIn: context.isBuiltIn };
}

type ClientRequest =
  | { kind: "default" }
  /** `rest` is what followed the client: an intent name, then free words. */
  | { kind: "client"; id: string; rest: string[] };

/** What the commands that need a server share: the paired (or freshly started) server, and progress. */
interface ServerSession {
  inv: ParsedInvocation;
  options: TerminalOptions;
  credentials: CliDeviceCredentials;
  server: LocalServer | null;
  progress: ReturnType<typeof createLaunchProgress>;
  out(line: string): void;
  signal: AbortSignal;
  interactive: boolean;
}

async function runClientCommand(
  inv: ParsedInvocation,
  context: TerminalCommandContext,
  request: ClientRequest
): Promise<number> {
  return withServer(
    inv,
    context,
    async (session) => {
      const { options, credentials, server, signal } = session;
      const hostState = context.hostState ?? new TerminalHostState();
      const shims: ShimContext = { state: hostState, isBuiltIn: context.isBuiltIn };
      let select: ClientSelection = { default: true };
      if (request.kind === "client") {
        const planned = await planClient(session, context, request);
        if (planned.kind === "ran") return 0;
        select = planned.select;
        if (planned.develop !== undefined) hostState.setDevelopment(request.id, planned.develop);
      }
      if (!session.interactive) {
        throw new UsageError(
          "This client needs an interactive terminal: stdin and stdout must both be a TTY."
        );
      }
      const exit = await runTerminalSessions({
        credentials,
        ...(options.workspace ? { workspace: options.workspace } : {}),
        select,
        server: describeServer(credentials, server),
        ...(server && !server.retained ? { serverExited: server.exited } : {}),
        yes: options.yes,
        stdin: process.stdin,
        stdout: process.stdout,
        progress: session.progress,
        hostVersion: context.hostVersion,
        hostState,
        shims,
        signal,
      });
      return reportTerminalExit(exit, server?.logFile);
    },
    request.kind === "default"
  );
}

/**
 * Resolve the client and intent the person named against the server's list,
 * and run a background intent right here: it executes server-side, so no
 * client is loaded and the result goes to stdout.
 */
async function planClient(
  session: ServerSession,
  context: TerminalCommandContext,
  request: Extract<ClientRequest, { kind: "client" }>
): Promise<{ kind: "ran" } | { kind: "launch"; select: ClientSelection; develop?: boolean }> {
  const { inv, signal } = session;
  const systemRoute = await selectRemoteWorkspace(
    session.credentials,
    { privateRole: "system" },
    { signal }
  );
  const device = new RpcClient(systemRoute, { signal });
  const release = device.retainConnection();
  return runWithOwnedCleanup(
    async () => {
      const descriptor = terminalHostDescriptor(context.hostVersion);
      const call = deviceCall(device);
      const clients = createTypedServiceClient("clients", clientsMethods, call);
      const listings = await clients.list(descriptor);
      syncClientIndex(shimContext(context), listings);
      const listing = listings.find((candidate) => candidate.id === request.id);
      if (!listing) {
        throw new UsageError(
          `No client "${request.id}" is available in this terminal. See \`vibestudio clients list\`.`
        );
      }
      if (listing.runtime !== "terminal") {
        throw new UsageError(
          `${listing.id} is a ${listing.runtime} client; it does not run in a terminal.`
        );
      }
      const [named, ...words] = request.rest;
      const decl = resolveIntent(listing, named);
      const flagParams = parseParamFlags(inv.flagsMulti("param"));
      const develop =
        inv.flags["develop"] === undefined ? undefined : inv.flags["develop"] === true;
      if (decl.kind === "foreground") {
        if (words.length > 0) {
          throw new UsageError(
            `Intent ${decl.name} takes parameters with --param key=value, not words.`
          );
        }
        const params = buildIntentParams(decl, { flagParams, words: [], stdin: null });
        return {
          kind: "launch" as const,
          select:
            decl.name === "open" && Object.keys(params).length === 0
              ? { id: listing.id }
              : { id: listing.id, intent: decl.name, params },
          ...(develop === undefined ? {} : { develop }),
        };
      }
      // A background intent never loads the client; piped input is its text.
      const stdin = process.stdin.isTTY ? null : await readAll(process.stdin, signal);
      const params = buildIntentParams(decl, { flagParams, words, stdin });
      await runBackgroundIntent({
        call,
        descriptor,
        clientId: listing.id,
        decl,
        params,
        stdout: process.stdout,
        followStream: (channelId) =>
          followIntentStream(device, systemRoute.deviceId, channelId, signal),
      });
      return { kind: "ran" as const };
    },
    async () => {
      await runOwnedCleanupSteps(
        [() => release(), () => device.close()],
        "Client intent connection retirement failed"
      );
    },
    "Client intent and retirement failed"
  );
}

/** Print what a `text-stream` intent's channel says, through the CLI's one channel reader. */
async function followIntentStream(
  device: RpcClient,
  deviceId: string,
  channelId: string,
  signal: AbortSignal
): Promise<void> {
  const callerId = shellCallerId(deviceId);
  const follow = await followChannel(device, {
    callerId,
    channelId,
    replayMessageLimit: 0,
    render: (event) => {
      if (event.senderId === callerId) return;
      const entry = toHistoryEntry(event);
      if (entry.text)
        process.stdout.write(entry.text.endsWith("\n") ? entry.text : `${entry.text}\n`);
    },
  });
  const abort = () => void follow.stop().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([
      follow.ended,
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      ),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
    await follow.stop();
  }
  signal.throwIfAborted();
}

async function readAll(stream: NodeJS.ReadStream, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    signal.throwIfAborted();
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withSystemClients<T>(
  session: ServerSession,
  context: TerminalCommandContext,
  body: (listings: ClientListing[]) => Promise<T>
): Promise<T> {
  const systemRoute = await selectRemoteWorkspace(
    session.credentials,
    { privateRole: "system" },
    { signal: session.signal }
  );
  const device = new RpcClient(systemRoute, { signal: session.signal });
  const release = device.retainConnection();
  return runWithOwnedCleanup(
    async () => {
      const clients = createTypedServiceClient("clients", clientsMethods, deviceCall(device));
      return body(await clients.list(terminalHostDescriptor(context.hostVersion)));
    },
    async () => {
      await runOwnedCleanupSteps(
        [() => release(), () => device.close()],
        "Clients connection retirement failed"
      );
    },
    "Clients listing and retirement failed"
  );
}

async function listClients(
  session: ServerSession,
  context: TerminalCommandContext
): Promise<number> {
  return withSystemClients(session, context, async (listings) => {
    const shims = shimContext(context);
    const { table, removedShims } = syncClientIndex(shims, listings);
    const linked = shims.state.read().shims;
    const lines = listings.map((listing) => {
      const registered =
        listing.terminalCommand && table.commands[listing.terminalCommand]?.clientId === listing.id;
      const links = Object.entries(linked)
        .filter(([, shim]) => shim.clientId === listing.id)
        .map(([name]) => name);
      return [
        listing.id.padEnd(18),
        listing.runtime.padEnd(14),
        (listing.isDefault ? "default" : listing.status).padEnd(18),
        (registered
          ? `vibestudio ${listing.terminalCommand}`
          : `vibestudio open ${listing.id}`
        ).padEnd(30),
        links.length ? `link: ${links.join(", ")}` : "",
        listing.unavailableReason ?? "",
      ]
        .join(" ")
        .trimEnd();
    });
    process.stdout.write(`${lines.join("\n")}${lines.length ? "\n" : ""}`);
    for (const rejected of table.rejected) {
      process.stderr.write(
        `Client ${rejected.clientId}: \`vibestudio ${rejected.command}\` is not registered: ${rejected.reason}.\n`
      );
    }
    for (const name of removedShims) process.stderr.write(`Removed ${name}: its client is gone.\n`);
    return 0;
  });
}

async function linkClient(
  session: ServerSession,
  context: TerminalCommandContext,
  id: string,
  name: string | undefined
): Promise<number> {
  return withSystemClients(session, context, async (listings) => {
    const shims = shimContext(context);
    const { table } = syncClientIndex(shims, listings);
    const listing = listings.find((candidate) => candidate.id === id);
    if (!listing || listing.runtime !== "terminal") {
      throw new UsageError(
        `No terminal client "${id}" is available. See \`vibestudio clients list\`.`
      );
    }
    const command = name ?? clientInvocation(listing, table).split(" ")[0]!;
    const file = linkClientShim(shims, { name: command === "open" ? id : command, listing, table });
    process.stdout.write(`Linked ${file}\n`);
    return 0;
  });
}

/**
 * Everything the server-backed commands share: this command's own warnings go
 * to its log, a hang-up stops the server it owns, a missing local server is
 * started and the terminal paired with it, and the server is retired when the
 * body settles.
 */
async function withServer(
  inv: ParsedInvocation,
  context: TerminalCommandContext,
  body: (session: ServerSession) => Promise<number>,
  /** `vibestudio terminal`: it needs a terminal and may be given a pairing link. */
  terminal = false
): Promise<number> {
  // First, before any await: the terminal is the user's, so this command's own
  // warnings — including those raised while the CLI loaded, which Node emits
  // on the next tick — go to its log.
  const releaseWarnings = routeProcessWarnings(appendTerminalLog);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // A result goes to stdout; what the command is doing goes where a person looks.
  const out = (line: string) => (interactive ? process.stdout : process.stderr).write(`${line}\n`);
  // A hang-up stops the server this command owns (the supervisor forwards
  // SIGHUP); the dead terminal must not crash the command while it joins it.
  tolerateTerminalHangup();
  let server: LocalServer | null = null;
  const termination = new LaunchTermination();
  try {
    return await runWithOwnedCleanup(
      async () => {
        try {
          if (terminal && !interactive) {
            throw new UsageError(
              "vibestudio terminal needs an interactive terminal: stdin and stdout must both be a TTY."
            );
          }
          const options = parseOptions(inv, terminal);
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
            // Ctrl-C before the client starts stops the server we own and ends startup.
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
          return await body({
            inv,
            options,
            credentials,
            server,
            progress,
            out,
            signal: termination.signal,
            interactive,
          });
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

function parseOptions(inv: ParsedInvocation, acceptsLink: boolean): TerminalOptions {
  // Only `vibestudio terminal` takes a pairing link; the other commands' positionals are theirs.
  const [link, ...extra] = acceptsLink ? inv.positionals : [];
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
): TerminalClientServerInfo {
  const endpoint = serverEndpoint(credentials);
  if (!server) return { kind: "attached", endpoint };
  return {
    kind: server.retained ? "attached" : "owned",
    endpoint,
    logFile: server.logFile,
  };
}

/** Tell the user how the browser ended; returns the command's exit status. */
export function reportTerminalExit(exit: TerminalClientExit, logFile?: string): number {
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
