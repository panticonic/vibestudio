import { describe, expect, it } from "vitest";
import {
  IROH_CONNECTION_LOST_CODE,
  isIrohConnectionLost,
  withIrohConnectionLossTag,
} from "./connectionLoss.js";

describe("isIrohConnectionLost", () => {
  it("recognizes an operation that failed because this side closed the connection", () => {
    expect(isIrohConnectionLost(new Error("ConnectionLost(LocallyClosed)"))).toBe(true);
  });

  it("recognizes a connection the peer closed", () => {
    expect(
      isIrohConnectionLost(
        new Error(
          'ConnectionLost(ApplicationClosed(ApplicationClose { error_code: 0, reason: b"" }))'
        )
      )
    ).toBe(true);
  });

  it("reads a rejection that arrived as a bare string", () => {
    expect(isIrohConnectionLost("ConnectionLost(TimedOut)")).toBe(true);
  });

  it("recognizes a call whose own stream is already closed", () => {
    // What a read or write gets after the connection carrying it went away.
    // Treating it as an ordinary fault is what put `heartbeat failed:
    // RemoteRpcError: ClosedStream` in a renderer's warnings during a
    // desktop restart, and failed the smoke on it.
    expect(isIrohConnectionLost(new Error("ClosedStream"))).toBe(true);
  });

  it("leaves a reset request alone, because that one is worth reporting", () => {
    expect(isIrohConnectionLost(new Error("ReadError(Reset(513))"))).toBe(false);
    expect(isIrohConnectionLost(new Error("no such method"))).toBe(false);
  });

  it("does not treat a missing or shapeless error as a lost connection", () => {
    expect(isIrohConnectionLost(null)).toBe(false);
    expect(isIrohConnectionLost(undefined)).toBe(false);
    expect(isIrohConnectionLost({ message: "ConnectionLost(LocallyClosed)" })).toBe(false);
  });
});

describe("withIrohConnectionLossTag", () => {
  it("passes a result through untouched", async () => {
    await expect(withIrohConnectionLossTag(async () => 7)).resolves.toBe(7);
  });

  it("tags a lost connection so the code travels instead of the message", async () => {
    const error = await withIrohConnectionLossTag(() =>
      Promise.reject(new Error("ConnectionLost(LocallyClosed)"))
    ).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      code: IROH_CONNECTION_LOST_CODE,
      errorKind: "transport",
    });
  });

  it("leaves an unrelated failure unclassified", async () => {
    const error = await withIrohConnectionLossTag(() =>
      Promise.reject(new Error("ReadError(Reset(513))"))
    ).catch((thrown: unknown) => thrown);
    expect(error).not.toHaveProperty("code");
  });

  it("replaces the napi status code that every binding error already carries", async () => {
    // Measured, not assumed: the binding stamps `code: "GenericFailure"` on
    // everything it throws. Declining to tag an error that already had a code
    // therefore declined to tag every error there is, and left this edge inert
    // for as long as it existed.
    const error = await withIrohConnectionLossTag(() =>
      Promise.reject(
        Object.assign(new Error("ConnectionLost(LocallyClosed)"), { code: "GenericFailure" })
      )
    ).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: IROH_CONNECTION_LOST_CODE, errorKind: "transport" });
  });
});
