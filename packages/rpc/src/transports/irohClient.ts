import {
  decodeJsonFrame,
  IROH_WIRE_VERSION,
  MAX_ACTIVE_REQUESTS_PER_SESSION,
  MAX_CONTROL_FRAME_BYTES,
  MAX_ENVELOPE_FRAME_BYTES,
  MAX_PENDING_STREAM_ADMISSIONS,
  MAX_STREAM_CHUNK_BYTES,
  readFrame,
  readIrohStreamPreamble,
  readToEnd,
  writeChunked,
  writeFrame,
  writeIrohStreamPreamble,
  type IrohPhysicalBiStream,
  type IrohPhysicalConnection,
  type IrohConnectionDiagnostics,
  type IrohPhysicalReceiveStream,
} from "@vibestudio/iroh-transport";
import type {
  EnvelopeRpcTransport,
  RpcConnectionStatus,
  RpcEnvelope,
  RpcRequestCancel,
  RpcResponse,
  RpcStreamCancel,
  RpcStreamTrafficClass,
} from "../types.js";
import type { DecodedFramedStream } from "../protocol/streamCodec.js";
import { decodeIrohStreamResponseHead } from "../protocol/irohStreamResponse.js";
import { RemoteRpcError } from "../errors.js";
import { RPC_CONTRACT_VERSION } from "../protocol/contractVersion.js";
import type { RecoveryKind } from "../protocol/recoveryCoordinator.js";
import {
  decodeIrohSessionControlFrame,
  encodeIrohSessionControlFrame,
  IROH_SESSION_CLOSE,
  IROH_SESSION_CLOSED,
  IROH_SESSION_HELLO,
  IROH_SESSION_OPEN,
  IROH_SESSION_OPEN_RESULT,
  type IrohSessionControlFrame,
  type IrohSessionOpenResultFrame,
} from "../protocol/irohSession.js";
import type {
  ClientPlatform,
  DeviceCredential,
  OAuthCallbackMode,
  PairingContext,
} from "../protocol/wsProtocol.js";

const IROH_PROTOCOL_CLOSE_CODE = 0x200n;
const IROH_SESSION_CLOSE_CODE = 0x201n;
const IROH_CANCEL_CODE = 0x202n;
const IROH_STREAM_ADMISSION_TIMEOUT_MS = 10_000;

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `iroh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertEnvelope(value: unknown): asserts value is RpcEnvelope {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { from?: unknown }).from !== "string" ||
    typeof (value as { target?: unknown }).target !== "string" ||
    !(value as { message?: unknown }).message ||
    typeof (value as { message?: unknown }).message !== "object"
  ) {
    throw new Error("Malformed Iroh RPC envelope");
  }
}

function requestIdOf(envelope: RpcEnvelope): string | null {
  const message = envelope.message;
  return "requestId" in message && typeof message.requestId === "string" ? message.requestId : null;
}

class SerializedControlWriter {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly stream: IrohPhysicalBiStream["send"]) {}

  write(frame: IrohSessionControlFrame): Promise<void> {
    const operation = this.tail.then(() =>
      writeFrame(this.stream, encodeIrohSessionControlFrame(frame), MAX_CONTROL_FRAME_BYTES)
    );
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async finish(): Promise<void> {
    await this.tail;
    await this.stream.finish();
  }
}

export interface IrohClientSessionOptions {
  sid?: string;
  connectionId?: string;
  clientSessionId?: string;
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
  oauthCallbackMode?: OAuthCallbackMode;
  getToken(): string | Promise<string>;
  onPaired?(credential: DeviceCredential, context?: PairingContext): void | Promise<void>;
  onRecovery?(kind: RecoveryKind): void | Promise<void>;
  onTerminalClose?(error: Error): void;
}

export interface IrohClientSession extends EnvelopeRpcTransport {
  readonly sid: string;
  callerId(): string | null;
  isClosed(): boolean;
  close(): Promise<void>;
}

export interface IrohClientPipe {
  readonly peerEndpointId: string;
  ready(): Promise<void>;
  openSession(options: IrohClientSessionOptions): IrohClientSession;
  status(): RpcConnectionStatus;
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void;
  diagnostics(): IrohConnectionDiagnostics | null;
  onDiagnosticsChange(handler: (diagnostics: IrohConnectionDiagnostics | null) => void): () => void;
  close(): Promise<void>;
}

interface PendingOpen {
  resolve(frame: IrohSessionOpenResultFrame): void;
  reject(error: Error): void;
}

interface InboundRequest {
  stream: IrohPhysicalBiStream;
  settled: boolean;
}

class ClientSession implements IrohClientSession {
  readonly sid: string;
  private readonly listeners = new Set<(envelope: RpcEnvelope) => void>();
  private readonly statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  private readonly inboundRequests = new Map<string, InboundRequest>();
  private readonly outboundRequests = new Map<string, IrohPhysicalBiStream>();
  private openPromise: Promise<void> | null = null;
  private authenticatedCallerId: string | null = null;
  private lastServerBootId: string | null = null;
  private terminal = false;

  constructor(
    private readonly pipe: ClientPipe,
    private readonly options: IrohClientSessionOptions
  ) {
    this.sid = options.sid ?? options.connectionId ?? randomId();
  }

  callerId(): string | null {
    return this.authenticatedCallerId;
  }

  isClosed(): boolean {
    return this.terminal;
  }

  activeRequestCount(): number {
    return this.inboundRequests.size + this.outboundRequests.size;
  }

  status(): RpcConnectionStatus {
    return this.terminal ? "disconnected" : this.pipe.status();
  }

  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
    this.statusListeners.add(handler);
    const unsubscribePipe = this.pipe.onStatusChange(handler);
    return () => {
      unsubscribePipe();
      this.statusListeners.delete(handler);
    };
  }

  ready(): Promise<void> {
    return (this.openPromise ??= this.open());
  }

  onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async send(envelope: RpcEnvelope, signal?: AbortSignal): Promise<void> {
    await this.ready();
    if (this.terminal) throw new Error(`Iroh session ${this.sid} is closed`);
    const requestId = requestIdOf(envelope);

    if (
      (envelope.message.type === "request-cancel" || envelope.message.type === "stream-cancel") &&
      requestId
    ) {
      await this.cancelOutbound(envelope.message);
      return;
    }
    if (envelope.message.type === "response" && requestId) {
      const inbound = this.inboundRequests.get(requestId);
      if (inbound) {
        await this.respondOnInboundStream(inbound, envelope);
        this.inboundRequests.delete(requestId);
        this.pipe.diagnosticsChanged();
        return;
      }
    }

    const stream = await this.pipe.connection.openBi();
    await writeIrohStreamPreamble(stream.send, {
      k: "envelope",
      sid: this.sid,
      v: IROH_WIRE_VERSION,
    });
    await writeFrame(
      stream.send,
      new TextEncoder().encode(JSON.stringify(envelope)),
      MAX_ENVELOPE_FRAME_BYTES
    );
    const expectsResponse =
      requestId !== null &&
      (envelope.message.type === "request" || envelope.message.type === "stream-request");
    if (!expectsResponse) await stream.send.finish();

    if (
      requestId &&
      (envelope.message.type === "request" || envelope.message.type === "stream-request")
    ) {
      this.outboundRequests.set(requestId, stream);
      this.pipe.diagnosticsChanged();
    }
    const abort = (): void => {
      void stream.send.reset(IROH_CANCEL_CODE).catch(() => undefined);
      void stream.recv.stop(IROH_CANCEL_CODE).catch(() => undefined);
      if (requestId && this.outboundRequests.delete(requestId)) this.pipe.diagnosticsChanged();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    void this.readResponses(stream, requestId).finally(() => {
      if (expectsResponse) void stream.send.finish().catch(() => undefined);
      signal?.removeEventListener("abort", abort);
      if (requestId && this.outboundRequests.delete(requestId)) this.pipe.diagnosticsChanged();
    });
  }

  async stream(
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null,
    headTimeoutMs?: number,
    _trafficClass: RpcStreamTrafficClass = "interactive"
  ): Promise<Response> {
    const decoded = await this.openStreamingRequest(envelope, signal, body, headTimeoutMs);
    const status = decoded.status >= 200 && decoded.status <= 599 ? decoded.status : 502;
    const nullBody = status === 204 || status === 205 || status === 304;
    const response = new Response(
      nullBody ? null : (decoded.body as unknown as ConstructorParameters<typeof Response>[0]),
      {
        status,
        statusText: decoded.statusText,
        headers: new Headers(decoded.headers),
      }
    );
    if (decoded.finalUrl) {
      Object.defineProperty(response, "url", { value: decoded.finalUrl, configurable: true });
    }
    return response;
  }

  async streamReadable(
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null,
    headTimeoutMs?: number,
    _trafficClass: RpcStreamTrafficClass = "interactive"
  ): Promise<DecodedFramedStream> {
    return this.openStreamingRequest(envelope, signal, body, headTimeoutMs);
  }

  async close(): Promise<void> {
    if (this.terminal) return;
    this.terminal = true;
    await this.pipe.writeControl({ t: IROH_SESSION_CLOSE, sid: this.sid, code: 1000 });
    this.failOutstanding(new Error(`Iroh session ${this.sid} closed`));
    this.pipe.removeSession(this.sid, this);
    for (const listener of this.statusListeners) listener("disconnected");
  }

  async acceptEnvelope(stream: IrohPhysicalBiStream, envelope: RpcEnvelope): Promise<void> {
    const requestId = requestIdOf(envelope);
    if (
      requestId &&
      (envelope.message.type === "request" || envelope.message.type === "stream-request")
    ) {
      if (this.inboundRequests.has(requestId)) {
        throw new Error(`Duplicate Iroh inbound request id ${requestId}`);
      }
      if (this.inboundRequests.size >= MAX_ACTIVE_REQUESTS_PER_SESSION) {
        throw new Error(`Iroh session ${this.sid} exceeded its active request bound`);
      }
      this.inboundRequests.set(requestId, { stream, settled: false });
      this.pipe.diagnosticsChanged();
    } else {
      await stream.send.finish().catch(() => undefined);
    }
    this.emit(envelope);
  }

  handleOpenResult(frame: IrohSessionOpenResultFrame): void {
    this.pipe.settleOpen(frame);
  }

  handleClosed(frame: Extract<IrohSessionControlFrame, { t: typeof IROH_SESSION_CLOSED }>): void {
    const error = Object.assign(
      new Error(frame.reason ?? `Iroh session ${this.sid} was closed by the server`),
      { code: frame.code }
    );
    this.failOutstanding(error);
    if (frame.terminal) {
      this.terminal = true;
      this.options.onTerminalClose?.(error);
      for (const listener of this.statusListeners) listener("disconnected");
    } else {
      this.openPromise = null;
      void this.ready().catch((openError) => this.options.onTerminalClose?.(asError(openError)));
    }
  }

  fail(error: Error): void {
    this.failOutstanding(error);
    this.openPromise = null;
  }

  private async open(): Promise<void> {
    await this.pipe.ready();
    const resultPromise = this.pipe.waitForOpen(this.sid);
    await this.pipe.writeControl({
      t: IROH_SESSION_OPEN,
      sid: this.sid,
      token: await this.options.getToken(),
      ...(this.options.connectionId ? { connectionId: this.options.connectionId } : {}),
      ...(this.options.clientSessionId ? { clientSessionId: this.options.clientSessionId } : {}),
      ...(this.options.clientLabel ? { clientLabel: this.options.clientLabel } : {}),
      ...(this.options.clientPlatform ? { clientPlatform: this.options.clientPlatform } : {}),
      ...(this.options.oauthCallbackMode
        ? { oauthCallbackMode: this.options.oauthCallbackMode }
        : {}),
    });
    const result = await resultPromise;
    if (!result.success) {
      this.terminal = result.terminal ?? true;
      throw Object.assign(new Error(result.error ?? "Iroh session authentication failed"), {
        code: result.errorCode,
      });
    }
    this.authenticatedCallerId = result.callerId ?? null;
    if (result.deviceCredential) {
      await this.options.onPaired?.(result.deviceCredential, result.pairingContext);
    }
    const recovery: RecoveryKind =
      this.lastServerBootId !== null && this.lastServerBootId !== result.serverBootId
        ? "cold-recover"
        : result.sessionDirty
          ? "cold-recover"
          : "resubscribe";
    this.lastServerBootId = result.serverBootId ?? this.lastServerBootId;
    await this.options.onRecovery?.(recovery);
  }

  private async respondOnInboundStream(
    inbound: InboundRequest,
    envelope: RpcEnvelope
  ): Promise<void> {
    if (inbound.settled) throw new Error("Iroh inbound RPC stream already settled");
    inbound.settled = true;
    await writeChunked(
      inbound.stream.send,
      new TextEncoder().encode(JSON.stringify(envelope)),
      MAX_STREAM_CHUNK_BYTES
    );
    await inbound.stream.send.finish();
  }

  private async cancelOutbound(message: RpcRequestCancel | RpcStreamCancel): Promise<void> {
    const stream = this.outboundRequests.get(message.requestId);
    if (!stream) return;
    this.outboundRequests.delete(message.requestId);
    this.pipe.diagnosticsChanged();
    await Promise.all([
      stream.send.reset(IROH_CANCEL_CODE).catch(() => undefined),
      stream.recv.stop(IROH_CANCEL_CODE).catch(() => undefined),
    ]);
  }

  private async openStreamingRequest(
    envelope: RpcEnvelope,
    signal?: AbortSignal | null,
    body?: ReadableStream<Uint8Array> | null,
    headTimeoutMs = 20_000
  ): Promise<DecodedFramedStream> {
    await this.ready();
    if (this.terminal) throw new Error(`Iroh session ${this.sid} is closed`);
    const request = envelope.message;
    if (request.type !== "stream-request") {
      throw new Error(`stream() requires a stream-request envelope, got ${request.type}`);
    }
    if (signal?.aborted) throw new Error("Streaming RPC aborted by caller");
    if (this.outboundRequests.has(request.requestId)) {
      throw new Error(`Streaming RPC request id ${request.requestId} is already active`);
    }

    const stream = await this.pipe.connection.openBi();
    this.outboundRequests.set(request.requestId, stream);
    this.pipe.diagnosticsChanged();
    let cancelled = false;
    const cancel = (reason?: unknown): void => {
      if (cancelled) return;
      cancelled = true;
      this.outboundRequests.delete(request.requestId);
      this.pipe.diagnosticsChanged();
      void stream.send.reset(IROH_CANCEL_CODE).catch(() => undefined);
      void stream.recv.stop(IROH_CANCEL_CODE).catch(() => undefined);
      if (body) void body.cancel(reason).catch(() => undefined);
    };
    const onAbort = (): void =>
      cancel((signal as (AbortSignal & { reason?: unknown }) | null | undefined)?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await writeIrohStreamPreamble(stream.send, {
        body: body != null,
        k: "stream",
        requestId: request.requestId,
        sid: this.sid,
        v: IROH_WIRE_VERSION,
      });
      await writeFrame(
        stream.send,
        new TextEncoder().encode(JSON.stringify(envelope)),
        MAX_ENVELOPE_FRAME_BYTES
      );
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      cancel(error);
      throw error;
    }

    void this.pumpRequestBody(stream, body, cancel).catch(cancel);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const head = await Promise.race([
      readFrame(stream.recv, MAX_ENVELOPE_FRAME_BYTES).then(decodeIrohStreamResponseHead),
      new Promise<never>((_, reject) => {
        if (!Number.isFinite(headTimeoutMs) || headTimeoutMs <= 0) return;
        timeout = setTimeout(
          () =>
            reject(
              new Error(`Iroh streaming response head not received within ${headTimeoutMs}ms`)
            ),
          headTimeoutMs
        );
        (timeout as unknown as { unref?: () => void }).unref?.();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if (head.error) {
      cancel(head.error.message);
      throw new RemoteRpcError(
        head.error.message,
        head.error.errorKind,
        head.error.code,
        head.error.errorData
      );
    }
    const responseBody = irohReceiveStreamBody(stream.recv, cancel, () => {
      signal?.removeEventListener("abort", onAbort);
      this.outboundRequests.delete(request.requestId);
      this.pipe.diagnosticsChanged();
      if (!body) void stream.send.finish().catch(() => undefined);
    });
    return {
      status: head.status,
      statusText: head.statusText,
      headers: head.headerPairs,
      finalUrl: head.finalUrl,
      body: responseBody,
    };
  }

  private async pumpRequestBody(
    stream: IrohPhysicalBiStream,
    body: ReadableStream<Uint8Array> | null | undefined,
    cancel: (reason?: unknown) => void
  ): Promise<void> {
    if (!body) return;
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        for (let offset = 0; offset < value.byteLength; offset += MAX_STREAM_CHUNK_BYTES) {
          await stream.send.writeAll(
            value.subarray(offset, Math.min(value.byteLength, offset + MAX_STREAM_CHUNK_BYTES))
          );
        }
      }
      await stream.send.finish();
    } catch (error) {
      cancel(error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private async readResponses(
    stream: IrohPhysicalBiStream,
    requestId: string | null
  ): Promise<void> {
    try {
      const bytes = await readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES);
      const value = decodeJsonFrame(bytes);
      assertEnvelope(value);
      this.emit(value);
    } catch (error) {
      if (requestId && this.outboundRequests.has(requestId)) {
        this.emitTransportFailure(requestId, asError(error));
      }
    }
  }

  private emit(envelope: RpcEnvelope): void {
    for (const listener of [...this.listeners]) listener(envelope);
  }

  private emitTransportFailure(requestId: string, error: Error): void {
    const response: RpcResponse = {
      type: "response",
      requestId,
      error: error.message,
      errorKind: "transport",
      errorCode: "CONNECTION_LOST",
    };
    this.emit({
      from: "main",
      target: this.authenticatedCallerId ?? "",
      delivery: { caller: { callerId: "main", callerKind: "unknown" } },
      provenance: [],
      message: response,
    });
  }

  private failOutstanding(error: Error): void {
    for (const [requestId, stream] of this.outboundRequests) {
      void stream.send.reset(IROH_SESSION_CLOSE_CODE).catch(() => undefined);
      void stream.recv.stop(IROH_SESSION_CLOSE_CODE).catch(() => undefined);
      this.emitTransportFailure(requestId, error);
    }
    this.outboundRequests.clear();
    for (const inbound of this.inboundRequests.values()) {
      void inbound.stream.send.reset(IROH_SESSION_CLOSE_CODE).catch(() => undefined);
      void inbound.stream.recv.stop(IROH_SESSION_CLOSE_CODE).catch(() => undefined);
    }
    this.inboundRequests.clear();
    this.pipe.diagnosticsChanged();
  }
}

class ClientPipe implements IrohClientPipe {
  readonly peerEndpointId: string;
  readonly connection: IrohPhysicalConnection;
  private readonly sessions = new Map<string, ClientSession>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  private readonly statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  private readonly diagnosticsListeners = new Set<
    (diagnostics: IrohConnectionDiagnostics | null) => void
  >();
  private statusValue: RpcConnectionStatus = "connecting";
  private controlWriter: SerializedControlWriter | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private helloResolve!: () => void;
  private helloReject!: (error: Error) => void;
  private readonly helloPromise = new Promise<void>((resolve, reject) => {
    this.helloResolve = resolve;
    this.helloReject = reject;
  });
  private readonly unsubscribePhysicalDiagnostics: (() => void) | null;

  constructor(
    connection: IrohPhysicalConnection,
    private readonly dialMetadata?: {
      relayUrl: string;
      attempts: number;
      generation: number;
    }
  ) {
    this.connection = connection;
    this.peerEndpointId = connection.peerEndpointId;
    this.unsubscribePhysicalDiagnostics =
      connection.onDiagnosticsChange?.(() => this.diagnosticsChanged()) ?? null;
  }

  status(): RpcConnectionStatus {
    return this.statusValue;
  }

  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
    this.statusListeners.add(handler);
    return () => this.statusListeners.delete(handler);
  }

  onDiagnosticsChange(
    handler: (diagnostics: IrohConnectionDiagnostics | null) => void
  ): () => void {
    this.diagnosticsListeners.add(handler);
    handler(this.diagnostics());
    return () => this.diagnosticsListeners.delete(handler);
  }

  diagnostics(): IrohConnectionDiagnostics | null {
    const physical = this.connection.diagnostics?.();
    if (!physical && !this.dialMetadata) return null;
    return {
      ...(physical ?? { paths: [] }),
      logicalSessions: this.sessions.size,
      activeRequests: [...this.sessions.values()].reduce(
        (total, session) => total + session.activeRequestCount(),
        0
      ),
      ...(this.dialMetadata
        ? {
            dialRelayUrl: this.dialMetadata.relayUrl,
            dialAttempts: this.dialMetadata.attempts,
            endpointGeneration: this.dialMetadata.generation,
          }
        : {}),
    };
  }

  ready(): Promise<void> {
    return (this.startPromise ??= this.start());
  }

  openSession(options: IrohClientSessionOptions): IrohClientSession {
    const session = new ClientSession(this, options);
    if (this.sessions.has(session.sid))
      throw new Error(`Iroh session ${session.sid} already exists`);
    this.sessions.set(session.sid, session);
    this.diagnosticsChanged();
    return session;
  }

  async close(): Promise<void> {
    return (this.closePromise ??= (async () => {
      this.setStatus("disconnected");
      for (const session of this.sessions.values()) session.fail(new Error("Iroh pipe closed"));
      this.sessions.clear();
      this.unsubscribePhysicalDiagnostics?.();
      this.diagnosticsChanged();
      for (const pending of this.pendingOpens.values())
        pending.reject(new Error("Iroh pipe closed"));
      this.pendingOpens.clear();
      await this.controlWriter?.finish().catch(() => undefined);
      this.connection.close(0n, new TextEncoder().encode("client closed"));
      this.diagnosticsListeners.clear();
      this.statusListeners.clear();
    })());
  }

  writeControl(frame: IrohSessionControlFrame): Promise<void> {
    if (!this.controlWriter) throw new Error("Iroh control stream is not ready");
    return this.controlWriter.write(frame);
  }

  waitForOpen(sid: string): Promise<IrohSessionOpenResultFrame> {
    if (this.pendingOpens.has(sid)) throw new Error(`Iroh session ${sid} already opening`);
    return new Promise((resolve, reject) => this.pendingOpens.set(sid, { resolve, reject }));
  }

  settleOpen(frame: IrohSessionOpenResultFrame): void {
    const pending = this.pendingOpens.get(frame.sid);
    if (!pending) throw new Error(`Unexpected Iroh open-result for ${frame.sid}`);
    this.pendingOpens.delete(frame.sid);
    pending.resolve(frame);
  }

  removeSession(sid: string, session: ClientSession): void {
    if (this.sessions.get(sid) === session) {
      this.sessions.delete(sid);
      this.diagnosticsChanged();
    }
  }

  diagnosticsChanged(): void {
    const diagnostics = this.diagnostics();
    for (const listener of [...this.diagnosticsListeners]) listener(diagnostics);
  }

  private async start(): Promise<void> {
    const control = await this.connection.openBi();
    this.controlWriter = new SerializedControlWriter(control.send);
    await writeIrohStreamPreamble(control.send, { k: "control", v: IROH_WIRE_VERSION });
    await this.controlWriter.write({
      t: IROH_SESSION_HELLO,
      protocolVersion: IROH_WIRE_VERSION,
      contractVersion: RPC_CONTRACT_VERSION,
    });
    void this.readControl(control).catch((error) => this.failPipe(asError(error)));
    void this.acceptStreams().catch((error) => this.failPipe(asError(error)));
    void this.connection.closed().then((reason) => this.failPipe(new Error(reason)));
    await this.helloPromise;
    this.setStatus("connected");
  }

  private async readControl(control: IrohPhysicalBiStream): Promise<void> {
    while (this.statusValue !== "disconnected") {
      const frame = decodeIrohSessionControlFrame(
        await readFrame(control.recv, MAX_CONTROL_FRAME_BYTES)
      );
      switch (frame.t) {
        case IROH_SESSION_HELLO:
          if (frame.contractVersion !== RPC_CONTRACT_VERSION) {
            throw new Error(
              `RPC contract mismatch: peer ${frame.contractVersion}, local ${RPC_CONTRACT_VERSION}`
            );
          }
          this.helloResolve();
          break;
        case IROH_SESSION_OPEN_RESULT:
          this.sessions.get(frame.sid)?.handleOpenResult(frame);
          break;
        case IROH_SESSION_CLOSED:
          this.sessions.get(frame.sid)?.handleClosed(frame);
          break;
        case IROH_SESSION_OPEN:
        case IROH_SESSION_CLOSE:
          throw new Error(`Client received invalid Iroh control frame ${frame.t}`);
      }
    }
  }

  private async acceptStreams(): Promise<void> {
    let pendingAdmissions = 0;
    while (this.statusValue !== "disconnected") {
      const stream = await this.connection.acceptBi();
      if (pendingAdmissions >= MAX_PENDING_STREAM_ADMISSIONS) {
        void stream.recv.stop(IROH_PROTOCOL_CLOSE_CODE).catch(() => undefined);
        void stream.send.reset(IROH_PROTOCOL_CLOSE_CODE).catch(() => undefined);
        continue;
      }
      pendingAdmissions += 1;
      // QUIC streams are independent. Never wait for one peer-opened stream's
      // preamble or envelope in the admission loop: a stalled stream would
      // otherwise head-of-line block every later server event despite QUIC's
      // multiplexing. Only incomplete bounded headers occupy the explicit
      // admission budget; retained response streams do not.
      void this.acceptStream(stream)
        .catch(() => {
          // A peer-created request stream is an isolation boundary. Reject only
          // this malformed or stalled stream; the control stream and unrelated
          // sessions remain healthy.
          void stream.recv.stop(IROH_PROTOCOL_CLOSE_CODE).catch(() => undefined);
          void stream.send.reset(IROH_PROTOCOL_CLOSE_CODE).catch(() => undefined);
        })
        .finally(() => {
          pendingAdmissions -= 1;
        });
    }
  }

  private async acceptStream(stream: IrohPhysicalBiStream): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const admission = (async (): Promise<void> => {
      const preamble = await readIrohStreamPreamble(stream.recv);
      if (preamble.k === "control") throw new Error("Duplicate Iroh control stream");
      const session = this.sessions.get(preamble.sid);
      if (!session) {
        await stream.recv.stop(IROH_SESSION_CLOSE_CODE);
        await stream.send.reset(IROH_SESSION_CLOSE_CODE);
        return;
      }
      if (preamble.k === "stream") {
        await stream.recv.stop(IROH_PROTOCOL_CLOSE_CODE);
        await stream.send.reset(IROH_PROTOCOL_CLOSE_CODE);
        return;
      }
      if (preamble.k === "message") {
        void this.acceptMessage(session, stream).catch(() => {
          void stream.recv.stop(IROH_PROTOCOL_CLOSE_CODE).catch(() => undefined);
          void stream.send.reset(IROH_PROTOCOL_CLOSE_CODE).catch(() => undefined);
        });
        return;
      }
      const value = decodeJsonFrame(await readFrame(stream.recv, MAX_ENVELOPE_FRAME_BYTES));
      assertEnvelope(value);
      await session.acceptEnvelope(stream, value);
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void stream.recv.stop(IROH_PROTOCOL_CLOSE_CODE).catch(() => undefined);
        void stream.send.reset(IROH_PROTOCOL_CLOSE_CODE).catch(() => undefined);
        reject(
          new Error(
            `Iroh peer stream did not provide a complete header within ${IROH_STREAM_ADMISSION_TIMEOUT_MS}ms`
          )
        );
      }, IROH_STREAM_ADMISSION_TIMEOUT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([admission, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async acceptMessage(session: ClientSession, stream: IrohPhysicalBiStream): Promise<void> {
    const value = decodeJsonFrame(await readToEnd(stream.recv, MAX_STREAM_CHUNK_BYTES));
    assertEnvelope(value);
    await session.acceptEnvelope(stream, value);
  }

  private failPipe(error: Error): void {
    if (this.statusValue === "disconnected") return;
    this.helloReject(error);
    this.setStatus("disconnected");
    for (const pending of this.pendingOpens.values()) pending.reject(error);
    this.pendingOpens.clear();
    for (const session of this.sessions.values()) session.fail(error);
    this.connection.close(IROH_PROTOCOL_CLOSE_CODE, new TextEncoder().encode(error.message));
  }

  private setStatus(status: RpcConnectionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }
}

export function createIrohClientPipe(
  connection: IrohPhysicalConnection,
  dialMetadata?: { relayUrl: string; attempts: number; generation: number }
): IrohClientPipe {
  return new ClientPipe(connection, dialMetadata);
}

export function irohReceiveStreamBody(
  recv: IrohPhysicalReceiveStream,
  onCancel?: (reason?: unknown) => void,
  onSettled?: () => void
): ReadableStream<Uint8Array> {
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onSettled?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = Uint8Array.from(await recv.read(MAX_STREAM_CHUNK_BYTES));
        if (chunk.byteLength === 0) {
          settle();
          controller.close();
        } else controller.enqueue(chunk);
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      onCancel?.(reason);
      await recv.stop(IROH_CANCEL_CODE).catch(() => undefined);
      settle();
    },
  });
}
