import type { RpcConnectionStatus, RpcEnvelope, RpcStreamTrafficClass } from "../types.js";
import type { DecodedFramedStream } from "../protocol/streamCodec.js";
import type { IrohClientPipe, IrohClientSession, IrohClientSessionOptions } from "./irohClient.js";
import type { IrohConnectionDiagnostics } from "@vibestudio/iroh-transport";
import { SESSION_CONNECTION_LOST_CODE } from "../protocol/remoteSession.js";

export interface ReconnectingIrohPipeOptions {
  peerEndpointId: string;
  dial(): Promise<IrohClientPipe>;
  closeEndpoint(): Promise<void>;
  suspendEndpoint?(): Promise<void>;
  minRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  random?: () => number;
  onReconnectAttempt?(attempt: number, delayMs: number): void;
  onReconnectResult?(result: { attempt: number; success: boolean; error?: Error }): void;
}

export interface IrohReconnectProgress {
  attempt: number;
  phase: "scheduled" | "failed";
  reason: string;
  nextRetryInMs?: number;
}

export interface LifecycleIrohClientPipe extends IrohClientPipe {
  suspend(): Promise<void>;
  resume(): Promise<void>;
  onReconnectProgress(handler: (progress: IrohReconnectProgress) => void): () => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

function workspaceServerUnavailableError(): Error & { code: string; errorKind: "transport" } {
  return Object.assign(new Error("Workspace server is temporarily unavailable"), {
    code: SESSION_CONNECTION_LOST_CODE,
    errorKind: "transport" as const,
  });
}

class ReconnectingSession implements IrohClientSession {
  readonly sid: string;
  private inner: IrohClientSession | null = null;
  private activation: Promise<IrohClientSession> | null = null;
  private generation = 0;
  private closed = false;
  private terminal = false;
  private authenticatedCallerId: string | null = null;
  private readonly messageListeners = new Set<(envelope: RpcEnvelope) => void>();
  private readonly statusListeners = new Set<(status: RpcConnectionStatus) => void>();

  constructor(
    private readonly owner: ReconnectingPipe,
    private readonly options: IrohClientSessionOptions
  ) {
    this.sid = options.sid ?? options.connectionId ?? crypto.randomUUID();
  }

  callerId(): string | null {
    return this.authenticatedCallerId;
  }

  isClosed(): boolean {
    return this.closed || this.terminal;
  }

  status(): RpcConnectionStatus {
    if (this.closed || this.terminal) return "disconnected";
    return this.owner.status();
  }

  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
    this.statusListeners.add(handler);
    return () => this.statusListeners.delete(handler);
  }

  onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
    this.messageListeners.add(handler);
    return () => this.messageListeners.delete(handler);
  }

  ready(): Promise<void> {
    return this.ensureInner().then(() => undefined);
  }

  async send(envelope: RpcEnvelope, signal?: AbortSignal): Promise<void> {
    return (await this.requireAvailableInner()).send(envelope, signal);
  }

  async stream(
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null,
    headTimeoutMs?: number,
    trafficClass?: RpcStreamTrafficClass
  ): Promise<Response> {
    const inner = await this.requireAvailableInner();
    if (!inner.stream) throw new Error("Iroh session does not implement streaming RPC");
    return inner.stream(envelope, signal, body, headTimeoutMs, trafficClass);
  }

  async streamReadable(
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null,
    headTimeoutMs?: number,
    trafficClass?: RpcStreamTrafficClass
  ): Promise<DecodedFramedStream> {
    const inner = await this.requireAvailableInner();
    if (!inner.streamReadable)
      throw new Error("Iroh session does not implement readable streaming");
    return inner.streamReadable(envelope, signal, body, headTimeoutMs, trafficClass);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.owner.removeSession(this);
    const inner = this.inner;
    this.inner = null;
    this.activation = null;
    await inner?.close().catch(() => undefined);
    this.emitStatus("disconnected");
  }

  invalidate(generation: number): void {
    if (generation !== this.generation) return;
    this.inner = null;
    this.activation = null;
    if (!this.closed && !this.terminal) this.emitStatus("connecting");
  }

  activate(pipe: IrohClientPipe, generation: number): Promise<IrohClientSession> {
    if (this.closed) return Promise.reject(new Error(`Iroh session ${this.sid} is closed`));
    if (this.terminal) return Promise.reject(new Error(`Iroh session ${this.sid} is terminal`));
    if (this.inner && this.generation === generation) return Promise.resolve(this.inner);
    if (this.activation && this.generation === generation) return this.activation;
    this.generation = generation;
    this.activation = this.openInner(pipe, generation).catch((error) => {
      if (this.generation === generation) {
        this.inner = null;
        this.activation = null;
      }
      throw error;
    });
    return this.activation;
  }

  private async ensureInner(): Promise<IrohClientSession> {
    if (this.closed) throw new Error(`Iroh session ${this.sid} is closed`);
    if (this.terminal) throw new Error(`Iroh session ${this.sid} is terminal`);
    const { pipe, generation } = await this.owner.ensureConnected();
    return this.activate(pipe, generation);
  }

  /**
   * Initial authentication may wait for the first dial, but operations on a
   * previously-live session must never queue behind the unbounded reconnect
   * loop. The logical session remains desired and is reopened automatically;
   * callers get one typed, retryable availability failure for work attempted
   * during the outage.
   */
  private requireAvailableInner(): Promise<IrohClientSession> {
    if (this.closed) return Promise.reject(new Error(`Iroh session ${this.sid} is closed`));
    if (this.terminal) return Promise.reject(new Error(`Iroh session ${this.sid} is terminal`));
    if (this.authenticatedCallerId !== null && this.owner.status() !== "connected") {
      return Promise.reject(workspaceServerUnavailableError());
    }
    if (this.inner && this.generation === this.owner.generation()) {
      return Promise.resolve(this.inner);
    }
    return this.ensureInner();
  }

  private async openInner(pipe: IrohClientPipe, generation: number): Promise<IrohClientSession> {
    let terminalError: Error | null = null;
    const inner = pipe.openSession({
      ...this.options,
      sid: this.sid,
      onTerminalClose: (error) => {
        terminalError = error;
        this.terminal = true;
        this.options.onTerminalClose?.(error);
        this.emitStatus("disconnected");
      },
    });
    inner.onMessage((envelope) => {
      if (this.generation !== generation) return;
      for (const listener of [...this.messageListeners]) listener(envelope);
    });
    await inner.ready?.();
    if (terminalError) throw terminalError;
    if (this.closed || this.generation !== generation || this.owner.generation() !== generation) {
      await inner.close().catch(() => undefined);
      throw new Error(`Iroh session ${this.sid} opened on a stale connection generation`);
    }
    this.inner = inner;
    this.authenticatedCallerId = inner.callerId();
    this.emitStatus("connected");
    return inner;
  }

  private emitStatus(status: RpcConnectionStatus): void {
    for (const listener of [...this.statusListeners]) listener(status);
  }
}

interface ConnectedGeneration {
  pipe: IrohClientPipe;
  generation: number;
}

class ReconnectingPipe implements IrohClientPipe {
  readonly peerEndpointId: string;
  private readonly sessions = new Set<ReconnectingSession>();
  private readonly statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  private readonly reconnectListeners = new Set<(progress: IrohReconnectProgress) => void>();
  private connected: ConnectedGeneration | null = null;
  private connecting: Promise<ConnectedGeneration> | null = null;
  private statusValue: RpcConnectionStatus = "connecting";
  private generationValue = 0;
  private closed = false;
  private suspended = false;

  constructor(private readonly options: ReconnectingIrohPipeOptions) {
    this.peerEndpointId = options.peerEndpointId;
  }

  generation(): number {
    return this.generationValue;
  }

  status(): RpcConnectionStatus {
    return this.closed ? "disconnected" : this.statusValue;
  }

  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
    this.statusListeners.add(handler);
    return () => this.statusListeners.delete(handler);
  }

  onReconnectProgress(handler: (progress: IrohReconnectProgress) => void): () => void {
    this.reconnectListeners.add(handler);
    return () => this.reconnectListeners.delete(handler);
  }

  diagnostics(): IrohConnectionDiagnostics | null {
    return this.connected?.pipe.diagnostics() ?? null;
  }

  ready(): Promise<void> {
    return this.ensureConnected().then(() => undefined);
  }

  async suspend(): Promise<void> {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    const connected = this.connected;
    this.connected = null;
    this.setStatus("disconnected");
    if (connected) {
      for (const session of this.sessions) session.invalidate(connected.generation);
      await connected.pipe.close().catch(() => undefined);
    }
    await this.options.suspendEndpoint?.();
  }

  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    this.setStatus("connecting");
    await this.ensureConnected();
  }

  openSession(options: IrohClientSessionOptions): IrohClientSession {
    const session = new ReconnectingSession(this, options);
    if ([...this.sessions].some((candidate) => candidate.sid === session.sid)) {
      throw new Error(`Iroh session ${session.sid} already exists`);
    }
    this.sessions.add(session);
    return session;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.suspended = false;
    this.setStatus("disconnected");
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
    const pipe = this.connected?.pipe;
    this.connected = null;
    await pipe?.close().catch(() => undefined);
    await this.options.closeEndpoint();
    await this.connecting?.catch(() => undefined);
  }

  removeSession(session: ReconnectingSession): void {
    this.sessions.delete(session);
  }

  ensureConnected(): Promise<ConnectedGeneration> {
    if (this.closed) return Promise.reject(new Error("Iroh reconnect owner is closed"));
    if (this.suspended) return Promise.reject(new Error("Iroh reconnect owner is suspended"));
    if (this.connected?.pipe.status() === "connected") return Promise.resolve(this.connected);
    return (this.connecting ??= this.connectLoop().finally(() => {
      this.connecting = null;
    }));
  }

  private async connectLoop(): Promise<ConnectedGeneration> {
    const minimum = this.options.minRetryDelayMs ?? 200;
    const maximum = this.options.maxRetryDelayMs ?? 5_000;
    const random = this.options.random ?? Math.random;
    let attempt = 0;
    while (!this.closed && !this.suspended) {
      attempt += 1;
      const baseDelay = Math.min(maximum, minimum * 2 ** Math.min(attempt - 1, 8));
      const retryDelay = Math.max(1, Math.round(baseDelay * (0.75 + random() * 0.5)));
      if (attempt > 1) {
        this.options.onReconnectAttempt?.(attempt, retryDelay);
        this.emitReconnect({
          attempt,
          phase: "scheduled",
          reason: "physical Iroh connection closed",
          nextRetryInMs: retryDelay,
        });
        await delay(retryDelay);
      }
      if (this.closed || this.suspended) break;
      try {
        const pipe = await this.options.dial();
        await pipe.ready();
        if (this.closed) {
          await pipe.close();
          break;
        }
        const generation = ++this.generationValue;
        const connected = { pipe, generation };
        this.connected = connected;
        pipe.onStatusChange((status) => {
          if (status === "disconnected") this.invalidate(connected);
        });
        this.setStatus("connected");
        this.options.onReconnectResult?.({ attempt, success: true });
        await Promise.allSettled(
          [...this.sessions].map((session) => session.activate(pipe, generation))
        );
        return connected;
      } catch (error) {
        const failure = asError(error);
        this.options.onReconnectResult?.({ attempt, success: false, error: failure });
        this.emitReconnect({
          attempt,
          phase: "failed",
          reason: failure.message,
        });
        this.setStatus("connecting");
      }
    }
    throw new Error(
      this.suspended
        ? "Iroh reconnect owner suspended while connecting"
        : "Iroh reconnect owner closed while connecting"
    );
  }

  private invalidate(connected: ConnectedGeneration): void {
    if (this.connected !== connected || this.closed) return;
    this.connected = null;
    this.setStatus("connecting");
    this.emitReconnect({
      attempt: 1,
      phase: "scheduled",
      reason: "physical Iroh connection closed",
      nextRetryInMs: 0,
    });
    for (const session of this.sessions) session.invalidate(connected.generation);
    void connected.pipe.close().catch(() => undefined);
    if (this.sessions.size > 0) void this.ensureConnected().catch(() => undefined);
  }

  private setStatus(status: RpcConnectionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private emitReconnect(progress: IrohReconnectProgress): void {
    for (const listener of [...this.reconnectListeners]) listener(progress);
  }
}

export function createReconnectingIrohClientPipe(
  options: ReconnectingIrohPipeOptions
): LifecycleIrohClientPipe {
  return new ReconnectingPipe(options);
}
