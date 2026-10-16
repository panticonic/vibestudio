import {
  RpcBoundaryError,
  deserializeRpcFailure,
  serializeRpcFailure,
  type RpcFailure,
} from "@vibestudio/rpc";
import { SESSION_CONNECTION_LOST_CODE } from "@vibestudio/rpc/protocol/remoteSession";

/**
 * The typed channel between the Electron main process and the connection
 * utility process (docs/client-hosts-and-clients-plan.md §5.1.1).
 *
 * One `MessagePort` pair carries requests, events and byte streams in both
 * directions. It is deliberately small: every operation is a named request
 * with a structured-cloneable payload, a failure crosses as the structured
 * {@link RpcFailure} the rest of the platform already speaks, and a byte
 * stream is credit-controlled so a slow reader bounds memory instead of
 * queueing without limit.
 *
 * Lifecycle is authoritative, never timed. The channel ends when its port
 * closes or its owner calls {@link ControlChannel.fail} with the process's exit
 * reason; every pending request and every open stream then settles with that
 * reason.
 */

/** The subset of Electron's `MessagePortMain` this channel relies on. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: MessagePortLike[]): void;
  on(
    event: "message",
    listener: (event: { data: unknown; ports: MessagePortLike[] }) => void
  ): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}

/** Bytes a stream may have in flight before the sender waits for the reader. */
const STREAM_WINDOW_CHUNKS = 8;

type Wire =
  | { k: "req"; id: number; m: string; p: unknown; bs?: number }
  | { k: "res"; id: number; ok: true; r: unknown; rs?: number }
  | { k: "res"; id: number; ok: false; e: RpcFailure }
  | { k: "cancel"; id: number }
  | { k: "evt"; n: string; p: unknown }
  | { k: "data"; s: number; d: Uint8Array }
  | { k: "end"; s: number }
  | { k: "abort"; s: number; e: RpcFailure }
  | { k: "credit"; s: number; n: number }
  | { k: "stop"; s: number };

/** What a handler receives besides its payload. */
export interface RequestContext {
  /** Aborts when the requester cancels or the channel ends. */
  signal: AbortSignal;
  /** The request's upload body, when the requester sent one. */
  body: ReadableStream<Uint8Array> | null;
  /** Ports the requester transferred with the request. */
  ports: MessagePortLike[];
}

/** A handler's answer: a value, or a value with a byte stream following it. */
export type HandlerResult = unknown | StreamReply;

export class StreamReply {
  constructor(
    readonly head: unknown,
    readonly body: ReadableStream<Uint8Array>
  ) {}
}

export type RequestHandler = (
  payload: any,
  context: RequestContext
) => HandlerResult | Promise<HandlerResult>;

export interface RequestOptions {
  signal?: AbortSignal;
  body?: ReadableStream<Uint8Array> | null;
  transfer?: MessagePortLike[];
}

/** The answer to a request whose handler replied with a byte stream. */
export class StreamedResponse<T = unknown> {
  constructor(
    readonly head: T,
    readonly body: ReadableStream<Uint8Array>
  ) {}
}

type ResponseMode = "value" | "stream" | "either";

export function controlChannelClosed(reason: string, cause?: unknown): RpcBoundaryError {
  return new RpcBoundaryError(reason, "transport", SESSION_CONNECTION_LOST_CODE, cause);
}

interface OutgoingStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  credit: number;
  wake: (() => void) | null;
  stopped: boolean;
}

interface IncomingStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
}

export interface ControlChannelOptions {
  /** End the channel when its port closes (default). Owners with a better reason pass false. */
  endOnPortClose?: boolean;
}

export class ControlChannel {
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly listeners = new Map<string, Set<(payload: any) => void>>();
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void; mode: ResponseMode }
  >();
  private readonly inflight = new Map<number, AbortController>();
  private readonly outgoing = new Map<number, OutgoingStream>();
  private readonly incoming = new Map<number, IncomingStream>();
  private readonly closeListeners = new Set<(reason: Error) => void>();
  private nextRequest = 1;
  private nextStream: number;
  private ended: Error | null = null;

  /**
   * `side` partitions stream ids so both ends can open streams without a
   * handshake: side "a" allocates odd ids, side "b" even ones.
   */
  constructor(
    private readonly port: MessagePortLike,
    side: "a" | "b",
    options: ControlChannelOptions = {}
  ) {
    this.nextStream = side === "a" ? 1 : 2;
    port.on("message", (event) => this.receive(event.data as Wire, event.ports));
    // A peer that vanished takes its port with it, but only its owner knows why
    // (a process exit has a code). An owner that does passes `endOnPortClose:
    // false` and calls fail() with the real reason.
    if (options.endOnPortClose !== false) {
      port.on("close", () => this.fail(controlChannelClosed("The control port closed")));
    }
    port.start();
  }

  get isClosed(): boolean {
    return this.ended !== null;
  }

  /** The error every operation on an ended channel settles with, if it has ended. */
  get closedReason(): Error | null {
    return this.ended;
  }

  handle(method: string, handler: RequestHandler): void {
    if (this.handlers.has(method)) throw new Error(`Control method ${method} is already handled`);
    this.handlers.set(method, handler);
  }

  on(event: string, listener: (payload: any) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Observe the end of the channel. Fires once; fires immediately when already ended. */
  onClose(listener: (reason: Error) => void): () => void {
    if (this.ended) {
      listener(this.ended);
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emit(event: string, payload?: unknown): void {
    if (this.ended) return;
    this.send({ k: "evt", n: event, p: payload });
  }

  request<T = unknown>(
    method: string,
    payload?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    return this.issue(method, payload, options, "value") as Promise<T>;
  }

  /** A request whose answer is a head plus a byte stream. */
  requestStream<T = unknown>(
    method: string,
    payload?: unknown,
    options: RequestOptions = {}
  ): Promise<StreamedResponse<T>> {
    return this.issue(method, payload, options, "stream") as Promise<StreamedResponse<T>>;
  }

  /** A request whose handler decides, per call, between a value and a byte stream. */
  requestEither<T = unknown>(
    method: string,
    payload?: unknown,
    options: RequestOptions = {}
  ): Promise<T | StreamedResponse<T>> {
    return this.issue(method, payload, options, "either") as Promise<T | StreamedResponse<T>>;
  }

  /**
   * End the channel with `reason`: pending requests reject, open streams error,
   * the owner's close listeners run. Used for an authoritative terminal event
   * such as the utility process exiting. Idempotent.
   */
  fail(reason: Error): void {
    if (this.ended) return;
    this.ended = reason;
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      entry.reject(reason);
    }
    for (const abort of this.inflight.values()) abort.abort(reason);
    this.inflight.clear();
    for (const stream of this.incoming.values()) {
      try {
        stream.controller.error(reason);
      } catch {
        // The consumer already cancelled this stream.
      }
    }
    this.incoming.clear();
    for (const [id, stream] of this.outgoing) {
      stream.stopped = true;
      stream.wake?.();
      void stream.reader.cancel(reason).catch(() => undefined);
      this.outgoing.delete(id);
    }
    for (const listener of [...this.closeListeners]) {
      try {
        listener(reason);
      } catch {
        // A close observer must not stop the others from learning of the end.
      }
    }
    this.closeListeners.clear();
    try {
      this.port.close();
    } catch {
      // Already closed.
    }
  }

  close(): void {
    this.fail(controlChannelClosed("The control channel was closed"));
  }

  private issue(
    method: string,
    payload: unknown,
    options: RequestOptions,
    mode: ResponseMode
  ): Promise<unknown> {
    if (this.ended) return Promise.reject(this.ended);
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
    const id = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, mode });
      const bodyStream = options.body ? this.sendStream(options.body) : undefined;
      this.send(
        { k: "req", id, m: method, p: payload, ...(bodyStream ? { bs: bodyStream } : {}) },
        options.transfer
      );
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          if (!this.ended) this.send({ k: "cancel", id });
          reject(signal.reason ?? new Error("Aborted"));
        },
        { once: true }
      );
    });
  }

  private send(message: Wire, transfer?: MessagePortLike[]): void {
    // MessagePortMain rejects an explicit `undefined` transfer list.
    if (transfer && transfer.length > 0) this.port.postMessage(message, transfer);
    else this.port.postMessage(message);
  }

  private receive(message: Wire, ports: MessagePortLike[]): void {
    switch (message.k) {
      case "req":
        void this.serve(message, ports);
        return;
      case "res": {
        const entry = this.pending.get(message.id);
        if (!entry) {
          // The requester abandoned it; a stream the answer opened is not wanted.
          if (message.ok && message.rs !== undefined) this.send({ k: "stop", s: message.rs });
          return;
        }
        this.pending.delete(message.id);
        if (!message.ok) entry.reject(deserializeRpcFailure(message.e));
        else if (message.rs !== undefined) {
          if (entry.mode === "value") {
            this.send({ k: "stop", s: message.rs });
            entry.reject(
              new Error("A control request that expects a value was answered with a stream")
            );
          } else entry.resolve(new StreamedResponse(message.r, this.receiveStream(message.rs)));
        } else if (entry.mode === "stream")
          entry.reject(
            new Error("A control request that expects a stream was answered with a value")
          );
        else entry.resolve(message.r);
        return;
      }
      case "cancel":
        this.inflight.get(message.id)?.abort(new Error("Request cancelled by its caller"));
        return;
      case "evt":
        for (const listener of this.listeners.get(message.n) ?? []) listener(message.p);
        return;
      case "data": {
        const stream = this.incoming.get(message.s);
        if (!stream) return;
        stream.controller.enqueue(message.d);
        return;
      }
      case "end": {
        const stream = this.incoming.get(message.s);
        if (!stream) return;
        this.incoming.delete(message.s);
        stream.controller.close();
        return;
      }
      case "abort": {
        const stream = this.incoming.get(message.s);
        if (!stream) return;
        this.incoming.delete(message.s);
        stream.controller.error(deserializeRpcFailure(message.e));
        return;
      }
      case "credit": {
        const stream = this.outgoing.get(message.s);
        if (!stream) return;
        stream.credit += message.n;
        stream.wake?.();
        return;
      }
      case "stop": {
        const stream = this.outgoing.get(message.s);
        if (!stream) return;
        stream.stopped = true;
        stream.wake?.();
        return;
      }
    }
  }

  private async serve(
    message: Extract<Wire, { k: "req" }>,
    ports: MessagePortLike[]
  ): Promise<void> {
    const abort = new AbortController();
    this.inflight.set(message.id, abort);
    const body = message.bs !== undefined ? this.receiveStream(message.bs) : null;
    try {
      const handler = this.handlers.get(message.m);
      if (!handler) throw new Error(`Unknown control method ${message.m}`);
      const result = await handler(message.p, { signal: abort.signal, body, ports });
      if (this.ended || abort.signal.aborted) {
        if (result instanceof StreamReply) void result.body.cancel().catch(() => undefined);
        return;
      }
      if (result instanceof StreamReply) {
        const stream = this.sendStream(result.body);
        this.send({ k: "res", id: message.id, ok: true, r: result.head, rs: stream });
      } else {
        this.send({ k: "res", id: message.id, ok: true, r: result });
      }
    } catch (error) {
      if (this.ended) return;
      this.send({ k: "res", id: message.id, ok: false, e: serializeRpcFailure(error, "internal") });
    } finally {
      this.inflight.delete(message.id);
    }
  }

  /** Pump a local stream to the peer under its credit window. Returns the stream id. */
  private sendStream(source: ReadableStream<Uint8Array>): number {
    const id = this.nextStream;
    this.nextStream += 2;
    const stream: OutgoingStream = {
      reader: source.getReader(),
      credit: STREAM_WINDOW_CHUNKS,
      wake: null,
      stopped: false,
    };
    this.outgoing.set(id, stream);
    void this.pump(id, stream);
    return id;
  }

  private async pump(id: number, stream: OutgoingStream): Promise<void> {
    try {
      for (;;) {
        while (stream.credit <= 0 && !stream.stopped) {
          await new Promise<void>((resolve) => {
            stream.wake = resolve;
          });
          stream.wake = null;
        }
        if (stream.stopped) {
          await stream.reader
            .cancel(new Error("Stream stopped by its reader"))
            .catch(() => undefined);
          return;
        }
        const next = await stream.reader.read();
        if (this.ended || stream.stopped) {
          if (!next.done) await stream.reader.cancel().catch(() => undefined);
          return;
        }
        if (next.done) {
          this.send({ k: "end", s: id });
          return;
        }
        stream.credit -= 1;
        this.send({ k: "data", s: id, d: next.value });
      }
    } catch (error) {
      if (!this.ended) this.send({ k: "abort", s: id, e: serializeRpcFailure(error, "internal") });
    } finally {
      this.outgoing.delete(id);
      try {
        stream.reader.releaseLock();
      } catch {
        // A pending read keeps the lock; the stream is discarded with the entry.
      }
    }
  }

  private receiveStream(id: number): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.incoming.set(id, { controller });
        },
        pull: () => {
          // The consumer asked for another chunk: grant the sender one more.
          if (!this.incoming.has(id) || this.ended) return;
          this.send({ k: "credit", s: id, n: 1 });
        },
        cancel: () => {
          if (!this.incoming.delete(id) || this.ended) return;
          this.send({ k: "stop", s: id });
        },
      },
      { highWaterMark: 0 }
    );
  }
}

/** One end of an in-memory port pair, with `MessagePortMain` semantics. */
class InMemoryPort implements MessagePortLike {
  peer: InMemoryPort | null = null;
  private readonly messageListeners = new Set<
    (event: { data: unknown; ports: MessagePortLike[] }) => void
  >();
  private readonly closeListeners = new Set<() => void>();
  private queue: { data: unknown; ports: MessagePortLike[] }[] = [];
  private started = false;
  private closed = false;

  postMessage(message: unknown, transfer?: MessagePortLike[]): void {
    const peer = this.peer;
    if (this.closed || !peer || peer.closed) return;
    peer.deliver({ data: structuredClone(message), ports: transfer ?? [] });
  }

  private deliver(event: { data: unknown; ports: MessagePortLike[] }): void {
    if (!this.started) this.queue.push(event);
    else queueMicrotask(() => this.messageListeners.forEach((listener) => listener(event)));
  }

  on(event: "message" | "close", listener: never): this {
    if (event === "message") this.messageListeners.add(listener);
    else this.closeListeners.add(listener);
    return this;
  }

  start(): void {
    this.started = true;
    for (const event of this.queue.splice(0)) this.deliver(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeListeners.forEach((listener) => listener());
    const peer = this.peer;
    if (peer && !peer.closed) {
      peer.closed = true;
      queueMicrotask(() => peer.closeListeners.forEach((listener) => listener()));
    }
  }
}

/** Two connected in-memory ports, for tests and for in-process composition. */
export function createMessagePortPair(): [MessagePortLike, MessagePortLike] {
  const a = new InMemoryPort();
  const b = new InMemoryPort();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
