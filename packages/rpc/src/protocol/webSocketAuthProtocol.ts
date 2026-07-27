export type WebSocketAuthLane = "rpc" | "inspection" | "cdp-host";

const PREFIX = "vibestudio.auth";
const MAX_CREDENTIAL_BYTES = 4 * 1024;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Carries an opaque credential in a legal WebSocket subprotocol value so the
 * HTTP upgrade can be admitted before ws allocates a message receiver.
 */
export function webSocketAuthProtocol(lane: WebSocketAuthLane, credential: string): string {
  const bytes = new TextEncoder().encode(credential);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CREDENTIAL_BYTES) {
    throw new Error(`WebSocket ${lane} credential must be 1-${MAX_CREDENTIAL_BYTES} bytes`);
  }
  return `${PREFIX}.${lane}.${bytesToBase64Url(bytes)}`;
}

export function parseWebSocketAuthProtocol(
  header: string | string[] | undefined,
  lane: WebSocketAuthLane
): string | null {
  if (typeof header !== "string") return null;
  const protocols = header.split(",").map((protocol) => protocol.trim());
  if (protocols.length !== 1) return null;
  const protocol = protocols[0];
  if (!protocol) return null;
  const expectedPrefix = `${PREFIX}.${lane}.`;
  if (!protocol.startsWith(expectedPrefix)) return null;
  const bytes = base64UrlToBytes(protocol.slice(expectedPrefix.length));
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_CREDENTIAL_BYTES) return null;
  try {
    const credential = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return webSocketAuthProtocol(lane, credential) === protocol ? credential : null;
  } catch {
    return null;
  }
}
