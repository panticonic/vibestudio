/**
 * Ingress budgets are protocol contracts, not generic transport defaults.
 *
 * RPC WebSockets carry control envelopes. Large request/response bodies belong
 * on the streaming/Iroh bulk lanes, which provide backpressure and bounded
 * framing. CDP/inspector sockets legitimately carry large screenshots and
 * protocol payloads, so they retain a larger post-admission ceiling. Their
 * credentials are validated before the WebSocket upgrade.
 */
export const RPC_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Protocol-shape limit after upgrade; not described as an allocation bound. */
export const AUTHENTICATION_FRAME_MAX_BYTES = 64 * 1024;
export const RPC_MAX_PENDING_AUTHENTICATIONS = 256;
export const RPC_WS_ADMISSION_MAX_PENDING_RESOLUTIONS = 32;
export const RPC_WS_ADMISSION_MAX_OUTSTANDING_GRANTS = 1024;
export const RPC_WS_ADMISSION_GRANT_TTL_MS = 15_000;
export const RPC_WS_PAIRING_REPLAY_TTL_MS = 30_000;
export const RPC_WS_ADMISSION_RETRY_AFTER_MS = 1_000;
/** Bound async credential redemption so unauthenticated requests cannot retain admission slots. */
export const RPC_WS_ADMISSION_RESOLUTION_TIMEOUT_MS = 8_000;
export const RPC_WS_ADMISSION_MAX_CLIENT_LABEL_BYTES = 256;
export const CDP_WEBSOCKET_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export function rawWebSocketDataByteLength(data: Buffer | ArrayBuffer | readonly Buffer[]): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.reduce((total, chunk) => total + chunk.byteLength, 0);
}
