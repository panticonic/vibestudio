import { describe, expect, it, vi } from "vitest";
import { AsyncStateConvergenceLoop } from "./asyncStateConvergenceLoop.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("AsyncStateConvergenceLoop", () => {
  it("replays a state-change request received while synchronization is in flight", async () => {
    vi.useFakeTimers();
    const first = deferred<"settled">();
    const sync = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("settled");
    const loop = new AsyncStateConvergenceLoop(sync, () => false, 1_000);

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    expect(sync).toHaveBeenCalledTimes(1);

    loop.request();
    first.resolve("settled");
    await vi.runAllTimersAsync();

    expect(sync).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("level-checks non-terminal state until it converges", async () => {
    vi.useFakeTimers();
    const sync = vi
      .fn<() => Promise<"preparing" | "adopted">>()
      .mockResolvedValueOnce("preparing")
      .mockResolvedValueOnce("adopted");
    const loop = new AsyncStateConvergenceLoop(sync, (result) => result === "preparing", 1_000);

    loop.start();
    await vi.runAllTimersAsync();

    expect(sync).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not restart after a pending synchronization is stopped", async () => {
    vi.useFakeTimers();
    const first = deferred<"preparing">();
    const sync = vi.fn().mockReturnValue(first.promise);
    const loop = new AsyncStateConvergenceLoop(sync, () => true, 1_000);

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    loop.request();
    loop.stop();
    first.resolve("preparing");
    await vi.runAllTimersAsync();

    expect(sync).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
