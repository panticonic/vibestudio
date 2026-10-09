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
import { EntityNotCreatedError } from "@vibestudio/shared/runtime/entitySpec";
import {
  DURABLE_WORK_READY_HEADER,
  decodeDurableWorkReady,
  parseDurableWorkReady,
  type DurableWorkQueue,
} from "@vibestudio/shared/durableWork";

export type DORef = DORefParam;

/** Each workerd endpoint owns its transport pool and its generation retirement. */
const workerdConnectionDispatchers = new Map<string, Pool>();

export function getWorkerdConnectionDispatcher(endpoint: string): Dispatcher {
  const origin = new URL(endpoint).origin;
  let dispatcher = workerdConnectionDispatchers.get(origin);
  if (!dispatcher) {
    dispatcher = new Pool(origin, {
      // Semantic invocation lifetime is controlled by its owner and signal.
      headersTimeout: 0,
      bodyTimeout: 0,
      // POSTs have no universal replay identity. Give each invocation its own
      // connection rather than retrying an ambiguous stale keep-alive socket.
      pipelining: 0,
    });
    workerdConnectionDispatchers.set(origin, dispatcher);
  }
  return dispatcher;
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
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.workerdGatewayToken}`,
        ...(deps.workerdDispatchSecret
          ? { "X-Vibestudio-Dispatch-Secret": deps.workerdDispatchSecret }
          : {}),
      },
      body: encodeRpcJson(envelope),
      ...(signal ? { signal } : {}),
      dispatcher: getWorkerdConnectionDispatcher(url),
    } as RequestInit);
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
      await response.arrayBuffer();
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
    return decodeRpcJson(await res.text()) as RpcEnvelope;
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
  const text = await res.text();
  const identity = `${ref.source}:${ref.className}/${ref.objectKey}`;
  try {
    const parsed = decodeRpcJson(text) as {
      error?: unknown;
      errorKind?: unknown;
      errorCode?: unknown;
      errorData?: unknown;
    };
    if (typeof parsed.error === "string") {
      throw new RemoteRpcError(
        `${parsed.error} [Durable Object: ${identity}]`,
        parsed.errorKind === "access" ||
          parsed.errorKind === "service" ||
          parsed.errorKind === "transport" ||
          parsed.errorKind === "protocol" ||
          parsed.errorKind === "application" ||
          parsed.errorKind === "internal"
          ? parsed.errorKind
          : "transport",
        typeof parsed.errorCode === "string" ? parsed.errorCode : undefined,
        parsed.errorData && typeof parsed.errorData === "object"
          ? { ...(parsed.errorData as Record<string, unknown>), durableObject: ref }
          : { durableObject: ref }
      );
    }
  } catch (error) {
    if (error instanceof RemoteRpcError) throw error;
  }
  throw new Error(`DO RPC relay failed (${res.status}) for ${identity}: ${text}`);
}

function unwrapResponseEnvelope(raw: unknown): unknown {
  const responseEnvelope = raw as RpcEnvelope | undefined;
  const message = responseEnvelope?.message as RpcResponse | undefined;
  if (message && message.type === "response") {
    if ("error" in message) {
      const err = new RemoteRpcError(
        message.error,
        message.errorKind,
        message.errorCode,
        message.errorData
      );
      if (message.errorStack) err.stack = message.errorStack;
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
