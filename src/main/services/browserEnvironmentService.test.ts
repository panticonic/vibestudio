import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { browserEnvironmentMethods } from "@vibestudio/service-schemas/browserEnvironment";
import { createBrowserEnvironmentService } from "./browserEnvironmentService.js";

function service() {
  return createBrowserEnvironmentService({
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
    expect(prepare?.({ caller }, ["source", ["bookmarks"]])).toEqual({
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

  it("keeps sensitive values out of the plaintext import-frame contract", () => {
    expect(() =>
      browserEnvironmentMethods["startImportRead"]!.args.parse(["source", ["passwords"]])
    ).toThrow();
    expect(() =>
      browserEnvironmentMethods["nextImportFrame"]!.returns!.parse({
        type: "batch",
        dataType: "cookies",
        batchIndex: 0,
        items: [{ value: "secret" }],
      })
    ).toThrow();
    expect(
      browserEnvironmentMethods["startSensitiveImport"]!.args.parse([
        "source",
        ["cookies", "passwords", "formFill"],
        "operation-id",
      ])
    ).toEqual(["source", ["cookies", "passwords", "formFill"], "operation-id"]);
  });

  it("routes sensitive imports to the sealed provider operation", async () => {
    const startSensitiveImport = vi.fn(() => ({
      operationId: "operation-id",
      state: "running" as const,
      counts: [{ dataType: "cookies" as const, read: 2, stored: 2, skipped: 0, errors: 0 }],
    }));
    const definition = createBrowserEnvironmentService({
      getDownloads: () => null,
      getImportProvider: () => ({ startSensitiveImport }) as never,
      browserDataBrokerRepoPath: "extensions/browser-data",
    });

    const approvedCaller = createVerifiedCaller("extension-1", "extension", {
      callerId: "extension-1",
      callerKind: "extension",
      repoPath: "extensions/browser-data",
      effectiveVersion: "version-1",
      executionDigest: "a".repeat(64),
      requested: [],
    });
    approvedCaller.codeApproved = true;
    await expect(
      definition.handler({ caller: approvedCaller } as never, "startSensitiveImport", [
        "source",
        ["cookies"],
        "operation-id",
      ])
    ).resolves.toEqual({
      operationId: "operation-id",
      state: "running",
      counts: [{ dataType: "cookies", read: 2, stored: 2, skipped: 0, errors: 0 }],
    });
    expect(startSensitiveImport).toHaveBeenCalledWith("source", ["cookies"], "operation-id");
  });

  it("admits host-originated sensitive operations without a prepared prompt", async () => {
    const startSensitiveImport = vi.fn(() => ({
      operationId: "operation-id",
      state: "running" as const,
      counts: [{ dataType: "cookies" as const, read: 0, stored: 0, skipped: 0, errors: 0 }],
    }));
    const definition = createBrowserEnvironmentService({
      getDownloads: () => null,
      getImportProvider: () => ({ startSensitiveImport }) as never,
      browserDataBrokerRepoPath: "extensions/browser-data",
    });
    const caller = createVerifiedCaller("shell:main", "shell");
    caller.hostOriginated = true;
    await expect(
      definition.handler({ caller } as never, "startSensitiveImport", [
        "source",
        ["cookies"],
        "operation-id",
      ])
    ).resolves.toMatchObject({ state: "running" });
    expect(
      definition.authorityPreparation?.["browserEnvironment.broker.startSensitiveImport"]
    ).toBeUndefined();
  });

  it("rejects unapproved and wrong-source code from non-prompting sensitive endpoints", async () => {
    const definition = createBrowserEnvironmentService({
      getDownloads: () => null,
      getImportProvider: () => ({ startSensitiveImport: vi.fn() }) as never,
      browserDataBrokerRepoPath: "extensions/browser-data",
    });
    const unapproved = createVerifiedCaller("extension-1", "extension", {
      callerId: "extension-1",
      callerKind: "extension",
      repoPath: "extensions/browser-data",
      effectiveVersion: "version-1",
      executionDigest: "a".repeat(64),
      requested: [],
    });
    await expect(
      definition.handler({ caller: unapproved } as never, "startSensitiveImport", [
        "source",
        ["cookies"],
        "operation-id",
      ])
    ).rejects.toMatchObject({ code: "EACCES" });
    const wrong = {
      ...unapproved,
      codeApproved: true as const,
      code: { ...unapproved.code!, repoPath: "extensions/other" },
    };
    await expect(
      definition.handler({ caller: wrong } as never, "startSensitiveImport", [
        "source",
        ["cookies"],
        "operation-id",
      ])
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("adds no broker-source leaf to a host-originated call", () => {
    const definition = service();
    const prepare = definition.authorityPreparation?.["browserEnvironment.broker.nextImportFrame"];
    expect(
      prepare?.({ caller: createVerifiedCaller("shell:main", "shell") }, ["operation"])
    ).toEqual({ selections: [], payload: null });
  });
});
