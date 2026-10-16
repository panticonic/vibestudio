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
import type { ConnectionStatus } from "./serverClient.js";
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
  private readonly cdpTokens = new Map<string, string>();

  constructor(readonly channel: ControlChannel) {
    this.clients = new RemoteServerClients(channel);
    channel.on("cdp-token", ({ workspaceId, token }: { workspaceId: string; token: string }) => {
      this.cdpTokens.set(workspaceId, token);
    });
  }

  /** Serve the connection process's questions about host-owned services. */
  serveHost(endpoint: HostEndpoint): void {
    const { channel } = this;
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
    channel.handle("host.confirm-existing-hub", (lease) => handlers.confirmExistingLocalHub(lease));
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

    const descriptor = await channel.request<SessionDescriptor>("connection.establish", { args });
    const primary = this.workspaceConnection(descriptor);
    this.primary = primary.serverClient as RemoteServerClient;
    const workspaceSessions = new WorkspaceSessionDirectory<WorkspaceSessionConnection>(
      primary,
      async (workspaceId) =>
        this.workspaceConnection(
          await channel.request<WorkspaceDescriptor>("workspace.connect", { workspaceId })
        )
    );
    const hubControlClient = this.clients.adopt(descriptor.hubControl);
    const hubProcess: HubProcessHandle | null = descriptor.hasHubProcess
      ? {
          detach: () => channel.request<void>("hub.detach", {}),
          beginShutdown: () => channel.request<void>("hub.begin-shutdown", {}),
          stopTree: () => channel.request<ProcessTreeTerminationResult>("hub.stop-tree", {}),
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
          await channel.request("connection.close", {});
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Session close failed");
      },
    };
  }

  private workspaceConnection(descriptor: WorkspaceDescriptor): WorkspaceSessionConnection {
    const client = this.clients.adopt(descriptor.client);
    const { channel } = this;
    this.cdpTokens.set(descriptor.workspaceId, descriptor.cdpAuthToken);
    const serverInfo: ServerInfo = {
      gatewayConfig: descriptor.gatewayConfig,
      workerdPort: 0,
      externalHost: descriptor.externalHost,
      gatewayPort: descriptor.panelPort,
      protocol: descriptor.protocol,
      call: (service, method, args) => client.call(service, method, args),
    };
    return {
      nativeStorageScope: descriptor.nativeStorageScope,
      connectionMode: descriptor.connectionMode,
      serverOwnership: descriptor.serverOwnership,
      protocol: descriptor.protocol,
      gatewayPort: descriptor.gatewayPort,
      externalHost: descriptor.externalHost,
      gatewayConfig: descriptor.gatewayConfig,
      workerdPort: descriptor.workerdPort,
      workspaceName: descriptor.workspaceName,
      workspaceId: descriptor.workspaceId,
      workspacePath: descriptor.workspacePath,
      statePath: descriptor.statePath,
      workspaceConfig: descriptor.workspaceConfig,
      serverClient: client,
      panelHttpServer: {
        getBuildRevision: () => undefined,
        invalidateBuild: () => {},
        getPort: () => descriptor.panelPort,
      },
      serverInfo,
      getCdpAuthToken: () => this.cdpTokens.get(descriptor.workspaceId) ?? "",
      assetDiagnostics: () =>
        descriptor.hasAssetFacade
          ? channel.request<PanelAssetDiagnostics | null>("workspace.asset-diagnostics", {
              workspaceId: descriptor.workspaceId,
            })
          : Promise.resolve(null),
      close: async () => {
        try {
          await channel.request("workspace.close", { workspaceId: descriptor.workspaceId });
        } finally {
          this.cdpTokens.delete(descriptor.workspaceId);
          this.clients.forget(descriptor.client.handle);
        }
      },
    };
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
