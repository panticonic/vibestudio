import { describe, expect, it, vi } from "vitest";
import { createServerEventSubscriptionBridge } from "./serverEventSubscriptionBridge.js";

describe("createServerEventSubscriptionBridge", () => {
  it("forwards a desired subscription to the server once", async () => {
    const call = vi.fn(async () => undefined);
    const bridge = createServerEventSubscriptionBridge({
      getServerClient: () => ({ call }),
      log: { info: vi.fn(), warn: vi.fn() },
    });

    bridge.add("shell-approval:pending-changed");
    bridge.add("shell-approval:pending-changed");
    await bridge.replay();

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("events", "subscribe", ["shell-approval:pending-changed"]);
  });

  it("does not forward renderer unsubscriptions to the server", async () => {
    const call = vi.fn(async () => undefined);
    const bridge = createServerEventSubscriptionBridge({
      getServerClient: () => ({ call }),
      log: { info: vi.fn(), warn: vi.fn() },
    });

    bridge.add("shell-approval:pending-changed");
    await bridge.replay();
    bridge.delete("shell-approval:pending-changed");

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalledWith("events", "unsubscribe", expect.anything());
  });

  it("force replay resubscribes after a server reconnect", async () => {
    const call = vi.fn(async () => undefined);
    const bridge = createServerEventSubscriptionBridge({
      getServerClient: () => ({ call }),
      log: { info: vi.fn(), warn: vi.fn() },
    });

    bridge.add("shell-approval:pending-changed");
    await bridge.replay();
    await bridge.replay({ force: true });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(2, "events", "subscribe", [
      "shell-approval:pending-changed",
    ]);
  });

  it("retries subscriptions that previously failed", async () => {
    const warn = vi.fn();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const bridge = createServerEventSubscriptionBridge({
      getServerClient: () => ({ call }),
      log: { info: vi.fn(), warn },
    });

    bridge.add("shell-approval:pending-changed");
    await bridge.replay();
    await bridge.replay();

    expect(call).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "[events] forward subscribe(shell-approval:pending-changed) to server failed: offline"
    );
  });
});
