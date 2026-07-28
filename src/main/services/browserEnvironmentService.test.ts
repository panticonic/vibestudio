import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createBrowserEnvironmentService } from "./browserEnvironmentService.js";

function service() {
  return createBrowserEnvironmentService({
    getProjection: () => null,
    waitForProjection: async () => {
      throw new Error("Browser cookie projection is unavailable");
    },
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
    });
    const prepare = definition.authorityPreparation?.["browserEnvironment.broker.startImportRead"];
    expect(prepare?.({ caller }, ["source", ["passwords"]])).toEqual({
      selections: [
        expect.objectContaining({
          capability: "service:browserEnvironment.startImportRead",
          requirement: {
            kind: "all",
            requirements: [
              {
                kind: "any",
                requirements: [
                  {
                    kind: "all",
                    requirements: [
                      {
                        kind: "capability",
                        principal: "code",
                        capability: "service:browserEnvironment.startImportRead",
                      },
                      { kind: "relationship", name: "workspace-member" },
                    ],
                  },
                  {
                    kind: "all",
                    requirements: [
                      {
                        kind: "capability",
                        principal: "session",
                        capability: "service:browserEnvironment.startImportRead",
                      },
                      { kind: "relationship", name: "workspace-member" },
                    ],
                  },
                ],
              },
              {
                kind: "relationship",
                name: "code-source",
                value: "extensions/browser-data",
              },
            ],
          },
        }),
      ],
      payload: null,
    });
  });

  it("adds no broker-source leaf to a host-originated call", () => {
    const definition = service();
    const prepare = definition.authorityPreparation?.["browserEnvironment.broker.nextImportFrame"];
    expect(
      prepare?.({ caller: createVerifiedCaller("shell:main", "shell") }, ["operation"])
    ).toEqual({ selections: [], payload: null });
  });

  it("waits for projection readiness before flushing imported cookies", async () => {
    const flush = vi.fn(async () => ({ revision: 7 }));
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitForProjection = vi.fn(async () => {
      await ready;
      return { flush } as never;
    });
    const definition = createBrowserEnvironmentService({
      getProjection: () => null,
      waitForProjection,
      getDownloads: () => null,
      getImportProvider: () => null,
      browserDataBrokerRepoPath: "extensions/browser-data",
    });

    let settled = false;
    const result = definition
      .handler(
        {
          caller: createVerifiedCaller("extension-1", "extension", {
            callerId: "extension-1",
            callerKind: "extension",
            repoPath: "extensions/browser-data",
            effectiveVersion: "version-1",
            executionDigest: "a".repeat(64),
            requested: [],
          }),
        } as never,
        "flushCookieProjection",
        [[]]
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(result).resolves.toEqual({ revision: 7 });
    expect(waitForProjection).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith([]);
  });
});
