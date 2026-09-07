import { describe, expect, it } from "vitest";
import {
  isAuthorityDecisionDenied,
  isTerminalAuthorityFailure,
  isRpcConnectionLost,
  RemoteRpcError,
  RpcBoundaryError,
} from "./errors.js";

describe("isAuthorityDecisionDenied", () => {
  it("requires the structured user decision instead of denial prose", () => {
    expect(
      isAuthorityDecisionDenied({
        errorData: { authorityFailure: { reasonCode: "user-denied" } },
      })
    ).toBe(true);
    expect(isAuthorityDecisionDenied(new Error("Credential approval denied"))).toBe(false);
  });
});

describe("isTerminalAuthorityFailure", () => {
  it("classifies structured audience rejection but leaves acquisition recoverable", () => {
    const failure = (reasonCode: string) => ({
      errorData: { authorityFailure: { reasonCode } },
    });
    expect(isTerminalAuthorityFailure(failure("receiver-rejected"))).toBe(true);
    expect(isTerminalAuthorityFailure(failure("user-denied"))).toBe(true);
    expect(isTerminalAuthorityFailure(failure("approval-required"))).toBe(false);
    expect(isTerminalAuthorityFailure(failure("invalid-session"))).toBe(false);
    expect(isTerminalAuthorityFailure(new Error("receiver rejected"))).toBe(false);
  });
});

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
