import { describe, expect, it } from "vitest";
import { isRpcConnectionLost, RemoteRpcError, RpcBoundaryError } from "./errors.js";

describe("isRpcConnectionLost", () => {
  it("recognizes reserved session loss across local and remote carriers", () => {
    expect(
      isRpcConnectionLost(Object.assign(new Error("offline"), { code: "CONNECTION_LOST" }))
    ).toBe(true);
    expect(isRpcConnectionLost(new RemoteRpcError("offline", "transport", "CONNECTION_LOST"))).toBe(
      true
    );
    const remote = new RemoteRpcError("offline", "transport", "CONNECTION_LOST");
    expect(
      isRpcConnectionLost(
        Object.assign(new Error("subscription unavailable"), {
          code: "connection",
          errorCode: "CONNECTION_LOST",
          cause: remote,
        })
      )
    ).toBe(true);
  });

  it.each(["access", "service", "protocol", "application", "internal"] as const)(
    "preserves explicitly categorized %s failures",
    (kind) =>
      expect(isRpcConnectionLost(new RemoteRpcError("failure", kind, "CONNECTION_LOST"))).toBe(
        false
      )
  );

  it("does not infer session loss from prose or unrelated transport failures", () => {
    expect(isRpcConnectionLost(new Error("Connection lost before the response arrived"))).toBe(
      false
    );
    expect(isRpcConnectionLost(new RpcBoundaryError("offline", "transport", "ECONNRESET"))).toBe(
      false
    );
    expect(
      isRpcConnectionLost(
        Object.assign(new Error("domain failure"), {
          code: "server",
          errorCode: "CONNECTION_LOST",
        })
      )
    ).toBe(false);
    expect(isRpcConnectionLost(null)).toBe(false);
  });
});

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
