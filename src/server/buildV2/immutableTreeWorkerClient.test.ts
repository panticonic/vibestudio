import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImmutableTreeWorkerEntry } from "./immutableTreeWorkerClient.js";

describe("ImmutableTreeWorkerClient", () => {
  it("resolves the compiled worker bootstrap from the application root", () => {
    expect(resolveImmutableTreeWorkerEntry()).toBe(
      path.join(process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "immutable-tree-worker.mjs")
    );
  });
});
