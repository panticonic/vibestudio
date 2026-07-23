import { describe, expect, it } from "vitest";
import { BrowserEnvironmentReadiness } from "./browserEnvironmentReadiness.js";

describe("BrowserEnvironmentReadiness", () => {
  it("holds browser work until the canonical partition is ready", async () => {
    const readiness = new BrowserEnvironmentReadiness();
    let settled = false;
    const waiting = readiness.wait().finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    readiness.ready("persist:browser-environment:test");
    await expect(waiting).resolves.toBe("persist:browser-environment:test");
    expect(readiness.requireReady()).toBe("persist:browser-environment:test");
  });

  it("fails pending and future work on a terminal initialization error", async () => {
    const readiness = new BrowserEnvironmentReadiness();
    const pending = readiness.wait();
    const failure = new Error("No verified browser environment");

    readiness.unavailable(failure);

    await expect(pending).rejects.toBe(failure);
    await expect(readiness.wait()).rejects.toBe(failure);
    expect(() => readiness.requireReady()).toThrow(failure);
  });

  it("starts a fresh pending lifecycle after an unavailable environment", async () => {
    const readiness = new BrowserEnvironmentReadiness();
    readiness.unavailable(new Error("old workspace stopped"));
    readiness.begin();
    const waiting = readiness.wait();

    readiness.ready("persist:browser-environment:next");

    await expect(waiting).resolves.toBe("persist:browser-environment:next");
  });
});
