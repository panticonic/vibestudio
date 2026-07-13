import { describe, expect, it } from "vitest";
import { RpcBoundaryError } from "./errors.js";

describe("RpcBoundaryError", () => {
  it("preserves a standard-shaped cause on ES2020 targets", () => {
    const cause = new Error("socket closed");
    const error = new RpcBoundaryError("request failed", "transport", "ECONNRESET", cause);

    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
    expect(Object.getOwnPropertyDescriptor(error, "cause")).toMatchObject({
      enumerable: false,
      writable: true,
      configurable: true,
    });
  });
});
