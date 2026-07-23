import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createBrowserEnvironmentService } from "./browserEnvironmentService.js";

function service() {
  return createBrowserEnvironmentService({
    getProjection: () => null,
    getDownloads: () => null,
    getImportProvider: () => null,
    browserDataBrokerRepoPath: "extensions/browser-data",
  });
}

describe("browserEnvironment authority", () => {
  it("binds every code call to the manifest-declared broker source", () => {
    const definition = service();
    const caller = createVerifiedCaller("extension-1", "extension", {
      callerId: "extension-1",
      callerKind: "extension",
      repoPath: "extensions/browser-data",
      effectiveVersion: "version-1",
      executionDigest: "a".repeat(64),
      requested: [],
      evalCeilings: [],
    });
    const prepare = definition.authorityPreparation?.["browserEnvironment.broker.startImportRead"];
    expect(prepare?.({ caller }, ["source", ["passwords"]])).toEqual([
      expect.objectContaining({
        capability: "service:browserEnvironment.startImportRead",
        requirement: {
          kind: "all",
          requirements: [
            { kind: "relationship", name: "workspace-member" },
            {
              kind: "relationship",
              name: "code-source",
              value: "extensions/browser-data",
            },
          ],
        },
      }),
    ]);
  });

  it("adds no broker-source leaf to a host-originated call", () => {
    const definition = service();
    const prepare = definition.authorityPreparation?.["browserEnvironment.broker.nextImportFrame"];
    expect(
      prepare?.({ caller: createVerifiedCaller("shell:main", "shell") }, ["operation"])
    ).toEqual([]);
  });
});
