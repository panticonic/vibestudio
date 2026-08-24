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
  bindVerifiedExternalContext,
  executionSessionNonceFor,
  verifiedExternalContextFor,
} from "./internal-types.js";
export { DIRECT_AUTHORITY_ACCEPTED_AT_HEADER } from "./authority.js";
export {
  createInternalRpcClient,
  withExecutionAdmission,
  type InternalRpcClientConfig,
} from "./client-core.js";
export {
  createInternalConnectionlessRpcClient,
  type InternalConnectionlessRpcConfig,
} from "./connectionless-core.js";
export {
  createCausalRpcOperationTracker,
  type CausalRpcOperationTracker,
} from "./causal-operation-tracker.js";
