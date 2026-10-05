import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TypecheckWorkerClient, resolveTypecheckWorkerEntry } from "./typecheckWorkerClient.js";
import { workerPerformanceSnapshot } from "../workerPerformance.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("TypecheckWorkerClient", () => {
  it("resolves the source-mode worker bootstrap", () => {
    expect(resolveTypecheckWorkerEntry(REPO_ROOT)).toBe(
      path.join(REPO_ROOT, "src/server/buildV2/typecheckWorkerBootstrap.mjs")
    );
  });

  it("returns fail-closed diagnostics from the owned worker thread", async () => {
    const client = new TypecheckWorkerClient(REPO_ROOT);
    try {
      const diagnostics = await client.check({
        unitRelativePath: "does-not-exist",
        sourceRoot: REPO_ROOT,
        internalDeps: [],
        nodeModulesPaths: [],
        moduleConditions: ["vibestudio-panel", "import", "default"],
      });
      expect(diagnostics).toEqual([expect.objectContaining({ source: "tsc", severity: "error" })]);
    } finally {
      await client.close();
    }
  });
  it("reuses the compiler thread across reports and joins it at build-system shutdown", async () => {
    const client = new TypecheckWorkerClient(REPO_ROOT);
    const input = {
      unitRelativePath: "does-not-exist",
      sourceRoot: REPO_ROOT,
      internalDeps: [],
      nodeModulesPaths: [],
      moduleConditions: ["vibestudio-panel", "import", "default"],
    };
    let threadId: number | undefined;
    try {
      await client.check(input);
      threadId = (await workerPerformanceSnapshot()).find(
        (worker) => worker.label === "typecheck"
      )?.threadId;
      expect(threadId).toBeDefined();
      await client.check(input);
      expect(
        (await workerPerformanceSnapshot()).find((worker) => worker.label === "typecheck")?.threadId
      ).toBe(threadId);
    } finally {
      await client.close();
    }
    expect((await workerPerformanceSnapshot()).some((worker) => worker.threadId === threadId)).toBe(
      false
    );
  });

  it("settles every queued request on explicit shutdown and joins the worker", async () => {
    const client = new TypecheckWorkerClient(REPO_ROOT);
    const input = {
      unitRelativePath: "does-not-exist",
      sourceRoot: REPO_ROOT,
      internalDeps: [],
      nodeModulesPaths: [],
      moduleConditions: ["vibestudio-panel", "import", "default"],
    };
    const settled = Promise.allSettled([client.check(input), client.check(input)]);
    await client.close();
    const outcomes = await settled;
    expect(outcomes).toEqual([
      { status: "rejected", reason: new Error("Typecheck worker closed") },
      { status: "rejected", reason: new Error("Typecheck worker closed") },
    ]);
    if (outcomes[0].status === "rejected" && outcomes[1].status === "rejected") {
      expect(outcomes[0].reason).toBe(outcomes[1].reason);
    }
    expect((await workerPerformanceSnapshot()).some((worker) => worker.label === "typecheck")).toBe(
      false
    );
  });
});
