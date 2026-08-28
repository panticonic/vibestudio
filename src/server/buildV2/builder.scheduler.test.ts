import { describe, expect, it } from "vitest";

import { hasBuildSlotCapacity } from "./builder.js";

describe("Build V2 scheduler capacity", () => {
  it("reserves one multi-lane permit from speculative work", () => {
    expect(hasBuildSlotCapacity("speculative", 2, 2, 1, 3)).toBe(false);
    expect(hasBuildSlotCapacity("background", 2, 2, 1, 3)).toBe(false);
    expect(hasBuildSlotCapacity("interactive", 2, 2, 1, 3)).toBe(true);
  });

  it("admits required background work alongside one speculative build", () => {
    expect(hasBuildSlotCapacity("background", 1, 1, 1, 3)).toBe(true);
    expect(hasBuildSlotCapacity("speculative", 1, 1, 1, 3)).toBe(false);
  });

  it("still makes progress when only one lane exists", () => {
    expect(hasBuildSlotCapacity("speculative", 0, 0, 0, 1)).toBe(true);
    expect(hasBuildSlotCapacity("speculative", 1, 1, 1, 1)).toBe(false);
  });
});
