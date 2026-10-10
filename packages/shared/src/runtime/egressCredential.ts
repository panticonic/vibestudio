/**
 * Selects a credential on the runtime's host-attributed egress path. This is a
 * selector, never an authorization grant: the host validates caller, audience,
 * lifecycle and credential-use authority before injection. It is stripped on
 * the host and must never reach the destination.
 */
export const EGRESS_CREDENTIAL_HEADER = "x-vibestudio-egress-credential";
/** Opaque scope of one credentialed WebSocket, admitted through authenticated RPC. */
export const EGRESS_WEBSOCKET_SCOPE_HEADER = "x-vibestudio-egress-websocket-scope";
