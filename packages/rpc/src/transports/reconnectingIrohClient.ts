import type { RpcConnectionStatus, RpcEnvelope, RpcStreamTrafficClass } from "../types.js";
import type { DecodedFramedStream } from "../protocol/streamCodec.js";
import type { IrohClientPipe, IrohClientSession, IrohClientSessionOptions } from "./irohClient.js";
import type { IrohConnectionDiagnostics } from "@vibestudio/iroh-transport";
import { SESSION_CONNECTION_LOST_CODE } from "../protocol/remoteSession.js";
import { secureRandomUuid } from "../randomId.js";
import { RpcBoundaryError } from "../errors.js";

/** Cancel one waiter while its shared session/connection remains owned. */
function waitForSharedOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => {
      signal.removeEventListener("abort", cancelled);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancelled, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", cancelled);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancelled);
        reject(error);
      }
    );
    if (signal.aborted) cancelled();
  });
}

export interface ReconnectingIrohPipeOptions {
  peerEndpointId: string;
  dial(): Promise<IrohClientPipe>;
  closeEndpoint(): Promise<void>;
  suspendEndpoint?(): Promise<void>;
  minRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  random?: () => number;
  /** Clock for judging how long a connection stood up. */
  now?: () => number;
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
  invalidateEndpointGeneration(generation: number, reason: string): void;
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

interface SessionActivation {
  authenticated: Promise<IrohClientSession>;
  recovered: Promise<IrohClientSession>;
}

interface AuthenticatedSession {
  inner: IrohClientSession;
  recovery: Parameters<NonNullable<IrohClientSessionOptions["onRecovery"]>>[0] | undefined;
  retireOnFailure(error: unknown): Promise<never>;
}

class ReconnectingSession implements IrohClientSession {
  private readonly logicalId = secureRandomUuid();
  private inner: IrohClientSession | null = null;
  private activation: SessionActivation | null = null;
  private generation = 0;
  private closed = false;
  private terminal = false;
  private readonly retirement = new AbortController();
  private closePromise: Promise<void> | null = null;
  private readonly acquired = new Set<{ generation: number; close(): Promise<void> }>();
  private readonly activations = new Set<Promise<IrohClientSession>>();
  private authenticatedCallerId: string | null = null;
  private readonly messageListeners = new Set<(envelope: RpcEnvelope) => void>();
  private readonly statusListeners = new Set<(status: RpcConnectionStatus) => void>();

  constructor(
    private readonly owner: ReconnectingPipe,
    private readonly options: IrohClientSessionOptions
  ) {}

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
    return this.ensureActivation().then(async (activation) => {
      await activation.recovered;
    });
  }

  async send(envelope: RpcEnvelope, signal?: AbortSignal): Promise<void> {
    return (await this.requireAvailableInner(signal)).send(envelope, signal);
  }

  async stream(
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null,
    headTimeoutMs?: number,
    trafficClass?: RpcStreamTrafficClass
  ): Promise<Response> {
    const inner = await this.requireAvailableInner(signal);
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
    const inner = await this.requireAvailableInner(signal);
    if (!inner.streamReadable)
      throw new Error("Iroh session does not implement readable streaming");
    return inner.streamReadable(envelope, signal, body, headTimeoutMs, trafficClass);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.retirement.abort(
      new RpcBoundaryError(
        `Iroh session ${this.logicalId} is closed`,
        "transport",
        SESSION_CONNECTION_LOST_CODE
      )
    );
    this.owner.removeSession(this);
    this.inner = null;
    this.activation = null;
    const retiring = [...this.acquired].map((inner) => inner.close());
    this.closePromise = (async () => {
      const results = await Promise.allSettled(retiring);
      await Promise.allSettled([...this.activations]);
      this.emitStatus("disconnected");
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length) throw new AggregateError(errors, "Iroh session cleanup failed");
    })();
    return this.closePromise;
  }

  invalidate(generation: number): void {
    if (generation !== this.generation) return;
    this.inner = null;
    this.activation = null;
    for (const inner of this.acquired) {
      if (inner.generation === generation) {
        // Keep failed cleanup owned so close() reports it; successful
        // retirement releases the old generation immediately.
        void inner.close().catch(() => undefined);
      }
    }
    if (!this.closed && !this.terminal) this.emitStatus("connecting");
  }

  async activate(pipe: IrohClientPipe, generation: number): Promise<IrohClientSession> {
    return this.acquireActivation(pipe, generation).recovered;
  }

  private acquireActivation(pipe: IrohClientPipe, generation: number): SessionActivation {
    if (this.closed) throw new Error(`Iroh session ${this.logicalId} is closed`);
    if (this.terminal) throw new Error(`Iroh session ${this.logicalId} is terminal`);
    if (this.activation && this.generation === generation) return this.activation;
    this.generation = generation;
    const opening = this.openInner(pipe, generation);
    const authenticated = opening.then(({ inner }) => inner);
    // The recovery receipt owns the same authentication failure, even when no
    // request is waiting for the authentication receipt yet.
    void authenticated.catch(() => undefined);
    const recovered = opening
      .then(async (receipt) => {
        try {
          if (receipt.recovery !== undefined) await this.options.onRecovery?.(receipt.recovery);
          return receipt.inner;
        } catch (error) {
          return receipt.retireOnFailure(error);
        }
      })
      .catch((error) => {
        if (this.generation === generation) {
          this.inner = null;
          this.activation = null;
        }
        throw error;
      });
    this.activation = { authenticated, recovered };
    this.activations.add(recovered);
    void recovered.then(
      () => this.activations.delete(recovered),
      () => this.activations.delete(recovered)
    );
    return this.activation;
  }

  private async ensureActivation(): Promise<SessionActivation> {
    if (this.closed) throw new Error(`Iroh session ${this.logicalId} is closed`);
    if (this.terminal) throw new Error(`Iroh session ${this.logicalId} is terminal`);
    // This waiter belongs to the logical session. The shared physical dial
    // stays owned by the pipe and can serve other sessions after this closes.
    const { pipe, generation } = await waitForSharedOperation(
      this.owner.ensureConnected(),
      this.retirement.signal
    );
    return this.acquireActivation(pipe, generation);
  }

  /**
   * Initial authentication may wait for the first dial, but operations on a
   * previously-live session must never queue behind the unbounded reconnect
   * loop. The logical session remains desired and is reopened automatically;
   * callers get one typed, retryable availability failure for work attempted
   * during the outage.
   */
  private requireAvailableInner(signal?: AbortSignal | null): Promise<IrohClientSession> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error(`Iroh session ${this.logicalId} is closed`));
    if (this.terminal)
      return Promise.reject(new Error(`Iroh session ${this.logicalId} is terminal`));
    if (this.authenticatedCallerId !== null && this.owner.status() !== "connected") {
      return Promise.reject(workspaceServerUnavailableError());
    }
    const availability =
      this.inner && this.generation === this.owner.generation()
        ? Promise.resolve(this.inner)
        : this.ensureActivation().then((activation) => activation.authenticated);
    return signal ? waitForSharedOperation(availability, signal) : availability;
  }

  private async openInner(pipe: IrohClientPipe, generation: number): Promise<AuthenticatedSession> {
    let terminalError: Error | null = null;
    let recovery: Parameters<NonNullable<IrohClientSessionOptions["onRecovery"]>>[0] | undefined;
    const inner = pipe.openSession({
      ...this.options,
      // Recovery replay can call this same logical session. Capture the
      // authentication result until its validated inner session is installed.
      onRecovery: (kind) => {
        recovery = kind;
      },
      onTerminalClose: (error) => {
        terminalError = error;
        this.terminal = true;
        this.options.onTerminalClose?.(error);
        this.emitStatus("disconnected");
      },
    });
    // Acquisition precedes authentication. Shutdown must be able to revoke
    // this owner while ready() is still waiting for the server's result.
    let closing: Promise<void> | null = null;
    const acquired = {
      generation,
      close: () =>
        (closing ??= inner.close().then(() => {
          this.acquired.delete(acquired);
        })),
    };
    this.acquired.add(acquired);
    const retireOnFailure = async (error: unknown): Promise<never> => {
      await acquired.close().catch((cleanupError: unknown) => {
        throw new AggregateError([error, cleanupError], "Iroh session opening and cleanup failed");
      });
      throw error;
    };
    inner.onMessage((envelope) => {
      if (this.generation !== generation) return;
      for (const listener of [...this.messageListeners]) listener(envelope);
    });
    try {
      await inner.ready?.();
      if (terminalError) throw terminalError;
      if (this.closed || this.generation !== generation || this.owner.generation() !== generation)
        throw new Error(`Iroh session ${this.logicalId} opened on a stale connection generation`);
      this.inner = inner;
      this.authenticatedCallerId = inner.callerId();
      this.emitStatus("connected");
      return { inner, recovery, retireOnFailure };
    } catch (error) {
      return retireOnFailure(error);
    }
  }

  private emitStatus(status: RpcConnectionStatus): void {
    for (const listener of [...this.statusListeners]) listener(status);
  }
}

interface ConnectedGeneration {
  pipe: IrohClientPipe;
  generation: number;
  disposeObservers(): void;
}

class ReconnectingPipe implements IrohClientPipe {
  readonly peerEndpointId: string;
  private readonly sessions = new Set<ReconnectingSession>();
  private readonly retiringPipes = new Set<Promise<void>>();
  private readonly statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  private readonly reconnectListeners = new Set<(progress: IrohReconnectProgress) => void>();
  private readonly diagnosticsListeners = new Set<
    (diagnostics: IrohConnectionDiagnostics | null) => void
  >();
  private connected: ConnectedGeneration | null = null;
  private connecting: Promise<ConnectedGeneration> | null = null;
  private statusValue: RpcConnectionStatus = "connecting";
  private generationValue = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private suspended = false;
  /**
   * Reconnection is a property of a session that has actually connected.
   * Before that point, callers are waiting for an initial acquisition and must
   * receive its bounded failure so startup can present recovery instead of
   * disappearing into this pipe's background retry loop.
   */
  private hasConnected = false;
  /**
   * Consecutive dial attempts since the last connection that stood up.
   *
   * The retry budget belongs to the pipe, not to one run of `connectLoop`.
   * While it was a local counter, every invalidation started a fresh loop at
   * attempt one — which has no delay — so a connection that died right after
   * it was established was redialed instantly, forever, and the backoff the
   * loop computes never applied to the one case it was needed for.
   */
  private retryAttempts = 0;
  /** When the live connection was installed, or null while there is none. */
  private connectedSince: number | null = null;

  constructor(private readonly options: ReconnectingIrohPipeOptions) {
    this.peerEndpointId = options.peerEndpointId;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * How long a connection has to last to count as having worked.
   *
   * The retry ceiling is the natural scale: a link that outlived the longest
   * wait this pipe would ever impose between dials was not a failed attempt,
   * so the drop that ends it starts its own count and is redialed at once. One
   * that dies sooner is exactly the flap the backoff exists for.
   */
  private durableConnectionMs(): number {
    return this.options.maxRetryDelayMs ?? 5_000;
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

  onDiagnosticsChange(
    handler: (diagnostics: IrohConnectionDiagnostics | null) => void
  ): () => void {
    this.diagnosticsListeners.add(handler);
    handler(this.diagnostics());
    return () => this.diagnosticsListeners.delete(handler);
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
    this.connectedSince = null;
    // Suspension is a decision, not a failure, so resuming dials at once.
    this.retryAttempts = 0;
    connected?.disposeObservers();
    const physical = connected ? this.retirePipe(connected.pipe) : undefined;
    this.emitDiagnostics();
    this.setStatus("disconnected");
    if (connected) {
      for (const session of this.sessions) session.invalidate(connected.generation);
    }
    const results = await Promise.allSettled([
      physical,
      Promise.resolve().then(() => this.options.suspendEndpoint?.()),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length) throw new AggregateError(errors, "Iroh suspension cleanup failed");
  }

  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    this.setStatus("connecting");
    await this.ensureConnected();
  }

  invalidateEndpointGeneration(generation: number, reason: string): void {
    if (this.closed || this.suspended) return;
    const connected = this.connected;
    if (!connected || connected.pipe.diagnostics()?.endpointGeneration !== generation) return;
    this.invalidate(connected, reason);
  }

  openSession(options: IrohClientSessionOptions): IrohClientSession {
    const session = new ReconnectingSession(this, options);
    this.sessions.add(session);
    return session;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.suspended = false;
    // Cache the retirement before notifying observers, which can re-enter close.
    return (this.closePromise = Promise.resolve().then(async () => {
      const sessions = [...this.sessions];
      this.sessions.clear();
      const connected = this.connected;
      this.connected = null;
      connected?.disposeObservers();
      if (connected) this.retirePipe(connected.pipe);
      this.setStatus("disconnected");
      this.emitDiagnostics();
      // Physical retirement releases session I/O and a pending dial. Start
      // every owned close before joining any of those dependent operations.
      const retirements = [
        ...this.retiringPipes,
        Promise.resolve().then(() => this.options.closeEndpoint()),
        ...sessions.map((session) => Promise.resolve().then(() => session.close())),
      ];
      const results = await Promise.allSettled(retirements);
      await this.connecting?.catch(() => undefined);
      // A dial admitted before shutdown can hand back a late physical pipe.
      // Successful retirements release themselves; failed ones stay owned.
      const physicalResults = await Promise.allSettled([...this.retiringPipes]);
      this.diagnosticsListeners.clear();
      this.statusListeners.clear();
      this.reconnectListeners.clear();
      const errors = [
        ...new Set(
          [...results, ...physicalResults].flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
          )
        ),
      ];
      if (errors.length) throw new AggregateError(errors, "Iroh pipe cleanup failed");
    }));
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
    while (!this.closed && !this.suspended) {
      const attempt = (this.retryAttempts += 1);
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
          await this.retirePipe(pipe);
          break;
        }
        const generation = ++this.generationValue;
        // A dial can be answered and then dropped before this attempt has
        // finished installing it. `invalidate` recognizes the live connection
        // by identity, so a drop arriving that early had nothing to match and
        // was discarded — and the attempt went on to publish the dead pipe as
        // connected, leaving a session that believes it can send. Hold the
        // observation until there is something to apply it to.
        let connected: ConnectedGeneration | null = null;
        let droppedBeforeInstalled = false;
        const unsubscribeStatus = pipe.onStatusChange((status) => {
          if (status !== "disconnected") return;
          if (!connected) {
            droppedBeforeInstalled = true;
            return;
          }
          this.invalidate(connected, "physical Iroh connection closed");
        });
        const unsubscribeDiagnostics = pipe.onDiagnosticsChange(() => this.emitDiagnostics());
        connected = {
          pipe,
          generation,
          disposeObservers: () => {
            unsubscribeStatus();
            unsubscribeDiagnostics();
          },
        };
        if (droppedBeforeInstalled) {
          // Never reached "connected", so this is a failed attempt like any
          // other: keep the loop's backoff rather than announcing a connection
          // and immediately retracting it.
          connected.disposeObservers();
          await this.retirePipe(pipe).catch(() => undefined);
          const failure = new Error("physical Iroh connection closed before it was installed");
          this.options.onReconnectResult?.({
            attempt,
            success: false,
            error: failure,
          });
          this.emitReconnect({
            attempt,
            phase: "failed",
            reason: "physical Iroh connection closed before it was installed",
          });
          this.setStatus("connecting");
          if (!this.hasConnected) throw failure;
          continue;
        }
        this.connected = connected;
        this.hasConnected = true;
        this.connectedSince = this.now();
        this.emitDiagnostics();
        this.setStatus("connected");
        this.options.onReconnectResult?.({ attempt, success: true });
        // Physical readiness releases logical authentication waiters. Logical
        // recovery owns its own receipt and can use those authenticated sessions.
        // Waiting for replay here would make replay depend on its own readiness.
        for (const session of this.sessions)
          void session.activate(pipe, generation).catch(() => undefined);
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
        if (!this.hasConnected) throw failure;
      }
    }
    throw new Error(
      this.suspended
        ? "Iroh reconnect owner suspended while connecting"
        : "Iroh reconnect owner closed while connecting"
    );
  }

  private invalidate(connected: ConnectedGeneration, reason: string): void {
    if (this.connected !== connected || this.closed) return;
    this.connected = null;
    const heldForMs = this.connectedSince === null ? 0 : this.now() - this.connectedSince;
    this.connectedSince = null;
    if (heldForMs >= this.durableConnectionMs()) this.retryAttempts = 0;
    connected.disposeObservers();
    // Retire the native generation before notifying logical observers. Those
    // callbacks can synchronously close a session; they must not issue control
    // writes on the generation this owner has already invalidated.
    this.retirePipe(connected.pipe);
    this.emitDiagnostics();
    this.setStatus("connecting");
    this.emitReconnect({
      attempt: this.retryAttempts + 1,
      phase: "scheduled",
      reason,
      // The loop announces its own delay once it has one; only the redial that
      // happens immediately can say so here.
      ...(this.retryAttempts === 0 ? { nextRetryInMs: 0 } : {}),
    });
    for (const session of this.sessions) session.invalidate(connected.generation);
    if (this.sessions.size > 0) void this.ensureConnected().catch(() => undefined);
  }

  private retirePipe(pipe: IrohClientPipe): Promise<void> {
    let retirement: Promise<void>;
    try {
      retirement = pipe.close();
    } catch (error) {
      retirement = Promise.reject(error);
    }
    this.retiringPipes.add(retirement);
    void retirement.then(
      () => this.retiringPipes.delete(retirement),
      () => undefined
    );
    return retirement;
  }

  private setStatus(status: RpcConnectionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private emitReconnect(progress: IrohReconnectProgress): void {
    for (const listener of [...this.reconnectListeners]) listener(progress);
  }

  private emitDiagnostics(): void {
    const diagnostics = this.diagnostics();
    for (const listener of [...this.diagnosticsListeners]) listener(diagnostics);
  }
}

export function createReconnectingIrohClientPipe(
  options: ReconnectingIrohPipeOptions
): LifecycleIrohClientPipe {
  return new ReconnectingPipe(options);
}
