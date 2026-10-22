import { describe, expect, it } from "vitest";
import { mapBounded } from "./boundedMap.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("mapBounded", () => {
  it("never has more than the limit in flight and keeps the order of its results", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapBounded([5, 4, 3, 2, 1, 0], 2, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      for (let i = 0; i < value; i += 1) await tick();
      inFlight -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 40, 30, 20, 10, 0]);
    expect(peak).toBe(2);
  });

  it("starts nothing more after a failure and reports it once the work in flight has settled", async () => {
    const started: number[] = [];
    let settled = 0;
    const failure = new Error("fetch failed");
    await expect(
      mapBounded([0, 1, 2, 3, 4, 5], 2, async (value) => {
        started.push(value);
        if (value === 0) throw failure;
        await tick();
        await tick();
        settled += 1;
        return value;
      })
    ).rejects.toBe(failure);
    expect(started).toEqual([0, 1]);
    expect(settled).toBe(1);
  });

  it("accepts no items and rejects a limit that cannot make progress", async () => {
    await expect(mapBounded([], 3, async () => 1)).resolves.toEqual([]);
    await expect(mapBounded([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });
});
