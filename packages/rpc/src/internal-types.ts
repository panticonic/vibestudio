import type {
  AuthenticatedCaller,
  RpcCallOptions,
  RpcEvent,
  RpcRequest,
  RpcStreamOptions,
  RpcStreamRequest,
} from "./types.js";
import type { ContextIntegrityFact, DirectAuthorityAttestation } from "./authority.js";

const EXECUTION_SESSION_NONCE = Symbol.for("vibestudio.rpc.executionSessionNonce");
const VERIFIED_EXTERNAL_CONTEXT = Symbol.for("vibestudio.rpc.verifiedExternalContext");

/**
 * Bind one trusted runtime-created options object to a live evaluated-execution
 * admission. The nonce is deliberately held out-of-band rather than exposed as
 * a public RpcCallOptions property, so workspace code cannot copy or override
 * the host admission proof.
 */
export function bindExecutionSession<T extends RpcCallOptions | RpcStreamOptions>(
  options: T,
  nonce: string
): T {
  Object.defineProperty(options, EXECUTION_SESSION_NONCE, {
    value: nonce,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return options;
}

export function executionSessionNonceFor(
  options: RpcCallOptions | RpcStreamOptions | undefined
): string | undefined {
  if (!options) return undefined;
  const nonce = (options as Record<PropertyKey, unknown>)[EXECUTION_SESSION_NONCE];
  return typeof nonce === "string" ? nonce : undefined;
}

/**
 * Attach one host-verified external ingress fact to an in-process call.
 *
 * Like evaluated-execution admission, this rides a non-enumerable runtime-only
 * property. JSON/wire callers therefore cannot copy, forge, or downgrade it.
 * The receiver gets an immutable copy so later mutation cannot change the
 * authority fact after the host verification boundary has accepted it.
 */
export function bindVerifiedExternalContext<T extends RpcCallOptions>(
  options: T,
  fact: ContextIntegrityFact
): T {
  if (
    fact.class !== "external" ||
    !Number.isSafeInteger(fact.latchEpoch) ||
    fact.latchEpoch < 0 ||
    fact.externalKeys.length < 1 ||
    fact.externalKeys.length > 256 ||
    !fact.externalKeys.every(
      (key) => typeof key === "string" && key.length > 0 && key.length <= 1_024
    )
  ) {
    throw new TypeError("Verified external context must contain bounded external lineage");
  }
  const sealed = Object.freeze({
    class: "external" as const,
    latchEpoch: fact.latchEpoch,
    externalKeys: Object.freeze([...new Set(fact.externalKeys)]),
  });
  Object.defineProperty(options, VERIFIED_EXTERNAL_CONTEXT, {
    value: sealed,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return options;
}

/** Host-side accessor for the runtime-only fact bound above. */
export function verifiedExternalContextFor(
  options: RpcCallOptions | undefined
): ContextIntegrityFact | null {
  if (!options) return null;
  const fact = (options as Record<PropertyKey, unknown>)[VERIFIED_EXTERNAL_CONTEXT];
  return fact && typeof fact === "object" ? (fact as ContextIntegrityFact) : null;
}

/** Authenticated transport caller before it is sanitized for user handlers. */
export interface AttestedCaller extends AuthenticatedCaller {
  authorization?: DirectAuthorityAttestation;
}

/** Runtime-only direct-invocation correlation carried on a unary request. */
export interface InternalRpcRequest extends RpcRequest {
  authorityParentNonce?: string;
  executionSessionNonce?: string;
}

/** Runtime-only direct-invocation correlation carried on a streaming request. */
export interface InternalRpcStreamRequest extends RpcStreamRequest {
  authorityParentNonce?: string;
  executionSessionNonce?: string;
}

/** Runtime-only evaluated-execution correlation carried on an event. */
export interface InternalRpcEvent extends RpcEvent {
  executionSessionNonce?: string;
}
