import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import type { BuildPerformanceProfileWire } from "@vibestudio/service-schemas/build";
import { EVAL_OPERATION_JOURNAL_PREVIEW_CHARS } from "@vibestudio/service-schemas/eval";
import { EvalDO } from "./EvalDO.js";
import { ExecutionJournal } from "./executionJournal.js";

function profile(): BuildPerformanceProfileWire {
  return {
    version: 1,
    source: "panels/example",
    ref: "ctx:owner",
    startedAt: 1,
    firstRun: { elapsedMs: 10, cacheState: "built-during-profile" },
    verifiedCacheRun: { elapsedMs: 1, sameBuildKeys: true },
    report: {
      repoPath: "panels/example",
      kind: "panel",
      status: "ok",
      stateHash: "state:exact",
      diagnostics: [],
      builds: [{ target: "runtime", buildKey: "build:exact", diagnosticIndexes: [] }],
    },
    targets: [
      {
        target: "runtime",
        buildKey: "build:exact",
        builtAt: "now",
        artifactCount: 1,
        artifactBytes: 42,
        largestArtifacts: [],
        executableModuleCount: 1,
        executableSourceBytes: 42,
        bundleReport: { initial: { bytes: 42 }, source: "PRIVATE BUNDLE CONTENT" },
      },
    ],
  } as unknown as BuildPerformanceProfileWire;
}

describe("execution-owned native operation evidence", () => {
  it("copies provenance before guest mutation and excludes bundle contents", () => {
    const journal = new ExecutionJournal();
    const measured = profile();
    journal.recordBuildProfile(measured);
    measured.report.stateHash = "forged";
    measured.targets[0]!.buildKey = "forged";
    const result = journal.close();
    expect(result.entries[0]).toMatchObject({
      type: "build.profile",
      receipt: {
        report: { stateHash: "state:exact" },
        targets: [{ buildKey: "build:exact", bundleReport: { initial: { bytes: 42 } } }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE BUNDLE CONTENT");
  });

  it("retains native receipts when the caller only returns a summary", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = (
      instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } }
    ).rpc;
    vi.spyOn(nativeRpc, "call").mockResolvedValueOnce(profile());
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    const returned = await owner.rpc.call("main", "build.getPerformanceProfile", [
      "panels/example",
      "ctx:owner",
    ]);
    const summary = { measured: !!returned };
    expect(summary).toEqual({ measured: true });
    expect(owner.operationJournal.close().entries).toHaveLength(1);
  });

  it("records filesystem access from native dispatch without copying file contents", async () => {
    const { instance } = await createTestDO(EvalDO);
    const nativeRpc = (
      instance as unknown as { rpc: { call: (...args: unknown[]) => Promise<unknown> } }
    ).rpc;
    vi.spyOn(nativeRpc, "call").mockResolvedValue("PRIVATE FILE CONTENT");
    const owner = (
      instance as unknown as {
        createExecutionContext: (input: { contextId: string }) => {
          rpc: typeof nativeRpc;
          operationJournal: ExecutionJournal;
        };
      }
    ).createExecutionContext({ contextId: "owner" });
    await owner.rpc.call("main", "fs.readFile", ["skills/system-testing/tests/example.ts", "utf8"]);
    await owner.rpc.call("main", "problemReports.create", [
      { description: "skills/system-testing/tests/example.ts" },
    ]);
    expect(owner.operationJournal.close().entries).toEqual([
      { type: "fs.read", method: "fs.readFile", path: "skills/system-testing/tests/example.ts" },
    ]);
    expect(JSON.stringify(owner.operationJournal.entries)).not.toContain("PRIVATE FILE CONTENT");
  });

  it("seals late completions to their old owner instead of the next execution", () => {
    const oldOwner = new ExecutionJournal();
    const nextOwner = new ExecutionJournal();
    const terminal = oldOwner.close();
    oldOwner.recordBuildProfile(profile());
    expect(terminal.entries).toEqual([]);
    expect(nextOwner.close().entries).toEqual([]);
  });

  it("marks incomplete evidence without exceeding the wire budget", () => {
    const owner = new ExecutionJournal();
    owner.recordBuildProfile(profile());
    owner.append({ type: "large", data: "x".repeat(EVAL_OPERATION_JOURNAL_PREVIEW_CHARS) });
    const terminal = owner.close();
    expect(terminal.truncated).toBe(true);
    expect(terminal.entries).toHaveLength(1);
  });
});
