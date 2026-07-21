import type {
  AuthenticatedCaller,
  CallerKind,
  EnvelopeRpcTransport,
  EventMap,
  MethodMap,
  RpcCallOptions,
  RpcCausalParent,
  RpcClient,
  RpcClientConfig,
  RpcConnectionStatus,
  RpcContextMethods,
  RpcContextStreamingHandler,
  RpcEnvelope,
  RpcEvent,
  RpcEventContext,
  RpcMessage,
  RpcPeer,
  RpcRequest,
  RpcRequestContext,
  RpcResponse,
  RpcStreamCancel,
  RpcRequestCancel,
  RpcStreamFrameMessage,
  RpcStreamOptions,
  RpcStreamRequest,
  StreamingMethodFrame,
  TypedCallProxy,
} from "./types.js";
import { originOfEnvelope, responseEnvelopeFor } from "./envelope.js";
import { bytesToBase64, base64ToBytes } from "./base64.js";
import { SESSION_CONNECTION_LOST_CODE } from "./protocol/sessionNegotiation.js";
import type { RecoveryKind } from "./protocol/recoveryCoordinator.js";
import { RemoteRpcError, rpcErrorDataOf, rpcErrorKindOf } from "./errors.js";

const FRAME_HEAD = 0x01;
const FRAME_DATA = 0x02;
const FRAME_END = 0x03;
const FRAME_ERROR = 0x04;

/** Human-readable reason attached to CONNECTION_LOST rejections (§3.4). */
const CONNECTION_LOST_MESSAGE = "Connection lost before the response arrived";

/**
 * The server principal is addressed as `"main"` (SESSION_SERVER_RESPONDER) or
 * `"server"`. A direct client→server call's response is never inboxed, so it is
 * unrecoverable after any pipe drop. Every other target is a routed
 * caller↔caller call, whose response the server inbox can replay after a clean
 * reconnect.
 */
function isServerTarget(target: string): boolean {
  return target === "main" || target === "server";
}

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function callerForSelf(
  selfId: string,
  callerKind: CallerKind | "unknown" = "unknown"
): AuthenticatedCaller {
  return { callerId: selfId, callerKind };
}

function appendSelf(
  provenance: AuthenticatedCaller[],
  self: AuthenticatedCaller
): AuthenticatedCaller[] {
  if (provenance.length === 0) return [self];
  const last = provenance[provenance.length - 1];
  if (last?.callerId === self.callerId && last.callerKind === self.callerKind) return provenance;
  return [...provenance, self];
}

function createCallProxy<TMethods extends MethodMap>(
  invoke: (method: string, args: unknown[]) => Promise<unknown>
): TypedCallProxy<TMethods> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => invoke(prop, args);
      },
    }
  ) as TypedCallProxy<TMethods>;
}

export function defineContract<const TContract extends Record<string, unknown>>(
  contract: TContract
): TContract {
  return contract;
}

/**
 * Optional wiring for the pending-call policy (§3.4). The core needs to know
 * whether a reconnect was a `cold-recover` (server session state gone → routed
 * responses are unrecoverable) or a `resubscribe` (the inbox will replay them),
 * a distinction only the transport's recovery signal carries. Production
 * callers wire this from `createPairedConnection`'s recovery fan-out, e.g.
 *
 * ```ts
 * const paired = await createPairedConnection({ ... });
 * createRpcClient({
 *   selfId, transport: paired.mainSession,
 *   onRecovery: (handler) => paired.onRecovery(handler),
 * });
 * ```
 *
 * It is optional and additive: transports that cannot distinguish recovery kinds
 * omit it, and routed pendings are then settled only by a response, inbox
 * replay, or an explicit per-call deadline. (Kept local to the client rather
 * than baked into `RpcClientConfig` so the transport package owns the seam.)
 */
export interface RpcClientRecoveryOptions {
  onRecovery?: (handler: (kind: RecoveryKind) => void) => (() => void) | void;
}

export function createRpcClient(config: RpcClientConfig & RpcClientRecoveryOptions): RpcClient {
  const selfCaller = callerForSelf(config.selfId, config.callerKind);
  const baseProvenance = config.provenance?.length ? config.provenance : [selfCaller];
  const exposedMethods = new Map<
    string,
    (request: RpcRequestContext) => unknown | Promise<unknown>
  >();
  const streamingHandlers = new Map<string, RpcContextStreamingHandler>();
  const eventListeners = new Map<string, Set<(event: RpcEventContext) => void>>();
  const pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout> | null;
      abortCleanup: (() => void) | null;
      /** Envelope target — drives the direct-server vs routed rejection policy (§3.4). */
      target: string;
    }
  >();
  const pendingStreams = new Map<
    string,
    {
      controller: ReadableStreamDefaultController<Uint8Array>;
      resolveHead: (head: {
        status: number;
        statusText: string;
        headerPairs: Array<[string, string]>;
        finalUrl: string;
      }) => void;
      rejectHead: (err: unknown) => void;
      headEmitted: boolean;
      bodyClosed: boolean;
      bodyIdleTimeoutMs: number | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      cancel: () => void;
      cleanup: () => void;
    }
  >();
  const activeStreamingHandlers = new Map<string, AbortController>();
  const activeRequestHandlers = new Map<string, AbortController>();
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 90_000;

  function makeEnvelope(
    targetId: string,
    message: RpcMessage,
    options?: { idempotencyKey?: string; readOnly?: boolean },
    provenance: AuthenticatedCaller[] = baseProvenance
  ): RpcEnvelope {
    return {
      from: config.selfId,
      target: targetId,
      delivery: {
        caller: selfCaller,
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(options?.readOnly ? { readOnly: true } : {}),
      },
      provenance,
      message,
    };
  }

  function scopedClientFor(inbound: RpcEnvelope): RpcClient {
    const scopedProvenance = appendSelf(
      inbound.provenance.length ? inbound.provenance : [inbound.delivery.caller],
      selfCaller
    );
    return {
      ...client,
      call: (targetId, method, args, options) =>
        callWithProvenance(scopedProvenance, targetId, method, args, options),
      stream: (targetId, method, args, options) =>
        streamWithProvenance(scopedProvenance, targetId, method, args, options),
      emit: (targetId, event, payload, options) =>
        emitWithProvenance(scopedProvenance, targetId, event, payload, options),
      peer: (targetId) => peer(targetId, scopedProvenance),
    };
  }

  function requestContext(
    envelope: RpcEnvelope,
    message: RpcRequest | RpcStreamRequest,
    signal: AbortSignal
  ): RpcRequestContext {
    return {
      caller: envelope.delivery.caller,
      origin: originOfEnvelope(envelope),
      method: message.method,
      args: message.args,
      signal,
      rpc: scopedClientFor(envelope),
    };
  }

  async function send(
    targetId: string,
    message: RpcMessage,
    options?: { idempotencyKey?: string; readOnly?: boolean; signal?: AbortSignal },
    provenance?: AuthenticatedCaller[]
  ): Promise<void> {
    const envelope = makeEnvelope(targetId, message, options, provenance);
    await deliverEnvelope(envelope, options?.signal);
  }

  async function deliverEnvelope(envelope: RpcEnvelope, signal?: AbortSignal): Promise<void> {
    if (envelope.target === config.selfId) {
      queueMicrotask(() => handleEnvelope(envelope));
      return;
    }
    await config.transport.send(envelope, signal);
  }

  function clearPendingStream(requestId: string): void {
    const entry = pendingStreams.get(requestId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      entry.cleanup();
    } catch {
      // best effort
    }
    pendingStreams.delete(requestId);
  }

  function armStreamHeadTimer(requestId: string, timeoutMs = streamIdleTimeoutMs): void {
    const entry = pendingStreams.get(requestId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const current = pendingStreams.get(requestId);
      if (!current || current.bodyClosed) return;
      const err = new Error("Streaming RPC timed out before response headers");
      current.rejectHead(err);
      clearPendingStream(requestId);
    }, timeoutMs);
  }

  function armStreamBodyIdleTimer(requestId: string): void {
    const entry = pendingStreams.get(requestId);
    if (!entry || entry.bodyClosed || entry.bodyIdleTimeoutMs === null) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const current = pendingStreams.get(requestId);
      if (!current || current.bodyClosed) return;
      current.bodyClosed = true;
      current.controller.error(new Error("Streaming RPC response body timed out while idle"));
      current.cancel();
      clearPendingStream(requestId);
    }, entry.bodyIdleTimeoutMs);
  }

  function makeConnectionLostError(): NodeJS.ErrnoException {
    const err = new Error(CONNECTION_LOST_MESSAGE) as NodeJS.ErrnoException;
    err.code = SESSION_CONNECTION_LOST_CODE;
    return err;
  }

  // Reject + remove every pending request whose target matches `predicate`,
  // clearing its deadline timer and abort wiring. The pending-call policy
  // (§3.4) uses it twice: direct-server pendings on pipe-down, routed pendings
  // on cold-recover.
  function rejectPendingRequests(predicate: (target: string) => boolean, error: Error): void {
    for (const [requestId, pending] of [...pendingRequests]) {
      if (!predicate(pending.target)) continue;
      pendingRequests.delete(requestId);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.abortCleanup?.();
      pending.reject(error);
    }
  }

  function handleResponse(response: RpcResponse): void {
    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;
    pendingRequests.delete(response.requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.abortCleanup?.();
    if ("error" in response) {
      const err = new RemoteRpcError(
        response.error,
        response.errorKind,
        response.errorCode,
        response.errorData
      );
      if (response.errorStack) err.stack = response.errorStack;
      pending.reject(err);
      return;
    }
    pending.resolve(response.result);
  }

  function handleEvent(envelope: RpcEnvelope, event: RpcEvent): void {
    const listeners = eventListeners.get(event.event);
    if (!listeners) return;
    const context: RpcEventContext = {
      caller: envelope.delivery.caller,
      origin: originOfEnvelope(envelope),
      event: event.event,
      payload: event.payload,
    };
    for (const listener of listeners) listener(context);
  }

  function handleStreamFrame(frame: RpcStreamFrameMessage): void {
    const entry = pendingStreams.get(frame.requestId);
    if (!entry || entry.bodyClosed) return;
    if (frame.frameType === FRAME_HEAD) {
      try {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        entry.headEmitted = true;
        entry.resolveHead(JSON.parse(frame.payload));
        armStreamBodyIdleTimer(frame.requestId);
      } catch (err) {
        entry.rejectHead(err);
        clearPendingStream(frame.requestId);
      }
      return;
    }
    if (frame.frameType === FRAME_DATA) {
      entry.controller.enqueue(base64ToBytes(frame.payload));
      armStreamBodyIdleTimer(frame.requestId);
      return;
    }
    if (frame.frameType === FRAME_END) {
      entry.bodyClosed = true;
      entry.controller.close();
      clearPendingStream(frame.requestId);
      return;
    }
    if (frame.frameType === FRAME_ERROR) {
      let parsed: {
        message: string;
        code?: string;
        errorKind: import("./types.js").RpcErrorKind;
        errorData?: import("./types.js").RpcErrorData;
      };
      try {
        parsed = JSON.parse(frame.payload);
      } catch {
        parsed = { message: "Streaming RPC error", errorKind: "protocol" };
      }
      const err = new RemoteRpcError(
        parsed.message,
        parsed.errorKind,
        parsed.code,
        parsed.errorData
      );
      if (entry.headEmitted) {
        entry.bodyClosed = true;
        entry.controller.error(err);
      } else {
        entry.rejectHead(err);
      }
      clearPendingStream(frame.requestId);
    }
  }

  function handleStreamCancel(cancel: RpcStreamCancel): void {
    activeStreamingHandlers.get(cancel.requestId)?.abort();
  }

  function handleRequestCancel(cancel: RpcRequestCancel): void {
    activeRequestHandlers.get(cancel.requestId)?.abort();
  }

  function handleRequest(envelope: RpcEnvelope, request: RpcRequest): void {
    const handler = exposedMethods.get(request.method);
    // A failed response send means the caller's awaiter will hang. We can't
    // recover the delivery here, but the drop MUST be observable rather than
    // silently swallowed (silent-drop class).
    const logResponseSendFailure = (error: unknown): void => {
      console.warn(
        `[rpc:${config.selfId}] failed to deliver response for "${request.method}" ` +
          `(requestId=${request.requestId}) to ${envelope.from}:`,
        error
      );
    };
    if (!handler) {
      void deliverEnvelope(
        responseEnvelopeFor(envelope, selfCaller, {
          type: "response",
          requestId: request.requestId,
          error: `Method "${request.method}" is not exposed by this endpoint`,
          errorKind: "application",
        })
      ).catch(logResponseSendFailure);
      return;
    }
    const abort = new AbortController();
    activeRequestHandlers.set(request.requestId, abort);
    Promise.resolve()
      .then(() => handler(requestContext(envelope, request, abort.signal)))
      .then((result) =>
        deliverEnvelope(
          responseEnvelopeFor(envelope, selfCaller, {
            type: "response",
            requestId: request.requestId,
            result,
          })
        )
      )
      .catch((error) =>
        deliverEnvelope(
          responseEnvelopeFor(envelope, selfCaller, {
            type: "response",
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
            errorKind: rpcErrorKindOf(error),
            ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
            ...(error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
              ? { errorCode: (error as NodeJS.ErrnoException).code }
              : {}),
            ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
          })
        ).catch(logResponseSendFailure)
      )
      .finally(() => {
        if (activeRequestHandlers.get(request.requestId) === abort) {
          activeRequestHandlers.delete(request.requestId);
        }
      });
  }

  function handleStreamRequest(envelope: RpcEnvelope, request: RpcStreamRequest): void {
    const handler = streamingHandlers.get(request.method);
    const sendFrame = (frameType: number, payload: string): Promise<void> =>
      send(envelope.from, {
        type: "stream-frame",
        requestId: request.requestId,
        fromId: config.selfId,
        frameType,
        payload,
      });
    if (!handler) {
      void sendFrame(
        FRAME_ERROR,
        JSON.stringify({
          status: 404,
          message: `No streaming handler for method "${request.method}"`,
          errorKind: "application",
        })
      ).catch(() => {});
      return;
    }
    const abort = new AbortController();
    activeStreamingHandlers.set(request.requestId, abort);
    const sink = (frame: StreamingMethodFrame): Promise<void> | void => {
      if (frame.kind === "head") {
        return sendFrame(
          FRAME_HEAD,
          JSON.stringify({
            status: frame.status,
            statusText: frame.statusText,
            headerPairs: frame.headerPairs,
            finalUrl: frame.finalUrl,
          })
        );
      }
      if (frame.kind === "chunk") return sendFrame(FRAME_DATA, bytesToBase64(frame.bytes));
      if (frame.kind === "end")
        return sendFrame(FRAME_END, JSON.stringify({ bytesIn: frame.bytesIn }));
      return sendFrame(
        FRAME_ERROR,
        JSON.stringify({
          status: frame.status,
          message: frame.message,
          code: frame.code,
          errorKind: frame.errorKind,
          ...(frame.errorData !== undefined ? { errorData: frame.errorData } : {}),
        })
      );
    };
    Promise.resolve()
      .then(() => handler(requestContext(envelope, request, abort.signal), sink))
      .catch((error) =>
        sendFrame(
          FRAME_ERROR,
          JSON.stringify({
            status: 502,
            message: error instanceof Error ? error.message : String(error),
            errorKind: rpcErrorKindOf(error),
            ...(rpcErrorDataOf(error) !== undefined ? { errorData: rpcErrorDataOf(error) } : {}),
          })
        ).catch(() => {})
      )
      .finally(() => activeStreamingHandlers.delete(request.requestId));
  }

  function handleEnvelope(envelope: RpcEnvelope): void {
    const message = envelope.message;
    switch (message.type) {
      case "request":
        handleRequest(envelope, message);
        return;
      case "response":
        handleResponse(message);
        return;
      case "event":
        handleEvent(envelope, message);
        return;
      case "stream-request":
        handleStreamRequest(envelope, message);
        return;
      case "stream-frame":
        handleStreamFrame(message);
        return;
      case "stream-cancel":
        handleStreamCancel(message);
        return;
      case "request-cancel":
        handleRequestCancel(message);
        return;
    }
  }

  function callWithProvenance<T = unknown>(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<T> {
    if (options?.signal?.aborted) return Promise.reject(new Error("RPC call aborted by caller"));
    const requestId = generateRequestId();
    const request: RpcRequest = {
      type: "request",
      requestId,
      fromId: config.selfId,
      method,
      args,
      ...(options?.causalParent ? { causalParent: options.causalParent } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let abortCleanup: (() => void) | null = null;
      const rejectPending = (err: Error): void => {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.abortCleanup?.();
        pending.reject(err);
      };
      // No implicit deadline: callers opt in with a positive timeoutMs when a
      // specific operation should be time-bounded.
      const effectiveTimeoutMs = options?.timeoutMs;
      if (effectiveTimeoutMs !== undefined && effectiveTimeoutMs > 0) {
        timeout = setTimeout(
          () => rejectPending(new Error(`RPC call timed out after ${effectiveTimeoutMs}ms`)),
          effectiveTimeoutMs
        );
      }
      if (options?.signal) {
        const onAbort = (): void => {
          void send(
            targetId,
            { type: "request-cancel", requestId, fromId: config.selfId },
            undefined,
            provenance
          ).catch(() => {});
          rejectPending(new Error("RPC call aborted by caller"));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
      pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        abortCleanup,
        target: targetId,
      });
      void send(targetId, request, options, provenance).catch((error) => {
        const pending = pendingRequests.get(requestId);
        pendingRequests.delete(requestId);
        if (pending?.timeout) clearTimeout(pending.timeout);
        pending?.abortCleanup?.();
        reject(error);
      });
    });
  }

  function emitWithProvenance(
    provenance: AuthenticatedCaller[],
    targetId: string,
    event: string,
    payload: unknown,
    options?: RpcCallOptions
  ): Promise<void> {
    const message: RpcEvent = { type: "event", fromId: config.selfId, event, payload };
    return send(targetId, message, options, provenance);
  }

  function streamWithProvenance(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions
  ): Promise<Response> {
    // Connectionless transports (HTTP) physically stream the response body, so
    // delegate to their first-class `stream` hook. Socket transports omit it
    // and fall back to the duplex stream-request/stream-frame envelope path.
    if (config.transport.stream) {
      const envelope = makeEnvelope(
        targetId,
        {
          type: "stream-request",
          requestId: generateRequestId(),
          fromId: config.selfId,
          method,
          args,
          ...(options?.causalParent ? { causalParent: options.causalParent } : {}),
        },
        options,
        provenance
      );
      // Body-capable transports (the WebRTC session) pump the request body on
      // the bulk channel; transports that can't THROW (plan §1.6 — fail loud,
      // never a silent base64 fallback).
      return config.transport.stream(
        envelope,
        options?.signal ?? null,
        options?.body ?? null,
        options?.headTimeoutMs
      );
    }
    if (options?.body) {
      // The duplex stream-request/stream-frame envelope path (plain WS, panel
      // postMessage bridges) has no request-body channel at all — but a panel
      // shell bridge can still carry uploads through its dedicated upload hop
      // (`streamBody`, plan §1.6): the panel pumps the body across the bridge
      // as chunk messages and the HOST feeds it to its WebRTC session.
      if (config.transport.streamBody) {
        const envelope = makeEnvelope(
          targetId,
          {
            type: "stream-request",
            requestId: generateRequestId(),
            fromId: config.selfId,
            method,
            args,
            ...(options?.causalParent ? { causalParent: options.causalParent } : {}),
          },
          options,
          provenance
        );
        return config.transport.streamBody(envelope, options?.signal ?? null, options.body);
      }
      throw new Error(
        "Streaming request bodies (uploads) require the WebRTC transport; this transport cannot stream a request body"
      );
    }
    return streamImpl(provenance, targetId, method, args, options);
  }

  function streamReadableWithProvenance(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions
  ) {
    // Prefer a transport-native raw stream (notably React Native WebRTC, where
    // whatwg-fetch Response cannot consume a ReadableStream body). Browser and
    // Node transports can losslessly unwrap the ordinary Response path.
    if (!config.transport.streamReadable) {
      return streamImpl(provenance, targetId, method, args, options).then((response) => {
        if (!response.body) throw new Error("Streaming RPC response has no readable body");
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          finalUrl: response.url,
          body: response.body,
        };
      });
    }
    const envelope = makeEnvelope(
      targetId,
      {
        type: "stream-request",
        requestId: generateRequestId(),
        fromId: config.selfId,
        method,
        args,
        ...(options?.causalParent ? { causalParent: options.causalParent } : {}),
      },
      options,
      provenance
    );
    return config.transport.streamReadable(
      envelope,
      options?.signal ?? null,
      options?.body ?? null,
      options?.headTimeoutMs
    );
  }

  function peer<
    TMethods extends MethodMap = MethodMap,
    TEvents extends EventMap = EventMap,
    TEmitEvents extends EventMap = TEvents,
  >(
    targetId: string,
    provenance: AuthenticatedCaller[] = baseProvenance
  ): RpcPeer<TMethods, TEvents, TEmitEvents> {
    const result: RpcPeer<TMethods, TEvents, TEmitEvents> = {
      id: targetId,
      call: createCallProxy<TMethods>((method, args) =>
        callWithProvenance(provenance, targetId, method, args)
      ),
      on(event, listener) {
        return client.on(event, (ev) => {
          if (ev.caller.callerId === targetId) listener(ev as never);
        });
      },
      emit(event, payload) {
        return emitWithProvenance(provenance, targetId, event, payload);
      },
      withContract(_contract, _role) {
        return peer(targetId, provenance) as never;
      },
    };
    return result;
  }

  async function streamImpl(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions
  ): Promise<Response> {
    if (options?.signal?.aborted) throw new Error("Streaming RPC aborted by caller");
    const requestId = generateRequestId();
    let resolveHead!: (head: {
      status: number;
      statusText: string;
      headerPairs: Array<[string, string]>;
      finalUrl: string;
    }) => void;
    let rejectHead!: (err: unknown) => void;
    const headPromise = new Promise<{
      status: number;
      statusText: string;
      headerPairs: Array<[string, string]>;
      finalUrl: string;
    }>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const sendCancel = (): void => {
      void send(
        targetId,
        { type: "stream-cancel", requestId, fromId: config.selfId },
        undefined,
        provenance
      ).catch(() => {});
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        const entry = pendingStreams.get(requestId);
        if (entry) entry.bodyClosed = true;
        clearPendingStream(requestId);
        sendCancel();
      },
    });
    const onAbort = (): void => {
      const entry = pendingStreams.get(requestId);
      if (!entry) return;
      const err = new Error("Streaming RPC aborted by caller");
      if (entry.headEmitted) {
        entry.bodyClosed = true;
        entry.controller.error(err);
      } else {
        entry.rejectHead(err);
      }
      clearPendingStream(requestId);
      sendCancel();
    };
    const signal = options?.signal;
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingStreams.set(requestId, {
      controller: bodyController!,
      resolveHead,
      rejectHead,
      headEmitted: false,
      bodyClosed: false,
      bodyIdleTimeoutMs:
        options?.bodyIdleTimeoutMs === null
          ? null
          : (options?.bodyIdleTimeoutMs ?? streamIdleTimeoutMs),
      idleTimer: null,
      cancel: sendCancel,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    });
    armStreamHeadTimer(requestId, options?.headTimeoutMs ?? streamIdleTimeoutMs);
    try {
      await send(
        targetId,
        {
          type: "stream-request",
          requestId,
          fromId: config.selfId,
          method,
          args,
          ...(options?.causalParent ? { causalParent: options.causalParent } : {}),
        },
        options,
        provenance
      );
    } catch (error) {
      clearPendingStream(requestId);
      signal?.removeEventListener("abort", onAbort);
      throw error;
    }
    const head = await headPromise;
    const response = new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
      status: head.status,
      statusText: head.statusText,
      headers: new Headers(head.headerPairs),
    });
    if (head.finalUrl) {
      try {
        Object.defineProperty(response, "url", {
          value: head.finalUrl,
          writable: false,
          configurable: true,
        });
      } catch {
        // ignore
      }
    }
    return response;
  }

  const client: RpcClient = {
    selfId: config.selfId,
    expose(method, handler): void {
      exposedMethods.set(
        method,
        handler as (request: RpcRequestContext) => unknown | Promise<unknown>
      );
    },
    exposeAll(methods: RpcContextMethods): void {
      for (const [name, handler] of Object.entries(methods)) {
        exposedMethods.set(
          name,
          handler as (request: RpcRequestContext) => unknown | Promise<unknown>
        );
      }
    },
    exposeStreaming(method, handler): void {
      streamingHandlers.set(method, handler);
    },
    async call<T = unknown>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ): Promise<T> {
      return callWithProvenance(baseProvenance, targetId, method, args, options);
    },
    async stream(targetId, method, args, options): Promise<Response> {
      return streamWithProvenance(baseProvenance, targetId, method, args, options);
    },
    streamReadable(targetId, method, args, options) {
      return streamReadableWithProvenance(baseProvenance, targetId, method, args, options);
    },
    emit(targetId, event, payload, options): Promise<void> {
      return emitWithProvenance(baseProvenance, targetId, event, payload, options);
    },
    on(event, listener): () => void {
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(event, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) eventListeners.delete(event);
      };
    },
    peer,
    status(): RpcConnectionStatus {
      return config.transport.status?.() ?? "connected";
    },
    ready(): Promise<void> {
      return config.transport.ready?.() ?? Promise.resolve();
    },
    onStatusChange(handler): () => void {
      return config.transport.onStatusChange?.(handler) ?? (() => {});
    },
  };

  config.transport.onMessage(handleEnvelope);

  // Pending-call policy (§3.4) — "nothing hangs, ever".
  //
  // Direct client→server responses are NEVER inboxed server-side, so any pipe
  // drop makes an in-flight direct-server call permanently unrecoverable. Reject
  // those pendings the instant the transport reports `disconnected`. Routed
  // caller↔caller pendings survive this flip: the server inbox can still replay
  // their responses across a clean reconnect. The one case inbox replay cannot
  // cover — a routed REQUEST or RESPONSE that was queued but never hit the
  // wire at pipe-down (nothing server-side to replay; a lost response strands
  // the REMOTE caller, whose pipe never went down) — is closed at the
  // TRANSPORT layer: the WebRTC transport re-drives undelivered routed frames
  // on a `resubscribe` recovery (webrtcClient.ts, unflushedRouted), so every
  // surviving routed pending is guaranteed its request AND response delivery.
  // The remaining case — the request WAS delivered but the callee then
  // terminally dies (grace expiry / lease revoke), so no response will ever
  // exist — is closed SERVER-side: rpcServer tracks the callee per in-flight
  // routed request and, at the callee's terminal departure, sends the caller
  // a `routed-response-error` (RECONNECT_GRACE_EXPIRED), which the transport
  // turns into a rejecting response here.
  config.transport.onStatusChange?.((status) => {
    if (status === "disconnected") {
      rejectPendingRequests(isServerTarget, makeConnectionLostError());
    }
  });

  // A routed pending is only truly lost on `cold-recover` (server session state
  // gone → no inbox to replay from); reject the remaining routed pendings then.
  // On `resubscribe` the inbox replay settles them, so leave them alone.
  config.onRecovery?.((kind) => {
    if (kind === "cold-recover") {
      rejectPendingRequests((target) => !isServerTarget(target), makeConnectionLostError());
    }
  });

  return client;
}

/**
 * Bind one exact upstream tool invocation to every ordinary call made through
 * a client. The coordinate is carried as provenance only; authorization still
 * comes entirely from the authenticated RPC caller and service policy.
 */
export function withCausalParent(base: RpcClient, causalParent: RpcCausalParent): RpcClient {
  return Object.freeze({
    selfId: base.selfId,
    expose: base.expose.bind(base),
    exposeAll: base.exposeAll.bind(base),
    exposeStreaming: base.exposeStreaming.bind(base),
    call: <T = unknown>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ) => base.call<T>(targetId, method, args, { ...(options ?? {}), causalParent }),
    stream: (targetId: string, method: string, args: unknown[], options?: RpcStreamOptions) =>
      base.stream(targetId, method, args, { ...(options ?? {}), causalParent }),
    streamReadable: (
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcStreamOptions
    ) => base.streamReadable(targetId, method, args, { ...(options ?? {}), causalParent }),
    emit: base.emit.bind(base),
    on: base.on.bind(base),
    peer: base.peer.bind(base),
    status: base.status.bind(base),
    ready: base.ready.bind(base),
    onStatusChange: base.onStatusChange.bind(base),
  });
}
