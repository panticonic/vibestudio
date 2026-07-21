/**
 * Client-side owner of one destructive `events.watch` response.
 *
 * Topic changes replace the response with a new response over the complete
 * desired set. Cancelling that response is the only unsubscribe operation.
 * Direct-address events are delivered by the authenticated RPC transport and
 * broadcast events are delivered by the owned watch response.
 */
import type { RpcCaller, RpcClient } from "@vibestudio/rpc";
import type { EventName, EventPayloads } from "@vibestudio/shared/events";
import { readEventWatchRecords } from "@vibestudio/service-schemas/events";
import type { RecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";

type Listener<E extends EventName> = (payload: EventPayloads[E]) => void;
type EventsRpc = Pick<RpcCaller, "stream"> & Partial<Pick<RpcClient, "streamReadable">>;

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
  private readonly serviceName: string;
  private readonly subscriptions = new Set<EventName>();
  private readonly listeners = new Map<EventName, Set<(payload: unknown) => void>>();
  private active: ActiveWatch | null = null;
  private pending: ActiveWatch | null = null;
  private generation = 0;
  private readonly watchId = createWatchId();
  private serverEpoch: string | null = null;
  private readonly lastSequenceByEvent = new Map<EventName, number>();
  private refreshQueue: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 250;

  constructor(
    rpc: EventsRpc,
    recoveryCoordinator?: Pick<
      RecoveryCoordinator,
      "registerResubscribeHandler" | "registerColdRecoverHandler"
    >,
    serviceName = "events"
  ) {
    this.rpc = rpc;
    this.serviceName = serviceName;
    const recover = () => this.queueRefresh();
    recoveryCoordinator?.registerResubscribeHandler("events-client", recover);
    recoveryCoordinator?.registerColdRecoverHandler("events-client", recover);
  }

  async subscribe(event: EventName): Promise<void> {
    if (this.subscriptions.has(event)) return;
    this.subscriptions.add(event);
    await this.queueRefresh();
  }

  async subscribeAll(events: Iterable<EventName>): Promise<void> {
    let changed = false;
    for (const event of events) {
      if (this.subscriptions.has(event)) continue;
      this.subscriptions.add(event);
      changed = true;
    }
    if (changed) await this.queueRefresh();
  }

  async unsubscribe(event: EventName): Promise<void> {
    if (!this.subscriptions.delete(event)) return;
    await this.queueRefresh();
  }

  async unsubscribeMany(events: Iterable<EventName>): Promise<void> {
    let changed = false;
    for (const event of events) changed = this.subscriptions.delete(event) || changed;
    if (changed) await this.queueRefresh();
  }

  async unsubscribeAll(): Promise<void> {
    if (this.subscriptions.size === 0 && !this.active) return;
    this.subscriptions.clear();
    await this.queueRefresh();
  }

  /** Re-open the desired watch after the transport reports a recovered session. */
  recover(): Promise<void> {
    return this.queueRefresh();
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
    const refresh = this.refreshQueue.then(() => this.refresh());
    this.refreshQueue = refresh.catch(() => {});
    return refresh;
  }

  private async refresh(): Promise<void> {
    this.clearRetry();
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
        const args = [[...this.subscriptions].sort(), this.watchId];
        const options = { signal: controller.signal, bodyIdleTimeoutMs: null };
        const response =
          typeof this.rpc.streamReadable === "function"
            ? await this.rpc.streamReadable("main", `${this.serviceName}.watch`, args, options)
            : await this.rpc.stream("main", `${this.serviceName}.watch`, args, options);
        for await (const record of readEventWatchRecords(response)) {
          if (record.kind === "watching") {
            if (acknowledged) throw new Error("Event watch sent more than one ACK");
            if (record.epoch !== this.serverEpoch) {
              this.serverEpoch = record.epoch;
              this.lastSequenceByEvent.clear();
            }
            watchEpoch = record.epoch;
            acknowledged = true;
            this.retryDelayMs = 250;
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
      () => this.watchTerminated(generation, controller)
    );
    try {
      await ack;
      this.active = next;
      this.pending = null;
    } catch (error) {
      controller.abort();
      if (this.pending === next) this.pending = null;
      if (previous?.settled && this.active === previous) this.active = null;
      this.scheduleRecovery();
      throw error;
    }
  }

  private watchTerminated(generation: number, controller: AbortController): void {
    if (controller.signal.aborted || this.active?.generation !== generation) return;
    if (this.pending) {
      this.active = null;
      return;
    }
    this.active = null;
    this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.subscriptions.size === 0 || this.retryTimer) return;
    const delayMs = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.queueRefresh().catch((error: unknown) => {
        console.warn("[EventsClient] event watch recovery failed:", error);
      });
    }, delayMs);
    (this.retryTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
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

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
