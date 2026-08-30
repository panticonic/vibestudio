import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImmutableTreeWorkerEntry } from "./immutableTreeWorkerClient.js";

describe("ImmutableTreeWorkerClient", () => {
  it("resolves the source worker bootstrap from the application root", () => {
    expect(resolveImmutableTreeWorkerEntry(process.cwd())).toBe(
      path.join(process.cwd(), "src/server/buildV2/immutableTreeWorkerBootstrap.mjs")
    );
  });
});
