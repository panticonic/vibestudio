/**
 * activityRegistry unit tests — begin/end aggregation, oldestStartedAt tracking
 * (with injected `now`), double-begin idempotency, and unknown-id end being a
 * no-op.
 */

import { describe, it, expect } from "vitest";
import { createActivityRegistry } from "./activityRegistry.js";

describe("createActivityRegistry", () => {
  it("aggregates activeRuns across begin/end", () => {
    const reg = createActivityRegistry();
    expect(reg.getActivity()).toEqual({ activeRuns: 0, oldestStartedAt: null });

    reg.begin("eval:a");
    reg.begin("eval:b");
    expect(reg.getActivity().activeRuns).toBe(2);

    reg.end("eval:a");
    expect(reg.getActivity().activeRuns).toBe(1);

    reg.end("eval:b");
    expect(reg.getActivity()).toEqual({ activeRuns: 0, oldestStartedAt: null });
  });

  it("tracks oldestStartedAt from the injected clock", () => {
    let t = 100;
    const reg = createActivityRegistry(() => t);

    reg.begin("eval:a");
    t = 250;
    reg.begin("eval:b");
    expect(reg.getActivity()).toEqual({ activeRuns: 2, oldestStartedAt: 100 });

    // Ending the oldest advances oldestStartedAt to the next-oldest.
    reg.end("eval:a");
    expect(reg.getActivity()).toEqual({ activeRuns: 1, oldestStartedAt: 250 });
  });

  it("treats double-begin of the same id as idempotent (keeps first startedAt)", () => {
    let t = 10;
    const reg = createActivityRegistry(() => t);

    reg.begin("eval:a");
    t = 999;
    reg.begin("eval:a");

    expect(reg.getActivity()).toEqual({ activeRuns: 1, oldestStartedAt: 10 });
  });

  it("ignores end of an unknown id", () => {
    const reg = createActivityRegistry(() => 5);
    reg.begin("eval:a");
    reg.end("eval:does-not-exist");
    expect(reg.getActivity()).toEqual({ activeRuns: 1, oldestStartedAt: 5 });
  });
});
