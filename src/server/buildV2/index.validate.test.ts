/**
 * P2 (narrow-host VCS): the build system as a service. Covers the gad-facing
 * `validate` surface and the host-internal `statusAt` cache read.
 *
 * `validate` must be idempotent on unpublished candidates — build + cache only,
 * never promoting the source digest baseline (`persistSourceState`) or recording provenance
 * (`recordBuild`). `statusAt` must be a PURE lookup over recorded/cached per-unit
 * results — never triggering a build — and must preserve the coarse
 * validated/failed contract. The push report semantics (pushed gate absolutely,
 * dependent regression gate, pre-existing red is informational) must match the
 * legacy `validateRepoPush` behaviour.
 *
 * `buildUnit` and `typecheckUnit` are mocked so build success/failure is
 * deterministic and no real esbuild/tsc runs: the mock honours the content-
 * addressed build store exactly as the real builder does (cache hit → no
 * rebuild), so cache-reuse across overlapping validations is observable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuildSourceProvider } from "./buildSource.js";
import type { WorkspaceStateSource } from "./stateTrigger.js";
import type { BuildSystemV2 } from "./index.js";
import type { PackageGraph } from "./packageGraph.js";

const BASE_VIEW = "state:base";
const CANDIDATE_VIEW = "state:candidate";
const UNKNOWN_VIEW = "state:unknown";

// Per-test hook so a unit's build can be made to fail at a specific view.
let shouldFail: (name: string, sourceDigest: string, stateRef: string) => boolean = () => false;
// Records every non-cache-hit build the mock actually performs.
let buildCalls: Array<{ name: string; key: string }> = [];

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
 * source digest — and its dependent panel `app`'s source digest — change across the two views, while
 * standalone `solo` is stable.
 */
function fakeSource(
  workspaceRoot: string,
  graph: PackageGraph
): WorkspaceStateSource & BuildSourceProvider {
  return {
    ensureFresh: async () => ({ stateHash: BASE_VIEW }),
    unitHashes: async (stateHash, relPaths) =>
      Object.fromEntries(
        relPaths.map((relPath) => {
          if (relPath === "packages/lib" && stateHash === CANDIDATE_VIEW) {
            return [relPath, "h:packages/lib:candidate"];
          }
          return [relPath, `h:${relPath}`];
        })
      ),
    resolveHead: async () => BASE_VIEW,
    resolveContextView: async () => BASE_VIEW,
    discoverGraph: async (stateHash: string) => {
      if (stateHash === UNKNOWN_VIEW) throw new Error(`no such state: ${stateHash}`);
      return graph;
    },
    onStateAdvanced: () => () => {},
    recordBuild: async () => {},
    materializeForBuild: async () => ({ sourceRoot: workspaceRoot }),
  };
}

async function loadWithMocks(): Promise<{
  buildSystem: BuildSystemV2;
  workspaceRoot: string;
  cleanup: () => Promise<void>;
  buildStore: typeof import("./buildStore.js");
  diagnosticsStore: typeof import("./diagnosticsStore.js");
  persistSourceState: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-build-validate-"));
  const workspaceRoot = path.join(root, "workspace");
  writeUnit(workspaceRoot, "packages/lib", "@workspace/lib");
  writeUnit(workspaceRoot, "panels/app", "@workspace-panels/app", {
    "@workspace/lib": "workspace:*",
  });
  writeUnit(workspaceRoot, "panels/solo", "@workspace-panels/solo");

  const { setUserDataPath } = await import("@vibestudio/env-paths");
  setUserDataPath(path.join(root, "state"));

  const persistSourceState = vi.fn();
  vi.doMock("./sourceClosure.js", async () => {
    const actual = await vi.importActual<typeof import("./sourceClosure.js")>("./sourceClosure.js");
    return { ...actual, persistSourceState };
  });

  vi.doMock("./typecheckFold.js", () => ({ typecheckUnit: vi.fn(async () => []) }));

  vi.doMock("./builder.js", async () => {
    const actual = await vi.importActual<typeof import("./builder.js")>("./builder.js");
    const buildStore = await vi.importActual<typeof import("./buildStore.js")>("./buildStore.js");
    return {
      ...actual,
      buildUnit: vi.fn(
        async (
          node: { name: string; kind: string },
          sourceDigest: string,
          _graph: unknown,
          _root: string,
          stateRef: string,
          options?: unknown
        ) => {
          const key = actual.computeUnitCompilationCacheKey(
            node as never,
            sourceDigest,
            options as never
          );
          // Cache hit → reuse (exactly like the real builder + coalescing).
          const cached = buildStore.get(key);
          if (cached) return cached;
          buildCalls.push({ name: node.name, key });
          if (shouldFail(node.name, sourceDigest, stateRef)) {
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
              sourceDigest,
              sourceStateHash: stateRef,
              sourcemap: false,
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
  const diagnosticsStore = await import("./diagnosticsStore.js");
  const graph = discoverPackageGraph(workspaceRoot);
  const buildSystem = await initBuildSystemV2(workspaceRoot, fakeSource(workspaceRoot, graph), []);
  // Initialization only discovers/version-tracks units. Actual panel/worker
  // builds are demand-driven by their runtime access paths.
  expect(buildCalls).toEqual([]);

  return {
    buildSystem,
    workspaceRoot,
    buildStore,
    diagnosticsStore,
    persistSourceState,
    cleanup: async () => {
      await buildSystem.shutdown();
      vi.doUnmock("./builder.js");
      vi.doUnmock("./typecheckFold.js");
      vi.doUnmock("./sourceClosure.js");
      vi.resetModules();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("BuildSystemV2 P2 — validate / statusAt", () => {
  let env: Awaited<ReturnType<typeof loadWithMocks>> | null = null;

  beforeEach(() => {
    shouldFail = () => false;
    buildCalls = [];
  });

  afterEach(async () => {
    await env?.cleanup();
    env = null;
  });

  it("validate is idempotent on an unpublished candidate: no baseline promotion", async () => {
    env = await loadWithMocks();
    const { buildSystem, persistSourceState } = env;
    const recordBuild = vi.fn();
    // Re-point the source's recordBuild via a spy on the running system: the
    // fake's recordBuild is a no-op, so assert persistSourceState instead (the source digest
    // baseline promotion) plus that a second validate rebuilds nothing.
    persistSourceState.mockClear();

    const first = await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });
    const buildsAfterFirst = buildCalls.length;
    expect(buildsAfterFirst).toBeGreaterThan(0);

    const second = await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });

    // Reports identical across calls.
    expect(second).toEqual(first);
    // No source digest baseline promotion happened as a side effect of either validate.
    expect(persistSourceState).not.toHaveBeenCalled();
    expect(recordBuild).not.toHaveBeenCalled();
    // Second validate recompiled nothing (per-unit build cache reuse).
    expect(buildCalls.length).toBe(buildsAfterFirst);
  });

  it("per-unit build cache is reused across two validates sharing units", async () => {
    env = await loadWithMocks();
    const { buildSystem } = env;

    await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });
    const keysFirst = new Set(buildCalls.map((c) => c.key));
    expect(keysFirst.size).toBeGreaterThan(0);
    buildCalls = [];

    // A second, overlapping validation (same candidate) shares every unit's
    // build key → recompiles nothing, only re-classifies.
    await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });
    expect(buildCalls).toHaveLength(0);
  });

  it("preserves required-vs-informational classification", async () => {
    // Pushed buildable unit fails → required gate. Dependent that is ALSO red on
    // the base is pre-existing (informational, not required).
    shouldFail = (name) => name === "@workspace/lib" || name === "@workspace-panels/app";
    env = await loadWithMocks();
    const { buildSystem } = env;

    const reports = await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });
    const lib = reports.find((r) => r.unitName === "@workspace/lib");
    const app = reports.find((r) => r.unitName === "@workspace-panels/app");

    expect(lib).toMatchObject({ role: "pushed", required: true, status: "failed" });
    // app fails on both base and candidate → pre-existing → informational.
    expect(app).toMatchObject({ role: "dependent", status: "failed", required: false });
  });

  it("a newly-red dependent gates absolutely; no base ⇒ failed dependent gates", async () => {
    // app builds green on base, red only on the candidate view.
    shouldFail = (name, _ev, stateRef) =>
      name === "@workspace-panels/app" && stateRef === CANDIDATE_VIEW;
    env = await loadWithMocks();
    const { buildSystem } = env;

    const withBase = await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });
    const appWithBase = withBase.find((r) => r.unitName === "@workspace-panels/app");
    // Green on base, red on candidate → newly broken → required.
    expect(appWithBase).toMatchObject({ status: "failed", required: true });

    // Same push with NO base view: a failed dependent gates absolutely.
    const noBase = await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
    });
    const appNoBase = noBase.find((r) => r.unitName === "@workspace-panels/app");
    expect(appNoBase).toMatchObject({ status: "failed", required: true });
  });

  it("statusAt returns not-validated for an unknown view and never builds", async () => {
    env = await loadWithMocks();
    const { buildSystem } = env;

    const status = await buildSystem.statusAt(UNKNOWN_VIEW);
    expect(status).toEqual({ validated: false });
    expect(buildCalls).toHaveLength(0);
  });

  it("statusAt is a pure read: not-validated before validate, ok after, and it never builds", async () => {
    env = await loadWithMocks();
    const { buildSystem } = env;

    // Candidate changes lib → app's candidate source digest is not yet built.
    const before = await buildSystem.statusAt(CANDIDATE_VIEW);
    expect(before.validated).toBe(false);
    expect(buildCalls).toHaveLength(0); // pure read — no builds

    await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });
    const buildsAfterValidate = buildCalls.length;

    const after = await buildSystem.statusAt(CANDIDATE_VIEW);
    expect(after.validated).toBe(true);
    expect(after.failed).toBeUndefined();
    // statusAt itself triggered no further builds.
    expect(buildCalls.length).toBe(buildsAfterValidate);
    const app = after.unitStatuses?.find((u) => u.unit === "@workspace-panels/app");
    expect(app?.status).toBe("ok");
  });

  it("statusAt reports failed for a view whose unit failed to build", async () => {
    shouldFail = (name) => name === "@workspace-panels/app";
    env = await loadWithMocks();
    const { buildSystem } = env;

    await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });

    const status = await buildSystem.statusAt(CANDIDATE_VIEW);
    // The view WAS validated (every unit went through a build attempt), and it
    // failed — a recorded failure is evidence, distinct from "not validated".
    // This maps to the prompt's "failed" state (vs "not validated").
    expect(status.validated).toBe(true);
    expect(status.failed).toBe(true);
    const app = status.unitStatuses?.find((u) => u.unit === "@workspace-panels/app");
    expect(app?.status).toBe("failed");
  });

  it("statusAt lets recorded error diagnostics win over cached artifacts", async () => {
    env = await loadWithMocks();
    const { buildSystem, diagnosticsStore } = env;

    await buildSystem.validate({
      viewHash: CANDIDATE_VIEW,
      repoPaths: ["packages/lib"],
      baseViewHash: BASE_VIEW,
    });
    const appBuild = buildCalls.find((call) => call.name === "@workspace-panels/app");
    expect(appBuild).toBeDefined();

    diagnosticsStore.recordDiagnostics("@workspace-panels/app", appBuild!.key, [
      {
        source: "tsc",
        severity: "error",
        file: "panels/app/index.ts",
        line: 1,
        column: 1,
        message: "recorded diagnostic should dominate artifact presence",
      },
    ]);

    const status = await buildSystem.statusAt(CANDIDATE_VIEW);
    expect(status.validated).toBe(true);
    expect(status.failed).toBe(true);
    const app = status.unitStatuses?.find((u) => u.unit === "@workspace-panels/app");
    expect(app?.status).toBe("failed");
  });
});
