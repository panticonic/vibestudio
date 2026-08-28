/**
 * ServerClient — WebSocket RPC client that connects Electron to the server.
 */

import { WebSocket } from "ws";
import {
  createRpcClient,
  type DecodedFramedStream,
  type RpcClient,
  type RpcCallOptions,
  type RpcConnectionStatus,
  type RpcEnvelope,
  type RpcRequestContext,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import { wsClientTransport } from "@vibestudio/rpc/transports/wsClient";
import type {
  ClientPlatform,
  DeviceCredential,
  OAuthCallbackMode,
  PairingContext,
} from "@vibestudio/rpc/protocol/wsProtocol";
import { isAuthenticatedServerCaller } from "@vibestudio/rpc/protocol/remoteSession";
import { NodeWsLike } from "@vibestudio/rpc/transports/nodeWsLike";
import { authMethods } from "@vibestudio/service-schemas/auth";
import type { CallerKind } from "@vibestudio/shared/serviceDispatcher";
import type { RemoteTransportDiagnostics } from "@vibestudio/shared/types";
import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { serverRpcWsUrl } from "@vibestudio/shared/connect";

export type ConnectionStatus = RpcConnectionStatus;

export interface ScopedServerCaller {
  callerId: string;
  callerKind: CallerKind;
}

export type ServerMessageListener = (envelope: RpcEnvelope) => void;
export type HostServiceHandler = (
  request: Pick<RpcRequestContext, "args" | "signal">
) => unknown | Promise<unknown>;

export function exposeServerOriginatedHostMethod(
  rpc: RpcClient,
  method: string,
  handler: HostServiceHandler
): void {
  rpc.expose(method, (request) => {
    if (!isAuthenticatedServerCaller(request.caller)) {
      throw new Error(`Host method "${method}" accepts calls only from the authenticated server`);
    }
    return handler({ args: request.args, signal: request.signal });
  });
}

/**
 * A dedicated logical session for a single desktop panel principal. The host
 * (ipcDispatcher) relays the panel webview's RAW envelopes over it, so it carries
 * the panel's FULL RPC surface — requests, routed DO calls, event subscriptions,
 * and streams — as that panel's own `callerKind:"panel"` connection (the desktop
 * analogue of mobile's `openPanelSession`). The server attributes everything to
 * the panel by the authenticated session, so the host needs no per-message-type
 * handling.
 */
export interface PanelSession {
  send(envelope: RpcEnvelope): Promise<void> | void;
  onMessage(listener: ServerMessageListener): () => void;
  /** Status of the underlying session (observability; NOT the recycle signal). */
  status?(): ConnectionStatus;
  /**
   * True once the session is TERMINALLY closed (lease revoke / teardown). This
   * is the ONLY liveness signal the ipcDispatcher relay recycles on (§3.3):
   * transport-down is transient and the transport auto-reopens sessions.
   */
  isClosed?(): boolean;
  /**
   * First-class duplex stream with a streaming request body. Iroh uses a
   * native QUIC stream; loopback WebSocket uses ordered, ack-gated body frames.
   */
  streamReadable?(
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null
  ): Promise<DecodedFramedStream>;
  close(): void;
}

export interface ServerClient {
  /**
   * Publish one Electron-owned host method to the authenticated server.
   * Direct routed calls from workspace principals are rejected at this client
   * boundary; only the canonical `main` server may enter the host dispatcher.
   */
  exposeHostMethod(method: string, handler: HostServiceHandler): void;
  /** Call a backend service via the server */
  call(
    service: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown>;
  /** Call a concrete runtime target (for example a resolved Durable Object). */
  callTarget(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown>;
  /** Call a backend service via the server as an Electron-hosted runtime principal. */
  callAs(
    caller: ScopedServerCaller,
    service: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown>;
  /** Relay one already-formed envelope over an app principal's scoped session. */
  sendAs(caller: ScopedServerCaller, envelope: RpcEnvelope): Promise<void>;
  /** Forward server-originated messages for an Electron-hosted runtime principal. */
  addMessageListener(caller: ScopedServerCaller, listener: ServerMessageListener): () => void;
  /**
   * Open a dedicated session for a desktop panel principal, redeeming its
   * existing runtime lease (`connectionId`) with a one-shot grant for
   * `runtimeEntityId`. The host relays the panel's raw envelopes over it; see
   * {@link PanelSession}. The host-opened session is the panel's sole transport,
   * so it redeems the lease with no conflict.
   */
  openPanelSession(runtimeEntityId: string, connectionId: string): Promise<PanelSession>;
  /**
   * Stream a backend service method's `Response` on the session's native
   * transport. Remote Iroh sessions use one QUIC stream per request; loopback
   * WebSocket sessions use ordered, acknowledged upload frames.
   */
  stream(
    service: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions
  ): Promise<Response>;
  /** Stream a backend service as an Electron-hosted runtime principal. */
  streamAs(
    caller: ScopedServerCaller,
    service: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions
  ): Promise<Response>;
  /** Listen only to an event addressed to this authenticated shell session. */
  onDirectEvent<E extends EventName>(
    event: E,
    listener: (payload: EventPayloads[E]) => void
  ): () => void;
  /** Check if connected */
  isConnected(): boolean;
  /** Current connection status */
  getConnectionStatus(): ConnectionStatus;
  /**
   * Current Iroh path diagnostics. The loopback client returns `null` because
   * no remote network path exists.
   */
  transportDiagnostics(): RemoteTransportDiagnostics | null;
  /**
   * Liveness nudge (transport-level): probe a possibly-dead pipe so a stale
   * "connected" is torn down promptly instead of lingering (~45s) after a
   * sleep/wake or network change. Present only on transports that can probe
   * (the Iroh pipe); the loopback WS client omits it (loopback never sleeps
   * out from under us the same way). Never forces a teardown on its own — a
   * healthy pipe answers the probe and stays up.
   */
  nudge?(): void;
  /** Close connection, reject all pending calls, stop reconnection */
  close(): Promise<void>;
}

export interface ServerClientOptions {
  /** Host metadata bound into both WebSocket admission and session auth. */
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
  oauthCallbackMode?: OAuthCallbackMode;
  /**
   * Dynamic WebSocket URL provider, consulted before each connect/reconnect.
   * Used by local mode to follow the child server's port across restarts; when
   * omitted the client dials the fixed loopback gateway. There is no remote
   * `wsUrl`/TLS option — remote topology is Iroh QUIC, never a direct wss.
   */
  getWsUrl?: () => string;
  /** Called when the connection is permanently lost after explicit non-reconnect close. */
  onDisconnect?: () => void;
  /** Called when connection status changes (for UI indicators) */
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  /** Called after auth when the transport needs subscriptions or state replayed. */
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  /** Enable automatic reconnection on disconnect (default: true if getWsUrl is set). */
  reconnect?: boolean;
  /** Refresh the caller token after an auth failure during reconnect. */
  refreshAuthToken?: () => Promise<string>;
  /**
   * Fired once when the main session paired a fresh device (a one-time pairing
   * code was redeemed): the durable device credential to persist so reconnects
   * can authenticate with `refresh:<deviceId>:<refreshToken>` instead of
   * re-pairing.
   */
  onPaired?: (credential: DeviceCredential, context?: PairingContext) => void;
}

export async function createServerClient(
  serverRpcPort: number,
  authToken: string,
  options?: ServerClientOptions
): Promise<ServerClient> {
  let activeAuthToken = authToken;
  const getWsUrl = options?.getWsUrl ?? (() => serverRpcWsUrl(`http://127.0.0.1:${serverRpcPort}`));
  const shouldReconnect = options?.reconnect ?? !!options?.getWsUrl;
  const refreshAuthToken = options?.refreshAuthToken;

  const transport = wsClientTransport({
    selfId: "admin",
    getWsUrl,
    reconnect: shouldReconnect,
    logPrefix: "ServerClient",
    getAuthMessageFields: () => ({
      ...(options?.clientLabel ? { clientLabel: options.clientLabel } : {}),
      ...(options?.clientPlatform ? { clientPlatform: options.clientPlatform } : {}),
      ...(options?.oauthCallbackMode ? { oauthCallbackMode: options.oauthCallbackMode } : {}),
    }),
    onRecovery: options?.onRecovery,
    onAuthResult: (msg) => {
      if (msg.deviceCredential) options?.onPaired?.(msg.deviceCredential, msg.pairingContext);
    },
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => activeAuthToken,
      refreshAuthToken: refreshAuthToken
        ? async () => {
            activeAuthToken = await refreshAuthToken();
            return activeAuthToken;
          }
        : undefined,
      createSocket: (url, protocols) => new NodeWsLike(new WebSocket(url, protocols)),
    },
  });
  transport.onStatusChange?.((status) => {
    options?.onConnectionStatusChanged?.(status);
    if (status === "disconnected") options?.onDisconnect?.();
  });

  await transport.connectAndWait();
  const rpc = createRpcClient({
    selfId: "admin",
    callerKind: "server",
    transport,
  });
  const authClient = createTypedServiceClient("auth", authMethods, (service, method, args) =>
    rpc.call("main", `${service}.${method}`, args)
  );

  type ScopedClient = {
    transport: ReturnType<typeof wsClientTransport>;
    rpc: RpcClient;
    close(): Promise<void>;
  };
  const scopedClients = new Map<string, Promise<ScopedClient>>();
  const scopedListeners = new Map<string, Set<ServerMessageListener>>();
  const scopedKey = (caller: ScopedServerCaller): string =>
    `${caller.callerKind}\x00${caller.callerId}`;

  const createScopedClient = async (
    caller: ScopedServerCaller,
    onUnrecoverable: () => void
  ): Promise<ScopedClient> => {
    // Only app principals get a scoped runtime connection. A panel authenticates
    // its own direct connection, which holds the panel lease; a second
    // host-opened connection for the same panel is rejected by the lease gate.
    // Panel operations are therefore translated by the trusted host instead (see
    // panelView / panelOrchestrator). Native `shell` callers use call().
    if (caller.callerKind !== "app") {
      throw new Error(`Scoped server RPC is not available for ${caller.callerKind} callers`);
    }
    let activeGrantToken = (await authClient.grantConnection(caller.callerId)).token;
    const scopedTransport = wsClientTransport({
      selfId: caller.callerId,
      getWsUrl,
      // The renderer owns pending direct-target RPC state. Keep its exact
      // authenticated app session alive across a transient socket loss so the
      // server's routed response replay can settle those calls. Connection
      // grants are one-shot, therefore every reopen obtains a fresh grant.
      reconnect: true,
      logPrefix: `ServerClient:${caller.callerId}`,
      adapter: {
        now: () => Date.now(),
        getAuthToken: async () => activeGrantToken,
        refreshAuthToken: async () => {
          try {
            activeGrantToken = (await authClient.grantConnection(caller.callerId)).token;
            return activeGrantToken;
          } catch (error) {
            // The transport stops reconnecting once a refresh fails, so this
            // session is finished for good. Drop it from the cache now: a
            // principal that cannot mint a grant this instant may well be
            // mintable after the next app registration, and without this the
            // wedged socket would be reused for the rest of the process.
            onUnrecoverable();
            throw error;
          }
        },
        createSocket: (url, protocols) => new NodeWsLike(new WebSocket(url, protocols)),
      },
    });
    const scopedRpc = createRpcClient({
      selfId: caller.callerId,
      callerKind: caller.callerKind,
      transport: scopedTransport,
    });
    scopedTransport.onMessage((envelope) => {
      for (const listener of scopedListeners.get(scopedKey(caller)) ?? []) {
        listener(envelope);
      }
    });
    await scopedTransport.connectAndWait();
    return {
      transport: scopedTransport,
      rpc: scopedRpc,
      close: () => scopedTransport.close(),
    };
  };

  const getScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    const key = scopedKey(caller);
    const existing = scopedClients.get(key);
    if (existing) return existing;
    let entry: Promise<ScopedClient> | null = null;
    // Only ever evict this exact session; a later call may already have
    // installed a healthy replacement under the same key.
    const evict = (): void => {
      if (entry && scopedClients.get(key) === entry) scopedClients.delete(key);
    };
    const next = createScopedClient(caller, evict).catch((err) => {
      evict();
      throw err;
    });
    entry = next;
    scopedClients.set(key, next);
    return next;
  };

  return {
    exposeHostMethod(method, handler): void {
      exposeServerOriginatedHostMethod(rpc, method, handler);
    },
    call(
      service: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ): Promise<unknown> {
      return rpc.call("main", `${service}.${method}`, args, options);
    },
    callTarget(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ): Promise<unknown> {
      return rpc.call(targetId, method, args, options);
    },
    stream(
      service: string,
      method: string,
      args: unknown[],
      options?: RpcStreamOptions
    ): Promise<Response> {
      return rpc.stream("main", `${service}.${method}`, args, options);
    },
    onDirectEvent(event, listener) {
      return rpc.on(event, ({ payload }) => listener(payload as never));
    },
    async callAs(
      caller: ScopedServerCaller,
      service: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ): Promise<unknown> {
      // Scoped server RPC is for Electron-hosted runtime principals that can be
      // granted a caller-bound connection. Native-host `shell` callers
      // (electron-main / launch gate) use the admin connection via `call()`;
      // there is no shell→runtime proxy.
      const client = await getScopedClient(caller);
      return client.rpc.call("main", `${service}.${method}`, args, options);
    },
    async sendAs(caller: ScopedServerCaller, envelope: RpcEnvelope): Promise<void> {
      const client = await getScopedClient(caller);
      await client.transport.send(envelope);
    },
    async streamAs(
      caller: ScopedServerCaller,
      service: string,
      method: string,
      args: unknown[],
      options?: RpcStreamOptions
    ): Promise<Response> {
      const client = await getScopedClient(caller);
      return client.rpc.stream("main", `${service}.${method}`, args, options);
    },
    addMessageListener(caller: ScopedServerCaller, listener: ServerMessageListener): () => void {
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
    async openPanelSession(runtimeEntityId: string, connectionId: string): Promise<PanelSession> {
      // A dedicated panel-principal socket on the panel's lease connectionId, so
      // the server's lease gate (authorizePanelConnection) accepts it. The grant
      // encodes the panel principal (the server derives callerKind:"panel"), and
      // getAuthToken re-grants on every (re)connect because grants are one-shot.
      // reconnect:false — the ipcDispatcher relay re-opens a dead session lazily.
      const panelTransport = wsClientTransport({
        selfId: runtimeEntityId,
        getWsUrl,
        connectionId,
        reconnect: false,
        logPrefix: `PanelSession:${runtimeEntityId}`,
        adapter: {
          now: () => Date.now(),
          getAuthToken: async () => (await authClient.grantConnection(runtimeEntityId)).token,
          createSocket: (url, protocols) => new NodeWsLike(new WebSocket(url, protocols)),
        },
      });
      await panelTransport.connectAndWait();
      return {
        send: (envelope: RpcEnvelope) => panelTransport.send(envelope),
        onMessage: (listener: ServerMessageListener) => panelTransport.onMessage(listener),
        status: () => panelTransport.status?.() ?? "disconnected",
        // reconnect:false — a dropped socket never comes back, so "disconnected"
        // IS terminal here. This keeps the relay's isClosed()-only recycle
        // (§3.3) correct on the loopback WS path too.
        isClosed: () => (panelTransport.status?.() ?? "disconnected") === "disconnected",
        streamReadable: (envelope, signal, body) => {
          if (!panelTransport.streamReadable) {
            return Promise.reject(new Error("Loopback WebSocket stream transport is unavailable"));
          }
          return panelTransport.streamReadable(envelope, signal, body);
        },
        close: () => {
          void panelTransport.close();
        },
      };
    },
    isConnected(): boolean {
      return transport.status?.() === "connected";
    },
    getConnectionStatus(): ConnectionStatus {
      return transport.status?.() ?? "disconnected";
    },
    transportDiagnostics(): null {
      return null;
    },
    async close(): Promise<void> {
      await Promise.allSettled(
        [...scopedClients.values()].map(async (client) => (await client).close())
      );
      scopedClients.clear();
      return transport.close();
    },
  };
}
