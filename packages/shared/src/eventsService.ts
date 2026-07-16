/**
 * Event Service - Subscription-based event system for shell/panels/workers.
 *
 * Watched broadcasts use one long-lived response owned by the caller. Direct
 * addresses use authenticated live transport sessions.
 *
 * Usage:
 *   // Subscribe and listen through the response-owning typed client.
 *   await events.subscribe("panel-tree-updated");
 *
 *   // Listen for events
 *   events.on("panel-tree-updated", (data) => { ... });
 */

import type { CallerKind } from "./serviceDispatcher.js";
import { encodeEventWatchRecord, type EventName, type EventPayloads } from "./events.js";

// Re-export for consumers
export type { EventName, EventPayloads } from "./events.js";

// =============================================================================
// Owned event-response session
// =============================================================================

export interface DirectEventSession {
  callerId: string;
  connectionId: string;
  userId?: string;
  send(event: EventName, payload: unknown): void;
  callerKind: CallerKind;
}

/** A long-lived event response. The response terminal is its sole lifetime. */
class EventWatchSession {
  private destroyed = false;
  private destroyHandlers: (() => void)[] = [];

  constructor(
    public readonly callerId: string,
    public readonly connectionId: string,
    public readonly watchId: string,
    public callerKind: CallerKind,
    public readonly events: ReadonlySet<EventName>,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    public readonly userId?: string
  ) {}

  get isAlive(): boolean {
    return !this.destroyed;
  }

  sendEvent(event: EventName, payload: unknown, sequence: number): void {
    if (this.destroyed) return;
    try {
      const record = encodeEventWatchRecord({ kind: "event", event, payload, sequence });
      const capacity = this.controller.desiredSize;
      if (capacity !== null && record.byteLength > capacity) {
        this.fail(new Error("Event watch buffer capacity exceeded"));
        return;
      }
      this.controller.enqueue(record);
    } catch (error) {
      this.fail(error);
    }
  }

  sendSnapshot(event: EventName, payload: unknown, sequence: number): void {
    if (this.destroyed) return;
    try {
      this.controller.enqueue(
        encodeEventWatchRecord({ kind: "snapshot", event, payload, sequence })
      );
    } catch (error) {
      this.fail(error);
    }
  }

  onDestroyed(handler: () => void): void {
    this.destroyHandlers.push(handler);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.controller.close();
    } catch {
      // Already terminal.
    }
    for (const handler of this.destroyHandlers) handler();
  }

  private fail(error: unknown): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.controller.error(error);
    } catch {
      // Already terminal.
    }
    for (const handler of this.destroyHandlers) handler();
  }
}

// =============================================================================
// Event service
// =============================================================================

/**
 * Event service for owned event response resources and direct live-session delivery.
 *
 * Four delivery surfaces, intentionally kept distinct:
 *
 *   1. **`emit(event, data)` — watched broadcast.** Fans `data` out to every
 *      live `events.watch(...)` response that includes the event.
 *
 *   2. **`emitToCaller(callerId, event, data)` — direct caller address.**
 *      Delivers to every live connection for one caller ID, bypassing the
 *      watch set. The target doesn't need to hold an `events.watch` response —
 *      being authenticated on the RPC server is
 *      sufficient (see `RpcServer.handleAuth`, which registers a direct
 *      transport session). Use when all live instances for one durable caller
 *      should receive a message.
 *
 *   3. **`emitToUser(userId, event, data)` — direct account address.**
 *      Delivers to every live transport whose admission-time caller carries
 *      that host-verified account subject. This is the cross-device nudge path;
 *      it never trusts an account id supplied by a client connection.
 *
 *   4. **`emitToConnection(callerId, connectionId, event, data)` — direct
 *      session address.** Delivers to exactly one transport instance. Use for
 *      request/response-adjacent handoffs where delivering to a sibling shell
 *      or panel connection would be surprising.
 *
 * The indexes overlap deliberately. A caller watching event X and also holding
 * a direct-address session may receive both a watched broadcast via `emit`
 * AND a direct-address via `emitToCaller/emitToUser/emitToConnection(event=X)`. That's
 * fine — direct delivery doesn't consult the watch index, and `emit` iterates
 * the watch resources only. Direct-address semantics are independent. Every
 * watch is cleaned up by its response terminal; there is no liveness inference.
 */
export class EventService {
  static readonly DEFAULT_CONNECTION_ID = "_default";
  static readonly MAX_WATCH_BUFFER_BYTES = 1024 * 1024;

  private watchesByEvent = new Map<EventName, Set<EventWatchSession>>();
  private watchesByOwner = new Map<string, Map<string, Map<string, EventWatchSession>>>();
  private sessionsByCallerId = new Map<string, Map<string, DirectEventSession>>();
  /** Live transport sessions grouped by their host-verified account subject. */
  private sessionsByUserId = new Map<string, Set<DirectEventSession>>();
  /** Identifies the sequence namespace owned by this server activation. */
  private readonly epoch = crypto.randomUUID();
  private sequence = 0;
  private getConnectionId(connectionId?: string): string {
    return connectionId ?? EventService.DEFAULT_CONNECTION_ID;
  }

  private getSessionBucket(callerId: string, create: true): Map<string, DirectEventSession>;
  private getSessionBucket(
    callerId: string,
    create?: false
  ): Map<string, DirectEventSession> | undefined;
  private getSessionBucket(
    callerId: string,
    create = false
  ): Map<string, DirectEventSession> | undefined {
    let bucket = this.sessionsByCallerId.get(callerId);
    if (!bucket && create) {
      bucket = new Map();
      this.sessionsByCallerId.set(callerId, bucket);
    }
    return bucket;
  }

  private removeSession(session: DirectEventSession): void {
    const { callerId, connectionId } = session;
    const bucket = this.sessionsByCallerId.get(callerId);
    if (bucket?.get(connectionId) === session) {
      bucket.delete(connectionId);
      if (bucket.size === 0) this.sessionsByCallerId.delete(callerId);
    }
    if (session.userId) {
      const sessions = this.sessionsByUserId.get(session.userId);
      sessions?.delete(session);
      if (sessions?.size === 0) this.sessionsByUserId.delete(session.userId);
    }
  }

  openWatch(input: {
    callerId: string;
    callerKind: CallerKind;
    connectionId: string;
    watchId: string;
    userId?: string;
    events: EventName[];
    snapshots?: Partial<Record<EventName, () => unknown>>;
    onClosed?: () => void;
  }): Response {
    const events = new Set(input.events);
    let session!: EventWatchSession;
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          session = new EventWatchSession(
            input.callerId,
            input.connectionId,
            input.watchId,
            input.callerKind,
            events,
            controller,
            input.userId
          );
          const ownerConnections = this.watchesByOwner.get(input.callerId) ?? new Map();
          this.watchesByOwner.set(input.callerId, ownerConnections);
          const ownerWatches = ownerConnections.get(input.connectionId) ?? new Map();
          ownerConnections.set(input.connectionId, ownerWatches);
          const previous = ownerWatches.get(input.watchId);

          for (const event of events) {
            let watches = this.watchesByEvent.get(event);
            if (!watches) {
              watches = new Set();
              this.watchesByEvent.set(event, watches);
            }
            watches.add(session);
          }
          session.onDestroyed(() => {
            for (const event of events) {
              const watches = this.watchesByEvent.get(event);
              watches?.delete(session);
              if (watches?.size === 0) this.watchesByEvent.delete(event);
            }
            if (ownerWatches.get(input.watchId) === session) {
              ownerWatches.delete(input.watchId);
              if (ownerWatches.size === 0) ownerConnections.delete(input.connectionId);
              if (ownerConnections.size === 0) this.watchesByOwner.delete(input.callerId);
            }
            input.onClosed?.();
          });
          ownerWatches.set(input.watchId, session);
          previous?.destroy();
          controller.enqueue(
            encodeEventWatchRecord({ kind: "watching", events: [...events], epoch: this.epoch })
          );
          try {
            for (const event of events) {
              const snapshot = input.snapshots?.[event]?.();
              if (snapshot !== undefined) session.sendSnapshot(event, snapshot, this.sequence);
            }
          } catch (error) {
            session.destroy();
            throw error;
          }
        },
        cancel: () => session.destroy(),
      },
      new ByteLengthQueuingStrategy({ highWaterMark: EventService.MAX_WATCH_BUFFER_BYTES })
    );
    return new Response(body, {
      headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
    });
  }

  /** Emit an event to every response that watches it. */
  emit<E extends EventName>(event: E, data?: EventPayloads[E]): void {
    const sequence = ++this.sequence;
    for (const watch of [...(this.watchesByEvent.get(event) ?? [])]) {
      watch.sendEvent(event, data, sequence);
    }
  }

  /** Direct-address every live connection for one durable caller identity. */
  emitToCaller<E extends EventName>(callerId: string, event: E, data?: EventPayloads[E]): boolean {
    const callerSubs = this.sessionsByCallerId.get(callerId);
    if (!callerSubs || callerSubs.size === 0) return false;

    let delivered = false;
    for (const session of callerSubs.values()) {
      session.send(event, data);
      delivered = true;
    }
    return delivered;
  }

  /** Direct-address every live transport belonging to one verified account. */
  emitToUser<E extends EventName>(userId: string, event: E, data?: EventPayloads[E]): boolean {
    const sessions = this.sessionsByUserId.get(userId);
    if (!sessions || sessions.size === 0) return false;

    let delivered = false;
    for (const session of [...sessions]) {
      session.send(event, data);
      delivered = true;
    }
    return delivered;
  }

  /** Direct-address exactly one live transport connection for a caller. */
  emitToConnection<E extends EventName>(
    callerId: string,
    connectionId: string,
    event: E,
    data?: EventPayloads[E]
  ): boolean {
    const resolvedConnectionId = this.getConnectionId(connectionId);
    const session = this.sessionsByCallerId.get(callerId)?.get(resolvedConnectionId);
    if (!session) return false;
    session.send(event, data);
    return true;
  }

  /**
   * Get the number of subscribers for an event.
   */
  getSubscriberCount(event: EventName): number {
    return this.watchesByEvent.get(event)?.size ?? 0;
  }

  /**
   * Register a live direct-address delivery session.
   */
  registerTransportSession(session: DirectEventSession): () => void {
    const resolvedConnectionId = this.getConnectionId(session.connectionId);
    const existing = this.getSessionBucket(session.callerId)?.get(resolvedConnectionId);
    if (existing) this.removeSession(existing);
    const bucket = this.getSessionBucket(session.callerId, true);
    bucket.set(resolvedConnectionId, session);
    if (session.userId) {
      let sessions = this.sessionsByUserId.get(session.userId);
      if (!sessions) {
        sessions = new Set();
        this.sessionsByUserId.set(session.userId, sessions);
      }
      sessions.add(session);
    }
    return () => this.removeSession(session);
  }
}
