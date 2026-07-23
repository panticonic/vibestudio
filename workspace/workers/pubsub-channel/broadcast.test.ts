import { describe, expect, it, vi } from "vitest";
import {
  cleanupDeliveryChain,
  closeDeliveryChain,
  queueDoEnvelope,
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
});
