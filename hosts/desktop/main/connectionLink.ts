import { createDevLogger } from "@vibestudio/dev-log";
import { deserializeRpcFailure, formatRpcFailure, type RpcFailure } from "@vibestudio/rpc";
import type { RemoteTransportDiagnostics } from "@vibestudio/shared/types";
import {
  StreamReply,
  type ControlChannel,
  type MessagePortLike,
} from "../connection/controlChannel.js";
import type {
  ClientBindingState,
  ConnectionEvents,
  EstablishArgs,
  HostDispatch,
  PortBindingState,
  SessionDescriptor,
  WorkspaceDescriptor,
} from "../connection/connectionProtocol.js";
import type { NativeIpcCaller } from "../connection/uiSessions.js";
import type { StartupConnectionProgress } from "../../../src/startupConnectionProgress.js";
import type { ConnectionStatus, ScopedServerCaller } from "./serverClient.js";
import { RemoteServerClients, type RemoteServerClient } from "./remoteServerClient.js";
import type {
  HubProcessHandle,
  SessionConnection,
  WorkspaceSessionConnection,
} from "./sessionConnection.js";
import { WorkspaceSessionDirectory } from "./workspaceSessionDirectory.js";
import type { DeviceCredentialEntry } from "./services/deviceCredentialStore.js";
import type { PanelAssetDiagnostics } from "@vibestudio/shared/panelInterfaces";
import type { ServerInfo } from "./serverInfo.js";
import type { ProcessTreeTerminationResult } from "../../../scripts/owned-process-tree.mjs";

const log = createDevLogger("ConnectionLink");

/** What main answers when the connection process asks about host-owned services. */
export interface HostEndpoint {
  /** Ensure the workspace's desktop runtime and name the services main owns for it. */
  catalog(workspaceId: string): Promise<string[]>;
  /** Run one host-owned service call. A `Response` result streams back. */
  dispatch(
    request: HostDispatch,
    context: { signal: AbortSignal; body: ReadableStream<Uint8Array> | null }
  ): Promise<unknown>;
  panelLease(
    callerId: string
  ): Promise<{ runtimeEntityId: string; connectionId: string } | undefined>;
  observeFailure(event: ConnectionEvents["host.observe-failure"], error: Error): void;
}

/** What the connection process asks main while establishing and while connected. */
export interface ConnectionHandlers {
  /** Another desktop session holds the local hub: attach, replace it, or cancel. */
  confirmExistingLocalHub(lease: {
    pid: number;
    gatewayPort: number;
  }): Promise<"attach" | "replace" | "cancel">;
  /** The OS keystore, which only main can reach. */
  credentials: {
    load(serverId: string): DeviceCredentialEntry | null;
    preflight(): void;
    save(credential: DeviceCredentialEntry): void;
  };
  onStartupProgress(progress: StartupConnectionProgress): void;
  onConnectionStatusChanged(status: ConnectionStatus): void;
  onTransportDiagnosticsChanged(diagnostics: RemoteTransportDiagnostics | null): void;
  onReconnectProgress(progress: {
    attempt: number;
    phase: "scheduled" | "failed";
    reason: string;
    nextRetryInMs?: number;
  }): void;
  onLocalRecoveryFailure(error: Error): void;
  onMainSessionTerminalClose(error: Error): void;
  onCredentialSaveFailed(error: Error): void;
}

export interface PortBinding {
  caller: NativeIpcCaller;
  state: PortBindingState;
}

/** A workspace open on the connection, with the descriptor of the process serving it now. */
interface LiveWorkspace {
  client: RemoteServerClient;
  descriptor: WorkspaceDescriptor;
}

function decode(failure: RpcFailure): Error {
  return deserializeRpcFailure(failure);
}

/**
 * Main's end of the connection: establishes the desktop's connection in the
 * connection utility process, adopts the clients it reports, and gives renderer
 * documents' ports to the sessions that serve them.
 */
export class ConnectionLink {
  readonly clients: RemoteServerClients;
  private primary: RemoteServerClient | null = null;
  private hubControl: RemoteServerClient | null = null;
  private readonly cdpTokens = new Map<string, string>();
  /** The connection every workspace shares, and the other workspaces opened on it. */
  private readonly workspaces = new Map<string, LiveWorkspace>();
  private endpoint: HostEndpoint | null = null;
  private handlers: ConnectionHandlers | null = null;
  private establishArgs: EstablishArgs | null = null;
  private reestablishing = false;
  private readonly sessionEndedListeners = new Set<
    (caller: ScopedServerCaller, reason: string) => void
  >();

  constructor(channel: ControlChannel) {
    this.clients = new RemoteServerClients(channel);
    this.listen(channel);
  }

  /** The control channel of the connection process currently serving this link. */
  get channel(): ControlChannel {
    return this.clients.channel;
  }

  /** The arguments the connection was first established with. */
  get lastEstablishArgs(): EstablishArgs | null {
    return this.establishArgs;
  }

  /** A hosted client principal's session ended for good (`trust-revoked`, `retired`, ...). */
  onClientSessionEnded(listener: (caller: ScopedServerCaller, reason: string) => void): () => void {
    this.sessionEndedListeners.add(listener);
    return () => this.sessionEndedListeners.delete(listener);
  }

  private listen(channel: ControlChannel): void {
    channel.on("cdp-token", ({ workspaceId, token }: { workspaceId: string; token: string }) => {
      this.cdpTokens.set(workspaceId, token);
    });
    channel.on("clients.session-ended", (event: ConnectionEvents["clients.session-ended"]) => {
      for (const listener of [...this.sessionEndedListeners]) listener(event.caller, event.reason);
    });
  }

  /** Serve the connection process's questions about host-owned services. */
  serveHost(endpoint: HostEndpoint): void {
    this.endpoint = endpoint;
    this.registerHost(this.channel, endpoint);
  }

  private registerHost(channel: ControlChannel, endpoint: HostEndpoint): void {
    channel.handle("host.catalog", ({ workspaceId }) => endpoint.catalog(workspaceId));
    channel.handle("host.panel-lease", ({ callerId }) => endpoint.panelLease(callerId));
    channel.handle("host.dispatch", async (request: HostDispatch, context) => {
      const result = await endpoint.dispatch(request, {
        signal: context.signal,
        body: context.body,
      });
      if (!(result instanceof Response)) return result;
      return new StreamReply(
        {
          status: result.status,
          statusText: result.statusText,
          headers: [...result.headers.entries()],
        },
        result.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
      );
    });
    channel.on("host.observe-failure", (event: ConnectionEvents["host.observe-failure"]) =>
      endpoint.observeFailure(event, decode(event.error))
    );
  }

  /** Establish the desktop's connection and shape it for main's consumers. */
  async establish(args: EstablishArgs, handlers: ConnectionHandlers): Promise<SessionConnection> {
    const { channel } = this;
    this.establishArgs = args;
    this.handlers = handlers;
    this.registerHandlers(channel, handlers);
    const descriptor = await channel.request<SessionDescriptor>("connection.establish", { args });
    return this.sessionConnection(descriptor);
  }

  private registerHandlers(channel: ControlChannel, handlers: ConnectionHandlers): void {
    // A connection process that was replaced re-attaches to the hub this desktop
    // already runs; asking the person again would only repeat a question they answered.
    channel.handle("host.confirm-existing-hub", (lease) =>
      this.reestablishing ? "attach" : handlers.confirmExistingLocalHub(lease)
    );
    channel.handle("host.credential-load", ({ serverId }) => handlers.credentials.load(serverId));
    channel.handle("host.credential-preflight", () => handlers.credentials.preflight());
    channel.handle("host.credential-save", ({ credential }) =>
      handlers.credentials.save(credential)
    );
    channel.on("startup-progress", (progress: StartupConnectionProgress) =>
      handlers.onStartupProgress(progress)
    );
    channel.on("connection-status", (status: ConnectionStatus) =>
      handlers.onConnectionStatusChanged(status)
    );
    channel.on("transport-diagnostics", (diagnostics: RemoteTransportDiagnostics | null) => {
      this.primary?.applyDiagnostics(diagnostics);
      handlers.onTransportDiagnosticsChanged(diagnostics);
    });
    channel.on("reconnect-progress", (progress) => handlers.onReconnectProgress(progress));
    channel.on("local-recovery-failure", (failure: RpcFailure) =>
      handlers.onLocalRecoveryFailure(decode(failure))
    );
    channel.on("terminal-close", (failure: RpcFailure) =>
      handlers.onMainSessionTerminalClose(decode(failure))
    );
    channel.on("credential-save-failed", (failure: RpcFailure) =>
      handlers.onCredentialSaveFailed(decode(failure))
    );
  }

  private sessionConnection(descriptor: SessionDescriptor): SessionConnection {
    const primary = this.workspaceConnection(descriptor);
    this.primary = primary.serverClient as RemoteServerClient;
    const workspaceSessions = new WorkspaceSessionDirectory<WorkspaceSessionConnection>(
      primary,
      async (workspaceId) =>
        this.workspaceConnection(
          await this.channel.request<WorkspaceDescriptor>("workspace.connect", { workspaceId })
        )
    );
    const hubControlClient = this.clients.adopt(descriptor.hubControl);
    this.hubControl = hubControlClient;
    const hubProcess: HubProcessHandle | null = descriptor.hasHubProcess
      ? {
          detach: () => this.channel.request<void>("hub.detach", {}),
          beginShutdown: () => this.channel.request<void>("hub.begin-shutdown", {}),
          stopTree: () => this.channel.request<ProcessTreeTerminationResult>("hub.stop-tree", {}),
        }
      : null;
    return {
      ...primary,
      ...(descriptor.initialFocusedWorkspaceId
        ? { initialFocusedWorkspaceId: descriptor.initialFocusedWorkspaceId }
        : {}),
      hubControlClient,
      hubProcessManager: hubProcess,
      workspaceSessions,
      // Close every workspace connection, then the hub connection itself.
      close: async () => {
        const failures: unknown[] = [];
        try {
          await workspaceSessions.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.channel.request("connection.close", {});
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Session close failed");
      },
    };
  }

  private workspaceConnection(initial: WorkspaceDescriptor): WorkspaceSessionConnection {
    const client = this.clients.adopt(initial.client);
    // A replaced connection process re-establishes this workspace; the facts that
    // belong to a connection (ports, the CDP token) are read from the latest descriptor.
    const live: LiveWorkspace = { client, descriptor: initial };
    this.workspaces.set(initial.workspaceId, live);
    this.cdpTokens.set(initial.workspaceId, initial.cdpAuthToken);
    const serverInfo: ServerInfo = {
      gatewayConfig: initial.gatewayConfig,
      workerdPort: 0,
      externalHost: initial.externalHost,
      get gatewayPort() {
        return live.descriptor.panelPort;
      },
      protocol: initial.protocol,
      call: (service, method, args) => client.call(service, method, args),
    };
    return {
      nativeStorageScope: initial.nativeStorageScope,
      connectionMode: initial.connectionMode,
      serverOwnership: initial.serverOwnership,
      protocol: initial.protocol,
      gatewayPort: initial.gatewayPort,
      externalHost: initial.externalHost,
      gatewayConfig: initial.gatewayConfig,
      workerdPort: initial.workerdPort,
      workspaceName: initial.workspaceName,
      workspaceId: initial.workspaceId,
      workspacePath: initial.workspacePath,
      statePath: initial.statePath,
      workspaceConfig: initial.workspaceConfig,
      serverClient: client,
      panelHttpServer: {
        getBuildRevision: () => undefined,
        invalidateBuild: () => {},
        getPort: () => live.descriptor.panelPort,
      },
      serverInfo,
      getCdpAuthToken: () => this.cdpTokens.get(initial.workspaceId) ?? "",
      assetDiagnostics: () =>
        live.descriptor.hasAssetFacade
          ? this.channel.request<PanelAssetDiagnostics | null>("workspace.asset-diagnostics", {
              workspaceId: initial.workspaceId,
            })
          : Promise.resolve(null),
      close: async () => {
        try {
          await this.channel.request("workspace.close", { workspaceId: initial.workspaceId });
        } finally {
          this.cdpTokens.delete(initial.workspaceId);
          this.workspaces.delete(initial.workspaceId);
          this.clients.forget(live.descriptor.client.handle);
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Replacing the connection process
  // -------------------------------------------------------------------------

  /**
   * Follow a replacement connection process: re-establish the connection and
   * every workspace that was open on it, and bind each existing client proxy to
   * its new handle, so everything holding the proxies sees a connection that was
   * lost and recovered. Recovery then runs as `cold-recover`: the server sessions
   * are new, so every listener replays its state, and documents asking main for
   * their port again get one on the new process.
   *
   * Rejects when the new process cannot establish; the process's own exit fails
   * the channel, so the failure reaching here is the real one.
   */
  async reestablish(channel: ControlChannel, args: EstablishArgs): Promise<void> {
    const handlers = this.handlers;
    if (!handlers) throw new Error("The connection was never established");
    this.clients.attach(channel);
    this.listen(channel);
    if (this.endpoint) this.registerHost(channel, this.endpoint);
    this.reestablishing = true;
    try {
      this.registerHandlers(channel, handlers);
      const session = await channel.request<SessionDescriptor>("connection.establish", { args });
      this.establishArgs = args;
      const rebound: RemoteServerClient[] = [];
      const primaryId = session.workspaceId;
      this.refreshWorkspace(session, rebound);
      if (this.hubControl) {
        this.clients.rebind(this.hubControl, session.hubControl);
        rebound.push(this.hubControl);
      }
      for (const [workspaceId, live] of [...this.workspaces]) {
        if (workspaceId === primaryId) continue;
        try {
          this.refreshWorkspace(
            await channel.request<WorkspaceDescriptor>("workspace.connect", { workspaceId }),
            rebound
          );
        } catch (error) {
          // A workspace that cannot come back stays ended with this reason; the rest recover.
          log.warn(`Could not reconnect workspace ${workspaceId}: ${formatRpcFailure(error)}`);
          live.client.end(error instanceof Error ? error : new Error(formatRpcFailure(error)));
          this.workspaces.delete(workspaceId);
        }
      }
      for (const client of rebound) await client.runRecovery("cold-recover");
    } finally {
      this.reestablishing = false;
    }
  }

  private refreshWorkspace(descriptor: WorkspaceDescriptor, rebound: RemoteServerClient[]): void {
    const live = this.workspaces.get(descriptor.workspaceId);
    if (!live) throw new Error(`Workspace ${descriptor.workspaceId} was not open`);
    this.clients.rebind(live.client, descriptor.client);
    live.descriptor = descriptor;
    this.cdpTokens.set(descriptor.workspaceId, descriptor.cdpAuthToken);
    rebound.push(live.client);
  }

  // -------------------------------------------------------------------------
  // Renderer ports
  // -------------------------------------------------------------------------

  /**
   * Give `port` to the session that serves `binding`'s principal. The
   * connection process owns the port from here on; main never reads it.
   */
  bindPort(binding: PortBinding, port: MessagePortLike): Promise<void> {
    return this.channel.request(
      "ports.bind",
      { binding: { ...binding.caller, ...binding.state } },
      { transfer: [port] }
    );
  }

  /** End every renderer session; the app is shutting down. */
  shutdownPorts(): Promise<void> {
    return this.channel.request("ports.shutdown", {});
  }

  updateClient(callerId: string, client: ClientBindingState): void {
    this.fireAndObserve(
      this.channel.request("ports.update", { callerId, client }),
      "update a client window"
    );
  }

  /** A window or document ended; release every session it held. */
  releaseCaller(callerId: string): Promise<void> {
    return this.channel.request("ports.release", { callerId });
  }

  retireDocument(callerId: string): Promise<void> {
    return this.channel.request("ports.retire", { callerId });
  }

  revokeUi(callerId: string): Promise<void> {
    return this.channel.request("ports.revoke-ui", { callerId });
  }

  /** Deliver an event main produced to the panel-hosting client's document. */
  sendEventToShell(workspaceId: string, event: string, payload: unknown): void {
    this.fireAndObserve(
      this.channel.request("ports.deliver-shell", { workspaceId, event, payload }),
      "deliver an event to the shell"
    );
  }

  invalidateCatalog(workspaceId: string): void {
    this.fireAndObserve(
      this.channel.request("catalog.invalidate", { workspaceId }),
      "invalidate a service catalog"
    );
  }

  private fireAndObserve(operation: Promise<unknown>, what: string): void {
    operation.catch((error: unknown) => {
      if (this.channel.isClosed) return;
      log.error(`Could not ${what}: ${formatRpcFailure(error)}`);
    });
  }
}
