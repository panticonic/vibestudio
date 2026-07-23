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

const BASE_VIEW = "state:base";
const CANDIDATE_VIEW = "state:candidate";

// Per-test hook so a unit's build can be made to fail at a specific view.
let shouldFail: (name: string, ev: string, stateRef: string) => boolean = () => false;
// Records every non-cache-hit build the mock actually performs.
let buildCalls: Array<{ name: string; key: string; stateRef: string }> = [];

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
    resolveContextState: async () => CANDIDATE_VIEW,
    discoverGraph: async () => graph,
    onProtectedPublication: () => () => {},
    recordBuild: async () => {},
    materializeForBuild: async () => ({ sourceRoot: workspaceRoot }),
  };
}

async function loadWithMocks(): Promise<{
  buildSystem: BuildSystemV2;
  workspaceRoot: string;
  cleanup: () => Promise<void>;
  buildStore: typeof import("./buildStore.js");
  persistEvState: ReturnType<typeof vi.fn>;
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

  const persistEvState = vi.fn();
  vi.doMock("./effectiveVersion.js", async () => {
    const actual =
      await vi.importActual<typeof import("./effectiveVersion.js")>("./effectiveVersion.js");
    return { ...actual, persistEvState };
  });

  vi.doMock("./typecheckFold.js", () => ({ typecheckUnit: vi.fn(async () => []) }));

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
          options?: unknown
        ) => {
          const key = actual.computeBuildUnitKey(node as never, ev, options as never);
          // Cache hit → reuse (exactly like the real builder + coalescing).
          const cached = buildStore.get(key);
          if (cached) return cached;
          buildCalls.push({ name: node.name, key, stateRef });
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
              authority: { requests: [], evalCeilings: [] },
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
  const buildSystem = await initBuildSystemV2(workspaceRoot, fakeSource(workspaceRoot, graph), []);
  // Initialization only discovers/version-tracks units. Actual panel/worker
  // builds are demand-driven by their runtime access paths.
  expect(buildCalls).toEqual([]);

  return {
    buildSystem,
    workspaceRoot,
    buildStore,
    persistEvState,
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
    expect(buildsAfterFirst).toBeGreaterThan(0);
    expect(first).toMatchObject({
      repoPath: "packages/lib",
      unitName: "@workspace/lib",
      kind: "package",
      status: "ok",
      diagnostics: [],
      builds: [{ target: "library:panel", exportPath: ".", diagnostics: [] }],
    });

    const second = await buildSystem.getBuildReport("@workspace/lib", CANDIDATE_VIEW);

    expect(second).toEqual(first);
    expect(persistEvState).not.toHaveBeenCalled();
    expect(buildCalls.length).toBe(buildsAfterFirst);
  });

  it("resolves context selectors to exact content before building a report", async () => {
    env = await loadWithMocks();
    const { buildSystem } = env;

    const report = await buildSystem.getBuildReport("@workspace-panels/app", "ctx:review");

    expect(report).toMatchObject({
      unitName: "@workspace-panels/app",
      status: "ok",
      diagnostics: [],
      builds: [{ target: "runtime", diagnostics: [] }],
    });
    expect(buildCalls).toEqual([
      expect.objectContaining({ name: "@workspace-panels/app", stateRef: CANDIDATE_VIEW }),
    ]);
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
          diagnostics: [
            expect.objectContaining({
              severity: "error",
              message: expect.stringContaining("mock build failed: @workspace-panels/app"),
            }),
          ],
        },
      ],
    });
    expect(buildSystem.getUnitDiagnostics("@workspace-panels/app")).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error" })])
    );
  });
});
