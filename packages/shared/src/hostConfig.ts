/**
 * The server gateway is loopback HTTP only. Remote devices reach a server over
 * Iroh (Endpoint ID-authenticated), so there is no public host, bind address,
 * or TLS protocol to configure. All gateway URL construction flows through here.
 */

/** The only address a gateway binds and advertises. */
export const GATEWAY_HOST = "127.0.0.1";

/** `http://127.0.0.1:<port>` — the gateway origin for HTTP callers. */
export function gatewayHttpUrl(port: number): string {
  return `http://${GATEWAY_HOST}:${port}`;
}

/** `ws://127.0.0.1:<port>` — the gateway origin for WebSocket callers. */
export function gatewayWsUrl(port: number): string {
  return `ws://${GATEWAY_HOST}:${port}`;
}
