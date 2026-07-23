import { describe, expect, it, vi } from "vitest";
import {
  cleanupDeliveryChain,
  closeDeliveryChain,
  queueDoEnvelope,
  releaseDeliveryChain,
  reopenDeliveryChain,
  type BroadcastDeps,
} from "./broadcast.js";

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
});
