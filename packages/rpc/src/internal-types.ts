import type { AuthenticatedCaller, RpcRequest, RpcStreamRequest } from "./types.js";
import type { DirectAuthorityAttestation } from "./authority.js";

/** Authenticated transport caller before it is sanitized for user handlers. */
export interface AttestedCaller extends AuthenticatedCaller {
  authorization?: DirectAuthorityAttestation;
}

/** Runtime-only direct-invocation correlation carried on a unary request. */
export interface InternalRpcRequest extends RpcRequest {
  authorityParentNonce?: string;
}

/** Runtime-only direct-invocation correlation carried on a streaming request. */
export interface InternalRpcStreamRequest extends RpcStreamRequest {
  authorityParentNonce?: string;
}
