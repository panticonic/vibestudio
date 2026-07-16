import { describe, expect, it } from "vitest";
import { createQueuedRefresh } from "./queuedRefresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createQueuedRefresh", () => {
  it("runs one follow-up pass when invalidated during an in-flight refresh", async () => {
    const refresh = createQueuedRefresh();
    const first = deferred();
    const calls: string[] = [];

    const running = refresh.run(async () => {
      calls.push(`run-${calls.length + 1}`);
      if (calls.length === 1) await first.promise;
    });
    refresh.run(async () => {
      calls.push(`run-${calls.length + 1}`);
    });

    await Promise.resolve();
    expect(calls).toEqual(["run-1"]);
    first.resolve();
    await running;
    expect(calls).toEqual(["run-1", "run-2"]);
  });

  it("drops queued work after reset", async () => {
    const refresh = createQueuedRefresh();
    const first = deferred();
    const calls: string[] = [];

    const running = refresh.run(async () => {
      calls.push("old");
      await first.promise;
    });
    await Promise.resolve();
    refresh.run(() => {
      calls.push("queued-old");
    });
    refresh.reset();
    refresh.run(() => {
      calls.push("new");
    });

    first.resolve();
    await running;
    await Promise.resolve();
    expect(calls).toEqual(["old", "new"]);
  });
});
