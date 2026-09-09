export interface SecureRandomSource {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}

/**
 * Return an RFC 4122 version-4 UUID in every supported JavaScript runtime.
 *
 * Hermes exposes Web Crypto random bytes through the mobile polyfill, but it
 * does not expose `crypto.randomUUID()`. IDs used by RPC and Iroh are protocol
 * identities, so an insecure Math.random fallback is not acceptable.
 */
export function secureRandomUuid(
  source: SecureRandomSource | undefined = (globalThis as { crypto?: SecureRandomSource }).crypto
): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  if (typeof source?.getRandomValues !== "function") {
    throw new Error("Secure random ID generation requires crypto.getRandomValues()");
  }

  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
