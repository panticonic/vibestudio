import type {
  ClientHostEvent,
  ClientHostMethod,
  ClientHostMethods,
} from "./protocol";

/**
 * The client's end of the broker: typed requests to the host and the stream of
 * host events. The native implementation is `native.ts`; tests use
 * `testing.ts`. A client never constructs one itself; `connectNativeClientApi`
 * does.
 */
export interface BrokerChannel {
  request<M extends ClientHostMethod>(
    method: M,
    ...args: ClientHostMethods[M]["args"]
  ): Promise<ClientHostMethods[M]["result"]>;
  onEvent(handler: (event: ClientHostEvent) => void): () => void;
}

/** One subscription to the channel, demultiplexed by event type and session. */
export class EventHub {
  private readonly handlers = new Set<(event: ClientHostEvent) => void>();
  private release: (() => void) | null = null;

  constructor(private readonly channel: BrokerChannel) {}

  on(handler: (event: ClientHostEvent) => void): () => void {
    this.handlers.add(handler);
    this.release ??= this.channel.onEvent((event) => {
      for (const current of [...this.handlers]) current(event);
    });
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) {
        this.release?.();
        this.release = null;
      }
    };
  }

  /** Events of one type. */
  ofType<T extends ClientHostEvent["type"]>(
    type: T,
    handler: (event: Extract<ClientHostEvent, { type: T }>) => void
  ): () => void {
    return this.on((event) => {
      if (event.type === type) handler(event as Extract<ClientHostEvent, { type: T }>);
    });
  }

  /** Events of one type about one session. */
  ofSession<T extends Extract<ClientHostEvent, { sessionId: string }>["type"]>(
    type: T,
    sessionId: string,
    handler: (event: Extract<ClientHostEvent, { type: T }>) => void
  ): () => void {
    return this.on((event) => {
      if (event.type === type && (event as { sessionId?: string }).sessionId === sessionId) {
        handler(event as Extract<ClientHostEvent, { type: T }>);
      }
    });
  }
}
