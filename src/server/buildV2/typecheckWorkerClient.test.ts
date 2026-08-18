import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TypecheckWorkerClient, resolveTypecheckWorkerEntry } from "./typecheckWorkerClient.js";

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
      });
      expect(diagnostics).toEqual([expect.objectContaining({ source: "tsc", severity: "error" })]);
    } finally {
      await client.close();
    }
  });
});
