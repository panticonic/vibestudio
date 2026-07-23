import { describe, expect, it } from "vitest";
import { resolveHttpRuntimeCaller } from "./httpRuntimeIdentity.js";

describe("resolveHttpRuntimeCaller", () => {
  it("projects a class-scoped Durable Object service bearer to its concrete object", () => {
    expect(
      resolveHttpRuntimeCaller(
        "do-service:vibestudio/internal:EvalDO",
        "worker",
        "do:vibestudio/internal:EvalDO:owner-1"
      )
    ).toBe("do:vibestudio/internal:EvalDO:owner-1");
  });

  it("does not let a service bearer cross a source or class boundary", () => {
    expect(() =>
      resolveHttpRuntimeCaller(
        "do-service:vibestudio/internal:EvalDO",
        "worker",
        "do:vibestudio/internal:WorkspaceDO:owner-1"
      )
    ).toThrow(/cannot act as/);
  });

  it("rejects a class identity with no concrete object key", () => {
    expect(() =>
      resolveHttpRuntimeCaller(
        "do-service:vibestudio/internal:EvalDO",
        "worker",
        "do:vibestudio/internal:EvalDO:"
      )
    ).toThrow(/cannot act as/);
  });
});
