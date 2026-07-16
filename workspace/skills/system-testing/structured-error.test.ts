import { describe, expect, it } from "vitest";
import { serializeSystemTestError } from "./structured-error.js";

describe("structured system-test errors", () => {
  it("preserves typed RPC evidence and indexes opaque diagnostic handles", () => {
    const error = Object.assign(new Error("[vcs.importSnapshot] internal failure"), {
      name: "RemoteRpcError",
      code: "InternalFailure",
      errorKind: "application",
      errorData: {
        code: "InternalFailure",
        message: "Operation failed; use the diagnostic handle",
        handle: "diagnostic:vcs:01JABC",
        nested: {
          apiToken: "do-not-persist",
          diagnostic_handle: "diagnostic:vcs:01JDEF",
        },
      },
      cause: new Error("credential=do-not-persist"),
    });
    Object.defineProperty(error, "stack", {
      enumerable: true,
      value: "stack containing do-not-persist",
    });

    const serialized = serializeSystemTestError(error);

    expect(serialized).toEqual({
      name: "RemoteRpcError",
      message: "[vcs.importSnapshot] internal failure",
      code: "InternalFailure",
      errorKind: "application",
      errorData: {
        code: "InternalFailure",
        message: "Operation failed; use the diagnostic handle",
        handle: "diagnostic:vcs:01JABC",
        nested: {
          apiToken: "[redacted]",
          diagnostic_handle: "diagnostic:vcs:01JDEF",
        },
      },
      diagnosticHandles: ["diagnostic:vcs:01JABC", "diagnostic:vcs:01JDEF"],
    });
    expect(JSON.stringify(serialized)).not.toContain("stack containing");
    expect(JSON.stringify(serialized)).not.toContain("do-not-persist");
  });

  it("produces bounded JSON-safe data without invoking accessors", () => {
    const cyclic: Record<string, unknown> = { value: Number.POSITIVE_INFINITY };
    cyclic["self"] = cyclic;
    Object.defineProperty(cyclic, "password", {
      enumerable: true,
      get: () => {
        throw new Error("accessor must not run");
      },
    });
    const error = Object.assign(new Error("authorization=top-secret"), {
      errorData: cyclic,
    });

    const serialized = serializeSystemTestError(error);

    expect(serialized.message).toBe("authorization=[redacted]");
    expect(serialized.errorData).toEqual({
      value: "Infinity",
      self: "[circular]",
      password: "[redacted]",
    });
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });
});
