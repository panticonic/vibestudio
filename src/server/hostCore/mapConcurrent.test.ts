import { describe, expect, it } from "vitest";
import { mapConcurrent } from "./mapConcurrent.js";

describe("mapConcurrent", () => {
  it("keeps input order with bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapConcurrent([30, 10, 20, 0], 2, "failed", async (delay, index) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delay));
      inFlight--;
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it("joins admitted work and admits nothing new before rejecting", async () => {
    const settled: number[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
    const run = mapConcurrent([0, 1, 2], 2, "failed", async (value) => {
      if (value === 0) {
        await slow;
        settled.push(0);
        return;
      }
      if (value === 1) throw new Error("one failed");
      settled.push(value);
    });
    let rejected = false;
    run.catch(() => (rejected = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected).toBe(false);
    releaseSlow();
    await expect(run).rejects.toThrow("one failed");
    expect(settled).toEqual([0]);
  });

  it("aggregates several failures", async () => {
    await expect(
      mapConcurrent([1, 2], 2, "both failed", async (value) => {
        throw new Error(`failure ${value}`);
      })
    ).rejects.toMatchObject({
      message: "both failed",
      errors: [expect.any(Error), expect.any(Error)],
    });
  });
});
