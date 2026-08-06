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
    const enqueueDoEnvelopes = vi.fn();
    const deps = {
      objectKey: "channel-broadcast",
      participants: () => [
        { id: senderId, structured: true, incarnation: "sender-incarnation" },
        { id: recipientId, structured: true, incarnation: "recipient-incarnation" },
        { id: streamSenderId, structured: false, incarnation: null },
      ],
      deliverParticipant,
      enqueueDoEnvelopes,
    } as unknown as BroadcastDeps;

    broadcast(deps, channelEvent(senderId), { kind: "log", phase: "live" }, senderId);

    expect(enqueueDoEnvelopes).toHaveBeenCalledOnce();
    expect(enqueueDoEnvelopes).toHaveBeenCalledWith([
      {
        participantId: recipientId,
        targetIncarnation: "recipient-incarnation",
        envelope: expect.objectContaining({ kind: "log" }),
      },
    ]);
    expect(deliverParticipant).toHaveBeenCalledWith(streamSenderId, expect.any(Object));
  });

  it("delivers a logical caller's terminal while excluding the actual publisher", () => {
    const callerId = "do:workers/agent-worker:AiChatWorker:caller";
    const publisherId = "do:vibestudio/internal:EvalDO:publisher";
    const enqueueDoEnvelopes = vi.fn();
    const deps = {
      objectKey: "channel-terminal",
      participants: () =>
        [callerId, publisherId].map((id) => ({
          id,
          structured: true,
          incarnation: `${id}:incarnation`,
        })),
      deliverParticipant: vi.fn(),
      enqueueDoEnvelopes,
    } as unknown as BroadcastDeps;

    broadcast(deps, channelEvent(callerId), { kind: "log", phase: "live" }, callerId, publisherId);

    expect(enqueueDoEnvelopes).toHaveBeenCalledWith([
      {
        participantId: callerId,
        targetIncarnation: `${callerId}:incarnation`,
        envelope: expect.objectContaining({ kind: "log" }),
      },
    ]);
  });

  it("enqueues every structured recipient as one ordered batch", () => {
    const enqueueDoEnvelopes = vi.fn();
    const deps = {
      objectKey: "channel-batch",
      participants: () => [
        { id: "agent:first", structured: true, incarnation: "incarnation:first" },
        { id: "agent:second", structured: true, incarnation: "incarnation:second" },
      ],
      deliverParticipant: vi.fn(),
      enqueueDoEnvelopes,
    } satisfies BroadcastDeps;

    broadcast(deps, channelEvent("panel:user"), { kind: "log", phase: "live" }, "panel:user");

    expect(enqueueDoEnvelopes).toHaveBeenCalledOnce();
    expect(enqueueDoEnvelopes.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        participantId: "agent:first",
        targetIncarnation: "incarnation:first",
      }),
      expect.objectContaining({
        participantId: "agent:second",
        targetIncarnation: "incarnation:second",
      }),
    ]);
  });

  it("projects transport routing once from participant rows", () => {
    const rows = [
      {
        id: "do:agent",
        transport: "do",
        metadata: JSON.stringify({ type: "agent", receivesChannelEnvelopes: true }),
        participant_incarnation: "agent-incarnation",
      },
      {
        id: "do:ordinary",
        transport: "do",
        metadata: JSON.stringify({ type: "agent" }),
        participant_incarnation: "ordinary-incarnation",
      },
      {
        id: "panel:one",
        transport: "rpc",
        metadata: "not parsed for rpc",
        participant_incarnation: null,
      },
    ];
    const exec = vi.fn(() => ({ toArray: () => rows }));

    expect(loadBroadcastParticipants({ exec } as never)).toEqual([
      { id: "do:agent", structured: true, incarnation: "agent-incarnation" },
      { id: "do:ordinary", structured: false, incarnation: "ordinary-incarnation" },
      { id: "panel:one", structured: false, incarnation: null },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
