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
});
