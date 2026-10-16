import type { SecretKey } from "@number0/iroh";
import {
  assertEndpointDelegation,
  endpointDelegationStatement,
  type EndpointDelegation,
} from "./deviceDelegation.js";
import { EndpointGenerationOwner } from "./endpointGeneration.js";
import { loadIrohNodeBinding } from "./nodeBinding.js";
import {
  createNodeEndpointBinding,
  type NodePhysicalConnection,
  type NodePhysicalEndpoint,
} from "./nodePhysical.js";

const hex = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The device signing public key for a device secret. */
export function deviceKeyOf(deviceSecret: SecretKey): string {
  return deviceSecret.public().toString();
}

/** Delegate `endpointId` to the device that owns `deviceSecret`. */
export function signEndpointDelegation(
  deviceSecret: SecretKey,
  endpointId: string
): EndpointDelegation {
  const deviceKey = deviceKeyOf(deviceSecret);
  const signature = deviceSecret.sign([...endpointDelegationStatement(deviceKey, endpointId)]);
  return { deviceKey, signature: hex(signature.toBytes()) };
}

/**
 * Whether `delegation` was signed by its own device key for exactly
 * `endpointId`. Malformed input is a refusal, not an exception.
 */
export function verifyEndpointDelegation(
  delegation: EndpointDelegation,
  endpointId: string
): boolean {
  try {
    assertEndpointDelegation(delegation);
    const { EndpointId, Signature } = loadIrohNodeBinding();
    const signature = Signature.fromBytes([...Buffer.from(delegation.signature, "hex")]);
    EndpointId.fromString(delegation.deviceKey).verify(
      [...endpointDelegationStatement(delegation.deviceKey, endpointId)],
      signature
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * One host process's transport identity: a fresh, in-memory endpoint (never
 * persisted, never shared with another process) and the device's delegation of
 * it. Hub control and workspace dials from the same process share one.
 */
export interface NodeDeviceEndpoint {
  owner: EndpointGenerationOwner<NodePhysicalConnection, NodePhysicalEndpoint>;
  delegation: EndpointDelegation;
}

export function createNodeDeviceEndpoint(
  deviceSecret: Uint8Array,
  relayUrls: readonly string[]
): NodeDeviceEndpoint {
  if (deviceSecret.byteLength !== 32) {
    throw new Error("Iroh device secret must contain exactly 32 bytes");
  }
  const { SecretKey } = loadIrohNodeBinding();
  const device = SecretKey.fromBytes([...deviceSecret]);
  const endpointSecret = SecretKey.generate();
  return {
    owner: new EndpointGenerationOwner(
      createNodeEndpointBinding({ secretKey: endpointSecret, relayUrls })
    ),
    delegation: signEndpointDelegation(device, endpointSecret.public().toString()),
  };
}
