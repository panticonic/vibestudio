import { describe, expect, it } from "vitest";
import { classifyStartupDependency } from "./startupDependencyStatus.js";

describe("classifyStartupDependency", () => {
  it.each([
    [Object.assign(new Error("provider unavailable"), { code: "ENOEXT" })],
    [Object.assign(new Error("provider starting"), { code: "ENOTREADY" })],
    [new Error("Extension is waiting for approval")],
  ])("treats approval and provider readiness as waiting for consent", (error) => {
    expect(classifyStartupDependency(error)).toEqual({
      state: "waiting-for-consent",
      message: "Waiting for you to review the workspace dependency provider.",
    });
  });

  it("keeps genuine import errors visible as failures", () => {
    expect(classifyStartupDependency(new Error("remote repository is corrupt"))).toEqual({
      state: "failed",
      message: "remote repository is corrupt",
    });
  });
});
