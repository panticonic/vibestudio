import { beforeEach, describe, expect, it, vi } from "vitest";
import { VIBESTUDIO_IROH_ALPN } from "@vibestudio/iroh-transport";

const native = vi.hoisted(() => ({
  createIdentity: vi.fn(),
  deleteIdentity: vi.fn(),
  bind: vi.fn(),
  identityPublicKey: vi.fn(),
  signWithIdentity: vi.fn(),
  shutdownEndpoint: vi.fn(),
  dial: vi.fn(),
  accept: vi.fn(),
  openBi: vi.fn(),
  acceptBi: vi.fn(),
  write: vi.fn(),
  finish: vi.fn(),
  reset: vi.fn(),
  stopped: vi.fn(),
  read: vi.fn(),
  readExact: vi.fn(),
  stop: vi.fn(),
  receivedReset: vi.fn(),
  closeConnection: vi.fn(),
  connectionClosed: vi.fn(),
}));

vi.mock("react-native", () => ({ NativeModules: { VibestudioIroh: native } }));

import { loadIrohNodeBinding } from "@vibestudio/iroh-transport/node";
import { verifyEndpointDelegation } from "@vibestudio/iroh-transport/node";
import {
  createMobileEndpointBinding,
  mobileIrohIdentity,
  signMobileEndpointDelegation,
} from "./nativeBridge.js";

const reach = {
  endpointId: "ab".repeat(32),
  relays: ["https://relay.example/"],
  v: 5 as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  native.bind.mockResolvedValue({ endpointHandle: "endpoint-1", endpointId: "cd".repeat(32) });
  native.dial.mockResolvedValue({
    connectionHandle: "connection-1",
    peerEndpointId: reach.endpointId,
  });
  native.openBi.mockResolvedValue({ sendHandle: "send-1", receiveHandle: "receive-1" });
  native.read.mockResolvedValue(Buffer.from([1, 2, 3]).toString("base64"));
  native.readExact.mockResolvedValue(Buffer.from([4, 5]).toString("base64"));
  native.stopped.mockResolvedValue("513");
  native.receivedReset.mockResolvedValue("514");
  native.connectionClosed.mockResolvedValue("closed");
});

const endpointSecret = new Uint8Array(32).fill(9);

describe("mobile Iroh native bridge", () => {
  it("binds and dials with the exact product ALPN and expected Endpoint ID", async () => {
    const endpoint = await createMobileEndpointBinding(endpointSecret, reach.relays).bind();
    const alpn = Buffer.from(VIBESTUDIO_IROH_ALPN).toString("base64");
    expect(native.bind).toHaveBeenCalledWith(
      Buffer.from(endpointSecret).toString("base64"),
      reach.relays,
      alpn
    );
    const connection = await endpoint.connect(reach, reach.relays[0]!);
    expect(native.dial).toHaveBeenCalledWith("endpoint-1", reach.endpointId, reach.relays[0], alpn);
    expect(connection.peerEndpointId).toBe(reach.endpointId);
  });

  it("closes a native connection that authenticates a different Endpoint ID", async () => {
    native.dial.mockResolvedValueOnce({
      connectionHandle: "wrong",
      peerEndpointId: "ef".repeat(32),
    });
    const endpoint = await createMobileEndpointBinding(endpointSecret, reach.relays).bind();
    await expect(endpoint.connect(reach, reach.relays[0]!)).rejects.toThrow(
      /different peer Endpoint ID/
    );
    expect(native.closeConnection).toHaveBeenCalledWith("wrong", "512", "");
  });

  it("preserves bounded reads and QUIC stream reset/stop lifecycle", async () => {
    const endpoint = await createMobileEndpointBinding(endpointSecret, reach.relays).bind();
    const connection = await endpoint.connect(reach, reach.relays[0]!);
    const stream = await connection.openBi();
    expect(await stream.recv.read(4096)).toEqual(new Uint8Array([1, 2, 3]));
    expect(native.read).toHaveBeenCalledWith("receive-1", 4096);
    expect(await stream.recv.readExact(2)).toEqual(new Uint8Array([4, 5]));
    await stream.send.writeAll(new Uint8Array([7, 8]));
    expect(native.write).toHaveBeenCalledWith("send-1", Buffer.from([7, 8]).toString("base64"));
    await stream.send.reset(513n);
    await stream.recv.stop(514n);
    expect(await stream.send.stopped()).toBe(513);
    expect(await stream.recv.receivedReset()).toBe(514);
    connection.close(0n, new TextEncoder().encode("done"));
    expect(native.closeConnection).toHaveBeenCalledWith(
      "connection-1",
      "0",
      Buffer.from("done").toString("base64")
    );
  });

  it("owns native endpoint identity creation and deletion explicitly", async () => {
    native.createIdentity.mockResolvedValue({
      identityId: "identity-1",
      endpointId: reach.endpointId,
    });
    expect(await mobileIrohIdentity.create()).toEqual({
      identityId: "identity-1",
      endpointId: reach.endpointId,
    });
    await mobileIrohIdentity.delete("identity-1");
    expect(native.deleteIdentity).toHaveBeenCalledWith("identity-1");
  });

  it("delegates a fresh endpoint with the native device identity so the server accepts it", async () => {
    const device = loadIrohNodeBinding().SecretKey.generate();
    native.identityPublicKey.mockResolvedValue(device.public().toString());
    native.signWithIdentity.mockImplementation(async (_id: string, messageBase64: string) =>
      Buffer.from(device.sign([...Buffer.from(messageBase64, "base64")]).toBytes()).toString(
        "base64"
      )
    );
    const endpointId = loadIrohNodeBinding().SecretKey.generate().public().toString();
    const delegation = await signMobileEndpointDelegation("identity-1", endpointId);
    expect(delegation.deviceKey).toBe(device.public().toString());
    expect(verifyEndpointDelegation(delegation, endpointId)).toBe(true);
    expect(verifyEndpointDelegation(delegation, "ab".repeat(32))).toBe(false);
  });
});
