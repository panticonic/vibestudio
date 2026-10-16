import type {
  BridgeStreamMessage,
  DecodedFramedStream,
  EnvelopeRpcTransport,
  RpcConnectionStatus,
  RpcEnvelope,
} from "@vibestudio/rpc";
import type { BrokerChannel, EventHub } from "./channel";
import { openRemoteStream } from "./remoteStream";
import type { SessionCloseReason, SessionOpened } from "./protocol";

export type RecoveryKind = "resubscribe" | "cold-recover";

export interface ReconnectProgress {
  attempt: number;
  phase: "scheduled" | "failed";
  reason: string;
  nextRetryInMs?: number;
}

export interface SessionClosed {
  reason: SessionCloseReason;
  message: string;
}

/**
 * One logical session of this client, held by the host. It is an
 * `EnvelopeRpcTransport`, so a client builds an ordinary `RpcClient` on it; the
 * envelopes and streamed bodies cross the broker, and the server sees the
 * session its host opened for this client's principal.
 */
export interface RemoteSession extends EnvelopeRpcTransport {
  readonly sessionId: string;
  callerId(): string | null;
  isClosed(): boolean;
  status(): RpcConnectionStatus;
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void;
  /** Resolves when the session is open and authenticated; rejects with the open failure. */
  ready(): Promise<void>;
  /** Resolves with the session as the server authenticated it; rejects with the open failure. */
  authenticated(): Promise<SessionOpened>;
  /** The session ended for good: the server or host closed it, or this side did. */
  onClosed(listener: (closed: SessionClosed) => void): () => void;
  /** Subscriptions to reopen after a reconnect (the rpc client registers these). */
  onRecovery(handler: (kind: RecoveryKind) => void): () => void;
  onReconnectProgress(handler: (progress: ReconnectProgress) => void): () => void;
  close(): Promise<void>;
}

export interface RemoteSessionOptions {
  channel: BrokerChannel;
  hub: EventHub;
  sessionId: string;
  /** Issues the host call that opens the session (called once, after the listeners exist). */
  open: () => Promise<SessionOpened>;
  /** Token for each (re)authentication of an auxiliary session. */
  getToken?: (signal?: AbortSignal) => string | Promise<string>;
}

export function createRemoteSession(options: RemoteSessionOptions): RemoteSession {
  const { channel, hub, sessionId } = options;
  const envelopeHandlers = new Set<(envelope: RpcEnvelope) => void>();
  const statusHandlers = new Set<(status: RpcConnectionStatus) => void>();
  const closedHandlers = new Set<(closed: SessionClosed) => void>();
  const recoveryHandlers = new Set<(kind: RecoveryKind) => void>();
  const progressHandlers = new Set<(progress: ReconnectProgress) => void>();
  const streamHandlers = new Set<(msg: BridgeStreamMessage) => void>();

  let description: SessionOpened | null = null;
  let status: RpcConnectionStatus = "connecting";
  let closed: SessionClosed | null = null;
  let authenticatedPromise: Promise<SessionOpened> | null = null;

  const setStatus = (next: RpcConnectionStatus): void => {
    if (status === next) return;
    status = next;
    for (const handler of [...statusHandlers]) handler(next);
  };
  const finish = (result: SessionClosed): void => {
    if (closed) return;
    closed = result;
    setStatus("disconnected");
    for (const handler of [...closedHandlers]) handler(result);
  };

  const releases = [
    hub.ofSession("session-envelope", sessionId, (event) => {
      for (const handler of [...envelopeHandlers]) handler(event.envelope);
    }),
    hub.ofSession("session-stream", sessionId, (event) => {
      for (const handler of [...streamHandlers]) handler(event.msg);
    }),
    hub.ofSession("session-status", sessionId, (event) => setStatus(event.status)),
    hub.ofSession("session-recovery", sessionId, (event) => {
      for (const handler of [...recoveryHandlers]) handler(event.kind);
    }),
    hub.ofSession("session-reconnect-progress", sessionId, (event) => {
      for (const handler of [...progressHandlers]) handler(event.progress);
    }),
    hub.ofSession("session-closed", sessionId, (event) => {
      finish({ reason: event.reason, message: event.message });
    }),
    hub.ofSession("session-token-request", sessionId, () => {
      void (async () => {
        try {
          if (!options.getToken) throw new Error("This session authenticates without a token");
          const token = await options.getToken();
          await channel.request("session.provideToken", sessionId, { token });
        } catch (error) {
          await channel
            .request("session.provideToken", sessionId, {
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      })();
    }),
  ];
  const stopListening = (): void => {
    for (const release of releases) release();
  };

  const openedPromise = options.open().then((result) => {
    description = result;
    setStatus(result.status);
    return result;
  });
  // A failed open reaches whoever awaits `ready()` or `authenticated()`; it must not
  // also surface as an unhandled rejection before anyone has asked.
  openedPromise.catch((error: unknown) => {
    finish({ reason: "closed", message: error instanceof Error ? error.message : String(error) });
    stopListening();
  });

  const authenticated = (): Promise<SessionOpened> => {
    authenticatedPromise ??= openedPromise
      .then(() => channel.request("session.ready", sessionId))
      .then((described) => {
        description = described;
        setStatus(described.status);
        return described;
      });
    return authenticatedPromise;
  };
  const ready = (): Promise<void> => authenticated().then(() => undefined);
  const requireOpen = (): void => {
    if (closed) throw new Error(`Session is closed: ${closed.message}`);
  };

  return {
    sessionId,
    callerId: () => description?.callerId ?? null,
    isClosed: () => closed !== null,
    status: () => status,
    onStatusChange(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    ready,
    authenticated,
    onClosed(listener) {
      closedHandlers.add(listener);
      return () => closedHandlers.delete(listener);
    },
    onRecovery(handler) {
      recoveryHandlers.add(handler);
      return () => recoveryHandlers.delete(handler);
    },
    onReconnectProgress(handler) {
      progressHandlers.add(handler);
      return () => progressHandlers.delete(handler);
    },
    onMessage(handler) {
      envelopeHandlers.add(handler);
      return () => envelopeHandlers.delete(handler);
    },
    async send(envelope, signal) {
      signal?.throwIfAborted();
      await ready();
      requireOpen();
      await channel.request("session.postEnvelope", sessionId, envelope);
    },
    async streamReadable(envelope, signal, body): Promise<DecodedFramedStream> {
      await ready();
      requireOpen();
      return openRemoteStream(
        {
          streamOpen: (msg) => channel.request("session.streamOpen", sessionId, msg),
          streamBodyChunk: (msg) => channel.request("session.streamBodyChunk", sessionId, msg),
          streamAbort: (opId) => {
            void channel.request("session.streamAbort", sessionId, opId).catch(() => undefined);
          },
          streamAck: (opId, seq) => {
            void channel.request("session.streamAck", sessionId, opId, seq).catch(() => undefined);
          },
          onStreamMessage: (handler) => {
            streamHandlers.add(handler);
            return () => streamHandlers.delete(handler);
          },
        },
        envelope,
        signal,
        body ?? null
      );
    },
    async close() {
      if (closed) return;
      try {
        await openedPromise;
        await channel.request("session.close", sessionId);
      } finally {
        finish({ reason: "closed", message: "closed by the client" });
        stopListening();
      }
    },
  };
}
