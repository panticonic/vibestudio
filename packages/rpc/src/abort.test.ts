import { describe, expect, it } from "vitest";
import { throwIfAborted } from "./abort.js";

describe("throwIfAborted", () => {
  it("does nothing for a live signal without newer AbortSignal methods", () => {
    const signal = { aborted: false } as AbortSignal;
    expect(() => throwIfAborted(signal)).not.toThrow();
  });

  it("throws the signal reason unchanged when cancellation has happened", () => {
    const reason = new Error("caller cancelled");
    const signal = { aborted: true, reason } as AbortSignal;
    expect(() => throwIfAborted(signal)).toThrow(reason);
  });

  it("uses an AbortError when an older signal has no reason", () => {
    const signal = { aborted: true } as AbortSignal;
    expect(() => throwIfAborted(signal)).toThrow(expect.objectContaining({ name: "AbortError" }));
  });
});
