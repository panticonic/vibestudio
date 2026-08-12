import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverPackageGraph } from "./packageGraph.js";
import type { BuildSourceProvider } from "./buildSource.js";
import type { WorkspaceStateSource } from "./stateTrigger.js";
import type { BuildSystemV2 } from "./index.js";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
} from "@vibestudio/shared/execution/retention";
import { sha256 } from "@vibestudio/shared/execution/identity";

const TEST_STATE = `state:${"a".repeat(64)}`;

function fakeWorkspaceSource(workspaceRoot: string): WorkspaceStateSource & BuildSourceProvider {
  return {
    workspaceId: "workspace:test",
    async ensureFresh() {
      return { stateHash: TEST_STATE };
    },
    async unitHashes(_stateHash, relPaths) {
      return Object.fromEntries(relPaths.map((relPath) => [relPath, `h:${relPath}`]));
    },
    async resolveContextState() {
      return TEST_STATE;
    },
    async readFile() {
      return null;
    },
    executionStateForContent(stateHash) {
      return { kind: "event", eventId: `event:${stateHash}` };
    },
    async discoverGraph() {
      return discoverPackageGraph(workspaceRoot);
    },
    onProtectedPublication() {
      return () => {};
    },
    async recordBuild() {},
    async materializeForBuild() {
      return { sourceRoot: workspaceRoot };
    },
  };
}

function productSeedArtifact() {
  const contentRoots = [{ repoPath: null, stateHash: `state:${sha256("product-seed")}` }];
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "product-seed" as const,
      workspaceId: "product:test",
      effectiveVersion: sha256("product-seed-effective-version"),
      state: null,
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: sha256("product-seed-recipe"),
    buildKey: sha256("product-seed-build"),
    artifactDigest: sha256("product-seed-artifact"),
  };
  return verifyExecutionArtifactRef({
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  });
}

describe("BuildSystemV2 startup", () => {
  let root: string;
  let workspaceRoot: string;
  let buildSystem: BuildSystemV2 | null;
  let previousSharedBuildCacheDir: string | undefined;
  let previousInstanceRoot: string | undefined;
  let previousSharedDerivedCacheDir: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    previousSharedBuildCacheDir = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
    previousInstanceRoot = process.env["VIBESTUDIO_INSTANCE_ROOT"];
    previousSharedDerivedCacheDir = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-startup-"));
    workspaceRoot = path.join(root, "workspace");
    const { setUserDataPath } = await import("@vibestudio/env-paths");
    setUserDataPath(path.join(root, "state"));
    // setUserDataPath only rebinds this thread's module state. The authority
    // analysis worker is a separate module registry, so durable-cache isolation
    // has to travel as an environment variable that the worker inherits. Both
    // roots matter: the instance root holds per-workspace cache files, and the
    // shared derived root holds content-addressed facts that are otherwise
    // reused across instances — including across test runs.
    process.env["VIBESTUDIO_INSTANCE_ROOT"] = path.join(root, "state");
    process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = path.join(root, "derived-cache");
    buildSystem = null;
  });

  afterEach(async () => {
    await buildSystem?.shutdown();
    vi.doUnmock("./builder.js");
    vi.resetModules();
    if (previousSharedBuildCacheDir === undefined) {
      delete process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
    } else {
      process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = previousSharedBuildCacheDir;
    }
    if (previousInstanceRoot === undefined) {
      delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
    } else {
      process.env["VIBESTUDIO_INSTANCE_ROOT"] = previousInstanceRoot;
    }
    if (previousSharedDerivedCacheDir === undefined) {
      delete process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    } else {
      process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = previousSharedDerivedCacheDir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves a declared icon from exact source content without materializing a build", async () => {
    const panelDir = path.join(workspaceRoot, "panels", "icon-only");
    const iconText = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    fs.mkdirSync(path.join(panelDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/icon-only",
        version: "0.1.0",
        vibestudio: { title: "Icon only", icon: "./assets/icon.svg" },
      })
    );
    fs.writeFileSync(path.join(panelDir, "assets", "icon.svg"), iconText);

    const base = fakeWorkspaceSource(workspaceRoot);
    const readFile = vi.fn(async (stateHash: string, filePath: string) => {
      if (filePath !== "panels/icon-only/assets/icon.svg") return null;
      const body = Buffer.from(iconText, "utf8");
      return {
        content: { kind: "text" as const, text: iconText },
        stateHash,
        contentHash: createHash("sha256").update(body).digest("hex"),
        mode: 0o100644,
        size: body.byteLength,
      };
    });
    const materializeForBuild = vi.fn(async () => ({ sourceRoot: workspaceRoot }));
    const source = { ...base, readFile, materializeForBuild };
    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, source, []);
    materializeForBuild.mockClear();

    const [first, concurrent] = await Promise.all([
      buildSystem.getUnitIcon("panels/icon-only", "assets/icon.svg"),
      buildSystem.getUnitIcon("panels/icon-only", "assets/icon.svg"),
    ]);
    const cached = await buildSystem.getUnitIcon("panels/icon-only", "assets/icon.svg");

    expect(first).toMatchObject({
      source: "panels/icon-only",
      path: "assets/icon.svg",
      stateHash: TEST_STATE,
      contentType: "image/svg+xml",
    });
    expect(first?.body.toString("utf8")).toBe(iconText);
    expect(concurrent).toBe(first);
    expect(cached).toBe(first);
    expect(readFile).toHaveBeenCalledOnce();
    expect(materializeForBuild).not.toHaveBeenCalled();
    await expect(
      buildSystem.getUnitIcon("panels/icon-only", "assets/not-the-icon.svg")
    ).resolves.toBeNull();
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("keeps authority analysis cold until publication validation needs it", async () => {
    let resolveEnvironment!: (value: { services: [] }) => void;
    const environment = new Promise<{ services: [] }>((resolve) => {
      resolveEnvironment = resolve;
    });
    const workspaceAuthorityEnvironmentAt = vi.fn(() => environment);

    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, fakeWorkspaceSource(workspaceRoot), [], {
      workspaceAuthorityEnvironmentAt,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workspaceAuthorityEnvironmentAt).not.toHaveBeenCalled();

    const publicationValidation = buildSystem.listAffectedBuildUnits(TEST_STATE, []);
    await new Promise((resolve) => setImmediate(resolve));
    expect(workspaceAuthorityEnvironmentAt).toHaveBeenCalledTimes(1);
    expect(workspaceAuthorityEnvironmentAt).toHaveBeenCalledWith(TEST_STATE);

    resolveEnvironment({ services: [] });
    await expect(publicationValidation).resolves.toEqual([]);
  });

  it("restores the exact authority baseline without reanalyzing units after restart", async () => {
    const panelDir = path.join(workspaceRoot, "panels", "authority-cached");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/authority-cached",
        version: "0.1.0",
        type: "module",
      })
    );
    fs.writeFileSync(path.join(panelDir, "index.ts"), "export const value = 1;\n");

    vi.doMock("./typecheckFold.js", async () => {
      const actual =
        await vi.importActual<typeof import("./typecheckFold.js")>("./typecheckFold.js");
      return { ...actual, typecheckProgramForUnit: vi.fn(async () => ({ mocked: true })) };
    });
    const source = fakeWorkspaceSource(workspaceRoot);
    const options = { workspaceAuthorityEnvironmentAt: async () => ({ services: [] }) };
    const { initBuildSystemV2 } = await import("./index.js");
    // The analyzer now runs inside the analysis worker, so the compiler pass is
    // observable from this thread only at the worker boundary.
    const { AuthorityAnalysisWorkerClient } = await import("./authorityAnalysisWorkerClient.js");
    const compilerSnapshot = vi.spyOn(AuthorityAnalysisWorkerClient.prototype, "compilerSnapshot");

    buildSystem = await initBuildSystemV2(workspaceRoot, source, [], options);
    await buildSystem.listAffectedBuildUnits(TEST_STATE, []);
    expect(compilerSnapshot).toHaveBeenCalledTimes(1);
    await buildSystem.shutdown();
    buildSystem = null;

    buildSystem = await initBuildSystemV2(workspaceRoot, source, [], options);
    await buildSystem.listAffectedBuildUnits(TEST_STATE, []);
    expect(compilerSnapshot).toHaveBeenCalledTimes(1);

    compilerSnapshot.mockRestore();
    vi.doUnmock("./typecheckFold.js");
  });

  it("materializes the union of cold authority consumer closures once", async () => {
    for (const name of ["alpha", "beta"]) {
      const unitDir = path.join(workspaceRoot, "packages", name);
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(
        path.join(unitDir, "package.json"),
        JSON.stringify({ name: `@workspace/${name}`, version: "0.1.0", type: "module" })
      );
      fs.writeFileSync(path.join(unitDir, "index.ts"), `export const ${name} = true;\n`);
    }

    vi.doMock("./typecheckFold.js", async () => {
      const actual =
        await vi.importActual<typeof import("./typecheckFold.js")>("./typecheckFold.js");
      return { ...actual, typecheckProgramForUnit: vi.fn(async () => ({ mocked: true })) };
    });
    const base = fakeWorkspaceSource(workspaceRoot);
    const materializeForBuild = vi.fn(
      async (_units: Parameters<BuildSourceProvider["materializeForBuild"]>[0]) => ({
        sourceRoot: workspaceRoot,
      })
    );
    const source = { ...base, materializeForBuild };
    const { initBuildSystemV2 } = await import("./index.js");
    const { AuthorityAnalysisWorkerClient } = await import("./authorityAnalysisWorkerClient.js");
    const compilerSnapshot = vi.spyOn(AuthorityAnalysisWorkerClient.prototype, "compilerSnapshot");
    buildSystem = await initBuildSystemV2(workspaceRoot, source, [], {
      workspaceAuthorityEnvironmentAt: async () => ({ services: [] }),
    });

    await buildSystem.listAffectedBuildUnits(TEST_STATE, []);

    expect(materializeForBuild).toHaveBeenCalledTimes(1);
    expect(materializeForBuild.mock.calls[0]?.[0].map((unit) => unit.name)).toEqual([
      "@workspace/alpha",
      "@workspace/beta",
    ]);
    expect(compilerSnapshot).toHaveBeenCalledTimes(1);

    compilerSnapshot.mockRestore();
    vi.doUnmock("./typecheckFold.js");
  });

  it("diagnoses host-owned retention roots without deleting stored builds", async () => {
    const buildsDir = path.join(root, "state", "builds");
    fs.mkdirSync(path.join(buildsDir, "retained"), { recursive: true });
    fs.mkdirSync(path.join(buildsDir, "unreferenced"), { recursive: true });
    fs.writeFileSync(path.join(buildsDir, "retained", "artifact.js"), "keep");
    fs.writeFileSync(path.join(buildsDir, "unreferenced", "artifact.js"), "unused");
    const onRetentionDiagnostic = vi.fn();

    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, fakeWorkspaceSource(workspaceRoot), [], {
      executionRootProviders: [
        ...(
          [
            "runtime-entity",
            "panel-history",
            "app-generation",
            "terminal-app",
            "runtime-image",
            "extension-generation",
            "eval-run",
            "development-run",
            "product-seed",
          ] as const
        ).map((id) => ({
          id,
          mandatory: true,
          async snapshotRoots() {
            if (id === "app-generation") throw new Error("registry offline");
            return [];
          },
        })),
      ],
      onRetentionDiagnostic,
    });

    await expect(buildSystem.gc()).resolves.toEqual({
      complete: false,
      epoch: 0,
      mode: "report",
      roots: 0,
      rootBuildKeys: [],
      storedRootBuildKeys: [],
      unresolvedAuthoritativeRootBuildKeys: [],
      reachableBuilds: 0,
      unreferenced: 2,
      unreferencedBytes: 10,
      quarantined: 0,
      deleted: 0,
      retainedForGrace: 0,
      notReconstructible: 2,
      notReconstructibleDetails: [
        {
          buildKey: "retained",
          missing: ["verified execution metadata or source content roots"],
        },
        {
          buildKey: "unreferenced",
          missing: ["verified execution metadata or source content roots"],
        },
      ],
      providerFailures: [
        {
          provider: "app-generation",
          error: "registry offline",
        },
      ],
      cleanupFailures: [],
      retainedSourceRoots: [],
    });
    expect(fs.readFileSync(path.join(buildsDir, "retained", "artifact.js"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(buildsDir, "unreferenced", "artifact.js"), "utf8")).toBe(
      "unused"
    );
    expect(onRetentionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ complete: false, unreferenced: 2 })
    );
  });

  it("keeps product-seed roots outside the workspace BuildStore census", async () => {
    const { initBuildSystemV2 } = await import("./index.js");
    const source = fakeWorkspaceSource(workspaceRoot);
    const providerIds = [
      "runtime-entity",
      "panel-history",
      "app-generation",
      "terminal-app",
      "runtime-image",
      "extension-generation",
      "eval-run",
      "development-run",
      "product-seed",
    ] as const;
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      source,
      [path.join(process.cwd(), "node_modules")],
      {
        executionRootProviders: providerIds.map((id) => ({
          id,
          mandatory: true,
          async snapshotRoots() {
            return id === "product-seed"
              ? [
                  {
                    owner: "product-seed" as const,
                    ownerId: "product:test",
                    reason: "active" as const,
                    artifact: productSeedArtifact(),
                  },
                ]
              : [];
          },
        })),
      }
    );

    await expect(buildSystem.gc()).resolves.toMatchObject({
      complete: true,
      roots: 0,
      rootBuildKeys: [],
      unresolvedAuthoritativeRootBuildKeys: [],
    });
  });

  it("reports an absent authoritative artifact root separately from unbuilt graph units", async () => {
    const panelDir = path.join(workspaceRoot, "panels", "unbuilt-panel");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/unbuilt-panel",
        version: "0.1.0",
        type: "module",
      })
    );

    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, fakeWorkspaceSource(workspaceRoot), [], {
      executionRootProviders: [
        ...(
          [
            "runtime-entity",
            "panel-history",
            "app-generation",
            "terminal-app",
            "runtime-image",
            "extension-generation",
            "eval-run",
            "development-run",
            "product-seed",
          ] as const
        ).map((id) => ({
          id,
          mandatory: true,
          async snapshotRoots() {
            if (id === "runtime-entity") throw new Error("missing live execution metadata");
            return [];
          },
        })),
      ],
    });

    await expect(buildSystem.gc()).resolves.toMatchObject({
      complete: false,
      storedRootBuildKeys: [],
      providerFailures: [{ provider: "runtime-entity", error: "missing live execution metadata" }],
    });
  });

  it("uses the explicit dependency workspace root for root-dependency fingerprints", async () => {
    const appRoot = path.join(root, "app");
    const dependencyWorkspaceRoot = path.join(appRoot, "workspace");
    fs.mkdirSync(dependencyWorkspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, "package.json"), '{"name":"host"}');
    fs.writeFileSync(path.join(appRoot, "pnpm-lock.yaml"), "host-lock\n");
    fs.writeFileSync(path.join(appRoot, "pnpm-workspace.yaml"), "packages: []\n");
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "package.json"), '{"name":"userland"}');
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "pnpm-lock.yaml"), "userland-lock\n");
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "pnpm-workspace.yaml"), "packages: []\n");
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(dependencyWorkspaceRoot, "tsconfig.integration.json"), "{}\n");

    const { initBuildSystemV2 } = await import("./index.js");
    const { getRootDependencyFingerprintInfo } = await import("./effectiveVersion.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, fakeWorkspaceSource(workspaceRoot), [], {
      appRoot,
      dependencyWorkspaceRoot,
    });

    const info = getRootDependencyFingerprintInfo();
    const workspacePackage = info.files.find((file) => file.file === "workspace/package.json");
    expect(info.root).toBe(appRoot);
    expect(info.rootSource).toBe("injected");
    expect(workspacePackage?.present).toBe(true);
    expect(workspacePackage?.path).toBe(path.join(dependencyWorkspaceRoot, "package.json"));
  });

  it("reuses a settled immutable runtime binding without re-resolving protected main", async () => {
    const panelDir = path.join(workspaceRoot, "panels", "cached");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/cached",
        version: "0.1.0",
        type: "module",
        vibestudio: {
          title: "Cached",
          authority: { requests: [], provides: [] },
        },
      })
    );
    fs.writeFileSync(
      path.join(panelDir, "index.html"),
      '<!doctype html><html><body><script type="module" src="./index.ts"></script></body></html>'
    );
    fs.writeFileSync(path.join(panelDir, "index.ts"), 'document.body.textContent = "ready";\n');

    const source = fakeWorkspaceSource(workspaceRoot);
    const ensureFresh = vi.spyOn(source, "ensureFresh");
    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, source, [
      path.join(process.cwd(), "node_modules"),
    ]);

    const first = await buildSystem.bindRuntimeImage("panels/cached");
    const callsAfterFirstBinding = ensureFresh.mock.calls.length;
    const second = await buildSystem.bindRuntimeImage("panels/cached");

    expect(second).toEqual(first);
    expect(ensureFresh).toHaveBeenCalledTimes(callsAfterFirstBinding);
  });

  it("invalidates a cached binding when shared build metadata was rebound", async () => {
    const panelDir = path.join(workspaceRoot, "panels", "rebound-cache");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/rebound-cache",
        version: "0.1.0",
        type: "module",
        vibestudio: {
          title: "Rebound cache",
          authority: { requests: [], provides: [] },
        },
      })
    );
    fs.writeFileSync(
      path.join(panelDir, "index.html"),
      '<!doctype html><html><body><script type="module" src="./index.ts"></script></body></html>'
    );
    fs.writeFileSync(path.join(panelDir, "index.ts"), 'document.body.textContent = "ready";\n');

    const { initBuildSystemV2 } = await import("./index.js");
    const { rebindSourceState } = await import("./buildStore.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, fakeWorkspaceSource(workspaceRoot), [
      path.join(process.cwd(), "node_modules"),
    ]);

    const first = await buildSystem.bindRuntimeImage("panels/rebound-cache");
    const build = buildSystem.getBuildByKey(first.artifact.buildKey);
    expect(build).not.toBeNull();
    await rebindSourceState(build!, `state:${"b".repeat(64)}`);

    const rebound = await buildSystem.bindRuntimeImage("panels/rebound-cache");

    expect(rebound).toEqual(first);
    expect(buildSystem.getBuildByKey(first.artifact.buildKey)?.metadata.execution).toEqual(
      first.artifact
    );
  });

  it("reconstructs and loads an exact retained runtime after process state and build cache are cold", async () => {
    const workerDir = path.join(workspaceRoot, "workers", "retained");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, "package.json"),
      JSON.stringify({
        name: "@workspace-workers/retained",
        version: "0.1.0",
        private: true,
        type: "module",
        vibestudio: {
          entry: "worker.ts",
          durable: { classes: [{ className: "RetainedWorker" }] },
          authority: { requests: [], provides: [] },
        },
      })
    );
    fs.writeFileSync(
      path.join(workerDir, "worker.ts"),
      [
        "export class RetainedWorker {",
        '  marker(): string { return "cold-cache-runtime-loaded"; }',
        "}",
      ].join("\n")
    );

    const statePath = path.join(root, "state");
    const source = fakeWorkspaceSource(workspaceRoot);
    const { initBuildSystemV2 } = await import("./index.js");
    const { primaryTextArtifactContent } = await import("./buildStore.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, source, [
      path.join(process.cwd(), "node_modules"),
    ]);

    const warmBinding = await buildSystem.bindRuntimeImage("workers/retained", TEST_STATE);
    const warmBuild = buildSystem.getBuildByKey(warmBinding.artifact.buildKey);
    expect(warmBuild).not.toBeNull();
    const warmBundle = primaryTextArtifactContent(warmBuild!);
    expect(warmBundle).toContain("cold-cache-runtime-loaded");

    await buildSystem.shutdown();
    buildSystem = null;
    fs.rmSync(statePath, { recursive: true, force: true });

    vi.resetModules();
    const { setUserDataPath } = await import("@vibestudio/env-paths");
    setUserDataPath(statePath);
    const { initBuildSystemV2: initColdBuildSystem } = await import("./index.js");
    const { primaryTextArtifactContent: coldPrimaryTextArtifactContent } =
      await import("./buildStore.js");
    buildSystem = await initColdBuildSystem(workspaceRoot, fakeWorkspaceSource(workspaceRoot), [
      path.join(process.cwd(), "node_modules"),
    ]);

    const coldBinding = await buildSystem.bindRuntimeImage("workers/retained", TEST_STATE);
    const coldBuild = buildSystem.getBuildByKey(coldBinding.artifact.buildKey);
    expect(coldBuild).not.toBeNull();
    const rebuiltBundle = coldPrimaryTextArtifactContent(coldBuild!);
    expect(rebuiltBundle).toContain("cold-cache-runtime-loaded");
    expect(rebuiltBundle).toBe(warmBundle);
    expect(coldBinding).toEqual(warmBinding);

    const loaded = (await import(
      `data:text/javascript;base64,${Buffer.from(rebuiltBundle).toString("base64")}`
    )) as { RetainedWorker?: new () => { marker(): string } };
    expect(new loaded.RetainedWorker!().marker()).toBe("cold-cache-runtime-loaded");
  }, 60_000);

  it("reports an execution as non-reconstructible when its source root is absent", async () => {
    const workerDir = path.join(workspaceRoot, "workers", "missing-source");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, "package.json"),
      JSON.stringify({
        name: "@workspace-workers/missing-source",
        version: "0.1.0",
        private: true,
        type: "module",
        vibestudio: {
          entry: "worker.ts",
          durable: { classes: [{ className: "MissingSourceWorker" }] },
          authority: { requests: [], provides: [] },
        },
      })
    );
    fs.writeFileSync(path.join(workerDir, "worker.ts"), "export class MissingSourceWorker {}\n");

    const source = fakeWorkspaceSource(workspaceRoot);
    source.inspectContentRoot = vi.fn(async (stateHash) => ({
      reconstructible: false,
      missing: [`source content root ${stateHash}`],
    }));
    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, source, [
      path.join(process.cwd(), "node_modules"),
    ]);
    const binding = await buildSystem.bindRuntimeImage("workers/missing-source", TEST_STATE);
    const build = buildSystem.getBuildByKey(binding.artifact.buildKey);
    const executionDigest = build?.metadata.execution?.executionDigest;
    expect(executionDigest).toMatch(/^[0-9a-f]{64}$/u);

    await expect(buildSystem.inspectExecution(executionDigest!)).resolves.toMatchObject({
      artifact: expect.objectContaining({ buildKey: binding.artifact.buildKey }),
      reconstructible: false,
      missing: [`source content root ${TEST_STATE}`],
    });
  });

  it("keeps shared-cache-only retention report and inspection read-only", async () => {
    process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"] = path.join(root, "shared-builds");
    const workerDir = path.join(workspaceRoot, "workers", "shared-only");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, "package.json"),
      JSON.stringify({
        name: "@workspace-workers/shared-only",
        version: "0.1.0",
        private: true,
        type: "module",
        vibestudio: {
          entry: "worker.ts",
          durable: { classes: [{ className: "SharedOnlyWorker" }] },
          authority: { requests: [], provides: [] },
        },
      })
    );
    fs.writeFileSync(path.join(workerDir, "worker.ts"), "export class SharedOnlyWorker {}\n");

    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, fakeWorkspaceSource(workspaceRoot), [
      path.join(process.cwd(), "node_modules"),
    ]);
    const binding = await buildSystem.bindRuntimeImage("workers/shared-only", TEST_STATE);
    const localBuild = buildSystem.getBuildByKey(binding.artifact.buildKey);
    const artifact = localBuild?.metadata.execution;
    expect(artifact).toBeDefined();
    await buildSystem.shutdown();
    buildSystem = null;

    const consumerState = path.join(root, "consumer-state");
    const { setUserDataPath } = await import("@vibestudio/env-paths");
    setUserDataPath(consumerState);
    const source = fakeWorkspaceSource(workspaceRoot);
    source.inspectContentRoot = vi.fn(async () => ({ reconstructible: true, missing: [] }));
    const providerIds = [
      "runtime-entity",
      "panel-history",
      "app-generation",
      "terminal-app",
      "runtime-image",
      "extension-generation",
      "eval-run",
      "development-run",
      "product-seed",
    ] as const;
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      source,
      [path.join(process.cwd(), "node_modules")],
      {
        executionRootProviders: providerIds.map((id) => ({
          id,
          mandatory: true,
          async snapshotRoots() {
            return id === "runtime-entity"
              ? [
                  {
                    owner: "runtime-entity" as const,
                    ownerId: "entity:shared-only",
                    reason: "active" as const,
                    artifact: artifact!,
                  },
                ]
              : [];
          },
        })),
      }
    );
    const localBuildDir = path.join(consumerState, "builds", binding.artifact.buildKey);
    const gcState = path.join(consumerState, "execution-retention", "build-gc.json");

    await expect(buildSystem.gc()).resolves.toMatchObject({
      mode: "report",
      unresolvedAuthoritativeRootBuildKeys: [binding.artifact.buildKey],
    });
    await expect(buildSystem.inspectExecution(artifact!.executionDigest)).resolves.toMatchObject({
      artifact: expect.objectContaining({ buildKey: binding.artifact.buildKey }),
      reconstructible: false,
      missing: expect.arrayContaining(["artifact bytes"]),
    });
    expect(fs.existsSync(localBuildDir)).toBe(false);
    expect(fs.existsSync(gcState)).toBe(false);
  }, 60_000);

  it("seeds and batches immutable graph resolution from the initialization pass", async () => {
    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspaceRoot, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({
          name: `@workspace-panels/${name}`,
          version: "0.1.0",
          type: "module",
        })
      );
    }

    const source = fakeWorkspaceSource(workspaceRoot);
    const discoverGraph = vi.spyOn(source, "discoverGraph");
    const unitHashes = vi.spyOn(source, "unitHashes");
    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, source, []);

    const resolutions = await buildSystem.resolveBuildUnits(
      ["panels/first", "panels/second"],
      TEST_STATE
    );

    expect(resolutions.map((resolution) => resolution?.unitName)).toEqual([
      "@workspace-panels/first",
      "@workspace-panels/second",
    ]);
    expect(discoverGraph).toHaveBeenCalledTimes(1);
    expect(unitHashes).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent resolution of the same non-current immutable state", async () => {
    const panelDir = path.join(workspaceRoot, "panels", "context");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/context",
        version: "0.1.0",
        type: "module",
      })
    );

    const source = fakeWorkspaceSource(workspaceRoot);
    source.resolveContextState = async () => "state:context";
    const discoverGraph = vi.spyOn(source, "discoverGraph");
    const unitHashes = vi.spyOn(source, "unitHashes");
    const { initBuildSystemV2 } = await import("./index.js");
    buildSystem = await initBuildSystemV2(workspaceRoot, source, []);

    const [first, second] = await Promise.all([
      buildSystem.resolveBuildUnit("panels/context", "ctx:first"),
      buildSystem.resolveBuildUnitIdentity("panels/context", "ctx:second"),
    ]);

    expect(first?.stateHash).toBe("state:context");
    expect(second?.stateHash).toBe("state:context");
    expect(discoverGraph).toHaveBeenCalledTimes(2);
    expect(unitHashes).toHaveBeenCalledTimes(2);
  });
});
