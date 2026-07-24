import type { DORefParam } from "@vibestudio/shared/workspaceServiceRpc";
import {
  envelopeFromMessage,
  RemoteRpcError,
  type CallerKind,
  type RpcEnvelope,
  type RpcCausalParent,
  type RpcResponse,
} from "@vibestudio/rpc";
import type { AttestedCaller, DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import { Agent, type Dispatcher } from "undici";
import { isInternalDOSource } from "./internalDOs/internalDoLoader.js";
import { EntityNotCreatedError } from "@vibestudio/shared/runtime/entitySpec";

export type DORef = DORefParam;

/**
 * Dispatcher for the process-local Node→workerd transport. A DO method owns
 * its semantic lifetime; Undici's response-header/body defaults must not turn
 * into an undocumented method deadline. Callers retain cancellation through
 * AbortSignal, while the dispatch owners report slow-call liveness.
 */
let workerdConnectionDispatcher: Agent | null = null;

/**
 * Return the transport pool for the current workerd process generation.
 *
 * The pool is deliberately lazy: WorkerdManager destroys it before terminating
 * a generation, which closes idle keep-alive sockets and rejects every request
 * still physically attached to that process. The next generation receives a
 * fresh pool rather than inheriting connections or terminal state.
 */
export function getWorkerdConnectionDispatcher(): Dispatcher {
  workerdConnectionDispatcher ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return workerdConnectionDispatcher;
}

/**
 * Sever every Node→workerd connection owned by the current process generation.
 *
 * This is an abrupt transport terminal by design. A workerd restart or shutdown
 * cannot preserve an in-flight invocation, and leaving the pool alive makes
 * workerd wait indefinitely for a peer that the host has already abandoned.
 */
export async function destroyWorkerdConnections(reason: string): Promise<void> {
  const dispatcher = workerdConnectionDispatcher;
  workerdConnectionDispatcher = null;
  if (!dispatcher) return;
  await dispatcher.destroy(new Error(reason));
}

type RelayLane = {
  sealed: boolean;
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
  return { sealed: false, inFlight: 0, drained, resolveDrained };
}

function beginEntityRelay(targetId: string): () => void {
  let lane = entityRelayLanes.get(targetId);
  if (!lane) {
    lane = createRelayLane();
    entityRelayLanes.set(targetId, lane);
  }
  if (lane.sealed) throw new EntityNotCreatedError(targetId);
  const activeLane = lane;
  activeLane.inFlight += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeLane.inFlight -= 1;
    if (activeLane.sealed && activeLane.inFlight === 0) activeLane.resolveDrained();
    if (
      !activeLane.sealed &&
      activeLane.inFlight === 0 &&
      entityRelayLanes.get(targetId) === activeLane
    ) {
      entityRelayLanes.delete(targetId);
    }
  };
}

/** Seal a runtime DO target against new relays and await all admitted calls. */
export async function sealAndDrainDurableObjectRelays(targetId: string): Promise<void> {
  let lane = entityRelayLanes.get(targetId);
  if (!lane) {
    lane = createRelayLane();
    entityRelayLanes.set(targetId, lane);
  }
  lane.sealed = true;
  if (lane.inFlight === 0) lane.resolveDrained();
  await lane.drained;
}

/** Release a retirement seal after the entity row is retired or retirement aborts. */
export function releaseDurableObjectRelaySeal(targetId: string): void {
  entityRelayLanes.delete(targetId);
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

/** Canonical RPC target string for a DO (cosmetic on the wire; the DO reads its identity from the URL). */
export function doTargetString(ref: DORef): string {
  return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
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
  };
  const parts = [`${cause.name}: ${cause.message}`];
  for (const key of ["code", "errno", "syscall", "address", "port"] as const) {
    const value = fields[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${value}`);
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
      body: JSON.stringify(envelope),
      ...(signal ? { signal } : {}),
      dispatcher: getWorkerdConnectionDispatcher(),
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
  deps: DurableObjectRelayDeps
): Promise<unknown> {
  const res = await fetchEnvelopeFromDO(ref, envelope, deps);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO RPC relay failed (${res.status}): ${text}`);
  }

  return res.json();
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
  deps: DurableObjectRelayDeps
): Promise<unknown> {
  const targetId = doTargetString(ref);
  const finishRelay = beginEntityRelay(targetId);
  try {
    const caller = callerFromDeps(deps);
    const envelope = envelopeFromMessage({
      selfId: caller.callerId,
      from: caller.callerId,
      target: doTargetString(ref),
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
    return unwrapResponseEnvelope(await postEnvelopeToDO(ref, envelope, deps));
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
  const caller = callerFromDeps(deps);
  const envelope = envelopeFromMessage({
    selfId: caller.callerId,
    from: caller.callerId,
    target: doTargetString(ref),
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
  return fetchEnvelopeFromDO(ref, envelope, deps, signal);
}

/** Relay an event to a DO as an event envelope (fire-and-forget). */
export async function postEventToDurableObject(
  ref: DORef,
  event: string,
  payload: unknown,
  deps: DurableObjectRelayDeps
): Promise<void> {
  const caller = callerFromDeps(deps);
  const envelope = envelopeFromMessage({
    selfId: caller.callerId,
    from: caller.callerId,
    target: doTargetString(ref),
    caller,
    message: { type: "event", fromId: caller.callerId, event, payload },
  });
  await postEnvelopeToDO(ref, envelope, deps);
}
