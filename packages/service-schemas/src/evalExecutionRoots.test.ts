import { describe, expect, it } from "vitest";
import { evalExecutionRootsMethods } from "./evalExecutionRoots.js";

describe("eval execution-root method effects", () => {
  it("classifies immutable execution retention as read-only lifecycle bookkeeping", () => {
    expect(evalExecutionRootsMethods.retain.access).toEqual({ sensitivity: "read" });
  });
});
