import { describe, expect, it } from "vitest";
import { endpointDelegationStatement } from "./deviceDelegation.js";
import { loadIrohNodeBinding } from "./nodeBinding.js";
import {
  createNodeDeviceEndpoint,
  signEndpointDelegation,
  verifyEndpointDelegation,
} from "./nodeDelegation.js";

describe("endpoint delegation", () => {
  const { SecretKey } = loadIrohNodeBinding();
  const device = SecretKey.generate();
  const endpoint = SecretKey.generate().public().toString();

  it("verifies a delegation for exactly the endpoint it names", () => {
    const delegation = signEndpointDelegation(device, endpoint);
    expect(delegation.deviceKey).toBe(device.public().toString());
    expect(verifyEndpointDelegation(delegation, endpoint)).toBe(true);
  });

  it("refuses a delegation presented from a different endpoint", () => {
    const delegation = signEndpointDelegation(device, endpoint);
    const other = SecretKey.generate().public().toString();
    expect(verifyEndpointDelegation(delegation, other)).toBe(false);
  });

  it("refuses a signature by another key, a swapped device key, and malformed input", () => {
    const delegation = signEndpointDelegation(device, endpoint);
    const stranger = SecretKey.generate();
    expect(
      verifyEndpointDelegation({ ...delegation, deviceKey: stranger.public().toString() }, endpoint)
    ).toBe(false);
    expect(verifyEndpointDelegation({ ...delegation, signature: "00".repeat(64) }, endpoint)).toBe(
      false
    );
    expect(verifyEndpointDelegation({ ...delegation, signature: "zz" }, endpoint)).toBe(false);
  });

  it("separates the signed statement by domain and field", () => {
    const statement = new TextDecoder().decode(
      endpointDelegationStatement(device.public().toString(), endpoint)
    );
    expect(statement).toBe(
      `vibestudio-endpoint-delegation-v1\n${device.public().toString()}\n${endpoint}`
    );
  });

  it("gives two concurrent processes of one device distinct endpoints with the same device key", async () => {
    const deviceSecret = Uint8Array.from(device.toBytes());
    const first = createNodeDeviceEndpoint(deviceSecret, []);
    const second = createNodeDeviceEndpoint(deviceSecret, []);
    try {
      const [a, b] = await Promise.all([first.owner.ready(), second.owner.ready()]);
      expect(a.endpointId).not.toBe(b.endpointId);
      expect(first.delegation.deviceKey).toBe(device.public().toString());
      expect(second.delegation.deviceKey).toBe(first.delegation.deviceKey);
      expect(verifyEndpointDelegation(first.delegation, a.endpointId)).toBe(true);
      expect(verifyEndpointDelegation(second.delegation, b.endpointId)).toBe(true);
      expect(verifyEndpointDelegation(first.delegation, b.endpointId)).toBe(false);
    } finally {
      await Promise.all([first.owner.close(), second.owner.close()]);
    }
  });
});
