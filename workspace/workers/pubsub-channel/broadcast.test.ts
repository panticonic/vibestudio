import { describe, expect, it, vi } from "vitest";
import {
  broadcast,
  cleanupDeliveryChain,
  closeDeliveryChain,
  queueDoEnvelope,
  releaseDeliveryChain,
  reopenDeliveryChain,
  type BroadcastDeps,
} from "./broadcast.js";
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
    expect(enqueueDoEnvelope).not.toHaveBeenCalledWith(
      senderId,
      expect.any(Object)
    );
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

    broadcast(
      deps,
      channelEvent(callerId),
      { kind: "log", phase: "live" },
      callerId,
      publisherId
    );

    expect(enqueueDoEnvelope).toHaveBeenCalledWith(
      callerId,
      expect.objectContaining({ kind: "log" })
    );
    expect(enqueueDoEnvelope).not.toHaveBeenCalledWith(publisherId, expect.any(Object));
  });
});

describe("structured participant delivery lifecycle", () => {
  it("drains accepted delivery and rejects later envelopes before membership teardown", async () => {
    let release!: () => void;
    const firstDelivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = vi.fn(() => firstDelivery);
    const deps = {
      objectKey: "channel-drain",
      rpc: { call },
    } as unknown as BroadcastDeps;
    const participantId = "do:workers/agent:AgentDO:drain";

    const accepted = queueDoEnvelope(deps, participantId, {
      kind: "control",
      type: "ready",
      ready: { totalCount: 0, envelopeCount: 0 },
    });
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    const closing = closeDeliveryChain(deps.objectKey, participantId);
    const rejected = queueDoEnvelope(deps, participantId, {
      kind: "control",
      type: "ready",
      ready: { totalCount: 0, envelopeCount: 0 },
    });

    await rejected;
    expect(call).toHaveBeenCalledTimes(1);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await Promise.all([accepted, closing]);
    expect(closed).toBe(true);
    cleanupDeliveryChain(deps.objectKey, participantId);
  });

  it("cancels an activation delivery without deleting or reopening its lane implicitly", async () => {
    const call = vi.fn(
      (_target: string, _method: string, _args: unknown[], options?: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        })
    );
    const deps = {
      objectKey: "channel-release",
      rpc: { call },
    } as unknown as BroadcastDeps;
    const participantId = "do:workers/agent:AgentDO:release";
    const envelope = {
      kind: "control" as const,
      type: "ready" as const,
      ready: { totalCount: 0, envelopeCount: 0 },
    };

    const accepted = queueDoEnvelope(deps, participantId, envelope);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    await releaseDeliveryChain(deps.objectKey, participantId);
    await accepted;

    await queueDoEnvelope(deps, participantId, envelope);
    expect(call).toHaveBeenCalledTimes(1);

    reopenDeliveryChain(deps.objectKey, participantId);
    const replacement = queueDoEnvelope(deps, participantId, envelope);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    cleanupDeliveryChain(deps.objectKey, participantId);
    await replacement;
  });

  it("does not let a non-cooperative delivery hold activation release", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const call = vi.fn(() => pending);
    const deps = {
      objectKey: "channel-noncooperative-release",
      rpc: { call },
    } as unknown as BroadcastDeps;
    const participantId = "do:workers/agent:AgentDO:noncooperative";
    const envelope = {
      kind: "control" as const,
      type: "ready" as const,
      ready: { totalCount: 0, envelopeCount: 0 },
    };

    const accepted = queueDoEnvelope(deps, participantId, envelope);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    await expect(releaseDeliveryChain(deps.objectKey, participantId)).resolves.toBeUndefined();

    await queueDoEnvelope(deps, participantId, envelope);
    expect(call).toHaveBeenCalledTimes(1);

    finish();
    await accepted;
    reopenDeliveryChain(deps.objectKey, participantId);
    await queueDoEnvelope(deps, participantId, envelope);
    expect(call).toHaveBeenCalledTimes(2);
    cleanupDeliveryChain(deps.objectKey, participantId);
  });
});
