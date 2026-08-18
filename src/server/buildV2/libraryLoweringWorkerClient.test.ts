import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LibraryLoweringWorkerClient,
  resolveLibraryLoweringWorkerEntry,
} from "./libraryLoweringWorkerClient.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("LibraryLoweringWorkerClient", () => {
  it("resolves the source-mode worker bootstrap", () => {
    expect(resolveLibraryLoweringWorkerEntry(REPO_ROOT)).toBe(
      path.join(REPO_ROOT, "src/server/buildV2/libraryLoweringWorkerBootstrap.mjs")
    );
  });

  it("lowers modules on the owned worker thread", async () => {
    const client = new LibraryLoweringWorkerClient(REPO_ROOT);
    try {
      const lowered = await client.lower("export const value = 1;");
      expect(lowered).toContain("exports.value");
    } finally {
      await client.close();
    }
  });
});
