import { describe, expect, it } from "vitest";
import {
  isAutomationContextReplacement,
  retryIdempotentAutomationRead,
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
      retryIdempotentAutomationRead(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("Execution context was destroyed, most likely because of a navigation");
          }
          return "ready";
        },
        { label: "reading readiness", delayMs: 0 }
      )
    ).resolves.toBe("ready");
    expect(attempts).toBe(2);
  });

  it("does not repeat deterministic evaluation failures", async () => {
    let attempts = 0;

    await expect(
      retryIdempotentAutomationRead(
        async () => {
          attempts += 1;
          throw new Error("Unauthorized");
        },
        { label: "reading readiness" }
      )
    ).rejects.toThrow("Unauthorized");
    expect(attempts).toBe(1);
  });

  it("retries bootstrap Test API absence", async () => {
    let attempts = 0;

    await expect(
      retryIdempotentAutomationRead(
        async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Test API not available");
          return "ready";
        },
        { label: "reading readiness", delayMs: 0 }
      )
    ).resolves.toBe("ready");
    expect(attempts).toBe(2);
  });

  it("bounds a hung observation by wall-clock time", async () => {
    await expect(
      retryIdempotentAutomationRead(() => new Promise(() => {}), {
        label: "reading a hung observation",
        timeoutMs: 10,
      })
    ).rejects.toThrow("[AutomationRead] Timed out after 10ms while reading a hung observation");
  });

  it("reports the last transient failure when the deadline expires", async () => {
    await expect(
      retryIdempotentAutomationRead(
        async () => {
          throw new Error("Cannot find context with specified id: 42");
        },
        { label: "reading readiness", timeoutMs: 10, delayMs: 0 }
      )
    ).rejects.toThrow("last transient failure: Cannot find context with specified id: 42");
  });
});
