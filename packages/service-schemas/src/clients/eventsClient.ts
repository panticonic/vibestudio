import { mainRpcMethods } from "../mainRpc.js";
/**
 * Client-side owner of one destructive `events.watch` response.
 *
 * Topic changes replace the response with a new response over the complete
 * desired set. Cancelling that response is the only unsubscribe operation.
 * Direct-address events are delivered by the authenticated RPC transport and
 * broadcast events are delivered by the owned watch response.
 */
import { type RpcStreamOptions, type RpcClient } from "@vibestudio/rpc";
import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import type { RecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import { eventsMethods } from "@vibestudio/service-schemas/events";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";

type Listener<E extends EventName> = (payload: EventPayloads[E]) => void;
type EventsServiceName = "events" | "desktopEvents";
type EventsRpc = Pick<RpcClient, "streamReadable"> & Partial<Pick<RpcClient, "onRecovery">>;

interface ActiveWatch {
  generation: number;
  controller: AbortController;
  terminal: Promise<void>;
  settled: boolean;
}

function createWatchId(): string {
  const cryptoObject = globalThis.crypto as
    | {
        randomUUID?: () => string;
        getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
      }
    | undefined;
  if (typeof cryptoObject?.randomUUID === "function") return cryptoObject.randomUUID();
  if (typeof cryptoObject?.getRandomValues === "function") {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class EventsClient {
  private readonly rpc: EventsRpc;
  private readonly serviceName: EventsServiceName;
  private readonly subscriptions = new Map<EventName, number>();
  private readonly listeners = new Map<EventName, Set<(payload: unknown) => void>>();
  private active: ActiveWatch | null = null;
  private pending: ActiveWatch | null = null;
  private generation = 0;
  private readonly watchId = createWatchId();
  private serverEpoch: string | null = null;
  private readonly lastSequenceByEvent = new Map<EventName, number>();
  private readonly refreshQueue = new Map<string, Promise<unknown>>();
  private watchAdmission: Promise<void> = Promise.resolve();
  private recoveryFailure: unknown = undefined;
  private readonly recoveryCoordinator?: Pick<
    RecoveryCoordinator,
    "registerResubscribeHandler" | "registerColdRecoverHandler"
  >;
  private recoveryReleases: (() => void)[] = [];

  constructor(
    rpc: EventsRpc,
    recoveryCoordinator?: Pick<
      RecoveryCoordinator,
      "registerResubscribeHandler" | "registerColdRecoverHandler"
    >,
    serviceName: EventsServiceName = "events"
  ) {
    this.rpc = rpc;
    this.serviceName = serviceName;
    this.recoveryCoordinator = recoveryCoordinator;
  }

  /** Typed stream admission for callers that own and display the wire records. */
  static openWatch(
    rpc: EventsRpc,
    events: readonly EventName[],
    watchId: string,
    options: RpcStreamOptions | undefined,
    serviceName: EventsServiceName = "events"
  ) {
    const args = eventsMethods.watch.args.parse([[...events], watchId]);
    return rpc.streamReadable("main", mainRpcMethods[`${serviceName}.watch`], args, options);
  }

  async subscribe(event: EventName): Promise<void> {
    await this.subscribeAll([event]);
  }

  async subscribeAll(events: Iterable<EventName>): Promise<void> {
    const hadDemand = this.subscriptions.size > 0;
    let changed = false;
    for (const event of new Set(events)) {
      const owners = this.subscriptions.get(event) ?? 0;
      this.subscriptions.set(event, owners + 1);
      changed = owners === 0 || changed;
    }
    if (!hadDemand && this.subscriptions.size > 0) this.observeRecovery();
    if (changed) await this.queueRefresh();
    else await this.watchAdmission;
  }

  async unsubscribe(event: EventName): Promise<void> {
    await this.unsubscribeMany([event]);
  }

  async unsubscribeMany(events: Iterable<EventName>): Promise<void> {
    let changed = false;
    for (const event of new Set(events)) {
      const owners = this.subscriptions.get(event);
      if (owners === undefined) continue;
      if (owners === 1) {
        this.subscriptions.delete(event);
        changed = true;
      } else {
        this.subscriptions.set(event, owners - 1);
      }
    }
    const retiringLastOwner = this.subscriptions.size === 0;
    try {
      if (changed) await this.queueRefresh();
      else await this.watchAdmission;
    } catch (error) {
      if (!retiringLastOwner) throw error;
      this.releaseRecovery(error);
      return;
    }
    if (retiringLastOwner) this.releaseRecovery();
  }

  async unsubscribeAll(): Promise<void> {
    if (this.subscriptions.size === 0 && !this.active && !this.pending) {
      this.releaseRecovery();
      return;
    }
    this.subscriptions.clear();
    try {
      await this.queueRefresh();
    } catch (error) {
      this.releaseRecovery(error);
      return;
    }
    this.releaseRecovery();
  }

  /** Re-open the desired watch after the transport reports a recovered session. */
  async recover(): Promise<void> {
    const previousFailure = this.recoveryFailure;
    this.recoveryFailure = undefined;
    try {
      await this.queueRefresh();
    } catch (error) {
      if (previousFailure === undefined || previousFailure === error) throw error;
      throw new AggregateError(
        [previousFailure, error],
        "Event watch termination and recovery failed",
        { cause: previousFailure }
      );
    }
  }

  private observeRecovery(): void {
    if (this.recoveryReleases.length > 0) return;
    if (this.recoveryCoordinator) {
      const name = `events-client:${this.serviceName}:${this.watchId}`;
      this.recoveryReleases.push(
        this.recoveryCoordinator.registerResubscribeHandler(name, () => this.recover(), {
          includeCurrentGeneration: false,
        })
      );
      try {
        this.recoveryReleases.push(
          this.recoveryCoordinator.registerColdRecoverHandler(name, () => this.recover())
        );
      } catch (error) {
        this.releaseRecovery(error);
      }
      return;
    }
    if (!this.rpc.onRecovery) return;
    this.recoveryReleases.push(
      this.rpc.onRecovery(() => {
        void this.recover().catch((error: unknown) => {
          console.error("[EventsClient] event watch recovery failed:", error);
        });
      })
    );
  }

  private releaseRecovery(operationFailure?: unknown): void {
    const failures: unknown[] = operationFailure === undefined ? [] : [operationFailure];
    for (const release of this.recoveryReleases.splice(0)) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Event watch retirement failed", {
        cause: failures[0],
      });
    }
  }

  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener as (payload: unknown) => void);
    return () => {
      listeners?.delete(listener as (payload: unknown) => void);
      if (listeners?.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  private queueRefresh(): Promise<void> {
    // Empty demand revokes the response now, including an opening watch whose
    // ACK is holding the serializer. Queuing cancellation behind that ACK
    // makes the cancellation wait for the operation it must release.
    const retiring =
      this.subscriptions.size === 0
        ? [...new Set([this.pending, this.active].filter((watch) => watch !== null))]
        : [];
    for (const watch of retiring) watch.controller.abort();
    const refresh = serializeByKey(this.refreshQueue, "events-watch", () => this.refresh());
    this.watchAdmission = Promise.all([
      refresh,
      ...retiring.map((watch) => watch.terminal.catch(() => {})),
    ]).then(() => undefined);
    return this.watchAdmission;
  }

  private async refresh(): Promise<void> {
    const previous = this.active;
    if (this.subscriptions.size === 0) {
      this.active = null;
      this.pending?.controller.abort();
      this.pending = null;
      previous?.controller.abort();
      await previous?.terminal.catch(() => {});
      return;
    }

    const generation = ++this.generation;
    const controller = new AbortController();
    let resolveAck!: () => void;
    let rejectAck!: (error: Error) => void;
    const ack = new Promise<void>((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    let acknowledged = false;
    let watchEpoch: string | null = null;
    const next: ActiveWatch = {
      generation,
      controller,
      terminal: Promise.resolve(),
      settled: false,
    };
    const terminal = (async () => {
      try {
        const response = await EventsClient.openWatch(
          this.rpc,
          [...this.subscriptions.keys()].sort(),
          this.watchId,
          { signal: controller.signal, bodyIdleTimeoutMs: null },
          this.serviceName
        );
        const { readEventWatchRecords } = await import("@vibestudio/service-schemas/events");
        for await (const record of readEventWatchRecords(response)) {
          if (record.kind === "watching") {
            if (acknowledged) throw new Error("Event watch sent more than one ACK");
            if (record.epoch !== this.serverEpoch) {
              this.serverEpoch = record.epoch;
              this.lastSequenceByEvent.clear();
            }
            watchEpoch = record.epoch;
            acknowledged = true;
            resolveAck();
            continue;
          }
          if (!acknowledged) throw new Error("Event watch delivered data before its ACK");
          if (watchEpoch !== this.serverEpoch) continue;
          if (record.kind === "snapshot") {
            const previousSequence = this.lastSequenceByEvent.get(record.event) ?? 0;
            if (record.sequence < previousSequence) continue;
            this.lastSequenceByEvent.set(record.event, record.sequence);
            this.deliver(record.event, record.payload);
            continue;
          }
          const previousSequence = this.lastSequenceByEvent.get(record.event) ?? 0;
          if (record.sequence <= previousSequence) continue;
          this.lastSequenceByEvent.set(record.event, record.sequence);
          this.deliver(record.event, record.payload);
        }
        if (!acknowledged) throw new Error("Event watch closed before its ACK");
        const isOwned =
          this.pending?.generation === generation ||
          (!this.pending && this.active?.generation === generation);
        if (!controller.signal.aborted && isOwned) {
          throw new Error("Event watch closed unexpectedly");
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!acknowledged) rejectAck(failure);
        throw failure;
      }
    })();
    next.terminal = terminal.finally(() => {
      next.settled = true;
    });
    void next.terminal.catch(() => {});
    this.pending = next;
    void terminal.then(
      () => this.watchTerminated(generation, controller),
      (error: unknown) => this.watchTerminated(generation, controller, error)
    );
    try {
      await ack;
      this.active = next;
      this.pending = null;
      this.recoveryFailure = undefined;
    } catch (error) {
      controller.abort();
      if (this.pending === next) this.pending = null;
      if (previous?.settled && this.active === previous) this.active = null;
      const concurrentFailure = this.recoveryFailure;
      this.recoveryFailure = undefined;
      if (concurrentFailure !== undefined && concurrentFailure !== error) {
        throw new AggregateError(
          [concurrentFailure, error],
          "Event watch generation and replacement failed",
          { cause: concurrentFailure }
        );
      }
      throw error;
    }
  }

  private watchTerminated(generation: number, controller: AbortController, error?: unknown): void {
    if (controller.signal.aborted || this.active?.generation !== generation) return;
    if (this.pending) {
      this.active = null;
      if (error !== undefined) this.recoveryFailure = error;
      return;
    }
    this.active = null;
    this.recoveryFailure = error ?? new Error("Event watch closed unexpectedly");
  }

  private deliver(event: EventName, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[EventsClient] listener for ${event} failed:`, error);
      }
    }
  }
}
