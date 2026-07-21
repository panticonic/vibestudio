import { describe, expect, it } from "vitest";
import { isAutomationContextReplacement } from "./automationContext.js";

describe("automation context replacement classification", () => {
  it.each([
    "Execution context was destroyed, most likely because of a navigation",
    "Cannot find context with specified id",
    "Inspected target navigated or closed",
  ])("retries the bootstrap handoff race: %s", (message) => {
    expect(isAutomationContextReplacement(new Error(message))).toBe(true);
  });

  it.each([
    "[hubControl.listWorkspaces] Compositional authority resolver is unavailable",
    "Unauthorized",
    "Target page, context or browser has been closed",
  ])("does not hide a deterministic failure: %s", (message) => {
    expect(isAutomationContextReplacement(new Error(message))).toBe(false);
  });
});
