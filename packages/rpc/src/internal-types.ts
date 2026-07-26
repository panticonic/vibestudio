import type {
  AuthenticatedCaller,
  RpcCallOptions,
  RpcEvent,
  RpcRequest,
  RpcStreamOptions,
  RpcStreamRequest,
} from "./types.js";
import type { DirectAuthorityAttestation } from "./authority.js";

const EXECUTION_SESSION_NONCE = Symbol.for("vibestudio.rpc.executionSessionNonce");

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
