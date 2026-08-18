import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpcClient.js";
import { channelEntities, existingChannelTarget } from "./channelCommands.js";

function clientWithEntities() {
  const call = vi.fn(async (method: string) => {
    if (method === "workers.listServices") {
      return [
        {
          source: "workers/pubsub-channel",
          kind: "durable-object",
          className: "PubSubChannel",
          protocols: ["vibestudio.channel.v1"],
        },
        {
          source: "workers/workspace-source",
          kind: "durable-object",
          className: "GadWorkspaceDO",
          protocols: ["vibestudio.vcs.v1"],
        },
      ];
    }
    if (method === "runtime.listEntities") {
      return [
        {
          id: "do:workers/pubsub-channel:PubSubChannel:chat-1",
          kind: "do",
          source: "workers/pubsub-channel",
          key: "chat-1",
          contextId: "ctx-1",
          createdAt: 10,
        },
        {
          id: "do:workers/workspace-source:GadWorkspaceDO:workspace",
          kind: "do",
          source: "workers/workspace-source",
          key: "workspace",
          contextId: "ctx-1",
          createdAt: 1,
        },
      ];
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { call, client: { call } as unknown as RpcClient };
}

describe("channel diagnostics", () => {
  it("enumerates channel runtime entities without resolving the VCS service", async () => {
    const { client, call } = clientWithEntities();

    await expect(channelEntities(client)).resolves.toEqual([
      expect.objectContaining({ key: "chat-1", contextId: "ctx-1" }),
    ]);
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "workers.listServices",
      "runtime.listEntities",
    ]);
  });

  it("addresses an existing channel directly without creator-context resolution", async () => {
    const { client, call } = clientWithEntities();

    await expect(existingChannelTarget(client, "chat-1")).resolves.toBe(
      "do:workers/pubsub-channel:PubSubChannel:chat-1"
    );
    expect(call).not.toHaveBeenCalledWith("workers.resolveService", expect.anything());
  });
});
