import { describe, expect, it } from "vitest";
import { evalRuntimeId } from "./evalRuntimeIdentity.js";

describe("evalRuntimeId", () => {
  it("derives a stable identity from both owner and scope", () => {
    const first = evalRuntimeId("session:perf", "default");
    expect(first).toMatch(/^do:vibestudio\/internal:EvalDO:[a-f0-9]{40}$/);
    expect(evalRuntimeId("session:perf", "default")).toBe(first);
    expect(evalRuntimeId("session:other", "default")).not.toBe(first);
    expect(evalRuntimeId("session:perf", "other")).not.toBe(first);
  });
});
