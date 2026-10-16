import { beforeEach, describe, expect, it, vi } from "vitest";
import { IrohRpcClient } from "./irohRpcClient.js";

const pipe = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<void>>(),
  close: vi.fn(async () => undefined),
}));
vi.mock("@vibestudio/iroh-transport/node", () => ({
  createNodeDeviceEndpoint: () => ({
    owner: { close: async () => undefined, dial: vi.fn() },
    delegation: { deviceKey: "a".repeat(64), signature: "b".repeat(128) },
  }),
}));
vi.mock("@vibestudio/rpc/transports/reconnectingIrohClient", () => ({
  createReconnectingIrohClientPipe: () => ({
    close: pipe.close,
    openSession: () => ({ ready: pipe.ready }),
  }),
}));

beforeEach(() => {
  pipe.ready.mockReset();
  pipe.close.mockReset().mockResolvedValue(undefined);
});

describe("IrohRpcClient direct RPC method contract", () => {
  it("closes the acquired pipe before joining authentication readiness", async () => {
    let rejectReady!: (error: unknown) => void;
    const stopped = new Error("logical session closed");
    pipe.ready.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectReady = reject;
        })
    );
    pipe.close.mockImplementationOnce(async () => {
      rejectReady(stopped);
    });
    const client = new IrohRpcClient({
      reach: { v: 5, endpointId: "a".repeat(64), relays: ["https://relay.example/"] },
      deviceSecret: new Uint8Array(32),
      callerId: "shell:cli",
      getToken: () => "token",
    });
    const ready = client.ready();
    const failed = expect(ready).rejects.toBe(stopped);
    await client.close();
    await failed;
    expect(pipe.close).toHaveBeenCalledOnce();
  });

  it("preserves authentication failure alongside failed pipe retirement", async () => {
    const admission = new Error("credential rejected");
    const retirement = new Error("physical retirement failed");
    pipe.ready.mockRejectedValueOnce(admission);
    pipe.close.mockRejectedValueOnce(retirement);
    const client = new IrohRpcClient({
      reach: { v: 5, endpointId: "a".repeat(64), relays: ["https://relay.example/"] },
      deviceSecret: new Uint8Array(32),
      callerId: "shell:cli",
      getToken: () => "token",
    });
    await expect(client.ready()).rejects.toMatchObject({ errors: [admission, retirement] });
    await expect(client.close()).rejects.toBe(retirement);
  });
  it("joins cancelled logical admission and preserves the caller's cause", async () => {
    const owner = new AbortController();
    const reason = new Error("terminal cancelled");
    let rejectReady!: (error: unknown) => void;
    pipe.ready.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectReady = reject;
        })
    );
    pipe.close.mockImplementationOnce(async () => {
      rejectReady(new Error("pipe closed"));
    });
    const client = new IrohRpcClient({
      reach: { v: 5, endpointId: "a".repeat(64), relays: ["https://relay.example/"] },
      deviceSecret: new Uint8Array(32),
      callerId: "shell:cli",
      getToken: () => "token",
      signal: owner.signal,
    });
    const failed = expect(client.ready()).rejects.toBe(reason);
    owner.abort(reason);
    await client.close();
    await failed;
    expect(pipe.close).toHaveBeenCalledOnce();
  });
  it("rejects dynamically supplied unqualified methods before connecting", async () => {
    const client = Object.create(IrohRpcClient.prototype);

    await expect(Reflect.apply(client.call, client, ["retireEntity", []])).rejects.toThrow(
      'Expected a service-qualified RPC method (service.method), received "retireEntity"'
    );
  });
});
