import { wireCallerFor, wireStreamFor } from "./schemaClient.js";
/**
 * Host/runtime-only RPC authority transport surface.
 *
 * Workspace code must use the package root. These values carry replay-sensitive
 * invocation proofs and exist only so trusted host and runtime packages can
 * share one wire contract.
 */
export type { DirectAuthorityAttestation } from "./authority.js";
export type {
  AttestedCaller,
  InternalRpcEvent,
  InternalRpcRequest,
  InternalRpcStreamRequest,
} from "./internal-types.js";
export {
  bindExecutionSession,
  bindInvocationParent,
  invocationParentFor,
  executionSessionNonceFor,
  mergeRpcOptions,
} from "./internal-types.js";
export { DIRECT_AUTHORITY_ACCEPTED_AT_HEADER } from "./authority.js";
export {
  createInternalRpcClient,
  createRpcPeer,
  withExecutionAdmission,
  type InternalRpcClientConfig,
} from "./client-core.js";
export {
  createInternalConnectionlessRpcClient,
  type InternalConnectionlessRpcConfig,
  type InternalConnectionlessRpcClient,
} from "./connectionless-core.js";
export {
  createCausalRpcOperationTracker,
  type CausalRpcOperationTracker,
} from "./causal-operation-tracker.js";

export type { RpcWireCaller, RpcWireClient } from "./internal-types.js";

/** Schema-client dispatch. The validator owns result decoding; wire code cannot infer a result type. */
export function dispatchRpcCall(
  caller:
    | Pick<import("./types.js").RpcCaller, "call">
    | Pick<import("./internal-types.js").RpcWireCaller, "call">,
  target: string,
  method: string,
  args: unknown[],
  options?: import("./types.js").RpcCallOptions
): Promise<unknown> {
  return wireCallerFor(caller).call(target, method, args, options);
}
export function dispatchRpcStream(
  caller: Pick<import("./types.js").RpcCaller, "stream">,
  target: string,
  method: string,
  args: unknown[],
  options?: import("./types.js").RpcStreamOptions
): Promise<Response> {
  return wireStreamFor(caller).stream(
    target,
    method,
    args,
    options
  );
}

export { schemaRpcClient, schemaRpcCaller, schemaRpcStream } from "./schemaClient.js";

export { wireClientFor, registerRpcWireClient } from "./schemaClient.js";

export { wireCallerFor } from "./schemaClient.js";
