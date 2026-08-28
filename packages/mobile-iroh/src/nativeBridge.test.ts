import { beforeEach, describe, expect, it, vi } from "vitest";
import { VIBESTUDIO_IROH_ALPN } from "@vibestudio/iroh-transport";

const native = vi.hoisted(() => ({
  createIdentity: vi.fn(),
  deleteIdentity: vi.fn(),
  bind: vi.fn(),
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

import { createMobileEndpointBinding, mobileIrohIdentity } from "./nativeBridge.js";

const reach = {
  endpointId: "ab".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
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

describe("mobile Iroh native bridge", () => {
  it("binds and dials with the exact product ALPN and expected Endpoint ID", async () => {
    const endpoint = await createMobileEndpointBinding("identity-1", reach.relays).bind();
    const alpn = Buffer.from(VIBESTUDIO_IROH_ALPN).toString("base64");
    expect(native.bind).toHaveBeenCalledWith("identity-1", reach.relays, alpn);
    const connection = await endpoint.connect(reach, reach.relays[0]!);
    expect(native.dial).toHaveBeenCalledWith("endpoint-1", reach.endpointId, reach.relays[0], alpn);
    expect(connection.peerEndpointId).toBe(reach.endpointId);
  });

  it("closes a native connection that authenticates a different Endpoint ID", async () => {
    native.dial.mockResolvedValueOnce({
      connectionHandle: "wrong",
      peerEndpointId: "ef".repeat(32),
    });
    const endpoint = await createMobileEndpointBinding("identity-1", reach.relays).bind();
    await expect(endpoint.connect(reach, reach.relays[0]!)).rejects.toThrow(
      /different peer Endpoint ID/
    );
    expect(native.closeConnection).toHaveBeenCalledWith("wrong", "512", "");
  });

  it("preserves bounded reads and QUIC stream reset/stop lifecycle", async () => {
    const endpoint = await createMobileEndpointBinding("identity-1", reach.relays).bind();
    const connection = await endpoint.connect(reach, reach.relays[0]!);
    const stream = await connection.openBi();
    expect(await stream.recv.read(4096)).toEqual([1, 2, 3]);
    expect(native.read).toHaveBeenCalledWith("receive-1", 4096);
    expect(await stream.recv.readExact(2)).toEqual([4, 5]);
    await stream.send.writeAll([7, 8]);
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
});
