import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_CLEANUP_LEDGER_ENV, E2E_TEMP_ROOT_ENV } from "./e2eRun.js";
import {
  assertRunOwnedPath,
  cleanupRunTempRoot,
  registerRunCleanupPath,
  releaseRunCleanupPath,
} from "./e2eCleanupLedger.js";

describe("E2E cleanup ledger", () => {
  const roots: string[] = [];
  afterEach(() => {
    delete process.env[E2E_TEMP_ROOT_ENV];
    delete process.env[E2E_CLEANUP_LEDGER_ENV];
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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

  it("preserves state when a worker exits without releasing its fixture", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cleanup-ledger-"));
    roots.push(root);
    process.env[E2E_TEMP_ROOT_ENV] = root;
    process.env[E2E_CLEANUP_LEDGER_ENV] = path.join(root, "ledger.jsonl");
    const fixture = path.join(root, "case-a");
    registerRunCleanupPath(fixture);
    const removeRoot = vi.fn();
    expect(() => cleanupRunTempRoot(root, removeRoot)).toThrow("Unreleased fixtures");
    expect(removeRoot).not.toHaveBeenCalled();
    releaseRunCleanupPath(fixture);
    cleanupRunTempRoot(root, removeRoot);
    expect(removeRoot).toHaveBeenCalledExactlyOnceWith(root);
    registerRunCleanupPath(fixture);
    expect(() => cleanupRunTempRoot(root, removeRoot)).toThrow("Unreleased fixtures");
    expect(removeRoot).toHaveBeenCalledTimes(1);
  });
});
