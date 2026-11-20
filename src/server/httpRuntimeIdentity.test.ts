import { describe, expect, it } from "vitest";
import { resolveHttpRuntimeCaller } from "./httpRuntimeIdentity.js";

describe("resolveHttpRuntimeCaller", () => {
  it("projects a class-scoped Durable Object service bearer to its concrete object", () => {
    expect(
      resolveHttpRuntimeCaller(
        "do-service:workers/session:SessionDO",
        "worker",
        "do:workers/session:SessionDO:owner-1"
      )
    ).toBe("do:workers/session:SessionDO:owner-1");
  });

  it("does not let a service bearer cross a source or class boundary", () => {
    expect(() =>
      resolveHttpRuntimeCaller(
        "do-service:workers/session:SessionDO",
        "worker",
        "do:vibestudio/internal:WorkspaceDO:owner-1"
      )
    ).toThrow(/cannot act as/);
  });

  it("rejects a class identity with no concrete object key", () => {
    expect(() =>
      resolveHttpRuntimeCaller(
        "do-service:workers/session:SessionDO",
        "worker",
        "do:workers/session:SessionDO:"
      )
    ).toThrow(/cannot act as/);
  });
});
