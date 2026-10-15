import { beforeEach, describe, expect, it, vi } from "vitest";
import { WsRpcClient } from "./wsClient.js";

const transportMocks = vi.hoisted(() => ({
  connectAndWait: vi.fn<() => Promise<void>>(),
  close: vi.fn(async () => undefined),
}));

vi.mock("@vibestudio/rpc/transports/wsClient", () => ({
  wsClientTransport: () => ({
    connectAndWait: transportMocks.connectAndWait,
    close: transportMocks.close,
  }),
}));

describe("WsRpcClient connection ownership", () => {
  beforeEach(() => {
    transportMocks.connectAndWait.mockReset();
    transportMocks.close.mockClear();
  });

  it("disposes its one-shot transport when initial connection fails", async () => {
    transportMocks.connectAndWait.mockRejectedValueOnce(new Error("admission timed out"));
    const client = new WsRpcClient({
      url: "https://server.example",
      callerId: "shell:cli",
      callerKind: "shell",
      getToken: () => "token",
    });

    await expect(client.ready()).rejects.toThrow("admission timed out");
    expect(transportMocks.close).toHaveBeenCalledOnce();
  });

  it("closes the acquired transport before joining unfinished authentication", async () => {
    let rejectReady!: (error: unknown) => void;
    let entered!: () => void;
    const connecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const closed = new Error("transport closed during admission");
    transportMocks.connectAndWait.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((_resolve, reject) => {
        rejectReady = reject;
      });
    });
    transportMocks.close.mockImplementationOnce(async () => {
      rejectReady(closed);
    });
    const client = new WsRpcClient({
      url: "https://server.example",
      callerId: "shell:cli",
      callerKind: "shell",
      getToken: () => "token",
    });
    const ready = client.ready();
    const failed = expect(ready).rejects.toBe(closed);
    await connecting;
    await client.close();
    await failed;
    expect(transportMocks.close).toHaveBeenCalledOnce();
  });

  it("preserves authentication and transport retirement failures together", async () => {
    const admission = new Error("credential rejected");
    const retirement = new Error("socket retirement failed");
    transportMocks.connectAndWait.mockRejectedValueOnce(admission);
    transportMocks.close.mockRejectedValueOnce(retirement);
    const client = new WsRpcClient({
      url: "https://server.example",
      callerId: "shell:cli",
      callerKind: "shell",
      getToken: () => "token",
    });
    await expect(client.ready()).rejects.toMatchObject({ errors: [admission, retirement] });
  });

  it("cancels and joins admitted authentication with the caller's original cause", async () => {
    const owner = new AbortController();
    const reason = new Error("terminal cancelled");
    let rejectReady!: (error: unknown) => void;
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    transportMocks.connectAndWait.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((_resolve, reject) => {
        rejectReady = reject;
      });
    });
    transportMocks.close.mockImplementationOnce(async () => {
      rejectReady(new Error("socket closed"));
    });
    const client = new WsRpcClient({
      url: "https://server.example",
      callerId: "shell:cli",
      callerKind: "shell",
      getToken: () => "token",
      signal: owner.signal,
    });
    const failed = expect(client.ready()).rejects.toBe(reason);
    await admitted;
    owner.abort(reason);
    await client.close();
    await failed;
    expect(transportMocks.close).toHaveBeenCalledOnce();
  });

  it("rejects dynamically supplied unqualified direct methods before connecting", async () => {
    const client = new WsRpcClient({
      url: "https://server.example",
      callerId: "shell:cli",
      callerKind: "shell",
      getToken: () => "token",
    });

    await expect(Reflect.apply(client.call, client, ["retireEntity", []])).rejects.toThrow(
      'Expected a service-qualified RPC method (service.method), received "retireEntity"'
    );
    expect(transportMocks.connectAndWait).not.toHaveBeenCalled();
  });
});
