import { describe, expect, it, vi } from "vitest";
import { ResidentSessionRegistry } from "./residentSession.js";

describe("activation-owned resident session registry", () => {
  it("keeps delivery and cancellation separate for owners sharing one executable and channel", async () => {
    const first = new ResidentSessionRegistry();
    const second = new ResidentSessionRegistry();
    const firstReceiver = vi.fn(async () => undefined);
    const secondReceiver = vi.fn(async () => undefined);
    const closeFirst = first.register("channel:shared", firstReceiver, { targetId: "channel:owner" });
    second.register("channel:shared", secondReceiver, { targetId: "channel:owner" });

    await first.acceptInvocation({ channelId: "channel:shared", message: "first" });
    await second.acceptInvocation({ channelId: "channel:shared", message: "second" });
    await first.cancelInvocation({ channelId: "channel:shared", transportCallId: "call:first" });
    expect(firstReceiver.mock.calls).toEqual([
      [{ channelId: "channel:shared", message: "first" }],
      [{ channelId: "channel:shared", cancellation: { transportCallId: "call:first" } }],
    ]);
    expect(secondReceiver.mock.calls).toEqual([[{ channelId: "channel:shared", message: "second" }]]);
    closeFirst();
    expect(first.inspect()).toEqual([]);
    expect(second.target("channel:shared")).toBe("channel:owner");
    await second.acceptInvocation({ channelId: "channel:shared", message: "still active" });
    await expect(first.deliver("channel:shared", {})).rejects.toMatchObject({ code: "ResidentSessionUnavailable" });
  });

  it("reconstructs an owner after facet eviction without retaining its old activation callback", async () => {
    const evicted = new ResidentSessionRegistry();
    const oldReceiver = vi.fn(async () => undefined);
    const oldCleanup = evicted.register("channel:one", oldReceiver, { targetId: "channel:old" });
    const restored = new ResidentSessionRegistry();
    const currentReceiver = vi.fn(async () => undefined);
    restored.register("channel:one", currentReceiver, { targetId: "channel:current" });
    oldCleanup();
    await restored.acceptInvocation({ channelId: "channel:one", message: "replay" });
    expect(oldReceiver).not.toHaveBeenCalled();
    expect(currentReceiver).toHaveBeenCalledExactlyOnceWith({ channelId: "channel:one", message: "replay" });
    expect(restored.target("channel:one")).toBe("channel:current");
  });
});
