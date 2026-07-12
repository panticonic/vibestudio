/**
 * WebRtcServerClient — the desktop shell's {@link ServerClient} over the WebRTC
 * pipe. It is the peer-to-peer counterpart of `createServerClient` (which dials a
 * co-located loopback `/rpc` over WS): same `ServerClient` surface, but every
 * principal is a logical session multiplexed over one DTLS pipe rather than its
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
 * pairing layer's concern, not the transport's. `node-datachannel` is loaded
 * lazily (only when a real pipe is built), so non-remote shells never touch it.
 */

import { randomUUID } from "node:crypto";
import {
  createRpcClient,
  type RpcClient,
  type RpcCallOptions,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import {
  type ReconnectProgress,
  type WebRtcSession,
  type WebRtcTransport,
} from "@vibestudio/rpc/transports/webrtcClient";
import { createPairedConnection } from "@vibestudio/rpc/transports/pairedConnection";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
} from "@vibestudio/rpc/transports/webrtcPeer";
import { authMethods } from "@vibestudio/shared/serviceSchemas/auth";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { ConnectPairing } from "@vibestudio/shared/connect";
import type {
  ConnectionStatus,
  PanelSession,
  ScopedServerCaller,
  ServerClient,
  ServerMessageListener,
} from "./serverClient.js";

export interface WebRtcServerClientArgs {
  /** The parsed pairing link (room/fp/sig/ice). */
  pairing: ConnectPairing;
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
  onPaired?: (credential: { deviceId: string; refreshToken: string }) => void;
  onServerEvent?: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onReconnectProgress?: (progress: ReconnectProgress) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  onMainSessionTerminalClose?: (error: Error) => void;
  /**
   * Test seam: a pre-built transport (the real path lazy-loads node-datachannel
   * + signaling). Production callers omit this.
   */
  transport?: WebRtcTransport;
}

/**
 * The desktop shell's `ServerClient` over the WebRTC pipe, plus additive
 * transport observability the loopback WS client has no equivalent for.
 */
export interface WebRtcServerClient extends ServerClient {
  /**
   * Last selected ICE candidate-pair type of the pipe — `'relay'` means TURN
   * engaged (the §9.8 relay alarm), `null` while the pipe is down. Additive
   * observability so the shell can surface the path (e.g. a "relayed" badge)
   * without re-plumbing the transport.
   */
  candidateType(): RtcCandidateType | null;
}

export async function createWebRtcServerClient(
  args: WebRtcServerClientArgs
): Promise<WebRtcServerClient> {
  // The ONE shared bootstrap (plan §3.1): connect-with-timeout + main-session
  // auth + close-on-ANY-failure (incl. mainSession.ready() rejection) + onPaired
  // await-retry all live in createPairedConnection now — this file no longer
  // hand-rolls (and can no longer re-diverge on) that sequence.
  const nativePipe = args.transport ? null : await buildNativePipe();
  let mainSessionTerminalError: Error | null = null;
  const paired = await createPairedConnection({
    pairing: {
      room: args.pairing.room,
      fingerprint: args.pairing.fp,
      iceTransportPolicy: args.pairing.ice,
    },
    sig: args.pairing.sig,
    ...(nativePipe
      ? { provider: nativePipe.provider, webSocketImpl: nativePipe.webSocketImpl, fetchImpl: fetch }
      : {}),
    ...(args.transport ? { transport: args.transport } : {}),
    getShellToken: args.getShellToken,
    connectionId: args.connectionId ?? randomUUID(),
    clientPlatform: "desktop",
    platform: "desktop",
    ...(args.onPaired ? { onPaired: args.onPaired } : {}),
    // App-level recovery passthrough (subscriptions/state replay). Registered on
    // the session before its first open, so it catches the first-open recovery.
    onRecovery: (kind) => {
      void args.onRecovery?.(kind);
    },
    onTerminalClose: (error) => {
      mainSessionTerminalError = error;
      args.onMainSessionTerminalClose?.(error);
    },
  });
  const transport = paired.transport;
  const mainSession = paired.mainSession;
  const effectiveConnectionStatus = (): ConnectionStatus =>
    mainSessionTerminalError || mainSession.isClosed() ? "disconnected" : transport.status();
  transport.onStatusChange(() => args.onConnectionStatusChanged?.(effectiveConnectionStatus()));
  // Older/custom transports used by embedders and tests may not yet expose
  // reconnect progress. Treat it as additive observability: real transports
  // forward it, while a legacy seam must not make an otherwise healthy
  // connection fail during setup.
  if (typeof transport.onReconnectProgress === "function") {
    transport.onReconnectProgress((progress) => args.onReconnectProgress?.(progress));
  }
  // Relay alarm (§9.8): remember the selected path for the shell and warn loud
  // when TURN engages — a relayed pipe works but P2P failed (or was forced).
  let lastCandidateType: RtcCandidateType | null = transport.candidateType();
  transport.onCandidateType((type) => {
    lastCandidateType = type;
    if (type === "relay") {
      console.warn("[webrtc-client] TURN relay engaged — P2P failed or forced");
    }
    // Re-drive the connection-status callback so the shell re-reads candidateType()
    // and re-emits `server-connection-changed` with the fresh path. A mid-connection
    // host→relay switch (or a late nomination) changes no status, so without this
    // the subtle "Relayed" hint would only surface on the next status transition.
    // Reuses the existing status channel — no new IPC surface — and is a no-op for
    // the shell's replay guard (the status value is unchanged).
    args.onConnectionStatusChanged?.(effectiveConnectionStatus());
  });
  if (args.onServerEvent) {
    mainSession.onMessage((envelope) => {
      const message = envelope.message;
      if (message && message.type === "event") args.onServerEvent?.(message.event, message.payload);
    });
  }
  const rpc = createRpcClient({
    selfId: args.callerId,
    callerKind: "shell",
    transport: mainSession,
    // §3.4 pending-call policy: on a cold-recover, the core rejects routed
    // pendings (server session state gone). Fed from the paired connection's
    // recovery fan-out (the same signal that drives the app-level onRecovery).
    onRecovery: (handler) => paired.onRecovery(handler),
  });
  const authClient = createTypedServiceClient("auth", authMethods, (service, method, callArgs) =>
    rpc.call("main", `${service}.${method}`, callArgs)
  );

  type ScopedClient = { session: WebRtcSession; rpc: RpcClient; close(): void };
  const scopedClients = new Map<string, Promise<ScopedClient>>();
  const materializedScopedClients = new Set<ScopedClient>();
  const scopedListeners = new Map<string, Set<ServerMessageListener>>();
  const scopedKey = (caller: ScopedServerCaller): string =>
    `${caller.callerKind}\x00${caller.callerId}`;
  let closing = false;

  const createScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    if (closing) throw new Error("WebRTC server client is closing");
    // Only app principals get a scoped runtime connection (mirrors the WS path:
    // a panel holds its own lease; native `shell` callers use call()).
    if (caller.callerKind !== "app") {
      throw new Error(`Scoped server RPC is not available for ${caller.callerKind} callers`);
    }
    const session = transport.openSession({
      connectionId: randomUUID(),
      clientPlatform: "desktop",
      // Re-grant on EVERY (re)open: connection grants are one-shot, so pinning the
      // first grant's token would fail the redeem on reconnect — the auto-reopened
      // session would reject unhandled, once per app principal. Mirrors the main
      // shell session, whose getShellToken is likewise re-invoked per open.
      getToken: async () => (await authClient.grantConnection(caller.callerId)).token,
    });
    await session.ready?.();
    if (closing) {
      session.close();
      throw new Error("WebRTC server client is closing");
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
      close: () => {
        materializedScopedClients.delete(client);
        session.close();
      },
    };
    materializedScopedClients.add(client);
    return client;
  };

  const getScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    if (closing) throw new Error("WebRTC server client is closing");
    const key = scopedKey(caller);
    const existing = scopedClients.get(key);
    if (existing) {
      const client = await existing;
      // The pipe outlives individual sessions: a scoped session can be terminally
      // closed (e.g. a lease revoke) while transport.status() still reads
      // "connected". Reusing it would throw "Session is closed" on the next call —
      // so re-grant a fresh session when EITHER the pipe is down or the session died.
      if (transport.status() === "connected" && !client.session.isClosed()) return client;
      scopedClients.delete(key);
      client.close();
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
    const session = transport.openSession({
      connectionId,
      clientPlatform: "desktop",
      getToken: async () => (await authClient.grantConnection(runtimeEntityId)).token,
    });
    await session.ready?.();
    return {
      send: (envelope) => session.send(envelope),
      onMessage: (listener) => session.onMessage(listener),
      status: () => session.status?.() ?? transport.status(),
      isClosed: () => session.isClosed(),
      // First-class duplex stream with the §1.6 upload body: the panel bridge
      // relay (ipcDispatcher) feeds a panel's reassembled request body here and
      // it rides the bulk channel as DATA frames keyed by the stream-open's
      // bodyStreamId.
      streamReadable: (envelope, signal, body) => {
        if (typeof session.streamReadable !== "function") {
          throw new Error("WebRTC panel session does not implement streamReadable");
        }
        return session.streamReadable(envelope, signal, body);
      },
      close: () => session.close(),
    };
  };

  return {
    call(service, method, callArgs, options?: RpcCallOptions): Promise<unknown> {
      return rpc.call("main", `${service}.${method}`, callArgs, options);
    },
    stream(service, method, callArgs, options?: RpcStreamOptions): Promise<Response> {
      // Streamed over the main shell session's bulk channel (chunked) — for
      // large bodies like gateway.fetch panel assets. `options.body` streams a
      // REQUEST body out on the same channel (plan §1.6).
      return rpc.stream("main", `${service}.${method}`, callArgs, options);
    },
    async callAs(caller, service, method, callArgs, options?: RpcCallOptions): Promise<unknown> {
      const client = await getScopedClient(caller);
      return client.rpc.call("main", `${service}.${method}`, callArgs, options);
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
    candidateType(): RtcCandidateType | null {
      return lastCandidateType;
    },
    nudge(): void {
      // Liveness probe passthrough (§3.1): on sleep/wake or a network change the
      // pipe can be dead while status() still reads "connected". A nudge pings
      // out-of-band; a missing pong within the deadline tears the pipe down so
      // reconnect kicks in — a healthy pipe answers and is untouched.
      transport.nudge();
    },
    async close(): Promise<void> {
      closing = true;
      const scoped = [...materializedScopedClients];
      scopedClients.clear();
      // Closes the main session AND the transport (createPairedConnection owns both).
      await paired.close();
      for (const client of scoped) client.close();
      materializedScopedClients.clear();
    },
  };
}

/** Lazy-load the native peer + Node `ws` for the real pipe (createPairedConnection
 * builds the transport + signaling from these). Non-remote shells never touch
 * node-datachannel — it loads only when a real pipe is actually built. */
async function buildNativePipe(): Promise<{
  provider: PeerConnectionProvider;
  webSocketImpl: unknown;
}> {
  const { createNodeDatachannelProvider } = await import("./webrtc/nodeDatachannelPeer.js");
  const { default: WS } = (await import("ws")) as unknown as {
    default: new (url: string) => unknown;
  };
  return { provider: createNodeDatachannelProvider({ peerName: "shell" }), webSocketImpl: WS };
}
