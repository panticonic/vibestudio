/**
 * IrohServerClient — the desktop shell's {@link ServerClient} over the Iroh
 * pipe. It is the peer-to-peer counterpart of `createServerClient` (which dials a
 * co-located loopback `/rpc` over WS): same `ServerClient` surface, but every
 * principal is a logical session over one authenticated QUIC connection rather than its
 * own socket.
 *
 * Structure mirrors `createServerClient` exactly so the two are interchangeable
 * behind `ServerClient`:
 *   - the main `shell` principal is one `openSession(...)` over the pipe;
 *   - each Electron-hosted `app` principal gets a one-time connection grant
 *     (`auth.grantConnection`) redeemed by its own `openSession(...)` over the
 *     same pipe — so one app dropping never tears down others. The server derives
 *     the authoritative caller-kind from the redeemed grant, not the session.
 *
 * The shell token is supplied by the caller (`getShellToken`), exactly as the
 * local path receives `ports.shellToken` from its child server and the CLI client
 * receives `getToken`: the device-credential → shell-token derivation is the
 * pairing layer's concern, not the transport's. The native Iroh binding is
 * loaded lazily, so non-remote shells never touch it.
 */

import { randomUUID } from "node:crypto";
import {
  createRpcClient,
  type RpcClient,
  type RpcCallOptions,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import {
  createIrohClientPipe,
  type IrohClientPipe,
  type IrohClientSession,
} from "@vibestudio/rpc/transports/irohClient";
import { createReconnectingIrohClientPipe } from "@vibestudio/rpc/transports/reconnectingIrohClient";
import type { LifecycleIrohClientPipe } from "@vibestudio/rpc/transports/reconnectingIrohClient";
import type { DeviceCredential, PairingContext } from "@vibestudio/rpc/protocol/wsProtocol";
import { EndpointGenerationOwner, type IrohReach } from "@vibestudio/iroh-transport";
import {
  createNodeEndpointBinding,
  loadIrohNodeBinding,
  type NodePhysicalConnection,
  type NodePhysicalEndpoint,
} from "@vibestudio/iroh-transport/node";
import { authMethods } from "@vibestudio/service-schemas/auth";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type {
  ConnectionStatus,
  HostServiceHandler,
  PanelSession,
  ScopedServerCaller,
  ServerClient,
  ServerMessageListener,
} from "./serverClient.js";
import { exposeServerOriginatedHostMethod } from "./serverClient.js";
import type { RemoteTransportDiagnostics } from "@vibestudio/shared/types";

export interface IrohServerClientArgs {
  reach: IrohReach;
  endpointSecret?: Uint8Array;
  endpointOwner?: EndpointGenerationOwner<NodePhysicalConnection, NodePhysicalEndpoint>;
  /** The shell's caller id, e.g. `shell:<deviceId>`. */
  callerId: string;
  /**
   * Supplies the short-lived shell token for each (re)open of the main session.
   * Re-invoked per open because connection grants are one-shot. The
   * device-credential → shell-token derivation lives in the pairing layer.
   */
  getShellToken: () => Promise<string> | string;
  /** Stable connection id (lease key) for the main shell session. */
  connectionId?: string;
  /**
   * Fired once when the main session paired a fresh device (the QR code was
   * redeemed): the durable device credential to persist so `getShellToken` can
   * switch to `refresh:<deviceId>:<refreshToken>` for reconnects.
   */
  onPaired?: (credential: DeviceCredential, context?: PairingContext) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onTransportDiagnosticsChanged?: (diagnostics: RemoteTransportDiagnostics | null) => void;
  onReconnectProgress?: (progress: {
    attempt: number;
    phase: "scheduled" | "failed";
    reason: string;
    nextRetryInMs?: number;
  }) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  onMainSessionTerminalClose?: (error: Error) => void;
  /** Test seam: a verified, already-started Iroh pipe. */
  pipe?: IrohClientPipe;
}

/**
 * The desktop shell's `ServerClient` over the Iroh pipe, plus additive
 * transport observability the loopback WS client has no equivalent for.
 */
export interface IrohServerClient extends ServerClient {
  /** Process-supervisor edge for one atomic native endpoint replacement. */
  invalidateEndpointGeneration(generation: number, reason: string): void;
}

function remoteDiagnosticsOf(
  diagnostics: ReturnType<IrohClientPipe["diagnostics"]>
): RemoteTransportDiagnostics | null {
  const selected = diagnostics?.paths.find((path) => path.selected);
  if (!selected) return null;
  return {
    path: selected.kind,
    ...(selected.rttMs == null && diagnostics?.rttMs == null
      ? {}
      : { rttMs: selected.rttMs ?? diagnostics?.rttMs }),
    ...(selected.remoteAddress ? { remoteAddress: selected.remoteAddress } : {}),
    ...(diagnostics?.dialRelayUrl ? { relayUrl: diagnostics.dialRelayUrl } : {}),
    ...(diagnostics?.endpointGeneration
      ? { endpointGeneration: diagnostics.endpointGeneration }
      : {}),
    ...(diagnostics?.dialAttempts === undefined ? {} : { dialAttempts: diagnostics.dialAttempts }),
    ...(diagnostics?.transmittedBytes === undefined
      ? {}
      : { transmittedBytes: diagnostics.transmittedBytes }),
    ...(diagnostics?.receivedBytes === undefined
      ? {}
      : { receivedBytes: diagnostics.receivedBytes }),
    ...(diagnostics?.lostBytes === undefined ? {} : { lostBytes: diagnostics.lostBytes }),
    ...(diagnostics?.logicalSessions === undefined
      ? {}
      : { logicalSessions: diagnostics.logicalSessions }),
    ...(diagnostics?.activeRequests === undefined
      ? {}
      : { activeRequests: diagnostics.activeRequests }),
  };
}

export async function createIrohServerClient(
  args: IrohServerClientArgs
): Promise<IrohServerClient> {
  if (!args.pipe && !args.endpointOwner && args.endpointSecret?.byteLength !== 32) {
    throw new Error("Iroh endpoint secret must contain exactly 32 bytes");
  }
  const ownsEndpoint = !args.pipe && !args.endpointOwner;
  const endpointOwner = args.pipe
    ? null
    : (args.endpointOwner ??
      new EndpointGenerationOwner<NodePhysicalConnection, NodePhysicalEndpoint>(
        createNodeEndpointBinding({
          secretKey: loadIrohNodeBinding().SecretKey.fromBytes([...args.endpointSecret!]),
          relayUrls: args.reach.relays,
        })
      ));
  let transport: IrohClientPipe;
  let lifecycleTransport: LifecycleIrohClientPipe | null = null;
  if (args.pipe) {
    transport = args.pipe;
  } else {
    lifecycleTransport = createReconnectingIrohClientPipe({
      peerEndpointId: args.reach.endpointId,
      dial: async () => {
        const dialed = await endpointOwner!.dial({
          reach: args.reach,
          overallDeadlineMs: 30_000,
          perAttemptDeadlineMs: 12_000,
        });
        return createIrohClientPipe(dialed.connection, dialed);
      },
      closeEndpoint: async () => {
        if (ownsEndpoint) await endpointOwner!.close();
      },
      onReconnectAttempt: (attempt, delayMs) =>
        args.onReconnectProgress?.({
          attempt,
          phase: "scheduled",
          reason: "physical Iroh connection closed",
          nextRetryInMs: delayMs,
        }),
      onReconnectResult: (result) => {
        if (!result.success) {
          args.onReconnectProgress?.({
            attempt: result.attempt,
            phase: "failed",
            reason: result.error?.message ?? "Iroh reconnect failed",
          });
        }
      },
    });
    transport = lifecycleTransport;
  }
  let mainSessionTerminalError: Error | null = null;
  const recoveryHandlers = new Set<
    (kind: "resubscribe" | "cold-recover") => void | Promise<void>
  >();
  const mainConnectionId = args.connectionId ?? randomUUID();
  const mainSession = transport.openSession({
    sid: mainConnectionId,
    connectionId: mainConnectionId,
    getToken: args.getShellToken,
    clientPlatform: "desktop",
    oauthCallbackMode: "client-loopback",
    ...(args.onPaired ? { onPaired: args.onPaired } : {}),
    // App-level recovery passthrough (subscriptions/state replay). Registered on
    // the session before its first open, so it catches the first-open recovery.
    onRecovery: async (kind) => {
      await args.onRecovery?.(kind);
      for (const handler of recoveryHandlers) await handler(kind);
    },
    onTerminalClose: (error) => {
      mainSessionTerminalError = error;
      args.onMainSessionTerminalClose?.(error);
    },
  });
  await mainSession.ready?.();
  const effectiveConnectionStatus = (): ConnectionStatus =>
    mainSessionTerminalError ? "disconnected" : transport.status();
  transport.onStatusChange(() => args.onConnectionStatusChanged?.(effectiveConnectionStatus()));
  transport.onDiagnosticsChange((diagnostics) =>
    args.onTransportDiagnosticsChanged?.(remoteDiagnosticsOf(diagnostics))
  );
  const rpc = createRpcClient({
    selfId: args.callerId,
    callerKind: "shell",
    transport: mainSession,
    // §3.4 pending-call policy: on a cold-recover, the core rejects routed
    // pendings (server session state gone). Fed from the paired connection's
    // recovery fan-out (the same signal that drives the app-level onRecovery).
    onRecovery: (handler) => {
      recoveryHandlers.add(handler);
      return () => recoveryHandlers.delete(handler);
    },
  });
  const authClient = createTypedServiceClient("auth", authMethods, (service, method, callArgs) =>
    rpc.call("main", `${service}.${method}`, callArgs)
  );

  type ScopedClient = {
    session: IrohClientSession;
    rpc: RpcClient;
    closed: boolean;
    close(): Promise<void>;
  };
  const scopedClients = new Map<string, Promise<ScopedClient>>();
  const materializedScopedClients = new Set<ScopedClient>();
  const scopedListeners = new Map<string, Set<ServerMessageListener>>();
  const scopedKey = (caller: ScopedServerCaller): string =>
    `${caller.callerKind}\x00${caller.callerId}`;
  let closing = false;

  const createScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    if (closing) throw new Error("Iroh server client is closing");
    // Only app principals get a scoped runtime connection (mirrors the WS path:
    // a panel holds its own lease; native `shell` callers use call()).
    if (caller.callerKind !== "app") {
      throw new Error(`Scoped server RPC is not available for ${caller.callerKind} callers`);
    }
    const session = transport.openSession({
      connectionId: randomUUID(),
      clientPlatform: "desktop",
      oauthCallbackMode: "client-loopback",
      // Re-grant on EVERY (re)open: connection grants are one-shot, so pinning the
      // first grant's token would fail the redeem on reconnect — the auto-reopened
      // session would reject unhandled, once per app principal. Mirrors the main
      // shell session, whose getShellToken is likewise re-invoked per open.
      getToken: async () => (await authClient.grantConnection(caller.callerId)).token,
    });
    await session.ready?.();
    if (closing) {
      await session.close().catch(() => undefined);
      throw new Error("Iroh server client is closing");
    }
    const scopedRpc = createRpcClient({
      selfId: caller.callerId,
      callerKind: caller.callerKind,
      transport: session,
    });
    session.onMessage((envelope) => {
      for (const listener of scopedListeners.get(scopedKey(caller)) ?? []) listener(envelope);
    });
    const client: ScopedClient = {
      session,
      rpc: scopedRpc,
      closed: false,
      close: async () => {
        materializedScopedClients.delete(client);
        if (client.closed) return;
        client.closed = true;
        await session.close().catch(() => undefined);
      },
    };
    materializedScopedClients.add(client);
    return client;
  };

  const getScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    if (closing) throw new Error("Iroh server client is closing");
    const key = scopedKey(caller);
    const existing = scopedClients.get(key);
    if (existing) {
      const client = await existing;
      // The pipe outlives individual sessions: a scoped session can be terminally
      // closed (e.g. a lease revoke) while transport.status() still reads
      // "connected". Reusing it would throw "Session is closed" on the next call —
      // so re-grant a fresh session when EITHER the pipe is down or the session died.
      if (transport.status() === "connected" && !client.closed) return client;
      scopedClients.delete(key);
      void client.close();
    }
    const next = createScopedClient(caller).catch((err) => {
      scopedClients.delete(key);
      throw err;
    });
    scopedClients.set(key, next);
    return next;
  };

  const openPanelSession = async (
    runtimeEntityId: string,
    connectionId: string
  ): Promise<PanelSession> => {
    // A panel-principal logical session on the panel's lease connectionId. The
    // grant for the entity id makes the server derive callerKind:"panel" and the
    // connectionId satisfies the lease gate (authorizePanelConnection). Re-grant
    // per open — grants are one-shot and the pipe auto-reopens sessions.
    let panelClosed = false;
    const session = transport.openSession({
      connectionId,
      clientPlatform: "desktop",
      oauthCallbackMode: "client-loopback",
      getToken: async () => (await authClient.grantConnection(runtimeEntityId)).token,
    });
    await session.ready?.();
    return {
      send: (envelope) => session.send(envelope),
      onMessage: (listener) => session.onMessage(listener),
      status: () => session.status?.() ?? transport.status(),
      isClosed: () => panelClosed,
      // First-class duplex stream with the §1.6 upload body: the panel bridge
      // relay (ipcDispatcher) feeds a panel's reassembled request body here and
      // it rides the request's bidirectional QUIC stream.
      streamReadable: (envelope, signal, body) => {
        if (typeof session.streamReadable !== "function") {
          throw new Error("Iroh panel session does not implement streamReadable");
        }
        return session.streamReadable(envelope, signal, body);
      },
      close: () => {
        panelClosed = true;
        void session.close();
      },
    };
  };

  return {
    invalidateEndpointGeneration(generation, reason): void {
      lifecycleTransport?.invalidateEndpointGeneration(generation, reason);
    },
    exposeHostMethod(method: string, handler: HostServiceHandler): void {
      exposeServerOriginatedHostMethod(rpc, method, handler);
    },
    call(service, method, callArgs, options?: RpcCallOptions): Promise<unknown> {
      return rpc.call("main", `${service}.${method}`, callArgs, options);
    },
    callTarget(targetId, method, callArgs, options?: RpcCallOptions): Promise<unknown> {
      return rpc.call(targetId, method, callArgs, options);
    },
    stream(service, method, callArgs, options?: RpcStreamOptions): Promise<Response> {
      // Streamed over a dedicated QUIC stream — for
      // large bodies like gateway.fetch panel assets. `options.body` streams a
      // REQUEST body out on the same channel (plan §1.6).
      return rpc.stream("main", `${service}.${method}`, callArgs, options);
    },
    onDirectEvent(event, listener) {
      return rpc.on(event, ({ payload }) => listener(payload as never));
    },
    async callAs(caller, service, method, callArgs, options?: RpcCallOptions): Promise<unknown> {
      const client = await getScopedClient(caller);
      return client.rpc.call("main", `${service}.${method}`, callArgs, options);
    },
    async sendAs(caller, envelope): Promise<void> {
      const client = await getScopedClient(caller);
      await client.session.send(envelope);
    },
    async streamAs(
      caller,
      service,
      method,
      callArgs,
      options?: RpcStreamOptions
    ): Promise<Response> {
      const client = await getScopedClient(caller);
      return client.rpc.stream("main", `${service}.${method}`, callArgs, options);
    },
    addMessageListener(caller, listener): () => void {
      const key = scopedKey(caller);
      let listeners = scopedListeners.get(key);
      if (!listeners) {
        listeners = new Set();
        scopedListeners.set(key, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) scopedListeners.delete(key);
      };
    },
    openPanelSession,
    isConnected(): boolean {
      return effectiveConnectionStatus() === "connected";
    },
    getConnectionStatus(): ConnectionStatus {
      return effectiveConnectionStatus();
    },
    transportDiagnostics(): RemoteTransportDiagnostics | null {
      return remoteDiagnosticsOf(transport.diagnostics());
    },
    async close(): Promise<void> {
      closing = true;
      const scoped = [...materializedScopedClients];
      scopedClients.clear();
      await Promise.allSettled([mainSession.close(), ...scoped.map((client) => client.close())]);
      materializedScopedClients.clear();
      await transport.close();
    },
  };
}
