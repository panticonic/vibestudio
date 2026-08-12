import { describe, expect, it } from "vitest";
import {
  isAutomationContextReplacement,
  retryAutomationContextReplacement,
} from "./automationContext.js";

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

  it("repeats an evaluation after the automation context is replaced", async () => {
    let attempts = 0;

    await expect(
      retryAutomationContextReplacement(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("Execution context was destroyed, most likely because of a navigation");
          }
          return "ready";
        },
        { delayMs: 0 }
      )
    ).resolves.toBe("ready");
    expect(attempts).toBe(2);
  });

  it("does not repeat deterministic evaluation failures", async () => {
    let attempts = 0;

    await expect(
      retryAutomationContextReplacement(async () => {
        attempts += 1;
        throw new Error("Unauthorized");
      })
    ).rejects.toThrow("Unauthorized");
    expect(attempts).toBe(1);
  });

  it("rethrows the final context replacement after the bounded attempts", async () => {
    let attempts = 0;

    await expect(
      retryAutomationContextReplacement(
        async () => {
          attempts += 1;
          throw new Error(`Cannot find context with specified id: ${attempts}`);
        },
        { attempts: 3, delayMs: 0 }
      )
    ).rejects.toThrow("Cannot find context with specified id: 3");
    expect(attempts).toBe(3);
  });
});
