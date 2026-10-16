import { pathToFileURL } from "node:url";
import { createRpcClient, type RpcConnectionStatus } from "@vibestudio/rpc";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import {
  ClientUpdateObserver,
  type ClientUpdate,
  type LaunchedClient,
  type PrincipalGrants,
  type SupervisionEvents,
} from "@vibestudio/client-host-core";
import type {
  TerminalClientExit,
  TerminalClientHost,
  TerminalClientModule,
  TerminalClientServerInfo,
  TerminalClientState,
  TerminalClientUpdate,
  TerminalClientUpdates,
  TerminalClientWorkspace,
  TerminalServerConnectionState,
} from "@vibestudio/shell-core/terminal/terminalClientHost";
import { CliError } from "../../src/cli/output.js";
import { shellCallerId, type PrincipalTransport, type RpcClient } from "../../src/cli/rpcClient.js";
import { guardTerminal } from "./ttyRestore.js";
import { createGatedModules } from "./hostModules.js";
import type { TerminalHostState } from "./hostState.js";

/**
 * The reason the server gives when it closes a client's sessions because the
 * System owner withdrew the client's device-level trust (§4.4.1).
 */
export const TRUST_REVOKED_REASON = "trust-revoked";

/**
 * Import the client's verified primary module from the artifact cache. The
 * cache verified the bytes against the integrity the server sealed before
 * they were stored, and Node loads the stored file by its own name (so stack
 * traces name a file); nothing is written or removed here.
 */
export async function importClientModule(launched: LaunchedClient): Promise<TerminalClientModule> {
  const { client } = launched;
  const entry = launched.artifacts.filter((artifact) => artifact.role === "primary");
  if (entry.length !== 1 || !entry[0]!.path.endsWith(".mjs")) {
    throw new CliError(
      `The terminal client ${client.source} has no single ESM entry module in build ${client.buildKey}.`
    );
  }
  const loaded = (await import(
    pathToFileURL(entry[0]!.handle).href
  )) as Partial<TerminalClientModule>;
  if (typeof loaded.run !== "function") {
    throw new CliError(`The terminal client ${client.source} does not export run(host).`);
  }
  return loaded as TerminalClientModule;
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

export interface TerminalClientRunOptions {
  /** The CLI's device connection to the System workspace, where clients are installed. */
  device: RpcClient;
  /** The CLI's device connection to the workspace the client shows (may be `device`). */
  workspaceDevice: RpcClient;
  launched: LaunchedClient;
  /** Grants for the exact verified build; redeemed again on every reconnect. */
  grants: PrincipalGrants;
  module: TerminalClientModule;
  system: TerminalClientWorkspace;
  workspace: TerminalClientWorkspace;
  server: TerminalClientServerInfo;
  /** Owned server lifetime: its exit is an authoritative terminal event. */
  serverExited?: Promise<string>;
  /** The System workspace's `supervision:changed`, for update observation. */
  events: SupervisionEvents;
  hostState: Pick<TerminalHostState, "isDevelopment">;
  state: TerminalClientState;
  signal?: AbortSignal;
  listWorkspaces(): Promise<TerminalClientWorkspace[]>;
  openExternal(url: string): Promise<void>;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export type TerminalClientRunResult =
  | { kind: "exit"; exit: TerminalClientExit }
  /** The client asked to be re-entered on a newer build (or development mode adopted one). */
  | { kind: "restart" }
  /** The server withdrew this client's trust and closed its sessions. */
  | { kind: "trust-revoked" };

/**
 * Connect the client's principal (System) and this device's workspace session
 * over the CLI's transports, hand the client its host, and run it until it
 * settles. The terminal is restored on every exit path, including errors and
 * `process.exit` inside the client.
 */
export async function runTerminalClient(
  options: TerminalClientRunOptions
): Promise<TerminalClientRunResult> {
  const { device, launched } = options;
  const { client, grant } = launched;
  const state = new TerminalConnectionState(options.server.endpoint);
  options.signal?.throwIfAborted();
  const lifetime = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  let restartRequested = false;
  let trustRevoked = false;
  const failures: unknown[] = [];
  const requestRestart = (cause: string) => {
    if (restartRequested) return;
    restartRequested = true;
    state.lose(cause);
  };

  // Update observation (§4.6): the server announces, this host decides.
  let pendingUpdate: TerminalClientUpdate | null = null;
  const updateListeners = new Set<(update: TerminalClientUpdate) => void>();
  const update: TerminalClientUpdates = {
    pending: () => pendingUpdate,
    onUpdate: (listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    restartAtSafePoint: () => {
      if (!pendingUpdate) throw new CliError("There is no update to restart into.");
      requestRestart("restarting into the updated client");
    },
  };
  const observer = new ClientUpdateObserver({
    events: options.events,
    source: client.source,
    buildKey: client.buildKey,
    policy: () => "restart-at-safe-point",
    developmentMode: () => options.hostState.isDevelopment(client.id),
    onUpdate: (ready: ClientUpdate, policy) => {
      pendingUpdate = {
        buildKey: ready.buildKey,
        effectiveVersion: ready.effectiveVersion,
        previousBuildKey: ready.previousBuildKey,
      };
      // Development mode adopts at once: the client is re-entered on the new build.
      if (policy === "immediate") {
        requestRestart("restarting into the rebuilt client (development mode)");
        return;
      }
      for (const listener of [...updateListeners]) {
        try {
          listener(pendingUpdate);
        } catch (error) {
          failures.push(error);
        }
      }
    },
    onError: (error) => failures.push(error),
  });

  // Every (re)authentication redeems a fresh one-use grant for the same
  // principal and the same verified build.
  let initialGrant: string | null = grant.connectionGrant;
  const getToken = async (authenticationSignal?: AbortSignal): Promise<string> => {
    const requestSignal = authenticationSignal
      ? AbortSignal.any([signal, authenticationSignal])
      : signal;
    requestSignal.throwIfAborted();
    if (state.lost) throw new CliError(`terminal session ended: ${describeLost(state)}`);
    if (initialGrant) {
      const token = initialGrant;
      initialGrant = null;
      return token;
    }
    return (
      await options.grants.acquire({
        source: client.source,
        buildKey: client.buildKey,
        executionDigest: client.executionDigest,
      })
    ).connectionGrant;
  };
  const onAbort = () => state.lose("the terminal invocation was cancelled");
  signal.addEventListener("abort", onAbort, { once: true });
  const transports: PrincipalTransport[] = [];
  const unsubscribes: Array<() => void> = [];
  const connect = async (
    connection: "client" | "workspace",
    open: (onRecovery: (kind: RecoveryKind) => void) => Promise<PrincipalTransport>,
    selfId: string,
    callerKind: "client" | "shell"
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
      lifetime: signal,
      onRecovery: (handler) => {
        recoveryHandlers.add(handler);
        return () => recoveryHandlers.delete(handler);
      },
    });
  };
  const onClientClose = (error: Error) => {
    // The server's close reason is authoritative: trust withdrawn is not a lost connection.
    if (error.message === TRUST_REVOKED_REASON) trustRevoked = true;
    state.lose(error.message);
  };
  const onWorkspaceClose = (error: Error) => state.lose(error.message);
  let releaseTerminal: (() => void) | null = null;
  let outcome: { ok: true; result: TerminalClientRunResult } | { ok: false; error: unknown };
  try {
    await observer.start();
    const rpc = await connect(
      "client",
      (onRecovery) =>
        device.openPrincipalTransport({
          selfId: grant.principalId,
          getToken,
          clientLabel: "Vibestudio terminal",
          onRecovery,
          onTerminalClose: onClientClose,
          signal,
        }),
      grant.principalId,
      "client"
    );
    const workspaceRpc = await connect(
      "workspace",
      (onRecovery) =>
        options.workspaceDevice.openShellTransport({
          clientLabel: "Vibestudio terminal",
          onRecovery,
          onTerminalClose: onWorkspaceClose,
          signal,
        }),
      shellCallerId(grant.deviceId),
      "shell"
    );
    void options.serverExited?.then((cause) => state.lose(cause));
    const host: TerminalClientHost = {
      client: {
        id: client.id,
        source: client.source,
        buildKey: client.buildKey,
        grantedCapabilities: client.grantedCapabilities,
      },
      intent: client.intent ?? null,
      rpc,
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
      ...createGatedModules({
        granted: client.grantedCapabilities,
        stdout: options.stdout,
        workspaceRpc,
        lifetime: signal,
      }),
      state: options.state,
      update,
      signal,
    };
    releaseTerminal = guardTerminal(options.stdin, options.stdout);
    const exit = await options.module.run(host);
    outcome = {
      ok: true,
      result: trustRevoked
        ? { kind: "trust-revoked" }
        : restartRequested
          ? { kind: "restart" }
          : { kind: "exit", exit },
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const cleanupFailures: unknown[] = [];
  for (const cleanup of [
    () => releaseTerminal?.(),
    () => signal.removeEventListener("abort", onAbort),
    ...unsubscribes,
    () => lifetime.abort(new Error("terminal client exited")),
  ]) {
    try {
      cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  // Join every session's close and the observation's end; none may be abandoned, and no failure is dropped.
  const closeFailures = (
    await Promise.allSettled([
      observer.stop(),
      ...transports.map(async (transport) => transport.close()),
    ])
  ).flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  closeFailures.unshift(...cleanupFailures, ...failures);
  if (!outcome.ok) {
    if (closeFailures.length === 0) throw outcome.error;
    throw new AggregateError(
      [outcome.error, ...closeFailures],
      "The terminal client failed and its connections could not all be closed"
    );
  }
  if (closeFailures.length === 1) throw closeFailures[0];
  if (closeFailures.length > 1) {
    throw new AggregateError(
      closeFailures,
      "The terminal client's connections could not all be closed"
    );
  }
  return outcome.result;
}

function describeLost(state: TerminalConnectionState): string {
  const current = state.current();
  return current.phase === "lost" ? current.cause : current.phase;
}
