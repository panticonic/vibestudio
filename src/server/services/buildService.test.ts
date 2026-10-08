import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  panelMetadataSchema,
  type BuildPerformanceProfileWire,
} from "@vibestudio/service-schemas/build";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBuildService } from "./buildService.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { setBuildRootConfig } from "../buildV2/effectiveVersion.js";

const inventory = vi.hoisted(() => ({
  modules: [
    {
      moduleId: "extensions/example/index.ts",
      contentDigest: "source-digest",
      package: { kind: "first-party" as const },
      format: "ts" as const,
      source: "export const example = true;",
    },
  ],
}));
vi.mock("../buildV2/buildStore.js", async (original) => ({
  ...(await original<typeof import("../buildV2/buildStore.js")>()),
  readExecutableModules: vi.fn(() => inventory.modules),
}));

beforeEach(() => setBuildRootConfig({ appRoot: process.cwd(), workspaceRoot: process.cwd() }));
afterEach(() => setBuildRootConfig(null));

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
              builtAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : null
    ),
    getUnitIcon: vi.fn(async () => null),
    getBuildReport: vi.fn(async () => ({
      repoPath: "extensions/example",
      unitName: "@workspace-extensions/example",
      kind: "extension",
      status: "ok" as const,
      diagnostics: [],
      builds: [{ target: "runtime", buildKey: "build-key", diagnosticIndexes: [] }],
    })),
    getEffectiveVersion: vi.fn(),
    getExternalDeps: vi.fn(),
    prepareTypecheck: vi.fn(),
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
        manifest: {
          title: "Hello Svelte",
          placement: { disposition: "split-below", preferredWidth: 480 },
        },
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
  it("preserves the exact semantic ref and native dependency resources", async () => {
    const buildSystem = makeBuildSystem();
    const environment = {
      stateHash: "state:context",
      dependencyKey: "immutable-dependencies",
      nodeModulesPaths: ["/native-owner/resources/node_modules"],
      workspacePackages: { "@vibestudio/sdk": "/native-owner/resources/sdk" },
      moduleConditions: ["worker", "workerd", "import", "default"],
    };
    vi.mocked(buildSystem.prepareTypecheck).mockResolvedValue(environment);
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => "agent-context",
    });
    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "prepareTypecheck", [
        "packages/example",
        "ctx:agent-context",
      ])
    ).resolves.toEqual(environment);
    expect(buildSystem.prepareTypecheck).toHaveBeenCalledWith(
      "packages/example",
      "ctx:agent-context"
    );
    const failure = new Error("Dependency acquisition failed");
    vi.mocked(buildSystem.prepareTypecheck).mockRejectedValue(failure);
    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "prepareTypecheck", [
        "packages/example",
        "ctx:agent-context",
      ])
    ).rejects.toBe(failure);
  });
  it("builds websites only from exact refs and returns a content-free immutable handle", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.getBuild).mockResolvedValue({
      buildKey: "website-key",
      sourceStateHash: "state:exact",
      artifacts: [
        {
          path: "site.js",
          role: "primary",
          contentType: "text/javascript",
          encoding: "utf8",
          content: "private source",
          byteLength: 14,
          integrity: `sha256:${"a".repeat(64)}`,
        },
      ],
      metadata: {
        details: {
          kind: "website-bundle",
          entryArtifact: "site.js",
          declaration: { entry: "site.tsx", expects: "a useful workspace" },
        },
      },
    } as never);
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "buildWebsite", [
        "@workspace-panels/site",
        "main",
      ])
    ).rejects.toThrow("exact ctx: or state:");
    const handle = await service.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "buildWebsite",
      ["@workspace-panels/site", "state:exact"]
    );
    expect(handle).toMatchObject({
      buildKey: "website-key",
      website: { entryArtifact: "site.js", declaration: { expects: "a useful workspace" } },
      artifacts: [{ path: "site.js", integrity: `sha256:${"a".repeat(64)}` }],
    });
    expect(handle).not.toHaveProperty("artifacts.0.content");
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-panels/site", "state:exact", {
      library: false,
      website: true,
    });
  });

  it("returns the portable { bundle } contract for library builds", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.getBuild).mockResolvedValue({ bundle: "module.exports = {};" } as never);
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

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

  it("returns compact build metadata by default", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

    const metadata = await service.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "getBuildMetadata",
      ["build-key"]
    );

    expect(metadata).toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/example",
      details: { kind: "extension", runtimeAbi: "4", providerContracts: {} },
    });
    expect(metadata).not.toHaveProperty("executableModules");
  });

  it("returns the executable source inventory only when explicitly requested", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getBuildMetadata", [
        "build-key",
        { includeExecutableModules: true },
      ])
    ).resolves.toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/example",
      executableModules: [{ moduleId: "extensions/example/index.ts" }],
      details: { kind: "extension", runtimeAbi: "4", providerContracts: {} },
    });
  });

  it("accepts an explicit compact metadata read", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

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

  it("schedules ahead-of-use build reports in the background", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

    await service.handler(
      { caller: createVerifiedCaller("panel:chat", "panel") },
      "getBuildReport",
      ["workers/agent-worker", "ctx:feature", { priority: "background" }]
    );

    expect(buildSystem.getBuildReport).toHaveBeenCalledWith(
      "workers/agent-worker",
      "ctx:feature",
      undefined,
      { priority: "background" }
    );
  });

  it("profiles exact builds without returning artifact or module contents", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

    const profile = (await service.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "getPerformanceProfile",
      ["extensions/example", "ctx:feature", { verifyCache: true }]
    )) as BuildPerformanceProfileWire;

    expect(profile).toMatchObject({
      version: 1,
      source: "extensions/example",
      ref: "ctx:feature",
      firstRun: {
        cacheState: "preexisting",
        phases: {
          bundlingMs: expect.any(Number),
          validationMs: expect.any(Number),
          otherMs: expect.any(Number),
        },
      },
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

  it("attributes report time to compilation, validation and source preparation", async () => {
    const buildSystem = makeBuildSystem();
    const report = await buildSystem.getBuildReport("extensions/example");
    vi.mocked(buildSystem.getBuildReport).mockImplementationOnce(async (_unit, _ref, progress) => {
      progress?.({ repoPath: "extensions/example", phase: "bundling" });
      progress?.({ repoPath: "extensions/example", phase: "typechecking" });
      return report;
    });
    const clock = vi.spyOn(performance, "now");
    clock
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(32);
    try {
      const service = createBuildService({
        buildSystem,
        listUnits: () => [],
        getCallerContextId: () => null,
      });
      const profile = (await service.handler(
        { caller: createVerifiedCaller("shell", "shell") },
        "getPerformanceProfile",
        ["extensions/example", undefined, { verifyCache: false }]
      )) as BuildPerformanceProfileWire;
      expect(profile.firstRun).toMatchObject({
        elapsedMs: 32,
        phases: { otherMs: 5, bundlingMs: 7, validationMs: 20 },
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("resolves panel metadata by its public workspace source path", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

    const metadata = await service.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "getPanelMetadata",
      ["panels/hello-svelte", "ctx:feature"]
    );
    expect(panelMetadataSchema.parse(metadata)).toMatchObject({
      source: "panels/hello-svelte",
      title: "Hello Svelte",
      placement: { disposition: "split-below", preferredWidth: 480 },
    });
    expect(buildSystem.listBuildUnits).toHaveBeenCalledWith("ctx:feature", ["panel"]);
  });

  it("resolves unpublished panel metadata in the same inherited context as activation", async () => {
    const buildSystem = makeBuildSystem();
    const panels = await buildSystem.listBuildUnits(undefined, ["panel"]);
    vi.mocked(buildSystem.listBuildUnits).mockImplementation(async (ref) =>
      ref === "ctx:context:unpublished" || ref === "event:explicit" ? panels : []
    );
    const getCallerContextId = vi.fn(() => "context:unpublished");
    const service = createBuildService({ buildSystem, listUnits: () => [], getCallerContextId });
    const context = { caller: createVerifiedCaller("worker:eval", "worker") };
    await expect(
      service.handler(context, "getPanelMetadata", ["panels/hello-svelte"])
    ).resolves.toMatchObject({ source: "panels/hello-svelte", title: "Hello Svelte" });
    expect(getCallerContextId).toHaveBeenCalledWith("worker:eval");
    expect(buildSystem.listBuildUnits).toHaveBeenLastCalledWith("ctx:context:unpublished", [
      "panel",
    ]);
    await service.handler(context, "getPanelMetadata", ["panels/hello-svelte", "event:explicit"]);
    expect(buildSystem.listBuildUnits).toHaveBeenLastCalledWith("event:explicit", ["panel"]);
  });

  it("uses a verified agent binding and keeps unbound root callers on main", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });
    await service.handler(
      {
        caller: createVerifiedCaller("agent:external", "agent", null, {
          entityId: "entity:bound",
          contextId: "context:bound",
          channelId: "channel:bound",
        }),
      },
      "getPanelMetadata",
      ["panels/hello-svelte"]
    );
    expect(buildSystem.listBuildUnits).toHaveBeenLastCalledWith("ctx:context:bound", ["panel"]);
    await service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getPanelMetadata", [
      "panels/hello-svelte",
    ]);
    expect(buildSystem.listBuildUnits).toHaveBeenLastCalledWith(undefined, ["panel"]);
  });

  it("returns file-backed icons as compact declarations bound to exact source state", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.listBuildUnits).mockResolvedValue([
      {
        unitName: "@workspace-panels/hello-svelte",
        unitPath: "panels/hello-svelte",
        kind: "panel",
        stateHash: `state:${"a".repeat(64)}`,
        effectiveVersion: "ev-panel",
        manifest: { title: "Hello Svelte", icon: "./assets/icon.svg" },
      },
    ]);
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

    const metadata = await service.handler(
      { caller: createVerifiedCaller("shell", "shell") },
      "getPanelMetadata",
      ["panels/hello-svelte", "ctx:feature"]
    );
    expect(panelMetadataSchema.parse(metadata)).toMatchObject({
      source: "panels/hello-svelte",
      icon: "./assets/icon.svg",
      iconState: `state:${"a".repeat(64)}`,
    });
    expect(buildSystem.getUnitIcon).not.toHaveBeenCalled();
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
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

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
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

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
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

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
    const service = createBuildService({
      buildSystem,
      listUnits: () => [],
      getCallerContextId: () => null,
    });

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
