import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
/**
 * On-demand build reports over exact workspace content.
 *
 * Building a report for unpublished content is advisory: it may populate the
 * content-addressed build and diagnostics stores, but never promotes the
 * published EV baseline or records a semantic build outcome.
 *
 * `buildUnit` and `typecheckUnit` are mocked so success/failure is deterministic
 * and no real esbuild/tsc runs. The mock honours the real content-addressed
 * build-store contract (cache hit means no rebuild).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuildSourceProvider } from "./buildSource.js";
import type { WorkspaceStateSource } from "./stateTrigger.js";
import type { BuildSystemV2 } from "./index.js";
import type { PackageGraph } from "./packageGraph.js";

const BASE_VIEW = `state:${"a".repeat(64)}`;
const CANDIDATE_VIEW = `state:${"b".repeat(64)}`;

// Per-test hook so a unit's build can be made to fail at a specific view.
let shouldFail: (name: string, ev: string, stateRef: string) => boolean = () => false;
let typecheckDiagnostics: (unitRelativePath: string) => Array<{
  source: "tsc" | "authority";
  severity: "error" | "warning";
  file: string;
  line: number;
  column: number;
  message: string;
}> = () => [];
let typecheckCalls = 0;
let typecheckInputs: Array<{
  unitRelativePath: string;
  moduleConditions: readonly string[];
  authority?: unknown;
}> = [];
// Records every non-cache-hit build the mock actually performs.
let buildCalls: Array<{
  name: string;
  key: string;
  stateRef: string;
  priority?: "interactive" | "background" | "speculative";
}> = [];

function writeUnit(
  workspaceRoot: string,
  dir: string,
  name: string,
  deps?: Record<string, string>
): void {
  const abs = path.join(workspaceRoot, dir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(
    path.join(abs, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      type: "module",
      ...(deps ? { dependencies: deps } : {}),
      vibestudio: { entry: "index.ts" },
    })
  );
  fs.writeFileSync(path.join(abs, "index.ts"), "export const x = 1;\n");
}

/**
 * Fake source. `packages/lib` content differs between base and candidate, so its
 * EV — and its dependent panel `app`'s EV — change across the two views, while
 * standalone `solo` is stable.
 */
function fakeSource(
  workspaceRoot: string,
  graph: PackageGraph
): WorkspaceStateSource & BuildSourceProvider {
  return {
    workspaceId: "workspace:test",
    ensureFresh: async () => ({ stateHash: BASE_VIEW }),
    unitHashes: async (stateHash, relPaths) =>
      Object.fromEntries(
        relPaths.map((relPath) => {
          if (relPath === "projects/notes") return [relPath, "h:projects/notes"];
          if (!graph.allNodes().some((node) => node.relativePath === relPath))
            return [relPath, null];
          if (relPath === "packages/lib" && stateHash === CANDIDATE_VIEW) {
            return [relPath, "h:packages/lib:candidate"];
          }
          return [relPath, `h:${relPath}`];
        })
      ),
    resolveContextState: async () => CANDIDATE_VIEW,
    readFile: async () => null,
    executionStateForContent: (stateHash) => ({
      kind: "event",
      eventId: `event:${stateHash}`,
    }),
    discoverGraph: async () => graph,
    onProtectedPublication: () => () => {},
    recordBuild: async () => {},
    materializeForBuild: async () => ({ sourceRoot: workspaceRoot }),
  };
}

async function loadWithMocks(
  options: {
    blockingAuthorityConsumer?: boolean;
    isolatedExports?: unknown;
    invalidPanelManifest?: boolean;
    resolvedBuildKey?: string;
  } = {}
): Promise<{
  buildSystem: BuildSystemV2;
  workspaceRoot: string;
  cleanup: () => Promise<void>;
  buildStore: typeof import("./buildStore.js");
  persistEvState: ReturnType<typeof vi.fn>;
  source: WorkspaceStateSource;
}> {
  vi.resetModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-validate-"));
  const workspaceRoot = path.join(root, "workspace");
  writeUnit(workspaceRoot, "packages/lib", "@workspace/lib");
  writeUnit(workspaceRoot, "packages/mid", "@workspace/mid", {
    "@workspace/lib": "workspace:*",
  });
  writeUnit(workspaceRoot, "packages/isolated", "@workspace/isolated");
  const isolatedManifestPath = path.join(workspaceRoot, "packages/isolated/package.json");
  const isolatedManifest = JSON.parse(fs.readFileSync(isolatedManifestPath, "utf8"));
  isolatedManifest.exports = options.isolatedExports ?? {
    ".": "./index.ts",
    "./alpha": "./index.ts",
    "./beta": "./index.ts",
  };
  fs.writeFileSync(isolatedManifestPath, JSON.stringify(isolatedManifest));
  writeUnit(workspaceRoot, "panels/app", "@workspace-panels/app", {
    "@workspace/mid": "workspace:*",
  });
  if (options.blockingAuthorityConsumer) {
    const libraryManifestPath = path.join(workspaceRoot, "packages/lib/package.json");
    const libraryManifest = JSON.parse(fs.readFileSync(libraryManifestPath, "utf8"));
    libraryManifest.vibestudio.authority = {
      serviceRequests: [{ protocol: "removed.notes.v1", availability: "required" }],
    };
    fs.writeFileSync(libraryManifestPath, JSON.stringify(libraryManifest));
    const isolatedManifestPath = path.join(workspaceRoot, "packages/isolated/package.json");
    const isolatedManifest = JSON.parse(fs.readFileSync(isolatedManifestPath, "utf8"));
    isolatedManifest.vibestudio.authority = {
      serviceRequests: [{ protocol: "removed.notes.v1", availability: "required" }],
    };
    fs.writeFileSync(isolatedManifestPath, JSON.stringify(isolatedManifest));
    writeUnit(workspaceRoot, "workers/removed-notes", "@workspace-workers/removed-notes");
  }
  writeUnit(workspaceRoot, "panels/solo", "@workspace-panels/solo");
  if (options.invalidPanelManifest) {
    fs.writeFileSync(
      path.join(workspaceRoot, "panels/solo/package.json"),
      '{"name":"@workspace-panels/solo","vibestudio":{"entry":"index.tsx"],}\n'
    );
  }

  const { setUserDataPath } = await import("@vibestudio/env-paths");
  setUserDataPath(path.join(root, "state"));

  const persistEvState = vi.fn();
  vi.doMock("./effectiveVersion.js", async () => {
    const actual =
      await vi.importActual<typeof import("./effectiveVersion.js")>("./effectiveVersion.js");
    return { ...actual, persistEvState };
  });

  vi.doMock("./typecheckWorkerClient.js", () => ({
    TypecheckWorkerClient: class {
      async check(input: {
        unitRelativePath: string;
        moduleConditions: readonly string[];
        authority?: unknown;
      }) {
        typecheckCalls += 1;
        typecheckInputs.push(input);
        return typecheckDiagnostics(input.unitRelativePath);
      }
      async close() {}
    },
  }));

  const resolvedBuildKey = options.resolvedBuildKey;
  vi.doMock("./builder.js", async () => {
    const actual = await vi.importActual<typeof import("./builder.js")>("./builder.js");
    const buildStore = await vi.importActual<typeof import("./buildStore.js")>("./buildStore.js");
    return {
      ...actual,
      buildUnit: vi.fn(
        async (
          node: { name: string; kind: string; relativePath: string },
          ev: string,
          _graph: unknown,
          _root: string,
          stateRef: string,
          options?: { priority?: "interactive" | "background" | "speculative" }
        ) => {
          const key =
            (node.name === "@workspace-panels/app" ? resolvedBuildKey : undefined) ??
            actual.computeBuildUnitKey(node as never, ev, options as never);
          // Cache hit → reuse (exactly like the real builder + coalescing).
          const cached = buildStore.get(key);
          if (cached) return cached;
          buildCalls.push({ name: node.name, key, stateRef, priority: options?.priority });
          if (shouldFail(node.name, ev, stateRef)) {
            throw new Error(`mock build failed: ${node.name}`);
          }
          return buildStore.put(
            key,
            {
              entries: [
                {
                  path: "bundle.js",
                  role: "primary" as const,
                  contentType: "text/javascript",
                  content: "//built\n",
                },
              ],
            },
            {
              kind: node.kind as never,
              name: node.name,
              buildKey: key,
              sourcePath: node.relativePath,
              ev,
              sourceStateHash: stateRef,
              sourcemap: false,
              authority: { requests: [], provides: [] },
              details: { kind: "generic" as const },
              builtAt: new Date().toISOString(),
            }
          );
        }
      ),
    };
  });

  const { initBuildSystemV2 } = await import("./index.js");
  const { discoverPackageGraph } = await import("./packageGraph.js");
  const buildStore = await import("./buildStore.js");
  const graph = discoverPackageGraph(workspaceRoot);
  const source = fakeSource(workspaceRoot, graph);
  const buildSystem = await initBuildSystemV2(workspaceRoot, source, [], {
    appRoot: process.cwd(),
    runNativeJob: runIsolatedBuildJob,
    dependencyWorkspaceRoot: workspaceRoot,
    ...(options.blockingAuthorityConsumer
      ? { workspaceAuthorityEnvironmentAt: async () => ({ services: [] }) }
      : {}),
  });
  // Initialization only discovers/version-tracks units. Actual panel/worker
  // builds are demand-driven by their runtime access paths.
  expect(buildCalls).toEqual([]);

  return {
    buildSystem,
    workspaceRoot,
    buildStore,
    persistEvState,
    source,
    cleanup: async () => {
      await buildSystem.shutdown();
      vi.doUnmock("./builder.js");
      vi.doUnmock("./typecheckFold.js");
      vi.doUnmock("./effectiveVersion.js");
      vi.resetModules();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("BuildSystemV2 — explicit build reports", () => {
  let env: Awaited<ReturnType<typeof loadWithMocks>> | null = null;

  beforeEach(() => {
    shouldFail = () => false;
    typecheckDiagnostics = () => [];
    typecheckCalls = 0;
    typecheckInputs = [];
    buildCalls = [];
  });

  afterEach(async () => {
    await env?.cleanup();
    env = null;
  });

  it("reuses an explicit report build without promoting the published baseline", async () => {
    env = await loadWithMocks();
    const { buildSystem, persistEvState } = env;
    persistEvState.mockClear();

    const first = await buildSystem.getBuildReport("@workspace/lib", CANDIDATE_VIEW);
    const buildsAfterFirst = buildCalls.length;
    const typechecksAfterFirst = typecheckCalls;
    expect(buildsAfterFirst).toBeGreaterThan(0);
    expect(first).toMatchObject({
      repoPath: "packages/lib",
      unitName: "@workspace/lib",
      kind: "package",
      status: "ok",
      diagnostics: [],
      builds: [{ target: "library:panel", exportPath: ".", diagnosticIndexes: [] }],
    });
    expect(first.builds.every((build) => !("artifacts" in build))).toBe(true);
    expect(typecheckInputs).not.toHaveLength(0);
    expect(typecheckInputs.every((input) => input.authority === undefined)).toBe(true);

    const second = await buildSystem.getBuildReport("@workspace/lib", CANDIDATE_VIEW);

    expect(second).toEqual(first);
    expect(persistEvState).not.toHaveBeenCalled();
    expect(buildCalls.length).toBe(buildsAfterFirst);
    expect(typecheckCalls).toBe(typechecksAfterFirst);
  }, 15_000);

  it("reports the artifact key resolved by the build backend", async () => {
    const resolvedBuildKey = "c".repeat(64);
    env = await loadWithMocks({ resolvedBuildKey });
    const report = await env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW);

    expect(report.status).toBe("ok");
    expect(report.builds).toEqual([
      { target: "runtime", buildKey: resolvedBuildKey, diagnosticIndexes: [] },
    ]);
    expect(env.buildSystem.getBuildByKey(report.builds[0]!.buildKey!)).toMatchObject({
      buildKey: resolvedBuildKey,
      artifacts: [expect.objectContaining({ path: "bundle.js" })],
    });
    expect(await env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW)).toEqual(
      report
    );
  });

  it("exposes only completed cached reports to runtime recovery surfaces", async () => {
    env = await loadWithMocks();
    const { buildSystem } = env;

    expect(buildSystem.peekBuildReport?.("panels/app", CANDIDATE_VIEW)).toBeNull();

    const report = await buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW);

    expect(buildSystem.peekBuildReport?.("panels/app", CANDIDATE_VIEW)).toBe(report);
    expect(buildSystem.peekBuildReport?.("@workspace-panels/app", CANDIDATE_VIEW)).toBe(report);
    expect(buildSystem.peekBuildReport?.("panels/app", BASE_VIEW)).toBeNull();
  });

  it("checks authority at executable boundaries, not library package boundaries", async () => {
    env = await loadWithMocks();

    await env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW);

    expect(typecheckInputs).toEqual([
      expect.objectContaining({
        unitRelativePath: "panels/app",
        authority: expect.any(Object),
      }),
    ]);
  });

  it("validates package source once per execution environment across all six exports", async () => {
    env = await loadWithMocks();
    const node = env.buildSystem;
    const report = await node.getBuildReport("@workspace/isolated", CANDIDATE_VIEW);
    expect(report.builds).toHaveLength(6);
    expect(typecheckCalls).toBe(2);
    expect(typecheckInputs[0]?.authority).toBeUndefined();
    expect(typecheckInputs.map((input) => input.moduleConditions)).toEqual([
      ["vibestudio-panel", "import", "default"],
      ["worker", "workerd", "import", "default"],
    ]);
    expect(buildCalls).toHaveLength(6);

    await node.getBuildReport("@workspace/isolated", CANDIDATE_VIEW);
    expect(typecheckCalls).toBe(2);
    expect(buildCalls).toHaveLength(6);
  });

  it("builds browser-only exports without requiring a worker entry", async () => {
    env = await loadWithMocks({ isolatedExports: { ".": { "vibestudio-panel": "./index.ts" } } });
    const report = await env.buildSystem.getBuildReport("@workspace/isolated", CANDIDATE_VIEW);
    expect(report.status).toBe("ok");
    expect(report.builds).toEqual([
      expect.objectContaining({ target: "library:panel", exportPath: "." }),
    ]);
    expect(typecheckCalls).toBe(1);
  });

  it("resolves each conditional subpath in its declared environment", async () => {
    env = await loadWithMocks({
      isolatedExports: {
        "./panel": { "vibestudio-panel": "./index.ts" },
        "./worker": { worker: "./index.ts" },
      },
    });
    const report = await env.buildSystem.getBuildReport("@workspace/isolated", CANDIDATE_VIEW);
    expect(report.status).toBe("ok");
    expect(report.builds.map(({ target, exportPath }) => ({ target, exportPath }))).toEqual([
      { target: "library:panel", exportPath: "./panel" },
      { target: "library:worker", exportPath: "./worker" },
    ]);
  });

  it("rejects a package with no resolvable public export", async () => {
    env = await loadWithMocks({ isolatedExports: { ".": null } });
    const report = await env.buildSystem.getBuildReport("@workspace/isolated", CANDIDATE_VIEW);
    expect(report.status).toBe("failed");
    expect(report.builds).toEqual([]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("No public export"),
      }),
    ]);
  });

  it("coalesces concurrent reports for the same immutable unit view", async () => {
    env = await loadWithMocks();

    const [first, second, third] = await Promise.all([
      env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW),
      env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW),
      env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW),
    ]);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(typecheckCalls).toBe(1);
  });

  it("reports the real build phases without changing the build result", async () => {
    env = await loadWithMocks();
    const phases: string[] = [];

    const report = await env.buildSystem.getBuildReport(
      "@workspace-panels/app",
      CANDIDATE_VIEW,
      ({ repoPath, phase }) => phases.push(`${repoPath}:${phase}`)
    );

    expect(report.status).toBe("ok");
    expect(phases).toEqual(["panels/app:bundling", "panels/app:typechecking"]);
  });

  it("carries speculative preparation priority into the canonical build", async () => {
    env = await loadWithMocks();

    await env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW, undefined, {
      priority: "speculative",
    });

    expect(buildCalls).toEqual([
      expect.objectContaining({
        name: "@workspace-panels/app",
        priority: "speculative",
      }),
    ]);
  });

  it("does not retain reports produced by transient validation failures", async () => {
    let attempt = 0;
    typecheckDiagnostics = () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary typecheck worker failure");
      return [];
    };
    env = await loadWithMocks();

    const first = await env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW);
    const second = await env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW);

    expect(first).toMatchObject({
      status: "failed",
      diagnostics: [
        expect.objectContaining({ message: expect.stringContaining("temporary typecheck") }),
      ],
    });
    expect(second).toMatchObject({ status: "ok", diagnostics: [] });
    expect(typecheckCalls).toBe(2);
  });

  it("resolves context selectors to exact content before building a report", async () => {
    env = await loadWithMocks();
    const { buildSystem } = env;

    const report = await buildSystem.getBuildReport("@workspace-panels/app", "ctx:review");

    expect(report).toMatchObject({
      unitName: "@workspace-panels/app",
      status: "ok",
      diagnostics: [],
      builds: [{ target: "runtime", diagnosticIndexes: [] }],
    });
    expect(buildCalls).toEqual([
      expect.objectContaining({ name: "@workspace-panels/app", stateRef: CANDIDATE_VIEW }),
    ]);
  });

  it("distinguishes absent units from existing content at the exact selected state", async () => {
    env = await loadWithMocks();
    for (const target of ["panels/missing", "@workspace/missing"]) {
      await expect(env.buildSystem.getBuildReport(target, "ctx:review")).rejects.toMatchObject({
        name: "BuildRequestError",
        message: expect.stringContaining(target),
      });
    }
    expect(await env.buildSystem.getBuildReport("projects/notes", "ctx:review")).toMatchObject({
      stateHash: CANDIDATE_VIEW,
      repoPath: "projects/notes",
      kind: "content",
      status: "skipped",
      builds: [],
      diagnostics: [],
    });
    expect(buildCalls).toEqual([]);
    expect(typecheckCalls).toBe(0);
  });

  it("reports an invalid located unit as a schema failure and selects it for publication", async () => {
    env = await loadWithMocks({ invalidPanelManifest: true });

    await expect(
      env.buildSystem.getBuildReport("panels/solo", "ctx:review")
    ).resolves.toMatchObject({
      repoPath: "panels/solo",
      kind: "panel",
      status: "failed",
      builds: [],
      diagnostics: [
        expect.objectContaining({
          source: "schema",
          file: "panels/solo/package.json",
          message: expect.stringContaining("Invalid JSON in package.json"),
        }),
      ],
    });
    await expect(
      env.buildSystem.listAffectedBuildUnits(CANDIDATE_VIEW, ["panels/solo/package.json"])
    ).resolves.toContain("panels/solo");
  });

  it("propagates source refresh failures instead of certifying a stale main snapshot", async () => {
    env = await loadWithMocks();
    const failure = new Error("protected publication unavailable");
    vi.spyOn(env.source, "ensureFresh").mockRejectedValue(failure);
    await expect(env.buildSystem.getBuildReport("panels/app")).rejects.toBe(failure);
    expect(buildCalls).toEqual([]);
  });

  it("scopes publication validation to the complete reverse-dependency closure", async () => {
    env = await loadWithMocks();
    const { buildSystem } = env;

    await expect(
      buildSystem.listAffectedBuildUnits(CANDIDATE_VIEW, ["packages/lib"])
    ).resolves.toEqual(["@workspace/lib", "@workspace/mid", "@workspace-panels/app"]);
  });

  it("does not turn content-only repository changes into a whole-workspace build", async () => {
    env = await loadWithMocks();
    const { buildSystem } = env;

    await expect(
      buildSystem.listAffectedBuildUnits(CANDIDATE_VIEW, ["projects/notes"])
    ).resolves.toEqual([]);
  });

  it("selects the same authority consumers for forward metadata and provider removal batches", async () => {
    env = await loadWithMocks({ blockingAuthorityConsumer: true });
    const { buildSystem } = env;

    const forward = await buildSystem.listAffectedBuildUnits(CANDIDATE_VIEW, ["meta"]);
    const reverse = await buildSystem.listAffectedBuildUnits(CANDIDATE_VIEW, [
      "workers/removed-notes",
    ]);

    expect(forward).toContain("@workspace-panels/app");
    expect(reverse).toContain("@workspace-panels/app");
    expect(forward).not.toContain("@workspace/lib");
    expect(reverse).not.toContain("@workspace/lib");
    expect(forward).not.toContain("@workspace/isolated");
    expect(reverse).not.toContain("@workspace/isolated");
  });

  it("keeps an unrelated broken sibling outside the protected-publication closure", async () => {
    shouldFail = (name) => name === "@workspace/isolated";
    typecheckDiagnostics = (unitRelativePath) =>
      unitRelativePath === "packages/isolated"
        ? [
            {
              source: "tsc",
              severity: "error",
              file: "packages/isolated/index.ts",
              line: 1,
              column: 1,
              message: "unrelated sibling is broken",
            },
          ]
        : [];
    env = await loadWithMocks();
    const { buildSystem } = env;

    const affected = await buildSystem.listAffectedBuildUnits(CANDIDATE_VIEW, [
      "panels/solo/index.ts",
    ]);
    const reports = await Promise.all(
      affected.map((unitName) => buildSystem.getBuildReport(unitName, CANDIDATE_VIEW))
    );

    expect(affected).toEqual(["@workspace-panels/solo"]);
    expect(reports).toEqual([expect.objectContaining({ status: "ok", diagnostics: [] })]);
    expect(buildCalls.some((call) => call.name === "@workspace/isolated")).toBe(false);
  });

  it("returns agent-actionable diagnostics for an explicit failed build", async () => {
    shouldFail = (name) => name === "@workspace-panels/app";
    env = await loadWithMocks();
    const { buildSystem } = env;

    const report = await buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW);

    expect(report).toMatchObject({
      unitName: "@workspace-panels/app",
      status: "failed",
      diagnostics: [
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("mock build failed: @workspace-panels/app"),
        }),
      ],
      builds: [
        {
          target: "runtime",
          diagnosticIndexes: [0],
        },
      ],
    });
    expect(buildSystem.getUnitDiagnostics("@workspace-panels/app")).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error" })])
    );
  });

  it("stores a repeated multi-target diagnostic once and references it by index", async () => {
    typecheckDiagnostics = (unitRelativePath) => [
      {
        source: "tsc",
        severity: "error",
        file: `${unitRelativePath}/index.ts`,
        line: 1,
        column: 1,
        message: "one source defect",
      },
    ];
    env = await loadWithMocks();

    const report = await env.buildSystem.getBuildReport("@workspace/isolated", CANDIDATE_VIEW);

    expect(report.diagnostics).toHaveLength(1);
    expect(typecheckCalls).toBe(2);
    expect(report.builds.length).toBeGreaterThan(1);
    expect(report.builds.every((build) => build.diagnosticIndexes[0] === 0)).toBe(true);
  });

  it("references a repeated diagnostic only once within each build target", async () => {
    typecheckDiagnostics = (unitRelativePath) => {
      const diagnostic = {
        source: "authority" as const,
        severity: "error" as const,
        file: `${unitRelativePath}/index.ts`,
        line: 1,
        column: 1,
        message: "one source defect",
      };
      return [diagnostic, diagnostic];
    };
    env = await loadWithMocks();
    const report = await env.buildSystem.getBuildReport("@workspace/isolated", CANDIDATE_VIEW);
    expect(report.diagnostics).toHaveLength(1);
    expect(report.builds.every((build) => JSON.stringify(build.diagnosticIndexes) === "[0]")).toBe(
      true
    );
  });

  it("includes authority errors in the same report consumed by protected-main validation", async () => {
    typecheckDiagnostics = (unitRelativePath) => [
      {
        source: "authority",
        severity: "error",
        file: `${unitRelativePath}/package.json`,
        line: 1,
        column: 1,
        message: "Installed code uses capability 'push.send' but does not declare it.",
      },
    ];
    env = await loadWithMocks();

    const report = await env.buildSystem.getBuildReport("@workspace-panels/app", CANDIDATE_VIEW);

    expect(report).toMatchObject({
      status: "failed",
      diagnostics: [
        expect.objectContaining({
          source: "authority",
          severity: "error",
          file: "panels/app/package.json",
        }),
      ],
    });
  });
});
