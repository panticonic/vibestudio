import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRpcClient, type RpcConnectionStatus } from "@vibestudio/rpc";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import {
  TERMINAL_BROWSER_HOST_CONTRACT_VERSION,
  type TerminalBrowserExit,
  type TerminalBrowserHost,
  type TerminalBrowserModule,
  type TerminalBrowserServerInfo,
  type TerminalBrowserWorkspace,
  type TerminalServerConnectionState,
} from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import {
  AppPrincipalGrantResponseSchema,
  type AppPrincipalGrantResponse,
} from "@vibestudio/service-schemas/auth";
import { CliError } from "../output.js";
import { shellCallerId, type PrincipalTransport, type RpcClient } from "../rpcClient.js";
import { guardTerminal } from "./ttyRestore.js";

/** Requests the device's terminal-app principal over the CLI's own connection. */
export async function requestTerminalAppGrant(
  device: Pick<RpcClient, "call">,
  source: string | null
): Promise<AppPrincipalGrantResponse> {
  return AppPrincipalGrantResponseSchema.parse(
    await device.call("auth.grantAppPrincipal", [{ principal: "terminal-app", source }])
  );
}

/**
 * Fetch the terminal app's primary ESM module — exactly the build its
 * principal is bound to — and import it into this process.
 *
 * The bytes travel over the CLI's authenticated connection (`gateway.fetch`),
 * so a remote Iroh server works like a local one. The module is written to a
 * private scratch directory only so Node can import it with a file URL (and
 * stack traces name a file); the directory is removed once it is loaded.
 */
export async function loadTerminalBrowserModule(
  device: Pick<RpcClient, "stream">,
  app: AppPrincipalGrantResponse["app"]
): Promise<TerminalBrowserModule> {
  const entry = app.artifacts.filter((artifact) => artifact.role === "primary");
  if (entry.length !== 1 || !entry[0]!.path.endsWith(".mjs")) {
    throw new CliError(
      `The terminal app ${app.source} has no single ESM entry module in build ${app.buildKey}.`
    );
  }
  const response = await device.stream("main", "gateway.fetch", [
    { path: entry[0]!.route, method: "GET" },
  ]);
  if (!response.ok) {
    throw new CliError(
      `Could not download the terminal app (${app.source}): HTTP ${response.status} ` +
        `${(await response.text()).slice(0, 200)}`
    );
  }
  const source = Buffer.from(await response.arrayBuffer());
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-terminal-app-"));
  try {
    const file = path.join(scratch, path.basename(entry[0]!.path));
    fs.writeFileSync(file, source, { mode: 0o600 });
    const loaded = (await import(pathToFileURL(file).href)) as Partial<TerminalBrowserModule>;
    if (typeof loaded.run !== "function") {
      throw new CliError(
        `The terminal app ${app.source} does not export run(host). It was built for an ` +
          "older terminal contract; update the workspace's System template."
      );
    }
    return loaded as TerminalBrowserModule;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Connection state reported to the browser, over every connection it uses.
 * `reconnecting` follows the transports' own recovery (connected only when
 * all of them are); `lost` is set only by an authoritative terminal event
 * (session closed by the server, owned server exited, app updated).
 */
export class TerminalConnectionState {
  private state: TerminalServerConnectionState = { phase: "connected" };
  private readonly listeners = new Set<(state: TerminalServerConnectionState) => void>();
  private readonly interrupted = new Set<string>();

  constructor(private readonly endpoint: string) {}

  current(): TerminalServerConnectionState {
    return this.state;
  }

  subscribe(listener: (state: TerminalServerConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Status of one named connection (the System app session, the workspace session). */
  transportStatus(connection: string, status: RpcConnectionStatus): void {
    if (this.state.phase === "lost") return;
    if (status === "connected") this.interrupted.delete(connection);
    else this.interrupted.add(connection);
    if (this.interrupted.size === 0) {
      if (this.state.phase !== "connected") this.set({ phase: "connected" });
    } else if (this.state.phase === "connected") {
      this.set({ phase: "reconnecting", cause: `connection to ${this.endpoint} interrupted` });
    }
  }

  lose(cause: string): void {
    if (this.state.phase === "lost") return;
    this.set({ phase: "lost", cause });
  }

  get lost(): boolean {
    return this.state.phase === "lost";
  }

  private set(state: TerminalServerConnectionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
  }
}

export interface TerminalBrowserRunOptions {
  /** The CLI's device connection to the System workspace, where the browser is installed. */
  device: RpcClient;
  /** The CLI's device connection to the workspace the browser shows (may be `device`). */
  workspaceDevice: RpcClient;
  grant: AppPrincipalGrantResponse;
  module: TerminalBrowserModule;
  system: TerminalBrowserWorkspace;
  workspace: TerminalBrowserWorkspace;
  server: TerminalBrowserServerInfo;
  /** Owned server lifetime: its exit is an authoritative terminal event. */
  serverExited?: Promise<string>;
  listWorkspaces(): Promise<TerminalBrowserWorkspace[]>;
  openExternal(url: string): Promise<void>;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export type TerminalBrowserRunResult =
  | { kind: "exit"; exit: TerminalBrowserExit }
  /** The app's active build changed under a running browser; load the new one. */
  | { kind: "app-updated" };

/**
 * Connect the app principal (System) and this device's workspace session over
 * the CLI's transports, hand the browser its host, and run it until it
 * settles. The terminal is restored on every exit path, including errors and
 * `process.exit` inside the app.
 */
export async function runTerminalBrowser(
  options: TerminalBrowserRunOptions
): Promise<TerminalBrowserRunResult> {
  const { device, grant } = options;
  const state = new TerminalConnectionState(options.server.endpoint);
  let appUpdated = false;
  let initialGrant: string | null = grant.connectionGrant;
  // Every (re)authentication redeems a fresh one-use grant for the same
  // principal. A grant bound to another build means the app was updated:
  // the running module can no longer be the principal's executable.
  const getToken = async (): Promise<string> => {
    if (state.lost) throw new CliError(`terminal session ended: ${describeLost(state)}`);
    if (initialGrant) {
      const token = initialGrant;
      initialGrant = null;
      return token;
    }
    const next = await requestTerminalAppGrant(device, grant.app.source);
    if (next.app.buildKey !== grant.app.buildKey) {
      appUpdated = true;
      state.lose("the terminal app was updated; reloading it");
      throw new CliError("the terminal app was updated");
    }
    return next.connectionGrant;
  };
  const lifetime = new AbortController();
  const transports: PrincipalTransport[] = [];
  const unsubscribes: Array<() => void> = [];
  const connect = async (
    connection: "app" | "workspace",
    open: (onRecovery: (kind: RecoveryKind) => void) => Promise<PrincipalTransport>,
    selfId: string,
    callerKind: "app" | "shell"
  ) => {
    const recoveryHandlers = new Set<(kind: RecoveryKind) => void>();
    const transport = await open((kind) => {
      for (const handler of [...recoveryHandlers]) handler(kind);
    });
    transports.push(transport);
    unsubscribes.push(
      transport.onStatusChange((status) => state.transportStatus(connection, status))
    );
    return createRpcClient({
      selfId,
      callerKind,
      transport,
      lifetime: lifetime.signal,
      onRecovery: (handler) => {
        recoveryHandlers.add(handler);
        return () => recoveryHandlers.delete(handler);
      },
    });
  };
  const onTerminalClose = (error: Error) => state.lose(error.message);
  let releaseTerminal: (() => void) | null = null;
  let outcome: { ok: true; result: TerminalBrowserRunResult } | { ok: false; error: unknown };
  try {
    const rpc = await connect(
      "app",
      (onRecovery) =>
        device.openPrincipalTransport({
          selfId: grant.callerId,
          getToken,
          clientLabel: "Vibestudio terminal",
          onRecovery,
          onTerminalClose,
        }),
      grant.callerId,
      "app"
    );
    const workspaceRpc = await connect(
      "workspace",
      (onRecovery) =>
        options.workspaceDevice.openShellTransport({
          clientLabel: "Vibestudio terminal",
          onRecovery,
          onTerminalClose,
        }),
      shellCallerId(grant.deviceId),
      "shell"
    );
    void options.serverExited?.then((cause) => state.lose(cause));
    const host: TerminalBrowserHost = {
      contractVersion: TERMINAL_BROWSER_HOST_CONTRACT_VERSION,
      rpc,
      appId: grant.callerId,
      system: options.system,
      workspace: options.workspace,
      workspaceRpc,
      server: options.server,
      stdin: options.stdin,
      stdout: options.stdout,
      connectionState: () => state.current(),
      onConnectionState: (listener) => state.subscribe(listener),
      listWorkspaces: () => options.listWorkspaces(),
      openExternal: (url) => options.openExternal(url),
    };
    releaseTerminal = guardTerminal(options.stdin, options.stdout);
    const exit = await options.module.run(host);
    outcome = { ok: true, result: appUpdated ? { kind: "app-updated" } : { kind: "exit", exit } };
  } catch (error) {
    outcome = { ok: false, error };
  }
  releaseTerminal?.();
  for (const unsubscribe of unsubscribes) unsubscribe();
  lifetime.abort(new Error("terminal browser exited"));
  // Join every session's close; none may be abandoned, and no failure is dropped.
  const closeFailures = (
    await Promise.allSettled(transports.map((transport) => transport.close()))
  ).flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  if (!outcome.ok) {
    if (closeFailures.length === 0) throw outcome.error;
    throw new AggregateError(
      [outcome.error, ...closeFailures],
      "The terminal browser failed and its connections could not all be closed"
    );
  }
  if (closeFailures.length === 1) throw closeFailures[0];
  if (closeFailures.length > 1) {
    throw new AggregateError(
      closeFailures,
      "The terminal browser's connections could not all be closed"
    );
  }
  return outcome.result;
}

function describeLost(state: TerminalConnectionState): string {
  const current = state.current();
  return current.phase === "lost" ? current.cause : current.phase;
}
