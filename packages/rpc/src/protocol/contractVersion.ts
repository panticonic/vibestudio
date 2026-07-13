/**
 * End-to-end RPC envelope/service contract version.
 *
 * This is deliberately distinct from transport protocol versions: a transport
 * can remain byte-compatible while RPC envelope or service semantics change.
 * Persistent peers must present this exact version during admission.
 */
export const RPC_CONTRACT_VERSION = 1 as const;
