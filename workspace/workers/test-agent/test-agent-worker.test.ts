import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";

import { TestAgentWorker } from "./test-agent-worker.js";

class CapturingTestAgentWorker extends TestAgentWorker {
  published: Array<{ event: { kind?: string; turnId?: string }; opts?: unknown }> = [];

  protected override createChannelClient() {
    return {
      publishAgenticEvent: async (
        _participantId: string,
        event: { kind?: string; turnId?: string },
        opts?: unknown
      ) => {
        this.published.push({ event, opts });
        return { id: this.published.length };
      },
    } as never;
  }

  seedDeterministicSubscription(channelId = "ch-1", participantId = "agent-test") {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      Date.now(),
      JSON.stringify({ deterministicResponse: true }),
      participantId
    );
  }
}

describe("TestAgentWorker", () => {
  it("publishes deterministic replies inside an explicit open and closed turn", async () => {
    const { instance } = await createTestDO(CapturingTestAgentWorker);
    const worker = instance as CapturingTestAgentWorker;
    worker.seedDeterministicSubscription();

    await worker.processChannelEvent("ch-1", {
      id: 1,
      messageId: "msg-1",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      senderId: "panel:user",
      senderMetadata: { type: "panel", name: "User", handle: "user" },
      payload: {
        kind: "message.completed",
        actor: { kind: "panel", id: "panel:user" },
        causality: { messageId: "user-msg-1" },
        payload: {
          protocol: "agentic.trajectory.v1",
          role: "user",
          blocks: [{ blockId: "user-msg-1:block:0", type: "text", content: "hello" }],
          outcome: "completed",
        },
        createdAt: "2026-05-28T00:00:00.000Z",
      },
      ts: Date.now(),
    });

    expect(worker.published.map(({ event }) => event.kind)).toEqual([
      "turn.opened",
      "invocation.started",
      "invocation.output",
      "invocation.completed",
      "message.completed",
      "turn.closed",
    ]);
    expect(new Set(worker.published.map(({ event }) => event.turnId))).toEqual(
      new Set(["deterministic-turn-msg-1"])
    );
  });
});
