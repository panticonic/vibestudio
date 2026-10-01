import { describe, it, expect } from "vitest";
import { BrowserActivity } from "./browserAutomation";
describe("native browser activity ownership", () => {
  it("keeps waits scoped to the originating panel and releases explicit cancellation", async () => {
    const activity = new BrowserActivity<string>();
    const a = new AbortController(),
      b = new AbortController();
    const first = activity.wait("first", a.signal),
      second = activity.wait("second", b.signal);
    const cancelled = new Error("caller cancelled");
    const rejection = expect(second).rejects.toBe(cancelled);
    activity.publish("first", "download");
    expect(await first).toBe("download");
    b.abort(cancelled);
    await rejection;
  });
  it("propagates native failure and provider teardown to every current and future waiter", async () => {
    const activity = new BrowserActivity<string>();
    const signal = new AbortController().signal;
    const error = new Error("download provider disconnected");
    const pending = expect(activity.wait("panel", signal)).rejects.toBe(error);
    activity.close(error);
    await pending;
    await expect(activity.wait("panel", signal)).rejects.toBe(error);
  });
});
