/**
 * End-to-end RPC envelope/service/native-host contract version.
 *
 * This is deliberately distinct from transport protocol versions: a transport
 * can remain byte-compatible while RPC envelopes, service semantics, or the
 * workspace shell's native-host projections change. Iroh peers exchange this
 * value in their pipe hello and require an exact match before either side may
 * send a logical-session `open` frame. Consequently a mismatched desktop and
 * server fail before a one-time pairing credential can be redeemed.
 *
 * Bump this whenever a separately updated desktop host and workspace/server
 * must not interoperate, even if the transport frame shapes themselves remain
 * valid. Persistent peers must present this exact version during admission.
 */
export const RPC_CONTRACT_VERSION = 3 as const;
