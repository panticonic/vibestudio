import { describe, expect, it } from "vitest";

import { CompactionTrigger } from "./compaction-trigger.js";

describe("CompactionTrigger.shouldCompact", () => {
  const model = { contextWindow: 100 } as any;

  it("returns false when disabled", () => {
    const trigger = new CompactionTrigger({ settings: { enabled: false } });
    expect(trigger.shouldCompact([{ role: "user", content: "hello", timestamp: 1 } as any], model)).toBe(false);
  });

  it("returns false when the model has no context window", () => {
    const trigger = new CompactionTrigger();
    expect(trigger.shouldCompact([{ role: "user", content: "hello", timestamp: 1 } as any], {} as any)).toBe(false);
  });
});
