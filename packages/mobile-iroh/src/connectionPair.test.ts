import { describe, expect, it } from "vitest";
import { MobileConnectionAggregateError } from "./connectionPair.js";

describe("mobile connection failures", () => {
  it("retains nested causes and includes each leaf in the visible message", () => {
    const readFailure = new Error("native stream read failed");
    const closeFailure = new Error("endpoint shutdown failed");
    const nested = new AggregateError([readFailure, closeFailure], "pipe cleanup failed");
    const failure = new MobileConnectionAggregateError(
      [nested, new Error("hub close failed")],
      "Mobile connections failed to close"
    );
    expect(failure.errors).toEqual([nested, expect.any(Error)]);
    expect(failure.cause).toBe(nested);
    expect(failure.message).toMatch(
      /pipe cleanup failed.*native stream read failed.*endpoint shutdown failed.*hub close failed/u
    );
  });
});
