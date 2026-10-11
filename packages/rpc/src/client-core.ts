import { encodeRpcJson, decodeRpcJson } from "./wireJson.js";
import {
  schemaRpcClient,
  wireClientFor,
  registerRpcWireClient,
  ownRpcOperation,
  registerRpcOperationOwner,
} from "./schemaClient.js";
import type { RpcWireClient } from "./internal-types.js";
import { serializeRpcFailure, deserializeRpcFailure } from "./errors.js";
import { validateWebsiteMethodPolicy, type WebsiteMethodPolicy } from "./authority.js";
import { responseFromDecodedStream } from "./protocol/streamCodec.js";
import { isLocalRpcDestination, rpcDestinationMatchesCaller } from "./destination.js";
import type { RpcDestination } from "./types.js";
import type {
  AuthenticatedCaller,
  CallerKind,
  MethodMap,
  RpcCallOptions,
  RpcCausalParent,
  RpcClientConfig,
  RpcConnectionStatus,
  RpcContextMethods,
  RpcContextStreamingHandler,
  RpcEnvelope,
  RpcExposure,
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
  RpcTargetOptions,
  StreamingMethodFrame,
  TypedCallProxy,
} from "./types.js";
import { originOfEnvelope, responseEnvelopeFor } from "./envelope.js";
import { bytesToBase64, base64ToBytes } from "./base64.js";
import { SESSION_CONNECTION_LOST_CODE } from "./protocol/remoteSession.js";
import { assertRpcMethodDescriptor } from "./methodDescriptor.js";
import type { RecoveryKind } from "./protocol/recoveryCoordinator.js";
import { isRpcAborted, rpcCallerAbortedError, RpcBoundaryError, rpcErrorDataOf } from "./errors.js";
import {
  bindExecutionSession,
  bindInvocationParent,
  invocationParentFor,
  mergeRpcOptions,
  executionSessionNonceFor,
  type InternalRpcEvent,
  type InternalRpcRequest,
  type InternalRpcStreamRequest,
} from "./internal-types.js";
import { secureRandomUuid } from "./randomId.js";

const FRAME_HEAD = 0x01;
const FRAME_DATA = 0x02;
const FRAME_END = 0x03;
const FRAME_ERROR = 0x04;

/** Human-readable reason attached to CONNECTION_LOST rejections (§3.4). */
const CONNECTION_LOST_MESSAGE = "Connection lost before the response arrived";

function acquisitionIdOf(error: unknown, selfId: string): string | null {
  if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "EACQUIRE") {
    return null;
  }
  const data = rpcErrorDataOf(error);
  if (!data || typeof data !== "object") return null;
  const acquisition = (data as { acquisition?: unknown }).acquisition;
  if (!acquisition || typeof acquisition !== "object") return null;
  const acquisitionRecord = acquisition as {
    acquisitionId?: unknown;
    ownerRuntimeId?: unknown;
  };
  if (acquisitionRecord.ownerRuntimeId !== selfId) return null;
  const acquisitionId = acquisitionRecord.acquisitionId;
  return typeof acquisitionId === "string" && acquisitionId.length > 0 ? acquisitionId : null;
}

/**
 * The server principal is addressed as `"main"` (SESSION_SERVER_RESPONDER) or
 * `"server"`. A direct client→server call's response is never inboxed, so it is
 * unrecoverable after any pipe drop. Every other target is a routed
 * caller↔caller call, whose response the server inbox can replay after a clean
 * reconnect.
 */
function isServerTarget(target: string, destination?: RpcDestination): boolean {
  return destination === undefined && (target === "main" || target === "server");
}

function generateRequestId(): string {
  return secureRandomUuid();
}

function callerForSelf(
  selfId: string,
  callerKind: CallerKind | "unknown" = "unknown",
  workspaceId?: string
): AuthenticatedCaller {
  return { callerId: selfId, callerKind, ...(workspaceId ? { workspaceId } : {}) };
}

function appendSelf(
  provenance: AuthenticatedCaller[],
  self: AuthenticatedCaller
): AuthenticatedCaller[] {
  if (provenance.length === 0) return [self];
  const last = provenance[provenance.length - 1];
  if (
    last?.callerId === self.callerId &&
    last.callerKind === self.callerKind &&
    last.workspaceId === self.workspaceId
  )
    return provenance;
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

export function createRpcPeer(
  client: Pick<RpcWireClient, "call" | "on" | "emit">,
  targetId: string,
  options?: RpcTargetOptions
): RpcPeer {
  return {
    id: targetId,
    ...(options?.destination ? { destination: options.destination } : {}),
    call: {},
    on(event, listener, website) {
      return client.on(
        event,
        (ev) => {
          if (
            ev.caller.callerId === targetId &&
            rpcDestinationMatchesCaller(options?.destination, ev.caller)
          ) {
            listener(ev as never);
          }
        },
        website
      );
    },
    emit: (event, payload) => client.emit(targetId, event, payload, options),
    withContract: (contract, role) => {
      const methods = contract[role]?.methods;
      const contracted = createRpcPeer(client, targetId, options);
      return {
        ...contracted,
        call: createCallProxy((name, args) => {
          const method = methods?.[name];
          if (!method) throw new Error(`RPC contract has no ${role} method ${name}`);
          return ownRpcOperation(client, async () => {
            assertRpcMethodDescriptor(method, "peer.call");
            return method.invoke(args, (parsed) =>
              client.call(targetId, method.name, parsed, options)
            );
          });
        }),
      } as never;
    },
  };
}

export function defineContract<const TContract extends import("./types.js").RpcContract>(
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

/** Configuration shared only by the runtime-facing client core. */
export interface InternalRpcClientConfig extends RpcClientConfig, RpcClientRecoveryOptions {
  /**
   * Runtime-only correlation hook for a nested call made during one
   * host-attested direct invocation. This is deliberately absent from the
   * public RpcClientConfig.
   */
  authorityParentNonce?: () => string | undefined;
  /** Runtime lifecycle hook for every outbound operation, including calls
   * made through scoped request clients and typed peers. The hook observes the
   * exact promise without changing RPC results or error semantics. */
  onOutboundOperation?: (operation: Promise<unknown>) => void;
}

function publicCaller(caller: AuthenticatedCaller): AuthenticatedCaller {
  return {
    callerId: caller.callerId,
    callerKind: caller.callerKind,
    ...(caller.callerPanelId ? { callerPanelId: caller.callerPanelId } : {}),
    ...(caller.userId ? { userId: caller.userId } : {}),
    ...(caller.workspaceId ? { workspaceId: caller.workspaceId } : {}),
  };
}

export function createRpcClient(
  config: RpcClientConfig & RpcClientRecoveryOptions
): import("./types.js").RpcClient {
  return schemaRpcClient(createRpcClientCore(config));
}

export function createInternalRpcClient(config: InternalRpcClientConfig): RpcWireClient {
  return createRpcClientCore(config);
}

function createRpcClientCore(config: InternalRpcClientConfig): RpcWireClient {
  let retired = false;
  const retiredError = (): Error => new Error(`RPC client "${config.selfId}" has been retired`);
  const requireActive = (): void => {
    if (retired) throw retiredError();
  };
  const operationSignal = (
    signal?: AbortSignal | null
  ): { signal: AbortSignal | null; cleanup: () => void } => {
    if (!config.lifetime) return { signal: signal ?? null, cleanup: () => {} };
    if (!signal) return { signal: config.lifetime, cleanup: () => {} };
    const controller = new AbortController();
    const abortForLifetime = (): void => controller.abort(config.lifetime?.reason);
    const abortForCall = (): void => controller.abort(signal.reason);
    config.lifetime.addEventListener("abort", abortForLifetime, { once: true });
    signal.addEventListener("abort", abortForCall, { once: true });
    // A call-specific cancellation is the caller's explicit intent when both
    // sources are already terminal by the time this operation is created.
    if (signal.aborted) abortForCall();
    else if (config.lifetime.aborted) abortForLifetime();
    return {
      signal: controller.signal,
      cleanup: () => {
        config.lifetime?.removeEventListener("abort", abortForLifetime);
        signal.removeEventListener("abort", abortForCall);
      },
    };
  };
  const selfCaller = callerForSelf(config.selfId, config.callerKind, config.workspaceId);
  const baseProvenance = (config.provenance?.length ? config.provenance : [selfCaller]).map(
    publicCaller
  );
  const exposedMethods = new Map<
    string,
    (request: RpcRequestContext) => unknown | Promise<unknown>
  >();
  const exposurePolicies = new Map<string, RpcExposure["entries"][number]>();
  function publishExposures(): void {
    if (config.publishExposures)
      void deliverEnvelope(
        makeEnvelope("main", {
          type: "exposure",
          entries: [...exposurePolicies.values()],
        })
      ).catch((error) => {
        // Exposure publication is retried when the transport reconnects. A
        // temporary outage must not raise a fatal development error overlay.
        console.warn("RPC exposure publication failed; retrying on reconnect", error);
      });
  }
  function declareExposure(
    name: string,
    kind: "method" | "stream" | "event",
    website: WebsiteMethodPolicy
  ): void {
    validateWebsiteMethodPolicy(website, name);
    exposurePolicies.set(`${kind}:${name}`, { name, kind, website: { ...website } });
  }
  const streamingHandlers = new Map<string, RpcContextStreamingHandler>();
  const eventListeners = new Map<string, Set<(event: RpcEventContext) => void>>();
  const statusSubscriptions = new Set<{
    handler: (status: RpcConnectionStatus) => void;
    unsubscribe: () => void;
  }>();
  const settleHeadWithinLifetime = <T>(
    operation: Promise<T>,
    disposeLate?: (value: T) => void
  ): Promise<T> => {
    if (!config.lifetime) return operation;
    return new Promise<T>((resolve, reject) => {
      let aborted = config.lifetime!.aborted;
      const onAbort = (): void => {
        aborted = true;
        reject(retiredError());
      };
      if (aborted) reject(retiredError());
      else config.lifetime!.addEventListener("abort", onAbort, { once: true });
      operation
        .then((value) => {
          if (aborted) disposeLate?.(value);
          else resolve(value);
        }, reject)
        .finally(() => config.lifetime!.removeEventListener("abort", onAbort));
    });
  };
  const responseWithinLifetime = (response: Response, release: () => void): Response => {
    if (!config.lifetime) {
      release();
      return response;
    }
    if (!response.body) {
      release();
      return response;
    }
    return responseFromDecodedStream({
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      finalUrl: response.url,
      body: bodyWithinLifetime(response.body, release),
    });
  };
  const bodyWithinLifetime = (
    body: ReadableStream<Uint8Array>,
    release: () => void = () => {}
  ): ReadableStream<Uint8Array> => {
    if (!config.lifetime) {
      release();
      return body;
    }
    const lifetime = config.lifetime;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    let ended = false;
    let onAbort: () => void;
    const cleanup = (): void => {
      lifetime.removeEventListener("abort", onAbort);
      release();
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        reader = body.getReader();
        onAbort = () => {
          if (ended) return;
          ended = true;
          void reader.cancel(retiredError()).catch(() => {});
          controller.error(retiredError());
          cleanup();
        };
        lifetime.addEventListener("abort", onAbort, { once: true });
        if (lifetime.aborted) onAbort();
      },
      async pull(controller) {
        if (ended) return;
        try {
          const next = await reader.read();
          if (ended) return;
          if (next.done) {
            ended = true;
            cleanup();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          if (ended) return;
          ended = true;
          cleanup();
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (ended) return;
        ended = true;
        cleanup();
        await reader.cancel(reason);
      },
    });
  };
  const observeOutbound = <T>(operation: Promise<T>): Promise<T> => {
    const owned = settleHeadWithinLifetime(operation);
    config.onOutboundOperation?.(owned);
    return owned;
  };
  const pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout> | null;
      abortCleanup: (() => void) | null;
      cancellationReason: Error | null;
      cancellationSend: Promise<void> | null;
      cancellationDeliveryError: Error | null;
      responseSettling: boolean;
      /** Envelope target — drives the direct-server vs routed rejection policy (§3.4). */
      target: string;
      destination?: RpcDestination;
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
      destination?: RpcDestination;
    }
  >();
  const activeStreamingHandlers = new Map<
    string,
    { abort: AbortController; caller: AuthenticatedCaller; envelope: RpcEnvelope }
  >();
  const activeRequestHandlers = new Map<
    string,
    { abort: AbortController; caller: AuthenticatedCaller; envelope: RpcEnvelope }
  >();
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? null;

  function makeEnvelope(
    targetId: string,
    message: RpcMessage,
    options?: RpcCallOptions | RpcStreamOptions,
    provenance: AuthenticatedCaller[] = baseProvenance
  ): RpcEnvelope {
    const parent = invocationParentFor(options);
    const executionSessionNonce =
      message.type === "request" || message.type === "stream-request" || message.type === "event"
        ? executionSessionNonceFor(options)
        : undefined;
    // An evaluated execution admission is the complete, durable trust unit for
    // this request. Do not also couple it to the transient direct invocation
    // that happened to start the work: that handler may return while its
    // journaled/background execution is still legitimately running.
    const authorityParentNonce =
      !executionSessionNonce &&
      (message.type === "request" || message.type === "stream-request" || message.type === "event")
        ? (parent?.nonce ?? config.authorityParentNonce?.())
        : undefined;
    const carriedMessage =
      (authorityParentNonce || executionSessionNonce) &&
      (message.type === "request" || message.type === "stream-request" || message.type === "event")
        ? ({
            ...message,
            ...(authorityParentNonce ? { authorityParentNonce } : {}),
            ...(executionSessionNonce ? { executionSessionNonce } : {}),
          } satisfies InternalRpcRequest | InternalRpcStreamRequest | InternalRpcEvent)
        : executionSessionNonce && message.type === "event"
          ? ({
              ...message,
              executionSessionNonce,
            } satisfies InternalRpcEvent)
          : message;
    return {
      from: config.selfId,
      target: targetId,
      ...(options?.destination ? { destination: options.destination } : {}),
      delivery: {
        caller: parent?.caller ?? selfCaller,
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(options?.readOnly ? { readOnly: true } : {}),
      },
      provenance: parent?.provenance ? [...parent.provenance] : provenance,
      message: carriedMessage,
    };
  }

  function scopedClientFor(inbound: RpcEnvelope): RpcWireClient {
    const scopedProvenance = appendSelf(
      (inbound.provenance.length ? inbound.provenance : [inbound.delivery.caller]).map(
        publicCaller
      ),
      selfCaller
    );
    const parentNonce = (
      inbound.message as InternalRpcRequest | InternalRpcStreamRequest | InternalRpcEvent
    ).authorityParentNonce;
    const inheritedOptions = <T extends RpcCallOptions | RpcStreamOptions>(
      options?: T
    ): T | undefined =>
      parentNonce
        ? (mergeRpcOptions(options, bindInvocationParent({}, { nonce: parentNonce })) as T)
        : options;
    const scoped: RpcWireClient = {
      ...client,
      call: (targetId, method, args, options) =>
        observeOutbound(
          callWithProvenance(scopedProvenance, targetId, method, args, inheritedOptions(options))
        ),
      stream: (targetId, method, args, options) =>
        observeOutbound(
          Promise.resolve().then(() =>
            streamWithProvenance(
              scopedProvenance,
              targetId,
              method,
              args,
              inheritedOptions(options)
            )
          )
        ),
      streamReadable: (targetId, method, args, options) =>
        observeOutbound(
          Promise.resolve().then(() =>
            streamReadableWithProvenance(
              scopedProvenance,
              targetId,
              method,
              args,
              inheritedOptions(options)
            )
          )
        ),
      emit: (targetId, event, payload, options) =>
        observeOutbound(
          emitWithProvenance(scopedProvenance, targetId, event, payload, inheritedOptions(options))
        ),
      peer: (targetId, options) => createRpcPeer(scoped, targetId, options),
    };
    return registerRpcWireClient(scoped, (operation) => observeOutbound(operation()));
  }

  function requestContext(
    envelope: RpcEnvelope,
    message: RpcRequest | RpcStreamRequest,
    signal: AbortSignal
  ): RpcRequestContext {
    return {
      caller: publicCaller(envelope.delivery.caller),
      origin: publicCaller(originOfEnvelope(envelope)),
      method: message.method,
      args: message.args,
      signal,
      rpc: schemaRpcClient(scopedClientFor(envelope)),
    };
  }

  async function send(
    targetId: string,
    message: RpcMessage,
    options?: {
      idempotencyKey?: string;
      readOnly?: boolean;
      signal?: AbortSignal;
      destination?: RpcDestination;
    },
    provenance?: AuthenticatedCaller[],
    physicalSignalOverride?: AbortSignal | null
  ): Promise<void> {
    requireActive();
    const envelope = makeEnvelope(targetId, message, options, provenance);
    const operation = operationSignal(
      physicalSignalOverride === null ? undefined : (physicalSignalOverride ?? options?.signal)
    );
    try {
      await deliverEnvelope(envelope, operation.signal ?? undefined);
    } finally {
      operation.cleanup();
    }
  }

  async function deliverEnvelope(envelope: RpcEnvelope, signal?: AbortSignal): Promise<void> {
    if (
      envelope.target === config.selfId &&
      isLocalRpcDestination(envelope.destination, config.workspaceId)
    ) {
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

  function armStreamHeadTimer(
    requestId: string,
    timeoutMs: number | null = streamIdleTimeoutMs
  ): void {
    const entry = pendingStreams.get(requestId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (timeoutMs === null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
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

  function makeConnectionLostError(): RpcBoundaryError {
    return new RpcBoundaryError(CONNECTION_LOST_MESSAGE, "transport", SESSION_CONNECTION_LOST_CODE);
  }

  // Reject + remove every pending request whose target matches `predicate`,
  // clearing its deadline timer and abort wiring. The pending-call policy
  // (§3.4) uses it twice: direct-server pendings on pipe-down, routed pendings
  // on cold-recover.
  function rejectPendingRequests(
    predicate: (target: string, destination?: RpcDestination) => boolean,
    error: Error
  ): void {
    for (const [requestId, pending] of [...pendingRequests]) {
      if (!predicate(pending.target, pending.destination)) continue;
      pendingRequests.delete(requestId);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.abortCleanup?.();
      pending.reject(error);
    }
  }

  function requestPendingCancellation(
    requestId: string,
    pending: {
      cancellationReason: Error | null;
      cancellationSend: Promise<void> | null;
      cancellationDeliveryError: Error | null;
      timeout: ReturnType<typeof setTimeout> | null;
      target: string;
      destination?: RpcDestination;
    },
    reason: Error,
    provenance: AuthenticatedCaller[]
  ): void {
    if (pendingRequests.get(requestId) !== pending) return;
    if (pending.cancellationReason) return;
    pending.cancellationReason = reason;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    const options = pending.destination ? { destination: pending.destination } : undefined;
    const cancellation = send(
      pending.target,
      { type: "request-cancel", requestId, fromId: config.selfId },
      options,
      provenance
    );
    pending.cancellationSend = cancellation;
    // The original request remains pending for its terminal response even if
    // cancellation delivery fails; connection-loss handling is the authority
    // that settles an otherwise stranded receiver invocation.
    void cancellation.catch((error: unknown) => {
      if (pendingRequests.get(requestId) !== pending) return;
      pending.cancellationDeliveryError = error instanceof Error ? error : new Error(String(error));
    });
  }

  function handleResponse(envelope: RpcEnvelope, response: RpcResponse): void {
    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;
    if (!rpcDestinationMatchesCaller(pending.destination, envelope.delivery.caller)) return;
    if (pending.responseSettling) return;
    pending.responseSettling = true;
    const settle = (): void => {
      if (pendingRequests.get(response.requestId) !== pending) return;
      pendingRequests.delete(response.requestId);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.abortCleanup?.();
      if ("error" in response) {
        let err: Error;
        try {
          err = deserializeRpcFailure(response.error);
        } catch (error) {
          err = error instanceof Error ? error : new Error(String(error));
        }
        if (pending.cancellationReason && isRpcAborted(err)) {
          if (pending.cancellationDeliveryError) {
            pending.reject(
              new AggregateError(
                [pending.cancellationReason, pending.cancellationDeliveryError],
                "RPC cancellation was acknowledged but cancellation delivery also failed"
              )
            );
          } else {
            pending.reject(pending.cancellationReason);
          }
        } else if (pending.cancellationDeliveryError) {
          pending.reject(
            new AggregateError(
              [err, pending.cancellationDeliveryError],
              "RPC handler failed during cancellation and cancellation delivery also failed",
              { cause: err }
            )
          );
        } else {
          pending.reject(err);
        }
      } else if (pending.cancellationReason) {
        if (pending.cancellationDeliveryError) {
          pending.reject(
            new AggregateError(
              [pending.cancellationReason, pending.cancellationDeliveryError],
              "RPC cancellation was requested but could not be delivered"
            )
          );
        } else {
          pending.reject(pending.cancellationReason);
        }
      } else {
        pending.resolve(response.result);
      }
    };
    if (pending.cancellationSend) {
      // The ordinary response is the receiver's terminal receipt. Also join
      // delivery of our cancellation request before settling the owner.
      void pending.cancellationSend.then(settle, settle);
    } else settle();
  }

  function handleEvent(envelope: RpcEnvelope, event: RpcEvent): void {
    const listeners = eventListeners.get(event.event);
    if (!listeners) return;
    const context: RpcEventContext = {
      caller: publicCaller(envelope.delivery.caller),
      origin: publicCaller(originOfEnvelope(envelope)),
      event: event.event,
      payload: event.payload,
    };
    for (const listener of listeners) listener(context);
  }

  function handleStreamFrame(envelope: RpcEnvelope, frame: RpcStreamFrameMessage): void {
    const entry = pendingStreams.get(frame.requestId);
    if (!entry || entry.bodyClosed) return;
    if (!rpcDestinationMatchesCaller(entry.destination, envelope.delivery.caller)) return;
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
      let parsed: { error: import("./types.js").RpcFailure };
      try {
        parsed = decodeRpcJson(frame.payload) as typeof parsed;
      } catch (cause) {
        parsed = {
          error: serializeRpcFailure(
            new RpcBoundaryError("Malformed streaming RPC error", "protocol", "EPROTOCOL", cause)
          ),
        };
      }
      let err: Error;
      try {
        err = deserializeRpcFailure(parsed.error);
      } catch (error) {
        err = error instanceof Error ? error : new Error(String(error));
      }
      if (entry.headEmitted) {
        entry.bodyClosed = true;
        entry.controller.error(err);
      } else {
        entry.rejectHead(err);
      }
      clearPendingStream(frame.requestId);
    }
  }

  function sameCaller(expected: AuthenticatedCaller, actual: AuthenticatedCaller): boolean {
    return expected.callerId === actual.callerId && expected.workspaceId === actual.workspaceId;
  }

  function handleStreamCancel(envelope: RpcEnvelope, cancel: RpcStreamCancel): void {
    const active = activeStreamingHandlers.get(cancel.requestId);
    if (active && sameCaller(active.caller, envelope.delivery.caller)) active.abort.abort();
  }

  function handleRequestCancel(envelope: RpcEnvelope, cancel: RpcRequestCancel): void {
    const active = activeRequestHandlers.get(cancel.requestId);
    if (active && sameCaller(active.caller, envelope.delivery.caller)) {
      active.abort.abort(rpcCallerAbortedError());
    }
  }

  function handleRequest(envelope: RpcEnvelope, request: RpcRequest): void {
    if (retired) return;
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
          error: {
            message: `Method "${request.method}" is not exposed by this endpoint`,
            errorKind: "application",
            code: "RPC_METHOD_NOT_EXPOSED",
            errorData: {
              kind: "rpc-endpoint",
              endpointId: config.selfId,
              requestedMethod: request.method,
            },
          },
        })
      ).catch(logResponseSendFailure);
      return;
    }
    const abort = new AbortController();
    activeRequestHandlers.set(request.requestId, {
      abort,
      caller: publicCaller(envelope.delivery.caller),
      envelope,
    });
    Promise.resolve()
      .then(() => {
        if (activeRequestHandlers.get(request.requestId)?.abort !== abort) return;
        return handler(requestContext(envelope, request, abort.signal));
      })
      .then(
        (result) => {
          if (activeRequestHandlers.get(request.requestId)?.abort !== abort) return;
          activeRequestHandlers.delete(request.requestId);
          return deliverEnvelope(
            responseEnvelopeFor(envelope, selfCaller, {
              type: "response",
              requestId: request.requestId,
              result,
            })
          ).catch(logResponseSendFailure);
        },
        (error) => {
          if (activeRequestHandlers.get(request.requestId)?.abort !== abort) return;
          activeRequestHandlers.delete(request.requestId);
          return deliverEnvelope(
            responseEnvelopeFor(envelope, selfCaller, {
              type: "response",
              requestId: request.requestId,
              error: serializeRpcFailure(error),
            })
          ).catch(logResponseSendFailure);
        }
      )
      .finally(() => {
        if (activeRequestHandlers.get(request.requestId)?.abort === abort) {
          activeRequestHandlers.delete(request.requestId);
        }
      });
  }

  function handleStreamRequest(envelope: RpcEnvelope, request: RpcStreamRequest): void {
    if (retired) return;
    const handler = streamingHandlers.get(request.method);
    const sendFrame = (frameType: number, payload: string): Promise<void> =>
      deliverEnvelope(
        responseEnvelopeFor(envelope, selfCaller, {
          type: "stream-frame",
          requestId: request.requestId,
          fromId: config.selfId,
          frameType,
          payload,
        })
      );
    if (!handler) {
      void sendFrame(
        FRAME_ERROR,
        JSON.stringify({
          status: 404,
          error: {
            message: `No streaming handler for method "${request.method}"`,
            errorKind: "application",
          },
        })
      ).catch(() => {});
      return;
    }
    const abort = new AbortController();
    activeStreamingHandlers.set(request.requestId, {
      abort,
      caller: publicCaller(envelope.delivery.caller),
      envelope,
    });
    const sink = (frame: StreamingMethodFrame): Promise<void> | void => {
      if (activeStreamingHandlers.get(request.requestId)?.abort !== abort) return;
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
      if (frame.kind === "end") {
        activeStreamingHandlers.delete(request.requestId);
        return sendFrame(FRAME_END, JSON.stringify({ bytesIn: frame.bytesIn }));
      }
      activeStreamingHandlers.delete(request.requestId);
      return sendFrame(
        FRAME_ERROR,
        encodeRpcJson({
          status: frame.status,
          error: frame.error,
        })
      );
    };
    Promise.resolve()
      .then(() => {
        if (activeStreamingHandlers.get(request.requestId)?.abort !== abort) return;
        return handler(requestContext(envelope, request, abort.signal), sink);
      })
      .catch((error) => {
        if (activeStreamingHandlers.get(request.requestId)?.abort !== abort) return;
        activeStreamingHandlers.delete(request.requestId);
        return sendFrame(
          FRAME_ERROR,
          encodeRpcJson({
            status: 502,
            error: serializeRpcFailure(error),
          })
        ).catch(() => {});
      })
      .finally(() => {
        if (activeStreamingHandlers.get(request.requestId)?.abort === abort) {
          activeStreamingHandlers.delete(request.requestId);
        }
      });
  }

  function handleEnvelope(envelope: RpcEnvelope): void {
    if (retired) return;
    if (!isLocalRpcDestination(envelope.destination, config.workspaceId)) return;
    const message = envelope.message;
    switch (message.type) {
      case "request":
        handleRequest(envelope, message);
        return;
      case "response":
        handleResponse(envelope, message);
        return;
      case "event":
        handleEvent(envelope, message);
        return;
      case "stream-request":
        handleStreamRequest(envelope, message);
        return;
      case "stream-frame":
        handleStreamFrame(envelope, message);
        return;
      case "stream-cancel":
        handleStreamCancel(envelope, message);
        return;
      case "request-cancel":
        handleRequestCancel(envelope, message);
        return;
    }
  }

  function invocationOptions<T extends { signal?: AbortSignal }>(options?: T): T | undefined {
    const signal = config.invocationSignal?.();
    if (!signal) return options;
    return mergeRpcOptions(options, {
      signal:
        options?.signal && options.signal !== signal
          ? AbortSignal.any([signal, options.signal])
          : signal,
    }) as T;
  }

  function callOnceWithProvenance(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown> {
    if (retired) return Promise.reject(retiredError());
    if (options?.signal?.aborted) {
      return Promise.reject(rpcCallerAbortedError(options.signal.reason));
    }
    const requestId = generateRequestId();
    const request: RpcRequest = {
      type: "request",
      requestId,
      fromId: config.selfId,
      method,
      args,
      ...(options?.causalParent ? { causalParent: options.causalParent } : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let abortCleanup: (() => void) | null = null;
      const pending = {
        resolve,
        reject,
        timeout: null as ReturnType<typeof setTimeout> | null,
        abortCleanup: null as (() => void) | null,
        cancellationReason: null as Error | null,
        cancellationSend: null as Promise<void> | null,
        cancellationDeliveryError: null as Error | null,
        responseSettling: false,
        target: targetId,
        ...(options?.destination ? { destination: options.destination } : {}),
      };
      // No implicit deadline: callers opt in with a positive timeoutMs when a
      // specific operation should be time-bounded.
      const effectiveTimeoutMs = options?.timeoutMs;
      if (effectiveTimeoutMs !== undefined && effectiveTimeoutMs > 0) {
        timeout = setTimeout(() => {
          requestPendingCancellation(
            requestId,
            pending,
            new Error(`RPC call timed out after ${effectiveTimeoutMs}ms`),
            provenance
          );
        }, effectiveTimeoutMs);
      }
      if (options?.signal) {
        const onAbort = (): void => {
          requestPendingCancellation(
            requestId,
            pending,
            rpcCallerAbortedError(options.signal?.reason),
            provenance
          );
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
      pending.timeout = timeout;
      pending.abortCleanup = abortCleanup;
      pendingRequests.set(requestId, pending);
      // Caller cancellation is conveyed by request-cancel while the original
      // transport request remains open to receive the handler's terminal
      // response. Only client destruction/disconnect aborts that transport.
      // The client lifetime is a physical transport owner; per-call aborts use
      // request-cancel and must leave this response route intact. Keep the
      // original options object so its invocation ancestry stays attached.
      void send(targetId, request, options, provenance, config.lifetime ?? null).catch((error) => {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        if (pending?.timeout) clearTimeout(pending.timeout);
        pending?.abortCleanup?.();
        pending.reject(error);
      });
    });
  }

  async function callWithProvenance(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown> {
    options = invocationOptions(options);
    for (;;) {
      try {
        return await callOnceWithProvenance(provenance, targetId, method, args, options);
      } catch (error) {
        const acquisitionMode = options?.authorityAcquisition ?? config.authorityAcquisition;
        const acquisitionId =
          acquisitionMode === "wait" ? acquisitionIdOf(error, config.selfId) : null;
        if (
          !acquisitionId ||
          (isServerTarget(targetId, options?.destination) && method === "authority.awaitDecision")
        ) {
          throw error;
        }

        // A human decision has no protocol deadline. The caller retains
        // lifecycle control through its AbortSignal; an explicit timeout on
        // the protected operation starts anew only when that operation is
        // retried after approval.
        // Waiting belongs to the same admitted caller and causal invocation.
        // Its control request must not reuse the protected effect's key.
        const waitOptions = mergeRpcOptions(options, {});
        delete waitOptions.timeoutMs;
        delete waitOptions.idempotencyKey;
        const outcome = await callOnceWithProvenance(
          provenance,
          "main",
          "authority.awaitDecision",
          [{ acquisitionId }],
          waitOptions
        );
        if (!outcome || typeof outcome !== "object" || !("state" in outcome))
          throw new RpcBoundaryError(
            "Authority decision returned an invalid outcome",
            "protocol",
            "INVALID_AUTHORITY_OUTCOME"
          );
        if (outcome.state !== "decided" && outcome.state !== "closed")
          throw new RpcBoundaryError(
            "Authority decision returned an invalid outcome",
            "protocol",
            "INVALID_AUTHORITY_OUTCOME"
          );
        if (outcome.state !== "decided") throw error;
      }
    }
  }

  function emitWithProvenance(
    provenance: AuthenticatedCaller[],
    targetId: string,
    event: string,
    payload: unknown,
    options?: RpcCallOptions
  ): Promise<void> {
    if (retired) return Promise.reject(retiredError());
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
    options = invocationOptions(options);
    if (retired) return Promise.reject(retiredError());
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
      // Body-capable transports pump the request body on their native wire;
      // transports that cannot must throw rather than silently dropping it.
      const operation = operationSignal(options?.signal);
      return settleHeadWithinLifetime(
        config.transport.stream(
          envelope,
          operation.signal,
          options?.body ? bodyWithinLifetime(options.body) : null,
          options?.headTimeoutMs,
          options?.trafficClass
        ),
        (late) => void late.body?.cancel(retiredError()).catch(() => {})
      )
        .then((response) => responseWithinLifetime(response, operation.cleanup))
        .catch((error) => {
          operation.cleanup();
          throw error;
        });
    }
    if (options?.body) {
      // The duplex stream-request/stream-frame envelope path (plain WS, panel
      // postMessage bridges) has no request-body channel at all — but a panel
      // shell bridge can still carry uploads through its dedicated upload hop
      // (`streamBody`, plan §1.6): the panel pumps the body across the bridge
      // as chunk messages and the HOST feeds it to its Iroh session.
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
        const operation = operationSignal(options?.signal);
        return settleHeadWithinLifetime(
          config.transport.streamBody(envelope, operation.signal, bodyWithinLifetime(options.body)),
          (late) => void late.body?.cancel(retiredError()).catch(() => {})
        )
          .then((response) => responseWithinLifetime(response, operation.cleanup))
          .catch((error) => {
            operation.cleanup();
            throw error;
          });
      }
      throw new Error("This RPC transport cannot stream a request body");
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
    options = invocationOptions(options);
    if (retired) return Promise.reject(retiredError());
    // Prefer a transport-native raw stream (notably React Native Iroh, where
    // whatwg-fetch Response cannot consume a ReadableStream body). Browser and
    // Node transports can losslessly unwrap the ordinary Response path.
    if (!config.transport.streamReadable) {
      return streamWithProvenance(provenance, targetId, method, args, options).then((response) => {
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          finalUrl: response.url,
          body:
            response.body ??
            new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
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
    const operation = operationSignal(options?.signal);
    return settleHeadWithinLifetime(
      config.transport.streamReadable(
        envelope,
        operation.signal,
        options?.body ? bodyWithinLifetime(options.body) : null,
        options?.headTimeoutMs,
        options?.trafficClass
      ),
      (late) => void late.body.cancel(retiredError()).catch(() => {})
    )
      .then((response) => {
        if (!config.lifetime) {
          operation.cleanup();
          return response;
        }
        return { ...response, body: bodyWithinLifetime(response.body, operation.cleanup) };
      })
      .catch((error) => {
        operation.cleanup();
        throw error;
      });
  }

  function peer(
    targetId: string,
    provenance: AuthenticatedCaller[] = baseProvenance,
    options?: RpcTargetOptions
  ): RpcPeer {
    return createRpcPeer(
      registerRpcOperationOwner(
        {
          call: (target, method, args, value) =>
            observeOutbound(callWithProvenance(provenance, target, method, args, value)),
          emit: (target, event, payload, value) =>
            observeOutbound(emitWithProvenance(provenance, target, event, payload, value)),
          on: client.on.bind(client),
        },
        (operation) => observeOutbound(operation())
      ),
      targetId,
      options
    );
  }

  async function streamImpl(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions
  ): Promise<Response> {
    requireActive();
    if (options?.signal?.aborted) throw rpcCallerAbortedError(options.signal.reason);
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
      const cancelOptions = options?.destination ? { destination: options.destination } : undefined;
      const envelope = makeEnvelope(
        targetId,
        { type: "stream-cancel", requestId, fromId: config.selfId },
        cancelOptions,
        provenance
      );
      void deliverEnvelope(envelope).catch(() => {});
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
      const err = rpcCallerAbortedError(signal?.reason);
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
      ...(options?.destination ? { destination: options.destination } : {}),
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
    return responseFromDecodedStream({
      status: head.status,
      statusText: head.statusText,
      headers: head.headerPairs,
      finalUrl: head.finalUrl,
      body: stream,
    });
  }

  const client: RpcWireClient = {
    selfId: config.selfId,
    expose(method, handler, website): void {
      requireActive();
      declareExposure(method, "method", website);
      exposedMethods.set(
        method,
        handler as (request: RpcRequestContext) => unknown | Promise<unknown>
      );
      publishExposures();
    },
    exposeAll(
      methods: RpcContextMethods,
      policies: Readonly<Record<string, WebsiteMethodPolicy>>
    ): void {
      requireActive();
      for (const name of Object.keys(methods)) validateWebsiteMethodPolicy(policies[name]!, name);
      for (const [name, handler] of Object.entries(methods)) {
        declareExposure(name, "method", policies[name]!);
        exposedMethods.set(
          name,
          handler as (request: RpcRequestContext) => unknown | Promise<unknown>
        );
      }
      publishExposures();
    },
    exposeStreaming(method, handler, website): void {
      requireActive();
      declareExposure(method, "stream", website);
      streamingHandlers.set(method, handler);
      publishExposures();
    },
    call(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ): Promise<unknown> {
      if (retired) return Promise.reject(retiredError());
      return observeOutbound(callWithProvenance(baseProvenance, targetId, method, args, options));
    },
    stream(targetId, method, args, options): Promise<Response> {
      if (retired) return Promise.reject(retiredError());
      return observeOutbound(
        Promise.resolve().then(() =>
          streamWithProvenance(baseProvenance, targetId, method, args, options)
        )
      );
    },
    streamReadable(targetId, method, args, options) {
      if (retired) return Promise.reject(retiredError());
      return observeOutbound(
        Promise.resolve().then(() =>
          streamReadableWithProvenance(baseProvenance, targetId, method, args, options)
        )
      );
    },
    emit(targetId, event, payload, options): Promise<void> {
      if (retired) return Promise.reject(retiredError());
      return observeOutbound(emitWithProvenance(baseProvenance, targetId, event, payload, options));
    },
    on(event, listener, website): () => void {
      requireActive();
      validateWebsiteMethodPolicy(website, event);
      const previous = exposurePolicies.get(`event:${event}`);
      if (previous && previous.website.kind !== website.kind)
        throw new Error(`Event ${event} listeners must agree on website exposure`);
      declareExposure(event, "event", website);
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(event, listeners);
      }
      listeners.add(listener);
      publishExposures();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          eventListeners.delete(event);
          exposurePolicies.delete(`event:${event}`);
          if (!retired) publishExposures();
        }
      };
    },
    peer: (targetId, options) => peer(targetId, baseProvenance, options),
    status(): RpcConnectionStatus {
      if (retired) return "disconnected";
      return config.transport.status?.() ?? "connected";
    },
    ready(): Promise<void> {
      if (retired) return Promise.reject(retiredError());
      return observeOutbound(config.transport.ready?.() ?? Promise.resolve());
    },
    onStatusChange(handler): () => void {
      requireActive();
      const unsubscribe = config.transport.onStatusChange?.(handler) ?? (() => {});
      const subscription = { handler, unsubscribe };
      statusSubscriptions.add(subscription);
      return () => {
        if (!statusSubscriptions.delete(subscription)) return;
        unsubscribe();
      };
    },
  };

  const unsubscribeMessage = config.transport.onMessage(handleEnvelope);

  // Pending-call policy (§3.4) — "nothing hangs, ever".
  //
  // Direct client→server responses are NEVER inboxed server-side, so any pipe
  // drop makes an in-flight direct-server call permanently unrecoverable. Reject
  // those pendings the instant the transport leaves `connected` (the reconnecting
  // Iroh owner reports `connecting` while it redials). Routed
  // caller↔caller pendings survive this flip: the server inbox can still replay
  // their responses across a clean reconnect. The one case inbox replay cannot
  // cover — a routed REQUEST or RESPONSE that was queued but never hit the
  // wire at pipe-down (nothing server-side to replay; a lost response strands
  // the REMOTE caller, whose pipe never went down) — is closed at the
  // TRANSPORT layer: the Iroh transport re-drives undelivered routed frames
  // on a `resubscribe` recovery, so every
  // surviving routed pending is guaranteed its request AND response delivery.
  // The remaining case — the request WAS delivered but the callee then
  // terminally dies (grace expiry / lease revoke), so no response will ever
  // exist — is closed SERVER-side: rpcServer tracks the callee per in-flight
  // routed request and, at the callee's terminal departure, sends the caller
  // a `routed-response-error` (RECONNECT_GRACE_EXPIRED), which the transport
  // turns into a rejecting response here.
  const unsubscribeStatus = config.transport.onStatusChange?.((status) => {
    if (status === "connected" && !retired) publishExposures();
    if (status !== "connected") {
      rejectPendingRequests(isServerTarget, makeConnectionLostError());
    }
  });

  // A routed pending is only truly lost on `cold-recover` (server session state
  // gone → no inbox to replay from); reject the remaining routed pendings then.
  // On `resubscribe` the inbox replay settles them, so leave them alone.
  const unsubscribeRecovery = config.onRecovery?.((kind) => {
    if (!retired) publishExposures();
    if (kind === "cold-recover") {
      rejectPendingRequests(
        (target, destination) => !isServerTarget(target, destination),
        makeConnectionLostError()
      );
    }
  });

  const retire = (): void => {
    if (retired) return;
    retired = true;
    const error = retiredError();
    unsubscribeMessage();
    unsubscribeStatus?.();
    unsubscribeRecovery?.();
    for (const subscription of statusSubscriptions) {
      subscription.handler("disconnected");
      subscription.unsubscribe();
    }
    statusSubscriptions.clear();
    for (const [requestId, pending] of pendingRequests) {
      void deliverEnvelope(
        makeEnvelope(
          pending.target,
          { type: "request-cancel", requestId, fromId: config.selfId },
          pending.destination ? { destination: pending.destination } : undefined
        )
      ).catch(() => {});
    }
    rejectPendingRequests(() => true, error);
    for (const [requestId, pending] of [...pendingStreams]) {
      pending.bodyClosed = true;
      if (pending.headEmitted) pending.controller.error(error);
      else pending.rejectHead(error);
      pending.cancel();
      clearPendingStream(requestId);
    }
    for (const [requestId, active] of [...activeRequestHandlers]) {
      activeRequestHandlers.delete(requestId);
      active.abort.abort(error);
      void deliverEnvelope(
        responseEnvelopeFor(active.envelope, selfCaller, {
          type: "response",
          requestId,
          error: { message: error.message, errorKind: "transport" },
        })
      ).catch(() => {});
    }
    for (const [requestId, active] of [...activeStreamingHandlers]) {
      activeStreamingHandlers.delete(requestId);
      active.abort.abort(error);
      void deliverEnvelope(
        responseEnvelopeFor(active.envelope, selfCaller, {
          type: "stream-frame",
          requestId,
          fromId: config.selfId,
          frameType: FRAME_ERROR,
          payload: JSON.stringify({
            status: 503,
            error: { message: error.message, errorKind: "transport" },
          }),
        })
      ).catch(() => {});
    }
    eventListeners.clear();
    exposedMethods.clear();
    exposurePolicies.clear();
    streamingHandlers.clear();
  };
  config.lifetime?.addEventListener("abort", retire, { once: true });
  if (config.lifetime?.aborted) retire();

  return registerRpcWireClient(client, (operation) => observeOutbound(operation()));
}

/** One client view path: peers must retain the same options as direct effects. */
function withCallOptions(
  base: RpcWireClient,
  map: (options?: RpcCallOptions | RpcStreamOptions) => RpcCallOptions & RpcStreamOptions,
  enter: <T>(operation: () => T) => T = (operation) => operation()
): RpcWireClient {
  const view: RpcWireClient = {
    selfId: base.selfId,
    expose: base.expose.bind(base),
    exposeAll: base.exposeAll.bind(base),
    exposeStreaming: base.exposeStreaming.bind(base),
    call: (target, method, args, options) =>
      enter(() => base.call(target, method, args, map(options))),
    stream: (target, method, args, options) =>
      enter(() => base.stream(target, method, args, map(options))),
    streamReadable: (target, method, args, options) =>
      enter(() => base.streamReadable(target, method, args, map(options))),
    emit: (target, event, payload, options) =>
      enter(() => base.emit(target, event, payload, map(options))),
    on: base.on.bind(base),
    peer: (target, options) => createRpcPeer(view, target, options),
    status: base.status.bind(base),
    ready: base.ready.bind(base),
    onStatusChange: base.onStatusChange.bind(base),
  };
  return registerRpcWireClient(Object.freeze(view), (operation) =>
    enter(() => ownRpcOperation(base, operation))
  );
}

function clientView<Client extends import("./types.js").RpcClient | RpcWireClient>(
  base: Client,
  map: Parameters<typeof withCallOptions>[1],
  enter?: Parameters<typeof withCallOptions>[2]
): Client {
  const wire = wireClientFor(base);
  const view = withCallOptions(wire, map, enter);
  return (wire === base ? view : schemaRpcClient(view)) as Client;
}

/** Enter the owning async context for every outbound effect, including peer calls.
 * Options retain separately admitted execution, provenance and cancellation. */
export function withRpcContext<Client extends import("./types.js").RpcClient | RpcWireClient>(
  base: Client,
  enter: <T>(operation: () => T) => T
): Client {
  return clientView(base, (options) => options ?? {}, enter) as unknown as Client;
}

/** Bind exact upstream provenance while retaining any evaluated execution admission. */
export function withCausalParent<Client extends import("./types.js").RpcClient | RpcWireClient>(
  base: Client,
  causalParent: RpcCausalParent
): Client {
  return clientView(base, (options) =>
    mergeRpcOptions(options, { causalParent })
  ) as unknown as Client;
}

/** Bind every call and stream to its owning operation without replacing local cancellation. */
export function withRpcAbortSignal<Client extends import("./types.js").RpcClient | RpcWireClient>(
  base: Client,
  signal: AbortSignal
): Client {
  return clientView(base, (options) =>
    mergeRpcOptions(options, {
      signal:
        options?.signal && options.signal !== signal
          ? AbortSignal.any([signal, options.signal])
          : signal,
    })
  ) as unknown as Client;
}

/** Runtime-only client view that binds every outbound effect to one host admission. */
export function withExecutionAdmission<
  Client extends import("./types.js").RpcClient | RpcWireClient,
>(base: Client, nonce: string): Client {
  return clientView(base, (options) =>
    mergeRpcOptions(options, bindExecutionSession({}, nonce))
  ) as unknown as Client;
}
