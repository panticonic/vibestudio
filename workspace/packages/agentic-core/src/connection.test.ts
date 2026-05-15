import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection.js";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";

function createConfig(): ConnectionConfig {
  const call = vi.fn((target: string, method: string) => {
    if (target === "main" && method === "workers.resolveService") {
      return Promise.resolve({
        kind: "durable-object",
        targetId: "do:workers/pubsub-channel:PubSubChannel:chat-1",
      });
    }
    if (method === "subscribe") return new Promise(() => {});
    return Promise.resolve(undefined);
  }) as NonNullable<ConnectionConfig["rpc"]>["call"];
  return {
    serverUrl: "ws://unused",
    token: "token",
    clientId: "panel-1",
    rpc: {
      selfId: "panel-1",
      call,
      onEvent: vi.fn(() => vi.fn()),
    },
  };
}

const metadata: ChatParticipantMetadata = {
  name: "Panel",
  type: "panel",
  handle: "user",
};

describe("ConnectionManager", () => {
  it("closes a pubsub client when a pending connect is aborted", async () => {
    const config = createConfig();
    const manager = new ConnectionManager({ config, metadata, callbacks: {} });

    const connectPromise = manager.connect({ channelId: "chat-1", methods: {} });
    await vi.waitFor(() => {
      expect(config.rpc!.call).toHaveBeenCalledWith(
        "do:workers/pubsub-channel:PubSubChannel:chat-1",
        "subscribe",
        "panel-1",
        expect.any(Object),
      );
    });
    manager.disconnect();

    await expect(connectPromise).rejects.toThrow("ready aborted");
    expect(config.rpc!.call).toHaveBeenCalledWith(
      "do:workers/pubsub-channel:PubSubChannel:chat-1",
      "unsubscribe",
      "panel-1",
    );
  });

  it("passes custom participant metadata through to pubsub subscription", async () => {
    const config = createConfig();
    const manager = new ConnectionManager({
      config,
      metadata: {
        ...metadata,
        hostPlatform: "electron",
      } as ChatParticipantMetadata,
      callbacks: {},
    });

    const connectPromise = manager.connect({ channelId: "chat-1", methods: {} });
    await vi.waitFor(() => {
      expect(config.rpc!.call).toHaveBeenCalledWith(
        "do:workers/pubsub-channel:PubSubChannel:chat-1",
        "subscribe",
        "panel-1",
        expect.objectContaining({
          name: "Panel",
          type: "panel",
          handle: "user",
          hostPlatform: "electron",
        }),
      );
    });
    manager.disconnect();
    await expect(connectPromise).rejects.toThrow("ready aborted");
  });
});
