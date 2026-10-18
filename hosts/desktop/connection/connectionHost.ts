import { createDevLogger } from "@vibestudio/dev-log";
import {
  RpcBoundaryError,
  formatRpcFailure,
  serializeRpcFailure,
  type RpcCallOptions,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import { SESSION_CONNECTION_LOST_CODE } from "@vibestudio/rpc/protocol/remoteSession";
import type { ClientArtifactStore } from "@vibestudio/client-host-core";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { gatewayMethods } from "@vibestudio/service-schemas/gateway";
import type { CentralDataManager } from "@vibestudio/shared/centralData";
import type {
  ConnectedSession,
  ConnectedWorkspace,
  establishServerSession,
} from "../main/serverSession.js";
import type { ConnectedServerClient } from "../main/serverClient.js";
import type { DeviceCredentialEntry } from "../main/services/deviceCredentialStore.js";
import { ControlChannel, StreamReply, StreamedResponse } from "./controlChannel.js";
import type {
  ClientCall,
  ClientState,
  ConnectionEvents,
  ConnectionToMain,
  EstablishArgs,
  HostDispatch,
  MainToConnection,
  SessionDescriptor,
  WorkspaceDescriptor,
} from "./connectionProtocol.js";
import type { HostCall, HostServiceEndpoint } from "./hostServices.js";
import { ClientLaunchHost } from "./clientLaunchHost.js";
import { RendererPortHost } from "./rendererPortHost.js";
import type { WorkspaceIpcRuntime } from "./uiSessions.js";

const log = createDevLogger("ConnectionHost");

export interface ConnectionHostDeps {
  channel: ControlChannel;
  establish: typeof establishServerSession;
  createCentralData(): CentralDataManager;
  /** The content-addressed store of verified client artifacts under a user-data root. */
  createArtifactStore(userDataPath: string): ClientArtifactStore;
}

interface ClientEntry {
  handle: number;
  client: ConnectedServerClient;
  /** Event subscriptions main asked for, by event name. */
  subscriptions: Map<string, () => void>;
  release(): void;
}

interface WorkspaceEntry {
  connection: ConnectedWorkspace;
  entry: ClientEntry;
  releaseCdp(): void;
}

type RequestArgs<K extends keyof MainToConnection> = MainToConnection[K];

/** Statuses for which a response may not carry a body. */
const BODYLESS_STATUS = new Set([101, 204, 205, 304]);

function optionsWith<T extends { signal?: AbortSignal }>(options: unknown, signal: AbortSignal): T {
  return { ...((options as object | undefined) ?? {}), signal } as T;
}

/**
 * Serves the control channel from inside the connection utility process.
 *
 * Owns the hub connection and every logical session on it. Main holds proxies
 * of the clients it needs for its own calls; renderer ports are bound straight
 * to sessions here and their traffic never reaches main.
 */
export class ConnectionHost {
  private readonly clients = new Map<number, ClientEntry>();
  private readonly clientByObject = new Map<ConnectedServerClient, ClientEntry>();
  private readonly workspaces = new Map<string, WorkspaceEntry>();
  private readonly runtimes = new Map<string, Promise<WorkspaceIpcRuntime>>();
  private session: ConnectedSession | null = null;
  /** Outlives the connection: main stops or detaches the hub after the sessions closed. */
  private hubManager: ConnectedSession["hubProcessManager"] = null;
  private ports: RendererPortHost | null = null;
  private launches: ClientLaunchHost | null = null;
  private nextHandle = 1;
  private closing: Promise<void> | null = null;

  constructor(private readonly deps: ConnectionHostDeps) {
    const { channel } = deps;
    const handle = <K extends keyof MainToConnection>(
      method: K,
      handler: (
        payload: RequestArgs<K>,
        context: Parameters<Parameters<ControlChannel["handle"]>[1]>[1]
      ) => unknown
    ): void => channel.handle(method, handler as never);

    handle("connection.establish", ({ args }) => this.establish(args));
    handle("connection.close", () => this.close());
    handle("hub.detach", () => this.hubProcess().detach());
    handle("hub.begin-shutdown", () => this.hubProcess().beginShutdown());
    handle("hub.stop-tree", () => this.hubProcess().stopTree());
    handle("workspace.connect", ({ workspaceId }) => this.connectWorkspace(workspaceId));
    handle("workspace.close", ({ workspaceId }) => this.closeWorkspace(workspaceId));
    handle("workspace.asset-diagnostics", ({ workspaceId }) => this.assetDiagnostics(workspaceId));
    handle("client.call", (call, context) => this.clientCall(call, context.signal));
    handle("client.stream", (call, context) => this.clientStream(call, context));
    handle("client.subscribe", ({ handle: id, event }) => this.subscribe(id, event));
    handle("client.unsubscribe", ({ handle: id, event }) => this.unsubscribe(id, event));
    handle("client.expose", ({ handle: id, method, stream }) => this.expose(id, method, stream));
    handle("client.nudge", ({ handle: id }) => this.entry(id).client.nudge?.());
    handle("client.close", ({ handle: id }) => this.entry(id).client.close());
    handle("ports.bind", ({ binding }, context) => {
      const [port] = context.ports;
      if (!port) throw new Error("A port binding requires a transferred port");
      const { hostsPanels, client, ...caller } = binding;
      this.portHost().bind(port, { caller, state: { hostsPanels, ...(client ? { client } : {}) } });
    });
    handle("ports.hold-client-session", ({ caller }) => this.portHost().holdClientSession(caller));
    handle("ports.shutdown", () => this.ports?.shutdown());
    handle("ports.update", ({ callerId, client }) =>
      this.portHost().updateClient(callerId, client)
    );
    handle("ports.release", ({ callerId }) =>
      this.portHost().release(callerId, "The window was closed")
    );
    handle("ports.retire", ({ callerId }) =>
      this.portHost().retire(callerId, "The document was retired")
    );
    handle("ports.revoke-ui", ({ callerId }) => this.portHost().revokeUi(callerId));
    handle("ports.deliver-shell", ({ workspaceId, event, payload }) =>
      this.portHost().sendEventToShell(workspaceId, event, payload)
    );
    handle("catalog.invalidate", ({ workspaceId }) => {
      this.runtimes.delete(workspaceId);
    });

    // The end of the control channel is the end of this process's purpose.
    channel.onClose(() => void this.close().catch(() => undefined));
  }

  private emit<K extends keyof ConnectionEvents>(event: K, payload: ConnectionEvents[K]): void {
    this.deps.channel.emit(event, payload);
  }

  private request<K extends keyof ConnectionToMain>(
    method: K,
    payload: ConnectionToMain[K],
    options?: Parameters<ControlChannel["request"]>[2]
  ): Promise<unknown> {
    return this.deps.channel.request(method, payload, options);
  }

  private hubProcess() {
    if (!this.hubManager) throw new Error("This connection has no local hub process");
    return this.hubManager;
  }

  private portHost(): RendererPortHost {
    if (!this.ports) throw new Error("The connection is not established");
    return this.ports;
  }

  private entry(handle: number): ClientEntry {
    const entry = this.clients.get(handle);
    if (!entry) {
      throw new RpcBoundaryError(
        "This server client is no longer available",
        "transport",
        SESSION_CONNECTION_LOST_CODE
      );
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // Establishing the connection
  // -------------------------------------------------------------------------

  private async establish(args: EstablishArgs): Promise<SessionDescriptor> {
    if (this.session) throw new Error("The connection is already established");
    const session = await this.deps.establish({
      mode: args.mode,
      pendingPairing: args.pendingPairing,
      pendingPairLabel: args.pendingPairLabel,
      storedRemote: args.storedRemote,
      appVersion: args.appVersion,
      userDataPath: args.userDataPath,
      centralData: this.deps.createCentralData(),
      credentials: {
        load: async (serverId) =>
          (await this.request("host.credential-load", {
            serverId,
          })) as DeviceCredentialEntry | null,
        preflight: async () => {
          await this.request("host.credential-preflight", {});
        },
        save: async (credential) => {
          await this.request("host.credential-save", { credential });
        },
      },
      onCredentialSaveFailed: (error) =>
        this.emit("credential-save-failed", serializeRpcFailure(error, "internal")),
      confirmExistingLocalHub: async (lease) =>
        (await this.request("host.confirm-existing-hub", {
          pid: lease.pid,
          gatewayPort: lease.gatewayPort,
        })) as "attach" | "replace" | "cancel",
      onInitialWorkspaceResolved: args.prepareInitialWorkspace
        ? (id, prepare) => {
            // The hub owns child startup. Ask it to prepare the known focus
            // target while System is still being built.
            void prepare().catch((error: unknown) => {
              log.warn(`Could not prepare initial workspace ${id}: ${formatRpcFailure(error)}`);
            });
          }
        : undefined,
      onStartupProgress: (progress) => this.emit("startup-progress", progress),
      onLocalRecoveryFailure: (error) =>
        this.emit("local-recovery-failure", serializeRpcFailure(error, "internal")),
      onMainSessionTerminalClose: (error) =>
        this.emit("terminal-close", serializeRpcFailure(error, "transport")),
      onConnectionStatusChanged: (status) => this.emit("connection-status", status),
      onTransportDiagnosticsChanged: (diagnostics) =>
        this.emit("transport-diagnostics", diagnostics),
      onReconnectProgress: (progress) => this.emit("reconnect-progress", progress),
    });
    this.session = session;
    const gateway = createTypedServiceClient("gateway", gatewayMethods, (service, method, args) =>
      session.serverClient.stream(service, method, args)
    );
    this.launches = new ClientLaunchHost({
      channel: this.deps.channel,
      call: (service, method, args) => session.serverClient.call(service, method, args),
      fetchArtifact: (route) => gateway.fetch({ path: route, method: "GET" }),
      store: this.deps.createArtifactStore(args.userDataPath),
    });
    // Client sessions are granted for the exact build this process verified.
    session.serverClient.setClientPrincipalSessions(this.launches.principalSessions());
    this.hubManager = session.hubProcessManager;
    const workspace = this.registerWorkspace(session);
    const hub = this.registerClient(session.hubControlClient);
    this.ports = new RendererPortHost({
      workspaceId: session.workspaceId,
      hubControlClient: session.hubControlClient,
      resolveWorkspace: (workspaceId) => this.resolveRuntime(workspaceId),
      panelRuntimeConnection: async (callerId) =>
        (await this.request("host.panel-lease", { callerId })) as
          | { runtimeEntityId: string; connectionId: string }
          | undefined,
    });
    return {
      ...workspace,
      ...(session.initialFocusedWorkspaceId
        ? { initialFocusedWorkspaceId: session.initialFocusedWorkspaceId }
        : {}),
      hubControl: this.stateOf(hub),
      hasHubProcess: session.hubProcessManager !== null,
    };
  }

  private async connectWorkspace(workspaceId: string): Promise<WorkspaceDescriptor> {
    const session = this.session;
    if (!session) throw new Error("The connection is not established");
    const connection = await session.connectWorkspace(workspaceId);
    try {
      return this.registerWorkspace(connection);
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  private registerWorkspace(connection: ConnectedWorkspace): WorkspaceDescriptor {
    const entry = this.registerClient(connection.serverClient);
    const releaseCdp = connection.onCdpAuthToken((token) =>
      this.emit("cdp-token", { workspaceId: connection.workspaceId, token })
    );
    this.workspaces.set(connection.workspaceId, { connection, entry, releaseCdp });
    return {
      client: this.stateOf(entry),
      nativeStorageScope: connection.nativeStorageScope,
      connectionMode: connection.connectionMode,
      serverOwnership: connection.serverOwnership,
      protocol: connection.protocol,
      gatewayPort: connection.gatewayPort,
      externalHost: connection.externalHost,
      gatewayConfig: connection.gatewayConfig,
      workerdPort: connection.workerdPort,
      workspaceName: connection.workspaceName,
      workspaceId: connection.workspaceId,
      workspacePath: connection.workspacePath,
      statePath: connection.statePath,
      workspaceConfig: connection.workspaceConfig,
      panelPort: connection.panelHttpServer.getPort(),
      hasAssetFacade: connection.panelHttpServer.getAssetDiagnostics !== undefined,
      cdpAuthToken: connection.getCdpAuthToken(),
    };
  }

  private async closeWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    this.runtimes.delete(workspaceId);
    if (!workspace) return;
    this.workspaces.delete(workspaceId);
    workspace.releaseCdp();
    try {
      await workspace.connection.close();
    } finally {
      workspace.entry.release();
    }
  }

  private assetDiagnostics(workspaceId: string): unknown {
    const workspace = this.workspaces.get(workspaceId);
    return workspace?.connection.panelHttpServer.getAssetDiagnostics?.() ?? null;
  }

  // -------------------------------------------------------------------------
  // Server clients
  // -------------------------------------------------------------------------

  private registerClient(client: ConnectedServerClient): ClientEntry {
    const existing = this.clientByObject.get(client);
    if (existing) return existing;
    const handle = this.nextHandle++;
    const entry: ClientEntry = {
      handle,
      client,
      subscriptions: new Map(),
      release: () => undefined,
    };
    const offStatus = client.onConnectionStatusChange(() =>
      this.emit("client.status", this.stateOf(entry))
    );
    // Recovery is awaited by the transport, so main's recovery work settles
    // before the server session is considered recovered, as it did in-process.
    const offRecovery = client.onRecovery((kind) =>
      this.request("client.recovery", { handle, kind }).then(() => undefined)
    );
    entry.release = () => {
      offStatus();
      offRecovery();
      for (const unsubscribe of entry.subscriptions.values()) unsubscribe();
      entry.subscriptions.clear();
      this.clients.delete(handle);
      this.clientByObject.delete(client);
    };
    this.clients.set(handle, entry);
    this.clientByObject.set(client, entry);
    return entry;
  }

  private stateOf(entry: ClientEntry): ClientState {
    const { client } = entry;
    return {
      handle: entry.handle,
      status: client.getConnectionStatus(),
      closed: client.isClosed(),
      diagnostics: client.transportDiagnostics(),
      canNudge: typeof client.nudge === "function",
    };
  }

  private clientCall(call: ClientCall, signal: AbortSignal): Promise<unknown> {
    const { client } = this.entry(call.handle);
    const options = optionsWith<RpcCallOptions>(call.options, signal);
    if (call.target !== undefined)
      return client.callTarget(call.target, call.method, call.args, options);
    if (call.as) return client.callAs(call.as, call.service, call.method, call.args, options);
    return client.call(call.service, call.method, call.args, options);
  }

  private async clientStream(
    call: ClientCall & { readable: boolean },
    context: { signal: AbortSignal; body: ReadableStream<Uint8Array> | null }
  ): Promise<StreamReply> {
    const { client } = this.entry(call.handle);
    const options = {
      ...optionsWith<RpcStreamOptions>(call.options, context.signal),
      ...(context.body ? { body: context.body } : {}),
    };
    if (call.readable) {
      const stream = await client.streamReadable(call.service, call.method, call.args, options);
      return new StreamReply(
        {
          status: stream.status,
          statusText: stream.statusText,
          headers: stream.headers,
          url: stream.finalUrl,
        },
        stream.body
      );
    }
    const response = call.as
      ? await client.streamAs(call.as, call.service, call.method, call.args, options)
      : await client.stream(call.service, call.method, call.args, options);
    return new StreamReply(
      {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        url: response.url,
      },
      response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    );
  }

  private subscribe(handle: number, event: string): void {
    const entry = this.entry(handle);
    if (entry.subscriptions.has(event)) return;
    entry.subscriptions.set(
      event,
      entry.client.onDirectEvent(event as never, (payload: unknown) =>
        this.emit("client.event", { handle, event, payload })
      )
    );
  }

  private unsubscribe(handle: number, event: string): void {
    const entry = this.clients.get(handle);
    entry?.subscriptions.get(event)?.();
    entry?.subscriptions.delete(event);
  }

  private expose(handle: number, method: string, stream: boolean): void {
    const { client } = this.entry(handle);
    if (!stream) {
      client.exposeHostMethod(method, ({ args, signal }) =>
        this.deps.channel.request("host.call", { handle, method, args }, { signal })
      );
      return;
    }
    client.exposeHostStream(method, async ({ args, signal }) => {
      const reply = await this.deps.channel.requestStream<{
        status: number;
        statusText: string;
        headers: [string, string][];
      }>("host.stream", { handle, method, args }, { signal });
      return new Response(BODYLESS_STATUS.has(reply.head.status) ? null : reply.body, {
        status: reply.head.status,
        statusText: reply.head.statusText,
        headers: reply.head.headers,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Host-owned services of workspace runtimes
  // -------------------------------------------------------------------------

  /**
   * One workspace's runtime for renderer routing: this process's client for it
   * and the catalog of services main owns for it. Main answers the catalog only
   * for a workspace whose desktop runtime is admitted, so a removed workspace
   * cannot be reached through a stale cache here.
   */
  private resolveRuntime(workspaceId: string): Promise<WorkspaceIpcRuntime> {
    const cached = this.runtimes.get(workspaceId);
    if (cached) return cached;
    const opening = (async (): Promise<WorkspaceIpcRuntime> => {
      const names = (await this.request("host.catalog", { workspaceId })) as string[];
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) {
        throw new RpcBoundaryError(
          "Workspace access was removed",
          "transport",
          SESSION_CONNECTION_LOST_CODE
        );
      }
      return {
        workspaceId,
        serverClient: workspace.connection.serverClient,
        dispatcher: new RemoteHostServices(this.deps.channel, new Set(names)),
      };
    })();
    this.runtimes.set(workspaceId, opening);
    opening.catch(() => {
      if (this.runtimes.get(workspaceId) === opening) this.runtimes.delete(workspaceId);
    });
    return opening;
  }

  // -------------------------------------------------------------------------
  // End of life
  // -------------------------------------------------------------------------

  /**
   * Release everything the connection owns. The hub process itself is left to
   * main's quit policy (`hub.stop-tree` / `hub.detach`); closing the connection
   * only ends this desktop's sessions on it.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const failures: unknown[] = [];
      const collect = async (work: () => Promise<unknown> | unknown): Promise<void> => {
        try {
          await work();
        } catch (error) {
          failures.push(error);
        }
      };
      await collect(() => this.ports?.shutdown());
      const session = this.session;
      const extras = [...this.workspaces.values()].filter(
        (workspace) => workspace.connection !== session
      );
      for (const workspace of extras) {
        workspace.releaseCdp();
        await collect(() => workspace.connection.close());
        workspace.entry.release();
      }
      this.workspaces.clear();
      this.runtimes.clear();
      await collect(() => session?.close());
      for (const entry of [...this.clients.values()]) entry.release();
      this.session = null;
      this.ports = null;
      this.launches = null;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Connection cleanup failed");
    })();
    return this.closing;
  }
}

/**
 * A workspace runtime's host-owned services, reached through main. The service
 * names are the runtime's catalog at the time it was resolved.
 */
class RemoteHostServices implements HostServiceEndpoint {
  constructor(
    private readonly channel: ControlChannel,
    private readonly names: ReadonlySet<string>
  ) {}

  hasService(service: string): boolean {
    return this.names.has(service);
  }

  async dispatch(
    call: HostCall,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const request: HostDispatch = {
      workspaceId: call.workspaceId,
      callerId: call.callerId,
      callerKind: call.callerKind,
      requestId: call.requestId,
      service,
      method,
      args,
      ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
      ...(call.readOnly ? { readOnly: true } : {}),
    };
    const result = await this.channel.requestEither<{
      status: number;
      statusText: string;
      headers: [string, string][];
    }>("host.dispatch", request, {
      ...(call.signal ? { signal: call.signal } : {}),
      ...(call.body ? { body: call.body } : {}),
    });
    if (result instanceof StreamedResponse) {
      return new Response(BODYLESS_STATUS.has(result.head.status) ? null : result.body, {
        status: result.head.status,
        statusText: result.head.statusText,
        headers: result.head.headers,
      });
    }
    return result;
  }

  observeFailure(call: HostCall, service: string, method: string, error: unknown): void {
    const event: ConnectionEvents["host.observe-failure"] = {
      workspaceId: call.workspaceId,
      callerId: call.callerId,
      callerKind: call.callerKind,
      requestId: call.requestId,
      service,
      method,
      error: serializeRpcFailure(error, "internal"),
    };
    this.channel.emit("host.observe-failure", event);
  }
}
