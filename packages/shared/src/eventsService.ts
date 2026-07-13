/**
 * Event Service - Subscription-based event system for shell/panels/workers.
 *
 * Replaces direct IPC event sending with a subscription model:
 * - Callers subscribe to events they care about
 * - Events are only sent to subscribers via WS
 * - Automatic cleanup when subscriber disconnects
 *
 * Usage:
 *   // Subscribe through a typed events client, then listen on the transport.
 *   await events.subscribe("panel-tree-updated");
 *
 *   // Listen for events
 *   rpc.on("event:panel-tree-updated", (data) => { ... });
 */

import type { WebSocket } from "ws";
import type { ServiceContext, CallerKind } from "./serviceDispatcher.js";
import type { EventName, EventPayloads } from "./events.js";

// Re-export for consumers
export type { EventName, EventPayloads } from "./events.js";

// =============================================================================
// Subscriber interface
// =============================================================================

export interface Subscriber {
  send(channel: string, payload: unknown): void;
  readonly isAlive: boolean;
  /** Check if this subscriber is bound to the given WebSocket */
  isBoundTo(ws: WebSocket): boolean;
  onDestroyed(handler: () => void): void;
  callerKind: CallerKind;
}

/**
 * A live transport instance for one authenticated caller.
 *
 * `callerId` is durable identity: it survives reconnects and may have multiple
 * simultaneous live sessions. `connectionId` is transport identity: it names
 * exactly one live connection and must not be persisted.
 */
export interface EventSession extends Subscriber {
  callerId: string;
  connectionId: string;
  /** Host-verified owning account; absent for connectionless/system sessions. */
  userId?: string;
}

/**
 * WsSubscriber — delivers events over WebSocket as ws:event messages.
 */
export class WsSubscriber implements Subscriber {
  private destroyed = false;
  private destroyHandlers: (() => void)[] = [];

  constructor(
    private ws: WebSocket,
    public callerKind: CallerKind
  ) {
    ws.on("close", () => {
      this.destroyed = true;
      for (const handler of this.destroyHandlers) handler();
    });
  }

  get isAlive(): boolean {
    return !this.destroyed && this.ws.readyState === 1; // WebSocket.OPEN
  }

  send(channel: string, payload: unknown): void {
    if (!this.isAlive) return;
    try {
      this.ws.send(JSON.stringify({ type: "ws:event", event: channel, payload }));
    } catch (err) {
      // A single failed send must not break the fan-out to sibling subscribers,
      // but it must be observable rather than silently swallowed.
      console.warn(
        `[EventService] failed to deliver "${channel}" to a ${this.callerKind} subscriber:`,
        err
      );
    }
  }

  isBoundTo(ws: WebSocket): boolean {
    return this.ws === ws;
  }

  onDestroyed(handler: () => void): void {
    this.destroyHandlers.push(handler);
  }
}

export class WsEventSession extends WsSubscriber implements EventSession {
  constructor(
    ws: WebSocket,
    callerKind: CallerKind,
    public callerId: string,
    public connectionId: string,
    public userId?: string
  ) {
    super(ws, callerKind);
  }
}

/**
 * Delivers an event to a connectionless Durable Object by POSTing an event
 * envelope to it (the server's relay path). Rejecting means the DO is gone /
 * hibernated / uninterested, which reaps the subscriber.
 */
export type DoEventPushDelivery = (
  callerId: string,
  channel: string,
  payload: unknown
) => Promise<void>;

/**
 * Relay error codes that mean the target DO/worker is permanently gone — there
 * is no point retrying a push, and the subscriber should be reaped. Anything
 * else (network blip, hibernated-but-revivable DO, transient workerd error) is
 * treated as transient: we retry with backoff and KEEP the subscription, so a
 * connectionless subscriber doesn't go silently deaf to all future events on a
 * single hiccup.
 */
const TERMINAL_PUSH_ERROR_CODES = new Set(["DO_NOT_CREATED", "UNKNOWN_TARGET_KIND"]);

function pushErrorIsTerminal(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && TERMINAL_PUSH_ERROR_CODES.has(code);
}

/** Tunables for `DoPushSubscriber` delivery retry (overridable in tests). */
export interface DoPushRetryOptions {
  /** Max delivery attempts (including the first) before reaping. Default 4. */
  maxAttempts?: number;
  /** Injectable backoff delay (tests collapse it). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Push-subscriber for a connectionless DO/worker caller. Unlike `WsSubscriber`
 * there is no socket whose close reaps it.
 *
 * A single failed delivery must NOT silently make the subscriber deaf to every
 * future event while it still believes it's subscribed. So `send` distinguishes
 * terminal failures (DO gone → reap) from transient ones (network/hibernation →
 * retry with backoff, keep the subscription). Every teardown logs callerId +
 * channel first. `EventService` also drops the subscriber when the caller's last
 * topic unsubscribes (ref-counted in `removeSubscriber`).
 *
 * Deliveries for one subscriber are processed in order (chained), so a slow
 * retry can't let a later event jump ahead.
 */
export class DoPushSubscriber implements Subscriber {
  private destroyed = false;
  private destroyHandlers: (() => void)[] = [];
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes deliveries so retries preserve event ordering. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    public readonly callerId: string,
    public callerKind: CallerKind,
    private readonly deliver: DoEventPushDelivery,
    opts: DoPushRetryOptions = {}
  ) {
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get isAlive(): boolean {
    return !this.destroyed;
  }

  send(channel: string, payload: unknown): void {
    if (this.destroyed) return;
    this.chain = this.chain.then(() => this.deliverWithRetry(channel, payload));
  }

  private async deliverWithRetry(channel: string, payload: unknown): Promise<void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (this.destroyed) return;
      try {
        await this.deliver(this.callerId, channel, payload);
        return;
      } catch (err) {
        // Terminal: the DO is permanently gone — reap (logging first) rather
        // than wasting retries pushing to a corpse.
        if (pushErrorIsTerminal(err)) {
          console.warn(
            `[EventService] push to ${this.callerKind} ${this.callerId} for "${channel}" hit a ` +
              `terminal error; reaping subscription:`,
            err
          );
          this.destroy();
          return;
        }
        const last = attempt === this.maxAttempts - 1;
        if (last) {
          // Exhausted retries on a transient-looking error: a revivable DO that
          // stayed unreachable. Reap so we stop re-waking it, but make it loud —
          // a permanently-deaf subscription must be diagnosable, never silent.
          console.warn(
            `[EventService] push to ${this.callerKind} ${this.callerId} for "${channel}" failed ` +
              `after ${this.maxAttempts} attempts; reaping subscription:`,
            err
          );
          this.destroy();
          return;
        }
        await this.sleep(100 * Math.pow(2, attempt));
      }
    }
  }

  isBoundTo(): boolean {
    return false;
  }

  onDestroyed(handler: () => void): void {
    this.destroyHandlers.push(handler);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const handler of this.destroyHandlers) handler();
  }
}

// =============================================================================
// Event service
// =============================================================================

/**
 * Event service for managing subscriptions and emitting events.
 *
 * Four delivery surfaces, intentionally kept distinct:
 *
 *   1. **`emit(event, data)` — pub/sub broadcast.** Fans `data` out to every
 *      subscriber that called `events.subscribe(event)`. Iterates the
 *      event-keyed table (`subscribers`). Use for anything a caller opts
 *      into ("notify me when the panel tree changes").
 *
 *   2. **`emitToCaller(callerId, event, data)` — direct caller address.**
 *      Delivers to every live connection for one caller ID, bypassing the
 *      subscription table. The target doesn't need to have called
 *      `events.subscribe` — being authenticated on the RPC server is
 *      sufficient (see `RpcServer.handleAuth`, which registers an
 *      `EventSession`). Use when all live instances for one durable caller
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
 * The indexes overlap deliberately. A caller who calls `events.subscribe`
 * for event X AND is authenticated will receive a `broadcast(X)` via `emit`
 * AND a direct-address via `emitToCaller/emitToUser/emitToConnection(event=X)`. That's
 * fine — direct delivery doesn't consult `subscribers`, and `emit` iterates
 * `subscribers` only. A caller who `events.unsubscribe`s from X still
 * receives direct delivery because direct-address semantics aren't governed by
 * the subscription table. Live sessions are cleaned up by connection
 * destruction, not by event-name unsubscription.
 */
export class EventService {
  static readonly DEFAULT_CONNECTION_ID = "_default";

  private subscribers = new Map<EventName, Map<string, Map<string, Subscriber>>>();
  private sessionsByCallerId = new Map<string, Map<string, EventSession>>();
  /** Live transport sessions grouped by their host-verified account subject. */
  private sessionsByUserId = new Map<string, Set<EventSession>>();
  /**
   * Server→DO event push. Set once at wiring time. Lets a connectionless DO
   * receive real `events.subscribe` pushes (e.g. `vcs.subscribeHead`) — without
   * it, a DO subscription would silently never deliver.
   */
  private doPushDelivery: DoEventPushDelivery | null = null;

  /** Wire the server→DO event push delivery (POSTs an event envelope to the DO). */
  setDoPushDelivery(delivery: DoEventPushDelivery): void {
    this.doPushDelivery = delivery;
  }

  private getConnectionId(connectionId?: string): string {
    return connectionId ?? EventService.DEFAULT_CONNECTION_ID;
  }

  private getSessionBucket(callerId: string, create: true): Map<string, EventSession>;
  private getSessionBucket(callerId: string, create?: false): Map<string, EventSession> | undefined;
  private getSessionBucket(
    callerId: string,
    create = false
  ): Map<string, EventSession> | undefined {
    let bucket = this.sessionsByCallerId.get(callerId);
    if (!bucket && create) {
      bucket = new Map();
      this.sessionsByCallerId.set(callerId, bucket);
    }
    return bucket;
  }

  private removeSubscriber(callerId: string, connectionId: string, subscriber?: Subscriber): void {
    const bucket = this.sessionsByCallerId.get(callerId);
    if (bucket) {
      if (!subscriber || bucket.get(connectionId) === subscriber) {
        bucket.delete(connectionId);
      }
      if (bucket.size === 0) {
        this.sessionsByCallerId.delete(callerId);
      }
    }

    if (subscriber && "userId" in subscriber) {
      const userId = (subscriber as EventSession).userId;
      if (userId) {
        const sessions = this.sessionsByUserId.get(userId);
        sessions?.delete(subscriber as EventSession);
        if (sessions?.size === 0) this.sessionsByUserId.delete(userId);
      }
    }

    for (const eventSubs of this.subscribers.values()) {
      const callerSubs = eventSubs.get(callerId);
      if (!callerSubs) continue;
      if (!subscriber || callerSubs.get(connectionId) === subscriber) {
        callerSubs.delete(connectionId);
      }
      if (callerSubs.size === 0) {
        eventSubs.delete(callerId);
      }
    }
  }

  /**
   * Subscribe a caller to an event.
   * Uses callerId + connectionId keyed maps for stable identity across calls.
   */
  subscribe(
    event: EventName,
    callerId: string,
    subscriber: Subscriber,
    connectionId?: string
  ): void {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Map());
    }

    const subs = this.subscribers.get(event)!;
    let callerSubs = subs.get(callerId);
    if (!callerSubs) {
      callerSubs = new Map();
      subs.set(callerId, callerSubs);
    }
    callerSubs.set(this.getConnectionId(connectionId), subscriber);
  }

  /**
   * Unsubscribe a caller from an event.
   */
  unsubscribe(event: EventName, callerId: string, connectionId?: string): void {
    const resolvedConnectionId = this.getConnectionId(connectionId);
    const callerSubs = this.subscribers.get(event)?.get(callerId);
    if (!callerSubs) return;
    callerSubs.delete(resolvedConnectionId);
    if (callerSubs.size === 0) {
      this.subscribers.get(event)?.delete(callerId);
    }
    this.reapIdleDoSubscriber(callerId, resolvedConnectionId);
  }

  /**
   * A `DoPushSubscriber` has no socket to reap it, so once its caller's last
   * topic unsubscribes, drop the session — otherwise the server keeps an idle
   * subscription (and would re-push to a hibernated DO). WS sessions are left
   * alone (reaped by connection close).
   */
  private reapIdleDoSubscriber(callerId: string, connectionId: string): void {
    const session = this.sessionsByCallerId.get(callerId)?.get(connectionId);
    if (!(session instanceof DoPushSubscriber)) return;
    for (const subs of this.subscribers.values()) {
      if (subs.get(callerId)?.has(connectionId)) return; // still subscribed to something
    }
    session.destroy();
  }

  /**
   * Unsubscribe a caller from all events.
   */
  unsubscribeAll(callerId: string, connectionId?: string): void {
    const resolvedConnectionId = this.getConnectionId(connectionId);
    for (const subs of this.subscribers.values()) {
      const callerSubs = subs.get(callerId);
      if (!callerSubs) continue;
      callerSubs.delete(resolvedConnectionId);
      if (callerSubs.size === 0) {
        subs.delete(callerId);
      }
    }
    // Drop the DO push-subscriber too (it has no socket to reap it) — without
    // this, a DO that subscribes then unsubscribeAlls leaks its DoPushSubscriber
    // forever and the server keeps re-waking a hibernated/uninterested DO.
    this.reapIdleDoSubscriber(callerId, resolvedConnectionId);
  }

  /**
   * Emit an event to all subscribers.
   * All subscribers get the same ws:event message format.
   */
  emit<E extends EventName>(event: E, data?: EventPayloads[E]): void {
    const subs = this.subscribers.get(event);
    if (!subs || subs.size === 0) {
      return;
    }

    const channel = `event:${event}`;
    // `removeSubscriber` mutates the very maps we iterate here (it sweeps the
    // connection out of EVERY event's table). Deliver first, COLLECT the dead
    // tuples, then reap after the loop so a sibling subscriber can never be
    // skipped by a mid-iteration delete.
    const dead: Array<{ callerId: string; connectionId: string; subscriber: Subscriber }> = [];
    for (const [callerId, callerSubs] of subs) {
      for (const [connectionId, subscriber] of callerSubs) {
        if (subscriber.isAlive) {
          subscriber.send(channel, data);
        } else {
          dead.push({ callerId, connectionId, subscriber });
        }
      }
    }
    for (const { callerId, connectionId, subscriber } of dead) {
      this.removeSubscriber(callerId, connectionId, subscriber);
    }
  }

  /** Direct-address every live connection for one durable caller identity. */
  emitToCaller<E extends EventName>(callerId: string, event: E, data?: EventPayloads[E]): boolean {
    const callerSubs = this.sessionsByCallerId.get(callerId);
    if (!callerSubs || callerSubs.size === 0) return false;

    let delivered = false;
    const channel = `event:${event}`;
    for (const [connectionId, subscriber] of callerSubs) {
      if (subscriber.isAlive) {
        subscriber.send(channel, data);
        delivered = true;
      } else {
        this.removeSubscriber(callerId, connectionId, subscriber);
      }
    }
    return delivered;
  }

  /** Direct-address every live transport belonging to one verified account. */
  emitToUser<E extends EventName>(userId: string, event: E, data?: EventPayloads[E]): boolean {
    const sessions = this.sessionsByUserId.get(userId);
    if (!sessions || sessions.size === 0) return false;

    let delivered = false;
    const channel = `event:${event}`;
    for (const session of [...sessions]) {
      if (session.isAlive) {
        session.send(channel, data);
        delivered = true;
      } else {
        this.removeSubscriber(session.callerId, session.connectionId, session);
      }
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
    const subscriber = this.sessionsByCallerId.get(callerId)?.get(resolvedConnectionId);
    if (!subscriber || !subscriber.isAlive) {
      if (subscriber) this.removeSubscriber(callerId, resolvedConnectionId, subscriber);
      return false;
    }
    subscriber.send(`event:${event}`, data);
    return true;
  }

  /**
   * Get the number of subscribers for an event.
   */
  getSubscriberCount(event: EventName): number {
    let count = 0;
    for (const callerSubs of this.subscribers.get(event)?.values() ?? []) {
      count += callerSubs.size;
    }
    return count;
  }

  /**
   * Register a live direct-address delivery session.
   */
  registerSession(session: EventSession): void {
    const resolvedConnectionId = this.getConnectionId(session.connectionId);
    const bucket = this.getSessionBucket(session.callerId, true);
    const existing = bucket.get(resolvedConnectionId);
    if (existing) {
      this.removeSubscriber(session.callerId, resolvedConnectionId, existing);
    }
    this.getSessionBucket(session.callerId, true).set(resolvedConnectionId, session);
    if (session.userId) {
      let sessions = this.sessionsByUserId.get(session.userId);
      if (!sessions) {
        sessions = new Set();
        this.sessionsByUserId.set(session.userId, sessions);
      }
      sessions.add(session);
    }
    session.onDestroyed(() => {
      this.removeSubscriber(session.callerId, resolvedConnectionId, session);
    });
  }

  /**
   * Register an external subscriber (e.g., IPC-backed) for direct delivery.
   * Used when the caller doesn't have a WebSocket. The optional connection ID
   * still represents an ephemeral runtime session and must not be persisted.
   */
  registerSubscriber(callerId: string, subscriber: Subscriber, connectionId?: string): void {
    const session = Object.assign(subscriber, {
      callerId,
      connectionId: this.getConnectionId(connectionId),
    }) satisfies EventSession;
    this.registerSession(session);
  }

  /**
   * Get or create a subscriber for a callerId from a WS client.
   */
  getOrCreateSubscriber(ctx: ServiceContext): Subscriber {
    const connectionId = this.getConnectionId(ctx.connectionId);
    // Allow pre-registered subscribers (e.g., IPC-backed shell subscriber)
    const preRegistered = this.sessionsByCallerId.get(ctx.caller.runtime.id)?.get(connectionId);
    if (preRegistered && preRegistered.isAlive) return preRegistered;

    if (!ctx.wsClient) {
      // Connectionless DO/worker callers have no socket; mint a push-subscriber
      // that POSTs event envelopes to them (server→DO push). This is what makes
      // `vcs.subscribeHead` / `workspace.units.watch` real on a DO.
      const kind = ctx.caller.runtime.kind;
      if ((kind === "do" || kind === "worker") && this.doPushDelivery) {
        const subscriber = new DoPushSubscriber(ctx.caller.runtime.id, kind, this.doPushDelivery);
        this.registerSubscriber(ctx.caller.runtime.id, subscriber, connectionId);
        return subscriber;
      }
      throw new Error("Event subscriptions require a WS connection or pre-registered subscriber");
    }

    const existing = this.sessionsByCallerId.get(ctx.caller.runtime.id)?.get(connectionId);
    // Cast ws from WsClientInfo.ws (unknown) to WebSocket -- eventsService
    // is server-only code that always receives the concrete WS instance.
    const ws = ctx.wsClient.ws as WebSocket;

    // Reuse only if alive AND bound to the same WS (connection replacement gives a new WS)
    if (existing && existing.isAlive && existing.isBoundTo(ws)) return existing;

    // Remove stale subscriber's event entries if it was replaced
    if (existing) {
      this.removeSubscriber(ctx.caller.runtime.id, connectionId, existing);
    }

    const session = new WsEventSession(
      ws,
      ctx.caller.runtime.kind,
      ctx.caller.runtime.id,
      connectionId,
      ctx.caller.subject?.userId
    );
    this.registerSession(session);
    return session;
  }
}
