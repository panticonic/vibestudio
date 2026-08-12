import path from "node:path";
import { describe, expect, it } from "vitest";
import { createE2eRunId, resolveE2eRunPaths, validateE2eRunId } from "./e2eRun.js";

describe("Playwright E2E run identity", () => {
  it("creates a stable path-safe default identity", () => {
    expect(createE2eRunId(new Date("2026-08-12T10:15:30.123Z"), 42, "a1b2c3d4")).toBe(
      "20260812T101530123Z-42-a1b2c3d4"
    );
  });

  it.each(["../shared", "contains/slash", "", "contains space"])(
    "rejects an unsafe explicit identity: %s",
    (runId) => expect(() => validateE2eRunId(runId)).toThrow("path-safe identifier")
  );

  it("places every default artifact under the run namespace", () => {
    const paths = resolveE2eRunPaths("/repo", "focused-42");
    expect(paths.artifactRoot).toBe(path.join("/repo", "test-results", "e2e", "focused-42"));
    expect(paths.cleanupLedgerPath).toBe(path.join(paths.artifactRoot, "cleanup-ledger.jsonl"));
  });
});
