import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  LibraryLoweringWorkerClient,
  resolveLibraryLoweringWorkerEntry,
} from "./libraryLoweringWorkerClient.js";

describe("LibraryLoweringWorkerClient", () => {
  it("resolves the compiled generation worker", () => {
    expect(resolveLibraryLoweringWorkerEntry()).toBe(
      path.join(process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "library-lowering-worker.mjs")
    );
  });

  it("lowers modules on the owned worker thread", async () => {
    const client = new LibraryLoweringWorkerClient();
    try {
      const lowered = await client.lower("export const value = 1;");
      expect(lowered).toContain("exports.value");
    } finally {
      await client.close();
    }
  });
});
