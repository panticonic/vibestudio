import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { BuildPerformanceProfileWire } from "@vibestudio/service-schemas/build";
import { describe, expect, it, vi } from "vitest";

import { createBuildService } from "./buildService.js";
import type { BuildSystemV2 } from "../buildV2/index.js";

function buildTrigger(path: string) {
  const repoPath = path.split("/").slice(0, 2).join("/");
  return {
    publicationId: "publication:abcdef123",
    resultHostRefsBasisDigest: "host-refs:abcdef123",
    appliedAt: 42,
    workspaceStateHash: "state:abcdef123",
    changedPaths: [path],
    repositories: [
      {
        repoPath,
        previousStateHash: "state:previous",
        nextStateHash: "state:abcdef123",
        fileChanges: [],
      },
    ],
  };
}

function makeBuildSystem(): BuildSystemV2 {
  return {
    getBuild: vi.fn(),
    getBuildNpm: vi.fn(),
    getBuildByKey: vi.fn((key: string) =>
      key === "build-key"
        ? {
            dir: "/tmp/build-key",
            artifacts: [
              {
                path: "bundle.js",
                role: "primary",
                contentType: "text/javascript; charset=utf-8",
                encoding: "utf8",
                content: "export {};",
              },
            ],
            metadata: {
              kind: "extension",
              name: "@workspace-extensions/example",
              ev: "ev-1",
              sourcemap: true,
              details: {
                kind: "extension",
                runtimeDepsKey: null,
                runtimeAbi: "4",
                providerContracts: {},
              },
              executableModules: [
                {
                  moduleId: "extensions/example/index.ts",
                  contentDigest: "source-digest",
                  package: { kind: "first-party" as const },
                  format: "ts" as const,
                  source: "export const example = true;",
                },
              ],
              builtAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : null
    ),
    getBuildReport: vi.fn(async () => ({
      repoPath: "extensions/example",
      unitName: "@workspace-extensions/example",
      kind: "extension",
      status: "ok" as const,
      diagnostics: [],
      builds: [
        { target: "runtime", status: "ok" as const, buildKey: "build-key", diagnostics: [] },
      ],
    })),
    getEffectiveVersion: vi.fn(),
    getExternalDeps: vi.fn(),
    listRecentBuildEvents: vi.fn(() => []),
    recompute: vi.fn(),
    gc: vi.fn(),
    getAboutPages: vi.fn(),
    hasUnit: vi.fn(),
    listBuildUnits: vi.fn(async () => [
      {
        unitName: "@workspace-panels/hello-svelte",
        unitPath: "panels/hello-svelte",
        kind: "panel",
        stateHash: "state:panel",
        effectiveVersion: "ev-panel",
        manifest: { title: "Hello Svelte" },
      },
    ]),
    getGraph: vi.fn(() => ({
      allNodes: () => [
        {
          name: "@workspace-extensions/example",
          kind: "extension",
          relativePath: "extensions/example",
          path: "/tmp/workspace/extensions/example",
          dependencies: {},
          dependencyOverrides: {},
          internalDeps: [],
          manifest: {},
        },
        {
          name: "@workspace-panels/hello-svelte",
          kind: "panel",
          relativePath: "panels/hello-svelte",
          path: "/tmp/workspace/panels/hello-svelte",
          dependencies: {},
          dependencyOverrides: {},
          internalDeps: [],
          manifest: { title: "Hello Svelte" },
        },
      ],
      tryGet: (name: string) =>
        name === "@workspace-extensions/example"
          ? {
              name: "@workspace-extensions/example",
              kind: "extension",
              relativePath: "extensions/example",
              path: "/tmp/workspace/extensions/example",
              dependencies: {},
              dependencyOverrides: {},
              internalDeps: [],
              manifest: {},
            }
          : undefined,
    })),
    getWorkspaceRoot: vi.fn(() => "/tmp/workspace"),
    onPushBuild: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as BuildSystemV2;
}

describe("build service extension diagnostics", () => {
  it("returns the portable { bundle } contract for library builds", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.getBuild).mockResolvedValue({ bundle: "module.exports = {};" } as never);
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getBuild", [
        "@workspace-packages/example",
        undefined,
        { library: true, libraryTarget: "worker" },
      ])
    ).resolves.toEqual({ bundle: "module.exports = {};" });
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-packages/example", undefined, {
      library: true,
      libraryTarget: "worker",
    });
  });

  it("exposes build metadata by immutable build key", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getBuildMetadata", [
        "build-key",
      ])
    ).resolves.toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/example",
      executableModules: [{ moduleId: "extensions/example/index.ts" }],
      details: { kind: "extension", runtimeAbi: "4", providerContracts: {} },
    });
  });

  it("omits executable source inventory from compact metadata reads", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    const metadata = await service.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "getBuildMetadata",
      ["build-key", { includeExecutableModules: false }]
    );

    expect(metadata).toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/example",
    });
    expect(metadata).not.toHaveProperty("executableModules");
  });

  it("profiles exact builds without returning artifact or module contents", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    const profile = (await service.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "getPerformanceProfile",
      ["extensions/example", "ctx:feature", { verifyCache: true }]
    )) as BuildPerformanceProfileWire;

    expect(profile).toMatchObject({
      version: 1,
      source: "extensions/example",
      ref: "ctx:feature",
      firstRun: { cacheState: "preexisting" },
      verifiedCacheRun: { sameBuildKeys: true },
      targets: [
        {
          buildKey: "build-key",
          artifactCount: 1,
          artifactBytes: 10,
          executableModuleCount: 1,
        },
      ],
    });
    expect(JSON.stringify(profile)).not.toContain("export const example");
    expect(buildSystem.getBuildReport).toHaveBeenCalledTimes(2);
  });

  it("resolves panel metadata by its public workspace source path", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getPanelMetadata", [
        "panels/hello-svelte",
        "ctx:feature",
      ])
    ).resolves.toMatchObject({
      source: "panels/hello-svelte",
      title: "Hello Svelte",
    });
    expect(buildSystem.listBuildUnits).toHaveBeenCalledWith("ctx:feature", ["panel"]);
  });

  it("runs retention diagnostics without accepting caller-maintained roots", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.gc).mockResolvedValue({
      epoch: 0,
      mode: "report",
      complete: true,
      roots: 3,
      rootBuildKeys: ["a", "b", "c"],
      storedRootBuildKeys: ["a", "b"],
      unresolvedAuthoritativeRootBuildKeys: [],
      reachableBuilds: 2,
      unreferenced: 1,
      unreferencedBytes: 42,
      quarantined: 0,
      deleted: 0,
      retainedForGrace: 0,
      notReconstructible: 0,
      notReconstructibleDetails: [],
      providerFailures: [],
      cleanupFailures: [],
      retainedSourceRoots: [],
    });
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "gc", [])
    ).resolves.toMatchObject({
      complete: true,
      roots: 3,
      unreferenced: 1,
    });
    expect(buildSystem.gc).toHaveBeenCalledWith();
  });

  it("reports build provenance for a workspace unit", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.getEffectiveVersion).mockReturnValue("ev-1");
    vi.mocked(buildSystem.listRecentBuildEvents).mockReturnValue([
      {
        type: "build-error",
        name: "@workspace-extensions/example",
        relativePath: "extensions/example",
        error: "Build failed with 1 error: missing module",
        trigger: buildTrigger("extensions/example/index.ts"),
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]);
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("shell", "shell") },
        "inspectBuildProvenance",
        ["extensions/example"]
      )
    ).resolves.toMatchObject({
      source: "extensions/example",
      found: true,
      workspaceRoot: "/tmp/workspace",
      unit: {
        name: "@workspace-extensions/example",
        kind: "extension",
        relativePath: "extensions/example",
      },
      effectiveVersion: "ev-1",
      cachedBuilds: {
        sourcemap: expect.objectContaining({
          cached: expect.any(Boolean),
          key: expect.any(String),
        }),
        production: expect.objectContaining({
          cached: expect.any(Boolean),
          key: expect.any(String),
        }),
      },
      recentBuildEvents: [
        expect.objectContaining({
          type: "build-error",
          error: "Build failed with 1 error: missing module",
          trigger: expect.objectContaining({
            publicationId: "publication:abcdef123",
            workspaceStateHash: "state:abcdef123",
          }),
        }),
      ],
    });
  });

  it("lists recent state-triggered build events", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.listRecentBuildEvents).mockReturnValue([
      {
        type: "build-error",
        name: "@workspace-panels/example",
        relativePath: "panels/example",
        error: "Could not resolve node:buffer",
        trigger: buildTrigger("panels/example/index.tsx"),
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ]);
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "listRecentBuildEvents", [
        "panels/example",
      ])
    ).resolves.toEqual([
      expect.objectContaining({
        name: "@workspace-panels/example",
        error: "Could not resolve node:buffer",
        trigger: expect.objectContaining({
          publicationId: "publication:abcdef123",
          workspaceStateHash: "state:abcdef123",
        }),
      }),
    ]);
    expect(buildSystem.listRecentBuildEvents).toHaveBeenCalledWith("panels/example");
  });

  it("does not guess build provenance when a basename is ambiguous", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.getGraph).mockReturnValue({
      allNodes: () => [
        {
          name: "@workspace-panels/example",
          kind: "panel",
          relativePath: "panels/example",
          path: "/tmp/workspace/panels/example",
          dependencies: {},
          dependencyOverrides: {},
          internalDeps: [],
          manifest: {},
        },
        {
          name: "@workspace-workers/example",
          kind: "worker",
          relativePath: "workers/example",
          path: "/tmp/workspace/workers/example",
          dependencies: {},
          dependencyOverrides: {},
          internalDeps: [],
          manifest: {},
        },
      ],
      tryGet: () => undefined,
    } as never);
    const service = createBuildService({ buildSystem, listUnits: () => [] });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("shell", "shell") },
        "inspectBuildProvenance",
        ["example"]
      )
    ).resolves.toMatchObject({
      source: "example",
      found: false,
      ambiguous: true,
      candidates: [
        { name: "@workspace-panels/example", kind: "panel", relativePath: "panels/example" },
        { name: "@workspace-workers/example", kind: "worker", relativePath: "workers/example" },
      ],
    });
  });
});
