import { describe, expect, it, vi } from "vitest";
import { broadcast, loadBroadcastParticipants, type BroadcastDeps } from "./broadcast.js";
import type { ChannelEvent } from "@workspace/harness";

function channelEvent(senderId: string): ChannelEvent {
  return {
    id: 1,
    messageId: "message-1",
    type: "agentic.trajectory.v1/event",
    payload: { kind: "message.read" },
    senderId,
    ts: Date.now(),
  };
}

describe("broadcast routing", () => {
  it("does not create a structured self-delivery cycle for the publisher", async () => {
    const senderId = "do:workers/agent-worker:AiChatWorker:sender";
    const recipientId = "do:workers/agent-worker:AiChatWorker:recipient";
    const streamSenderId = "panel:sender";
    const deliverParticipant = vi.fn(async () => undefined);
    const enqueueDoEnvelope = vi.fn();
    const deps = {
      objectKey: "channel-broadcast",
      participants: () => [
        { id: senderId, structured: true },
        { id: recipientId, structured: true },
        { id: streamSenderId, structured: false },
      ],
      deliverParticipant,
      enqueueDoEnvelope,
    } as unknown as BroadcastDeps;

    broadcast(deps, channelEvent(senderId), { kind: "log", phase: "live" }, senderId);

    expect(enqueueDoEnvelope).toHaveBeenCalledTimes(1);
    expect(enqueueDoEnvelope).toHaveBeenCalledWith(
      recipientId,
      expect.objectContaining({ kind: "log" })
    );
    expect(enqueueDoEnvelope).not.toHaveBeenCalledWith(senderId, expect.any(Object));
    expect(deliverParticipant).toHaveBeenCalledWith(streamSenderId, expect.any(Object));
  });

  it("delivers a logical caller's terminal while excluding the actual publisher", () => {
    const callerId = "do:workers/agent-worker:AiChatWorker:caller";
    const publisherId = "do:vibestudio/internal:EvalDO:publisher";
    const enqueueDoEnvelope = vi.fn();
    const deps = {
      objectKey: "channel-terminal",
      participants: () => [callerId, publisherId].map((id) => ({ id, structured: true })),
      deliverParticipant: vi.fn(),
      enqueueDoEnvelope,
    } as unknown as BroadcastDeps;

    broadcast(deps, channelEvent(callerId), { kind: "log", phase: "live" }, callerId, publisherId);

    expect(enqueueDoEnvelope).toHaveBeenCalledWith(
      callerId,
      expect.objectContaining({ kind: "log" })
    );
    expect(enqueueDoEnvelope).not.toHaveBeenCalledWith(publisherId, expect.any(Object));
  });

  it("projects transport routing once from participant rows", () => {
    const rows = [
      {
        id: "do:agent",
        transport: "do",
        metadata: JSON.stringify({ type: "agent", receivesChannelEnvelopes: true }),
      },
      {
        id: "do:ordinary",
        transport: "do",
        metadata: JSON.stringify({ type: "agent" }),
      },
      { id: "panel:one", transport: "rpc", metadata: "not parsed for rpc" },
    ];
    const exec = vi.fn(() => ({ toArray: () => rows }));

    expect(loadBroadcastParticipants({ exec } as never)).toEqual([
      { id: "do:agent", structured: true },
      { id: "do:ordinary", structured: false },
      { id: "panel:one", structured: false },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
