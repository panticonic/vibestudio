import { describe, expect, it, vi } from "vitest";
import { BoundedTaskScheduler } from "./boundedTaskScheduler.js";

describe("BoundedTaskScheduler", () => {
  it("bounds the full task lifecycle and starts queued work in FIFO order", async () => {
    const scheduler = new BoundedTaskScheduler(2);
    const releases: Array<() => void> = [];
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;

    const tasks = [0, 1, 2, 3].map((id) =>
      scheduler.run(async () => {
        started.push(id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      })
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases.splice(0).forEach((release) => release());
    await Promise.all(tasks);

    expect(maximumActive).toBe(2);
  });

  it("releases capacity when a task rejects", async () => {
    const scheduler = new BoundedTaskScheduler(1);
    const failed = scheduler.run(async () => {
      throw new Error("failed");
    });
    const next = vi.fn(async () => "ready");

    await expect(failed).rejects.toThrow("failed");
    await expect(scheduler.run(next)).resolves.toBe("ready");
    expect(next).toHaveBeenCalledOnce();
  });
});
