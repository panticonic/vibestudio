import { describe, expect, it } from "vitest";
import { launchGateProgress, launchGateText } from "./launchGateModel.js";

describe("launch gate model", () => {
  it("derives the steps a launch has taken from where it is", () => {
    expect(launchGateProgress({ status: "starting", reason: "" })).toEqual([]);
    expect(
      launchGateProgress({ status: "preparing", phase: "extensions", reason: "starting" })
    ).toEqual([
      { phase: "resolve", state: "complete" },
      { phase: "extensions", state: "active", detail: "starting" },
    ]);
    expect(launchGateProgress({ status: "approval-required", approvals: [] })).toEqual([
      { phase: "resolve", state: "complete" },
      { phase: "extensions", state: "complete" },
      { phase: "build", state: "blocked" },
    ]);
    expect(
      launchGateProgress({ status: "ready", title: "Browser" }).every((s) => s.state === "complete")
    ).toBe(true);
    // An unavailable launch shows where it actually stopped.
    expect(
      launchGateProgress({ status: "unavailable", reason: "unknown", phase: "resolve" })
    ).toEqual([{ phase: "resolve", state: "failed", detail: "unknown" }]);
    expect(
      launchGateProgress({ status: "unavailable", reason: "no build", phase: "build" })
    ).toEqual([
      { phase: "resolve", state: "complete" },
      { phase: "extensions", state: "complete" },
      { phase: "build", state: "failed", detail: "no build" },
    ]);
    expect(
      launchGateProgress({ status: "unavailable", reason: "no", declined: true, phase: "build" })
    ).toEqual([
      { phase: "resolve", state: "complete" },
      { phase: "extensions", state: "complete" },
      { phase: "build", state: "blocked" },
    ]);
    // A client that ended without a launch has no steps to show.
    expect(launchGateProgress({ status: "unavailable", reason: "retired" })).toEqual([]);
  });

  it("says one readable sentence per state", () => {
    expect(launchGateText({ status: "ready", title: "Browser" })).toBe(
      "Browser is approved and launching."
    );
    expect(launchGateText({ status: "failed", reason: "boom" })).toBe("boom");
    expect(launchGateText({ status: "approval-required", approvals: [] })).toMatch(
      /Review the code/
    );
  });
});
