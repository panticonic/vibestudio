import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_TEMP_ROOT_ENV } from "./e2eRun.js";
import {
  assertRunOwnedPath,
  cleanupRunTempRoot,
  releaseRunCleanupPath,
} from "./e2eCleanupLedger.js";

describe("E2E cleanup ledger", () => {
  afterEach(() => {
    delete process.env[E2E_TEMP_ROOT_ENV];
  });

  it("accepts only exact descendants of the owned run root", () => {
    expect(assertRunOwnedPath("/tmp/run/case-a", "/tmp/run")).toBe("/tmp/run/case-a");
    expect(() => assertRunOwnedPath("/tmp/run", "/tmp/run")).toThrow("strict descendant");
    expect(() => assertRunOwnedPath("/tmp/run-neighbor", "/tmp/run")).toThrow("strict descendant");
  });

  it("defers managed paths when a Playwright run owns them", () => {
    process.env[E2E_TEMP_ROOT_ENV] = "/tmp/run";
    expect(releaseRunCleanupPath("/tmp/run/case-a")).toBe(true);
  });

  it("performs one recursive run-root deletion in the final cleanup phase", () => {
    const removeRoot = vi.fn();
    cleanupRunTempRoot("/tmp/run", removeRoot);
    expect(removeRoot).toHaveBeenCalledOnce();
    expect(removeRoot).toHaveBeenCalledWith("/tmp/run");
  });
});
