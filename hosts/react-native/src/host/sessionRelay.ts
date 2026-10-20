import {
  createBridgeStreamRelay,
  stampEnvelopeCaller,
  type BridgeStreamRelay,
  type RpcConnectionStatus,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import type { IrohClientSession } from "@vibestudio/rpc/transports/irohClient";
import type {
  ClientHostEvent,
  SessionCloseReason,
  SessionKind,
  SessionOpened,
} from "@vibestudio/rn-client-api/protocol";
import type { BridgeBodyChunk, BridgeStreamOpen } from "@vibestudio/rpc";
import { BrokerError } from "./ports";

/** The server's reason when the System owner withdraws a client's device-level trust (§4.4.1). */
export const TRUST_REVOKED_REASON = "trust-revoked";

export type SessionCallerKind = "client" | "shell" | "panel";

export interface SessionHandlers {
  onRecovery(kind: "resubscribe" | "cold-recover"): void | Promise<void>;
  /** The server ended the session for good (credential revoked, principal retired). */
  onTerminalClose(error: Error): void;
}

/** A session the host opened for a client: the transport plus what a relay needs to know about it. */
export interface OpenedSession {
  session: IrohClientSession;
  callerKind: SessionCallerKind;
  deviceId: string | null;
  serverId: string | null;
  waitUntilConnected(timeoutMs: number): Promise<void>;
  onReconnectProgress(
    handler: (progress: {
      attempt: number;
      phase: "scheduled" | "failed";
      reason: string;
      nextRetryInMs?: number;
    }) => void
  ): () => void;
  /** Another logical session on the same connection (a panel's own). */
  openAuxiliary(
    label: string,
    getToken: (signal?: AbortSignal) => Promise<string>,
    handlers: SessionHandlers,
    connectionId?: string
  ): OpenedSession;
  /** Retire the session and release whatever the host holds for it (a workspace connection reference). */
  release(): Promise<void>;
}

/** What the host's connections can open for a client. */
export interface SessionOpeners {
  /** The client's own principal session, authenticating with `getToken` (the client's reusable credential). */
  principal(
    label: string,
    getToken: (signal?: AbortSignal) => Promise<string>,
    handlers: SessionHandlers
  ): OpenedSession;
  /** A device shell session on the hub control reach. */
  accountControl(label: string, handlers: SessionHandlers): OpenedSession;
  /** A device shell session on a routed workspace. */
  workspace(workspaceId: string, label: string, handlers: SessionHandlers): Promise<OpenedSession>;
}

interface Entry {
  kind: SessionKind;
  opened: OpenedSession;
  relay: BridgeStreamRelay;
  stopListening: Array<() => void>;
  tokenWaiter: null | { resolve(token: string): void; reject(error: Error): void };
  closed: boolean;
}

const SESSION_ID = /^s-[A-Za-z0-9-]{8,80}$/u;

export interface ClientSessionRelayOptions {
  /** This client's instance tag (its principal id); the label that keeps its sessions apart. */
  tag: string;
  openers: SessionOpeners;
  /** Deliver one event to the client instance. */
  emit(event: ClientHostEvent): void;
  /**
   * A session of this client was closed by the server with the trust-revoked
   * reason. The host runtime tears the whole instance down; the relay has
   * already told the client.
   */
  onTrustRevoked(): void;
}

/**
 * The host's side of one client's sessions. Each is a real logical session on
 * the host-owned connection; the client builds an RPC client on a remote view
 * of it (`@vibestudio/rn-client-api`). Envelopes pass through unchanged except
 * for their identity, which is stamped with what the server authenticated:
 * the client never asserts who it is. Streams use the panel bridge's
 * ack-gated chunk protocol, so a slow reader bounds memory on both sides.
 */
export class ClientSessionRelay {
  private readonly entries = new Map<string, Entry>();
  /** Ids claimed by an open that has not finished (a workspace connection is still being made). */
  private readonly reserved = new Set<string>();
  private disposed = false;

  constructor(private readonly options: ClientSessionRelayOptions) {}

  openPrincipal(
    sessionId: string,
    getToken: (signal?: AbortSignal) => Promise<string>
  ): SessionOpened {
    return this.adopt(sessionId, "principal", (handlers) =>
      this.options.openers.principal(
        `principal:${this.options.tag}:${sessionId}`,
        getToken,
        handlers
      )
    );
  }

  openAccountControl(sessionId: string): SessionOpened {
    return this.adopt(sessionId, "shell", (handlers) =>
      this.options.openers.accountControl(
        `account-control:${this.options.tag}:${sessionId}`,
        handlers
      )
    );
  }

  async openWorkspace(sessionId: string, workspaceId: string): Promise<SessionOpened> {
    this.claim(sessionId);
    try {
      const opened = await this.options.openers.workspace(
        workspaceId,
        `workspace:${this.options.tag}:${sessionId}`,
        this.handlersFor(sessionId)
      );
      return this.register(sessionId, "shell", opened);
    } catch (error) {
      this.reserved.delete(sessionId);
      throw error;
    }
  }

  openAuxiliary(
    sessionId: string,
    spec: { parentSessionId: string; label: string; connectionId?: string }
  ): SessionOpened {
    const parent = this.require(spec.parentSessionId);
    return this.adopt(sessionId, "auxiliary", (handlers) =>
      parent.opened.openAuxiliary(
        `${spec.label}:${this.options.tag}`,
        (signal) => this.requestToken(sessionId, signal),
        handlers,
        spec.connectionId
      )
    );
  }

  provideToken(sessionId: string, outcome: { token: string } | { error: string }): void {
    const entry = this.require(sessionId);
    const waiter = entry.tokenWaiter;
    if (!waiter)
      throw new BrokerError("NO_TOKEN_REQUEST", "No token was requested for this session.");
    entry.tokenWaiter = null;
    if ("token" in outcome) waiter.resolve(outcome.token);
    else waiter.reject(new Error(outcome.error));
  }

  /** Wait for authentication, then describe the session as the server knows it. */
  async ready(sessionId: string): Promise<SessionOpened> {
    const entry = this.require(sessionId);
    await entry.opened.session.ready?.();
    return this.describe(sessionId, entry);
  }

  waitUntilConnected(sessionId: string, timeoutMs: number): Promise<void> {
    return this.require(sessionId).opened.waitUntilConnected(timeoutMs);
  }

  async postEnvelope(sessionId: string, envelope: RpcEnvelope): Promise<void> {
    const entry = this.require(sessionId);
    await entry.opened.session.send(this.stamp(entry, envelope));
  }

  streamOpen(sessionId: string, msg: BridgeStreamOpen): void {
    this.require(sessionId).relay.open(msg);
  }

  streamBodyChunk(sessionId: string, msg: BridgeBodyChunk): Promise<void> {
    return this.require(sessionId).relay.pushBodyChunk(msg);
  }

  streamAbort(sessionId: string, opId: string): void {
    this.entries.get(sessionId)?.relay.abort(opId);
  }

  streamAck(sessionId: string, opId: string, seq: number): void {
    this.entries.get(sessionId)?.relay.ack(opId, seq);
  }

  /** Close one session at the client's request. */
  async close(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await this.retire(sessionId, entry);
  }

  /** The instance is going away: retire every session and keep every failure. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled(
      [...this.entries].map(([sessionId, entry]) => this.retire(sessionId, entry))
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Client sessions failed to close");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  // -------------------------------------------------------------------------

  private claim(sessionId: string): void {
    if (this.disposed) throw new BrokerError("CLIENT_STOPPED", "This client has stopped.");
    if (!SESSION_ID.test(sessionId)) {
      throw new BrokerError("BAD_SESSION_ID", "Session ids are `s-` followed by a UUID.");
    }
    if (this.entries.has(sessionId) || this.reserved.has(sessionId)) {
      throw new BrokerError("SESSION_ID_REUSED", "That session id is already in use.");
    }
    this.reserved.add(sessionId);
  }

  private adopt(
    sessionId: string,
    kind: SessionKind,
    open: (handlers: SessionHandlers) => OpenedSession
  ): SessionOpened {
    this.claim(sessionId);
    try {
      return this.register(sessionId, kind, open(this.handlersFor(sessionId)));
    } catch (error) {
      this.reserved.delete(sessionId);
      throw error;
    }
  }

  private register(sessionId: string, kind: SessionKind, opened: OpenedSession): SessionOpened {
    const relay = createBridgeStreamRelay({
      chunkFormat: "base64",
      openStream: (envelope, signal, body) => {
        if (!opened.session.streamReadable) {
          throw new BrokerError("STREAMS_UNAVAILABLE", "This session cannot stream.");
        }
        return opened.session.streamReadable(this.stamp(entry, envelope), signal, body);
      },
      sendToPanel: (msg) => this.options.emit({ type: "session-stream", sessionId, msg }),
    });
    const entry: Entry = {
      kind,
      opened,
      relay,
      stopListening: [],
      tokenWaiter: null,
      closed: false,
    };
    entry.stopListening.push(
      opened.session.onMessage((envelope) =>
        this.options.emit({ type: "session-envelope", sessionId, envelope })
      ),
      opened.session.onStatusChange((status) =>
        this.options.emit({ type: "session-status", sessionId, status })
      ),
      opened.onReconnectProgress((progress) =>
        this.options.emit({ type: "session-reconnect-progress", sessionId, progress })
      )
    );
    this.reserved.delete(sessionId);
    this.entries.set(sessionId, entry);
    return this.describe(sessionId, entry);
  }

  /** `callerId` is empty until the session has authenticated (`ready`). */
  private describe(sessionId: string, entry: Entry): SessionOpened {
    return {
      sessionId,
      kind: entry.kind,
      callerId: entry.opened.session.callerId() ?? "",
      callerKind: entry.opened.callerKind,
      deviceId: entry.opened.deviceId,
      serverId: entry.opened.serverId,
      status: entry.opened.session.status() as RpcConnectionStatus,
    };
  }

  private handlersFor(sessionId: string): SessionHandlers {
    return {
      onRecovery: (kind) => this.options.emit({ type: "session-recovery", sessionId, kind }),
      onTerminalClose: (error) => this.terminalClose(sessionId, error),
    };
  }

  private terminalClose(sessionId: string, error: Error): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closed) return;
    entry.closed = true;
    entry.relay.destroy(`session ${sessionId} was closed: ${error.message}`);
    entry.tokenWaiter?.reject(error);
    // The server's close reason is authoritative: trust withdrawn is not a lost connection.
    const reason: SessionCloseReason =
      error.message === TRUST_REVOKED_REASON ? "trust-revoked" : "server-closed";
    this.options.emit({ type: "session-closed", sessionId, reason, message: error.message });
    for (const stop of entry.stopListening) stop();
    this.entries.delete(sessionId);
    void entry.opened.release().catch((failure: unknown) => {
      console.warn("[host] releasing a closed client session failed", failure);
    });
    if (reason === "trust-revoked") this.options.onTrustRevoked();
  }

  private async retire(sessionId: string, entry: Entry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    entry.relay.destroy(`session ${sessionId} closed`);
    entry.tokenWaiter?.reject(new Error("session closed"));
    for (const stop of entry.stopListening) stop();
    this.entries.delete(sessionId);
    await entry.opened.release();
  }

  private requestToken(sessionId: string, signal?: AbortSignal): Promise<string> {
    const entry = this.entries.get(sessionId);
    if (!entry) return Promise.reject(new Error("session closed"));
    if (entry.tokenWaiter) {
      return Promise.reject(new Error("A token request for this session is already pending"));
    }
    return new Promise<string>((resolve, reject) => {
      entry.tokenWaiter = { resolve, reject };
      signal?.addEventListener(
        "abort",
        () => {
          if (entry.tokenWaiter?.reject === reject) entry.tokenWaiter = null;
          reject(new Error("token request aborted"));
        },
        { once: true }
      );
      this.options.emit({ type: "session-token-request", sessionId });
    });
  }

  private require(sessionId: string): Entry {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      throw new BrokerError("UNKNOWN_SESSION", "That session is not open (it may have ended).");
    }
    return entry;
  }

  private stamp(entry: Entry, envelope: RpcEnvelope): RpcEnvelope {
    const callerId = entry.opened.session.callerId();
    if (!callerId)
      throw new BrokerError("SESSION_NOT_READY", "The session is not authenticated yet.");
    return stampEnvelopeCaller(envelope, { callerId, callerKind: entry.opened.callerKind });
  }
}
