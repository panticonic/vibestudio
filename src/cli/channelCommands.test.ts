import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpcClient.js";
import { channelEntities, existingChannelTarget, toHistoryEntry } from "./channelCommands.js";

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
  const mainCall = vi.fn((method: string) => call(method));
  return { call: mainCall, client: { mainCall } as unknown as RpcClient };
}

describe("channel diagnostics", () => {
  it("retains protocol evidence even when a model round has no display text", () => {
    const payload = {
      kind: "message.completed",
      payload: {
        outcome: "tool_calls_only",
        blocks: [{ type: "data", metadata: { pi: { type: "toolCall", name: "read" } } }],
      },
    };
    expect(
      toHistoryEntry({
        id: 6,
        messageId: "native:4:41:0",
        type: "agentic.trajectory.v1/event",
        senderId: "agent-1",
        payload,
        ts: 10,
      })
    ).toMatchObject({
      seq: 6,
      text: null,
      payload,
    });
  });

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
