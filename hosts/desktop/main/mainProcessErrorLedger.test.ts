import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  clearMainProcessErrors,
  readMainProcessErrors,
  readRetainedMainProcessErrors,
  recordMainProcessError,
  observeMainProcessErrors,
} from "./mainProcessErrorLedger";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "main-errors-"));
  vi.stubEnv("VIBESTUDIO_INSTANCE_ROOT", directory);
  clearMainProcessErrors();
});
afterEach(() => {
  clearMainProcessErrors();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe("main-process diagnostic ownership", () => {
  it("retains failures before workspace startup without a test-mode gate, protects files, and returns defensive snapshots", () => {
    vi.stubEnv("VIBESTUDIO_TEST_MODE", "");
    recordMainProcessError("unhandledRejection", new Error("navigation failed"));
    const first = readMainProcessErrors();
    expect(first).toHaveLength(1);
    expect(readRetainedMainProcessErrors()[0]?.origin).toBe(first[0]?.origin);
    first[0]!.message = "mutated";
    expect(readMainProcessErrors()[0]?.message).toBe("navigation failed");
    expect(statSync(join(directory, "main-diagnostics", "errors.json")).mode & 0o777).toBe(0o600);
  });
  it("bounds storm retention and isolates a broken observer from the original error handler", () => {
    const stop = observeMainProcessErrors(() => {
      throw new Error("observer broken");
    });
    try {
      for (let i = 0; i < 105; i++)
        recordMainProcessError("uncaughtException", new Error("x".repeat(20000)));
      expect(readMainProcessErrors()).toHaveLength(100);
      expect(readRetainedMainProcessErrors()).toHaveLength(100);
      expect(readMainProcessErrors()[0]!.message.length).toBeLessThanOrEqual(4096);
    } finally {
      stop();
    }
  });
});
