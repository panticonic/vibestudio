import { describe, expect, it, vi } from "vitest";
import { broadcast, type BroadcastDeps } from "./broadcast.js";
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
    const call = vi.fn(async () => undefined);
    const deliverParticipant = vi.fn(async () => undefined);
    const enqueueDoEnvelope = vi.fn();
    const deps = {
      objectKey: "channel-broadcast",
      sql: {
        exec: () => ({
          toArray: () => [
            {
              id: senderId,
              transport: "do",
              metadata: JSON.stringify({
                type: "agent",
                receivesChannelEnvelopes: true,
              }),
            },
            {
              id: recipientId,
              transport: "do",
              metadata: JSON.stringify({
                type: "agent",
                receivesChannelEnvelopes: true,
              }),
            },
            { id: streamSenderId, transport: "rpc", metadata: "{}" },
          ],
        }),
      },
      rpc: { call },
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
    expect(call).not.toHaveBeenCalled();
    expect(deliverParticipant).toHaveBeenCalledWith(streamSenderId, expect.any(Object));
  });

  it("delivers a logical caller's terminal while excluding the actual publisher", () => {
    const callerId = "do:workers/agent-worker:AiChatWorker:caller";
    const publisherId = "do:vibestudio/internal:EvalDO:publisher";
    const enqueueDoEnvelope = vi.fn();
    const deps = {
      objectKey: "channel-terminal",
      sql: {
        exec: () => ({
          toArray: () =>
            [callerId, publisherId].map((id) => ({
              id,
              transport: "do",
              metadata: JSON.stringify({
                type: "agent",
                receivesChannelEnvelopes: true,
              }),
            })),
        }),
      },
      rpc: { call: vi.fn() },
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
});
