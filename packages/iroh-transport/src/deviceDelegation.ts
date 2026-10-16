/**
 * A device is identified by a long-term ed25519 signing key that never carries
 * transport. Each host process binds its own fresh, in-memory Iroh endpoint and
 * proves it acts for the device by presenting a delegation: the device key's
 * signature over a domain-separated statement naming that exact endpoint.
 *
 * Replaying a delegation is useless. QUIC/TLS already authenticates the
 * endpoint id on every connection, so only the holder of the endpoint's secret
 * can use a statement that names it. The statement therefore needs no expiry.
 *
 * This module is the single definition of the statement and its wire shape.
 * Signing and verification live beside the platform's ed25519 primitive:
 * `nodeDelegation.ts` for Node hosts and the native mobile module for React
 * Native.
 */

export const ENDPOINT_DELEGATION_DOMAIN = "vibestudio-endpoint-delegation-v1";

const DEVICE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

export interface EndpointDelegation {
  /** Device signing public key, 64 lowercase hex characters. */
  deviceKey: string;
  /** ed25519 signature over {@link endpointDelegationStatement}, 128 lowercase hex characters. */
  signature: string;
}

export function assertDeviceKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DEVICE_KEY_PATTERN.test(value)) {
    throw new Error("Device key must be 64 lowercase hex characters");
  }
}

export function assertEndpointDelegation(value: unknown): asserts value is EndpointDelegation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Endpoint delegation must be an object");
  }
  const record = value as Record<string, unknown>;
  assertDeviceKey(record["deviceKey"]);
  if (typeof record["signature"] !== "string" || !SIGNATURE_PATTERN.test(record["signature"])) {
    throw new Error("Endpoint delegation signature must be 128 lowercase hex characters");
  }
}

/** The exact bytes the device key signs to delegate `endpointId`. */
export function endpointDelegationStatement(deviceKey: string, endpointId: string): Uint8Array {
  assertDeviceKey(deviceKey);
  assertDeviceKey(endpointId);
  return new TextEncoder().encode(`${ENDPOINT_DELEGATION_DOMAIN}\n${deviceKey}\n${endpointId}`);
}
