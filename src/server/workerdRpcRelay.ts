import { deserializeRpcFailure } from "@vibestudio/rpc";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { doTargetId, type DORefParam } from "@vibestudio/shared/workspaceServiceRpc";
import {
  decodeRpcJson,
  encodeRpcJson,
  envelopeFromMessage,
  RemoteRpcError,
  type CallerKind,
  type RpcEnvelope,
  type RpcCausalParent,
  type RpcResponse,
} from "@vibestudio/rpc";
import type { AttestedCaller, DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import { Pool, type Dispatcher } from "undici";
import { isInternalDOSource } from "./internalDOs/internalDoLoader.js";
import { doExecutableHeaders } from "./doExecutableDispatch.js";
import { EntityNotCreatedError } from "@vibestudio/shared/runtime/entitySpec";
import {
  DURABLE_WORK_READY_HEADER,
  decodeDurableWorkReady,
  parseDurableWorkReady,
  type DurableWorkQueue,
} from "@vibestudio/shared/durableWork";

export type DORef = DORefParam;

/** Each workerd endpoint owns its transport pool and its generation retirement. */
const workerdConnectionDispatchers = new Map<string, Dispatcher>();
type WorkerdHttpObservation = ReturnType<typeof createWorkerdHttpObservation>;
const responseObservations = new WeakMap<Response, WorkerdHttpObservation>();

type WorkerdHttpExchange = {
  localPort?: number;
  remotePort?: number;
  requestCreatedAtMs?: number;
  requestSentAtMs?: number;
  requestBodySentAtMs?: number;
  responseStatus?: number;
  responseHeadersAtMs?: number;
  responseConnection?: string;
  responseKeepAlive?: string;
  socketPreviousResponseStatus?: number;
  socketPreviousResponseConnection?: string;
  socketPreviousResponseKeepAlive?: string;
  socketPreviousResponseAgeMs?: number;
  socketPreviousResponseBodyAgeMs?: number;
  requestErrorAtMs?: number;
  phase?: "request-sent" | "response-headers" | "request-error" | "response-body-complete";
  responseBodyComplete?: boolean;
  requestError?: { name: string; code?: string; syscall?: string; errno?: number };
};

type WorkerdHttpObservationState = {
  metadata: {
    source: string;
    className: string;
    method: string;
    requestId?: string;
  };
  startedAt: number;
  exchanges: Map<object, WorkerdHttpExchange>;
  signal?: AbortSignal;
};

const workerdHttpObservation = new AsyncLocalStorage<WorkerdHttpObservationState>();
const workerdRequestBodies = new WeakMap<object, WorkerdHttpObservationState>();
const workerdRequestObservations = new WeakMap<object, WorkerdHttpObservationState>();
const workerdRequestSockets = new WeakMap<object, object>();
type WorkerdSocketProtocolFacts = {
  responseStatus?: number;
  responseConnection?: string;
  responseKeepAlive?: string;
  responseAtMs?: number;
  responseBodyCompleteAtMs?: number;
};
const workerdSocketProtocolFacts = new WeakMap<object, WorkerdSocketProtocolFacts>();
const workerdRequestProtocolFacts = new WeakMap<object, WorkerdSocketProtocolFacts>();

function exchangeFor(request: unknown): WorkerdHttpExchange | undefined {
  if (!request || typeof request !== "object") return undefined;
  const state = workerdRequestObservations.get(request);
  if (!state) return undefined;
  let exchange = state.exchanges.get(request);
  if (!exchange) {
    // The operation may make a primary request and a cancellation request.
    // Keep a hard bound even if a caller accidentally loops within one scope.
    if (state.exchanges.size >= 4) return undefined;
    exchange = {};
    state.exchanges.set(request, exchange);
  }
  return exchange;
}

function responseHeaderValue(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  for (let index = 0; index + 1 < headers.length; index += 2) {
    const rawName = headers[index];
    const rawValue = headers[index + 1];
    const headerName =
      typeof rawName === "string"
        ? rawName
        : rawName instanceof Uint8Array
          ? Buffer.from(rawName).toString("latin1")
          : undefined;
    if (headerName?.toLowerCase() !== name) continue;
    const headerValue =
      typeof rawValue === "string"
        ? rawValue
        : rawValue instanceof Uint8Array
          ? Buffer.from(rawValue).toString("latin1")
          : undefined;
    return headerValue?.slice(0, 128);
  }
  return undefined;
}

channel("undici:request:create").subscribe((event: unknown) => {
  if (!event || typeof event !== "object") return;
  const detail = event as { request?: unknown };
  const requestBody =
    detail.request && typeof detail.request === "object"
      ? (detail.request as { body?: unknown }).body
      : undefined;
  const state =
    requestBody && typeof requestBody === "object"
      ? workerdRequestBodies.get(requestBody)
      : undefined;
  if (state && detail.request && typeof detail.request === "object") {
    workerdRequestObservations.set(detail.request, state);
    const exchange = exchangeFor(detail.request);
    if (exchange) exchange.requestCreatedAtMs = Math.max(0, Date.now() - state.startedAt);
  }
});

channel("undici:request:bodySent").subscribe((event: unknown) => {
  if (!event || typeof event !== "object") return;
  const detail = event as { request?: unknown };
  const exchange = exchangeFor(detail.request);
  if (!exchange) return;
  const state = workerdRequestObservations.get(detail.request as object);
  if (state) exchange.requestBodySentAtMs = Math.max(0, Date.now() - state.startedAt);
});

channel("undici:client:sendHeaders").subscribe((event: unknown) => {
  if (!event || typeof event !== "object") return;
  const detail = event as { request?: unknown; socket?: unknown };
  const exchange = exchangeFor(detail.request);
  if (!exchange || !detail.socket || typeof detail.socket !== "object") return;
  const state = workerdRequestObservations.get(detail.request as object);
  if (state) exchange.requestSentAtMs = Math.max(0, Date.now() - state.startedAt);
  const socket = detail.socket as { localPort?: unknown; remotePort?: unknown };
  if (detail.request && typeof detail.request === "object") {
    workerdRequestSockets.set(detail.request, detail.socket);
  }
  const previousResponse = workerdSocketProtocolFacts.get(detail.socket);
  if (previousResponse?.responseAtMs !== undefined) {
    const now = Date.now();
    exchange.socketPreviousResponseStatus = previousResponse.responseStatus;
    exchange.socketPreviousResponseConnection = previousResponse.responseConnection;
    exchange.socketPreviousResponseKeepAlive = previousResponse.responseKeepAlive;
    exchange.socketPreviousResponseAgeMs = Math.max(0, now - previousResponse.responseAtMs);
    if (previousResponse.responseBodyCompleteAtMs !== undefined) {
      exchange.socketPreviousResponseBodyAgeMs = Math.max(
        0,
        now - previousResponse.responseBodyCompleteAtMs
      );
    }
  }
  if (typeof socket.localPort === "number") exchange.localPort = socket.localPort;
  if (typeof socket.remotePort === "number") exchange.remotePort = socket.remotePort;
  exchange.phase = "request-sent";
});

channel("undici:request:headers").subscribe((event: unknown) => {
  if (!event || typeof event !== "object") return;
  const detail = event as {
    request?: unknown;
    response?: { statusCode?: unknown; headers?: unknown };
  };
  const exchange = exchangeFor(detail.request);
  const state = workerdRequestObservations.get(detail.request as object);
  if (exchange && typeof detail.response?.statusCode === "number") {
    exchange.responseStatus = detail.response.statusCode;
    if (state) exchange.responseHeadersAtMs = Math.max(0, Date.now() - state.startedAt);
    exchange.responseConnection = responseHeaderValue(detail.response.headers, "connection");
    exchange.responseKeepAlive = responseHeaderValue(detail.response.headers, "keep-alive");
    const socket =
      detail.request && typeof detail.request === "object"
        ? workerdRequestSockets.get(detail.request)
        : undefined;
    if (socket) {
      const facts: WorkerdSocketProtocolFacts = {
        responseStatus: exchange.responseStatus,
        responseConnection: exchange.responseConnection,
        responseKeepAlive: exchange.responseKeepAlive,
        responseAtMs: Date.now(),
      };
      workerdSocketProtocolFacts.set(socket, facts);
      if (detail.request && typeof detail.request === "object") {
        workerdRequestProtocolFacts.set(detail.request, facts);
      }
    }
    exchange.phase = "response-headers";
  }
});

channel("undici:request:trailers").subscribe((event: unknown) => {
  if (!event || typeof event !== "object") return;
  const detail = event as { request?: unknown };
  if (!detail.request || typeof detail.request !== "object") return;
  const facts = workerdRequestProtocolFacts.get(detail.request);
  if (facts) facts.responseBodyCompleteAtMs = Date.now();
});

channel("undici:request:error").subscribe((event: unknown) => {
  if (!event || typeof event !== "object") return;
  const detail = event as { request?: unknown; error?: unknown };
  const exchange = exchangeFor(detail.request);
  const state = workerdRequestObservations.get(detail.request as object);
  if (!exchange || !detail.error || typeof detail.error !== "object") return;
  if (state) exchange.requestErrorAtMs = Math.max(0, Date.now() - state.startedAt);
  const error = detail.error as {
    name?: unknown;
    code?: unknown;
    syscall?: unknown;
    errno?: unknown;
  };
  exchange.requestError = {
    name: typeof error.name === "string" ? error.name.slice(0, 80) : "Error",
    ...(typeof error.code === "string" ? { code: error.code.slice(0, 80) } : {}),
    ...(typeof error.syscall === "string" ? { syscall: error.syscall.slice(0, 80) } : {}),
    ...(typeof error.errno === "number" ? { errno: error.errno } : {}),
  };
  exchange.phase = "request-error";
});

/** Run a workerd HTTP exchange with bounded failure-only transport evidence. */
export function createWorkerdHttpObservation(
  metadata: WorkerdHttpObservationState["metadata"],
  signal?: AbortSignal
): {
  fetch: <T extends Response>(operation: () => Promise<T>) => Promise<T>;
  readText: (response: Response) => Promise<string>;
  readArrayBuffer: (response: Response) => Promise<ArrayBuffer>;
} {
  const state: WorkerdHttpObservationState = {
    metadata,
    startedAt: Date.now(),
    exchanges: new Map(),
    ...(signal ? { signal } : {}),
  };
  let responseCompleted = false;
  const observe = async <T>(operation: () => Promise<T>): Promise<T> =>
    workerdHttpObservation.run(state, async () => {
      try {
        return await operation();
      } catch (error) {
        if (!responseCompleted && !state.signal?.aborted) {
          console.warn(
            "[WorkerdHttp] request failed",
            JSON.stringify({
              ...state.metadata,
              elapsedMs: Math.max(0, Date.now() - state.startedAt),
              exchanges: [...state.exchanges.values()].slice(0, 4),
            })
          );
        }
        throw error;
      }
    });
  return {
    fetch: observe,
    readText: (response) =>
      observe(async () => {
        const body = await response.text();
        responseCompleted = true;
        for (const exchange of state.exchanges.values()) {
          exchange.responseBodyComplete = true;
          exchange.phase = "response-body-complete";
        }
        return body;
      }),
    readArrayBuffer: (response) =>
      observe(async () => {
        const body = await response.arrayBuffer();
        responseCompleted = true;
        for (const exchange of state.exchanges.values()) {
          exchange.responseBodyComplete = true;
          exchange.phase = "response-body-complete";
        }
        return body;
      }),
  };
}

export async function readWorkerdResponseText(response: Response): Promise<string> {
  const observation = responseObservations.get(response);
  if (!observation) return response.text();
  const body = await observation.readText(response);
  responseObservations.delete(response);
  return body;
}

async function readWorkerdResponseArrayBuffer(response: Response): Promise<ArrayBuffer> {
  const observation = responseObservations.get(response);
  if (!observation) return response.arrayBuffer();
  const body = await observation.readArrayBuffer(response);
  responseObservations.delete(response);
  return body;
}

export function getWorkerdConnectionDispatcher(endpoint: string): Dispatcher {
  const origin = new URL(endpoint).origin;
  let dispatcher = workerdConnectionDispatchers.get(origin);
  if (!dispatcher) {
    const pool = new Pool(origin, {
      // Semantic invocation lifetime is controlled by its owner and signal.
      headersTimeout: 0,
      bodyTimeout: 0,
      // A socket belongs to one RPC through its terminal response-body event.
      // Undici's p=0 sends Connection: close and retires that socket after EOF
      // (or cancellation), so a later invocation never trusts an idle socket
      // after workerd may have sent FIN. The origin Pool still owns all active
      // sockets and can retire them together with the provider generation.
      // Calls remain concurrent; POST failures are surfaced without replay.
      pipelining: 0,
    });
    dispatcher = withWorkerdHttpObservation(pool);
    workerdConnectionDispatchers.set(origin, dispatcher);
  }
  return dispatcher;
}

/** Bind each pooled request body to the observation active when it was queued.
 * Undici may later dispatch it while running the async context of the socket's
 * original request, so diagnostic-channel listeners cannot rely on ALS alone. */
export function withWorkerdHttpObservation(dispatcher: Dispatcher): Dispatcher {
  return dispatcher.compose((dispatch) => (options, handler) => {
    const state = workerdHttpObservation.getStore();
    if (state && options.body && typeof options.body === "object") {
      workerdRequestBodies.set(options.body, state);
    }
    return dispatch(options, handler);
  });
}

/** Retiring one process must never sever another workspace's active requests. */
export async function destroyWorkerdConnections(endpoint: string, reason: string): Promise<void> {
  const origin = new URL(endpoint).origin;
  const dispatcher = workerdConnectionDispatchers.get(origin);
  workerdConnectionDispatchers.delete(origin);
  if (dispatcher) await dispatcher.destroy(new Error(reason));
}

type RelayLane = {
  seals: Map<
    string,
    | {
        code: string;
        message: string;
        errorData?: Record<string, unknown>;
      }
    | undefined
  >;
  inFlight: number;
  drained: Promise<void>;
  resolveDrained: () => void;
};

/**
 * Process-local relay admission for runtime DO entities. Retirement seals the
 * target after its lifecycle prepare receipt, waits for every relay already
 * admitted here, then retires the durable identity. This is the authoritative
 * race boundary: individual services do not need bespoke "late message"
 * cleanup ordering, and no new relay can enter between the drain and retire.
 */
const entityRelayLanes = new Map<string, RelayLane>();

function createRelayLane(): RelayLane {
  let resolveDrained: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  return { seals: new Map(), inFlight: 0, drained, resolveDrained };
}

export function beginDurableObjectRelay(targetId: string): () => void {
  let lane = entityRelayLanes.get(targetId);
  if (!lane) {
    lane = createRelayLane();
    entityRelayLanes.set(targetId, lane);
  }
  if (lane.seals.size > 0) {
    const sealedError = [...lane.seals.values()].find((error) => error !== undefined);
    if (sealedError) {
      throw new RemoteRpcError(
        sealedError.message,
        "service",
        sealedError.code,
        sealedError.errorData
      );
    }
    throw new EntityNotCreatedError(targetId);
  }
  const activeLane = lane;
  activeLane.inFlight += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeLane.inFlight -= 1;
    if (activeLane.seals.size > 0 && activeLane.inFlight === 0) activeLane.resolveDrained();
    if (
      activeLane.seals.size === 0 &&
      activeLane.inFlight === 0 &&
      entityRelayLanes.get(targetId) === activeLane
    ) {
      entityRelayLanes.delete(targetId);
    }
  };
}

/** Seal a runtime DO target against new relays and await all admitted calls. */
export async function sealAndDrainDurableObjectRelays(
  targetId: string,
  ownerId: string,
  sealedError?: { code: string; message: string; errorData?: Record<string, unknown> }
): Promise<void> {
  let lane = entityRelayLanes.get(targetId);
  if (!lane) {
    lane = createRelayLane();
    entityRelayLanes.set(targetId, lane);
  }
  lane.seals.set(ownerId, sealedError);
  if (lane.inFlight === 0) lane.resolveDrained();
  await lane.drained;
}

/** Release a retirement seal after the entity row is retired or retirement aborts. */
export function releaseDurableObjectRelaySeal(targetId: string, ownerId: string): void {
  const lane = entityRelayLanes.get(targetId);
  if (!lane) return;
  lane.seals.delete(ownerId);
  if (lane.seals.size === 0 && lane.inFlight === 0) entityRelayLanes.delete(targetId);
}

export function doRefKey(ref: DORef): string {
  return `${ref.source}:${ref.className}/${ref.objectKey}`;
}

/** Pack a userland DO ref for the UniversalDO facet host (see doDispatch). */
export function encodeUniversalKey(ref: DORef): string {
  return [ref.source, ref.className, ref.objectKey].map(encodeURIComponent).join("|");
}

export function doRefUrl(ref: DORef, method: string): string {
  const methodPath = method.split("/").map(encodeURIComponent).join("/");
  // Userland DOs route through the UniversalDO facet host; internal DOs keep
  // their static per-class `/_w/` namespaces. Kept in sync with doDispatch.ts.
  if (!isInternalDOSource(ref.source)) {
    return `/_u/${encodeURIComponent(encodeUniversalKey(ref))}/${methodPath}`;
  }
  const sourcePath = ref.source.split("/").map(encodeURIComponent).join("/");
  return `/_w/${sourcePath}/${encodeURIComponent(ref.className)}/${encodeURIComponent(ref.objectKey)}/${methodPath}`;
}

export interface DurableObjectRelayDeps {
  resolveExecutableAdmission?: import("./doExecutableDispatch.js").DoExecutableAdmissionResolver;
  workerdUrl: string;
  workerdGatewayToken: string;
  workerdDispatchSecret?: string;
  callerId?: string;
  callerKind?: string;
  callerPanelId?: string;
  /** Host-verified owning account projected into the userland caller envelope. */
  userId?: string;
  callerWorkspaceId?: string;
  /** Fresh host mediation bound to this exact method and DO object. */
  authorization?: DirectAuthorityAttestation;
  /** Correlation id for this call; lets the DO match a later deferred reply. */
  requestId?: string;
  /** Optional dedup key, propagated so reissued calls collapse server-side. */
  idempotencyKey?: string;
  /** Read-only containment flag propagated through the request envelope. */
  readOnly?: boolean;
  /** Exact upstream invocation coordinate; provenance only, never authorization. */
  causalParent?: RpcCausalParent;
  /** Disposable post-commit readiness acceleration for the exact receiver. */
  onWorkReady?: (queues: DurableWorkQueue[]) => void;
}

function generateRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function callerFromDeps(deps: DurableObjectRelayDeps): AttestedCaller {
  return {
    callerId: deps.callerId ?? "main",
    callerKind: (deps.callerKind as CallerKind | undefined) ?? "server",
    ...(deps.callerPanelId ? { callerPanelId: deps.callerPanelId } : {}),
    ...(deps.userId ? { userId: deps.userId } : {}),
    ...(deps.callerWorkspaceId ? { workspaceId: deps.callerWorkspaceId } : {}),
    ...(deps.authorization ? { authorization: deps.authorization } : {}),
  };
}

function describeFetchCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const fields = cause as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    address?: unknown;
    port?: unknown;
    socket?: unknown;
  };
  const parts = [`${cause.name}: ${cause.message}`];
  for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${value}`);
    }
  }
  if (fields.socket && typeof fields.socket === "object") {
    const socket = fields.socket as Record<string, unknown>;
    for (const key of [
      "localAddress",
      "localPort",
      "remoteAddress",
      "remotePort",
      "bytesWritten",
      "bytesRead",
    ]) {
      const value = socket[key];
      if (typeof value === "string" || typeof value === "number") parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}

export function describeWorkerdFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (!cause) return message;
  return `${message} (cause: ${describeFetchCause(cause)})`;
}

/**
 * POST an `RpcEnvelope` to a DO's single `__rpc` endpoint (the converged
 * inbound dispatch). Caller attribution rides in `envelope.delivery.caller` /
 * `provenance` — no `X-vibestudio-Rpc-Caller-*` headers. The DO feeds the
 * envelope to its `createRpcClient` core (`respond`/`deliver` → `handleEnvelope`
 * → `exposeAll`'d method) and returns a response envelope.
 */
async function fetchEnvelopeFromDO(
  ref: DORef,
  envelope: RpcEnvelope,
  deps: DurableObjectRelayDeps,
  signal?: AbortSignal
): Promise<Response> {
  const url = `${deps.workerdUrl}${doRefUrl(ref, "__rpc")}`;
  const message = envelope.message;
  const observation = createWorkerdHttpObservation(
    {
      source: ref.source,
      className: ref.className,
      method: message.type === "request" ? message.method : "__rpc",
      ...(message.type === "request" || message.type === "request-cancel"
        ? { requestId: message.requestId }
        : {}),
    },
    signal
  );
  let res: Response;
  try {
    res = await observation.fetch(() =>
      fetch(url, {
        method: "POST",
        headers: {
          ...doExecutableHeaders(ref, deps.resolveExecutableAdmission),
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.workerdGatewayToken}`,
          ...(deps.workerdDispatchSecret
            ? { "X-Vibestudio-Dispatch-Secret": deps.workerdDispatchSecret }
            : {}),
        },
        body: encodeRpcJson(envelope),
        ...(signal ? { signal } : {}),
        dispatcher: getWorkerdConnectionDispatcher(url),
      } as RequestInit)
    );
    responseObservations.set(res, observation);
  } catch (error) {
    const wrapped = new Error(
      `DO RPC fetch to ${url} failed: ${describeWorkerdFetchFailure(error)}`
    ) as Error & { cause?: unknown };
    wrapped.cause = error;
    throw wrapped;
  }

  return res;
}

async function postEnvelopeToDO(
  ref: DORef,
  envelope: RpcEnvelope,
  deps: DurableObjectRelayDeps,
  signal?: AbortSignal
): Promise<unknown> {
  const message = envelope.message;
  const requestId = message.type === "request" ? message.requestId : null;
  if (requestId && signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("DO RPC dispatch aborted");
  }
  let admitted = false;
  let cancellationRequested = false;
  let cancellationDelivery: Promise<void> | null = null;
  const sendCancellation = (): Promise<void> => {
    if (cancellationDelivery) return cancellationDelivery;
    if (!requestId) return Promise.resolve();
    const cancellation: RpcEnvelope = {
      ...envelope,
      message: {
        type: "request-cancel",
        requestId,
        fromId: message.type === "request" ? message.fromId : envelope.from,
      },
    };
    cancellationDelivery = (async () => {
      const response = await fetchEnvelopeFromDO(ref, cancellation, deps);
      await assertDurableObjectResponseOk(ref, response);
      // Own the acknowledgement body as well as the POST. This is a unary
      // cancellation delivery receipt, not background cleanup.
      await readWorkerdResponseArrayBuffer(response);
    })();
    void cancellationDelivery.catch(() => {});
    return cancellationDelivery;
  };
  const onAbort = (): void => {
    cancellationRequested = true;
    if (admitted) void sendCancellation();
  };
  if (requestId) signal?.addEventListener("abort", onAbort, { once: true });
  const dispatch = await (async () => {
    // Keep the original fetch and its response body owned through the target's
    // terminal response. Its headers are the target admission receipt; caller
    // cancellation is a second envelope, never an abort of this response path.
    const res = await fetchEnvelopeFromDO(ref, envelope, deps, requestId ? undefined : signal);
    admitted = true;
    if (cancellationRequested) void sendCancellation();
    await assertDurableObjectResponseOk(ref, res);
    return decodeRpcJson(await readWorkerdResponseText(res)) as RpcEnvelope;
  })().then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason })
  );
  if (requestId) signal?.removeEventListener("abort", onAbort);
  const [cancellation] = await Promise.allSettled(
    cancellationDelivery ? [cancellationDelivery] : []
  );
  // Durable-work readiness describes committed receiver state. Observe it
  // even when cancellation delivery or the receiver's application result
  // failed, since the receiver may have committed queue work before either
  // failure became terminal.
  if (dispatch.status === "fulfilled") {
    const responseMessage = dispatch.value.message as RpcResponse | undefined;
    const ready = responseMessage?.metadata?.durableWorkReady;
    if (ready !== undefined) {
      try {
        const queues = parseDurableWorkReady(ready);
        if (queues.length > 0) deps.onWorkReady?.(queues);
      } catch (error) {
        // The owner registry remains the correctness backstop. A malformed
        // disposable hint must not turn committed work into an apparent failure.
        console.error("[WorkerdRpcRelay] ignored invalid durable-work receipt", error);
      }
    }
  }
  if (dispatch.status === "rejected" && cancellation?.status === "rejected") {
    throw new AggregateError(
      [dispatch.reason, cancellation.reason],
      "DO dispatch and cancellation delivery both failed"
    );
  }
  if (dispatch.status === "rejected") throw dispatch.reason;
  if (cancellation?.status === "rejected") throw cancellation.reason;
  return dispatch.value;
}

async function assertDurableObjectResponseOk(ref: DORef, res: Response): Promise<void> {
  if (res.ok) return;
  const text = await readWorkerdResponseText(res);
  const identity = `${ref.source}:${ref.className}/${ref.objectKey}`;
  let parsed: { error?: import("@vibestudio/rpc").RpcFailure };
  try {
    parsed = decodeRpcJson(text) as typeof parsed;
  } catch (cause) {
    throw new Error(`DO RPC relay failed (${res.status}) for ${identity}: ${text}`, { cause });
  }
  if (parsed.error) {
    const error = deserializeRpcFailure(parsed.error);
    error.message += ` [Durable Object: ${identity}]`;
    throw error;
  }
  throw new Error(`DO RPC relay failed (${res.status}) for ${identity}: ${text}`);
}

function unwrapResponseEnvelope(raw: unknown): unknown {
  const responseEnvelope = raw as RpcEnvelope | undefined;
  const message = responseEnvelope?.message as RpcResponse | undefined;
  if (message && message.type === "response") {
    if ("error" in message) {
      const err = deserializeRpcFailure(message.error);

      throw err;
    }
    return message.result;
  }
  throw new Error("DO RPC relay returned a malformed response envelope");
}

/** Relay an RpcClient method call to a DO as a request envelope; returns the unwrapped result. */
export async function postToDurableObject(
  ref: DORef,
  method: string,
  args: unknown[],
  deps: DurableObjectRelayDeps,
  signal?: AbortSignal
): Promise<unknown> {
  const targetId = doTargetId(ref);
  const finishRelay = beginDurableObjectRelay(targetId);
  try {
    const caller = callerFromDeps(deps);
    const envelope = envelopeFromMessage({
      selfId: caller.callerId,
      from: caller.callerId,
      target: doTargetId(ref),
      caller,
      ...(deps.idempotencyKey ? { idempotencyKey: deps.idempotencyKey } : {}),
      ...(deps.readOnly ? { readOnly: true } : {}),
      message: {
        type: "request",
        requestId: deps.requestId ?? generateRequestId(),
        fromId: caller.callerId,
        method,
        args,
        ...(deps.causalParent ? { causalParent: deps.causalParent } : {}),
      },
    });
    return unwrapResponseEnvelope(await postEnvelopeToDO(ref, envelope, deps, signal));
  } finally {
    finishRelay();
  }
}

/** Relay a streaming call to a DO. The returned body remains physically tied
 * to `signal`; cancelling it is the exact resource terminal observed by the DO. */
export async function streamFromDurableObject(
  ref: DORef,
  method: string,
  args: unknown[],
  deps: DurableObjectRelayDeps,
  signal: AbortSignal
): Promise<Response> {
  const targetId = doTargetId(ref);
  const finishRelay = beginDurableObjectRelay(targetId);
  const caller = callerFromDeps(deps);
  const envelope = envelopeFromMessage({
    selfId: caller.callerId,
    from: caller.callerId,
    target: doTargetId(ref),
    caller,
    ...(deps.idempotencyKey ? { idempotencyKey: deps.idempotencyKey } : {}),
    ...(deps.readOnly ? { readOnly: true } : {}),
    message: {
      type: "stream-request",
      requestId: deps.requestId ?? generateRequestId(),
      fromId: caller.callerId,
      method,
      args,
      ...(deps.causalParent ? { causalParent: deps.causalParent } : {}),
    },
  });
  try {
    const response = await fetchEnvelopeFromDO(ref, envelope, deps, signal);
    await assertDurableObjectResponseOk(ref, response);
    const encodedReady = response.headers.get(DURABLE_WORK_READY_HEADER);
    if (encodedReady) {
      try {
        const queues = decodeDurableWorkReady(encodedReady);
        if (queues.length > 0) deps.onWorkReady?.(queues);
      } catch (error) {
        console.error("[WorkerdRpcRelay] ignored invalid durable-work stream receipt", error);
      }
    }
    if (!response.body) {
      finishRelay();
      return response;
    }
    const reader = response.body.getReader();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      finishRelay();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    finishRelay();
    throw error;
  }
}

/** Relay an event to a DO as an event envelope (fire-and-forget). */
export async function postEventToDurableObject(
  ref: DORef,
  event: string,
  payload: unknown,
  deps: DurableObjectRelayDeps,
  signal?: AbortSignal
): Promise<void> {
  const finishRelay = beginDurableObjectRelay(doTargetId(ref));
  const caller = callerFromDeps(deps);
  const envelope = envelopeFromMessage({
    selfId: caller.callerId,
    from: caller.callerId,
    target: doTargetId(ref),
    caller,
    message: { type: "event", fromId: caller.callerId, event, payload },
  });
  try {
    await postEnvelopeToDO(ref, envelope, deps, signal);
  } finally {
    finishRelay();
  }
}
