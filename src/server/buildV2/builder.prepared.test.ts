import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUnit, resolveBuildUnitKey, type BuilderSession } from "./builder.js";
import type { BuildSourceProvider } from "./buildSource.js";
import type { StoredBuildResult } from "./buildStore.js";
import { createBuilderTestSession } from "./builderTestSession.js";
import { PackageGraph, type GraphNode } from "./packageGraph.js";
import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";

const state = `state:${"a".repeat(64)}`;
const ev = "b".repeat(64);
const key = "c".repeat(64);
const node: GraphNode = {
  name: "@workspace/source",
  relativePath: "workers/source",
  path: "/workspace/workers/source",
  kind: "worker",
  dependencies: {},
  peerDependencies: {},
  optionalPeerDependencies: [],
  dependencyOverrides: {},
  internalDeps: [],
  manifest: {},
};

const preparedResult: StoredBuildResult = {
  dir: "/published/build",
  buildKey: key,
  sourceStateHash: state,
  metadata: {
    kind: "worker",
    name: node.relativePath,
    buildKey: key,
    sourcePath: null,
    ev,
    sourceStateHash: state,
    sourcemap: false,
    authority: { requests: [], provides: [] },
    details: { kind: "generic" },
    builtAt: "2026-01-01T00:00:00.000Z",
  },
  artifacts: [],
};

function provider() {
  const materializeForBuild = vi.fn().mockRejectedValue(new Error("Compilation must not run"));
  const source: BuildSourceProvider = {
    preparedBuildForContent: () => ({ buildKey: key, effectiveVersion: ev }),
    materializeForBuild,
  };
  return { source, materializeForBuild };
}

describe("prepared template artifacts", () => {
  let root: string | undefined;
  let session: BuilderSession | undefined;
  let close: (() => Promise<void>) | undefined;

  async function open(source: BuildSourceProvider): Promise<BuilderSession> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-prepared-build-"));
    const context = await createBuilderTestSession({
      appRoot: process.cwd(),
      workspaceRoot: "/consumer-with-different-dependencies",
      stateRoot: path.join(root, "state"),
      runNativeJob: runIsolatedBuildJob,
      source,
    });
    session = context.session;
    close = context.close;
    return session;
  }

  afterEach(async () => {
    await close?.();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    session = undefined;
    close = undefined;
    vi.restoreAllMocks();
  });

  it("uses the published artifact key independently of consumer dependency installation", async () => {
    const { source, materializeForBuild } = provider();
    const buildSession = await open(source);
    const hydrate = vi.spyOn(buildSession.store, "getOrHydrate").mockResolvedValue(preparedResult);
    const built = await buildUnit(
      buildSession,
      node,
      ev,
      new PackageGraph(),
      "/consumer-with-different-dependencies",
      state
    );
    expect(built).toMatchObject({ buildKey: key, sourceStateHash: state, artifacts: [] });
    expect(hydrate).toHaveBeenCalledWith(key, state);
    expect(
      resolveBuildUnitKey(buildSession.rootFingerprint, buildSession.source, node, ev, state)
    ).toBe(key);
    expect(materializeForBuild).not.toHaveBeenCalled();
  });

  it("propagates a missing installed artifact rather than compiling during startup", async () => {
    const { source, materializeForBuild } = provider();
    const buildSession = await open(source);
    vi.spyOn(buildSession.store, "getOrHydrate").mockResolvedValue(null);
    await expect(
      buildUnit(buildSession, node, ev, new PackageGraph(), "/workspace", state)
    ).rejects.toThrow("Installed template artifact is missing");
    expect(materializeForBuild).not.toHaveBeenCalled();
  });

  it("rejects an artifact manifest for different source before hydration", async () => {
    const { source } = provider();
    const buildSession = await open(source);
    const hydrate = vi.spyOn(buildSession.store, "getOrHydrate");
    await expect(
      buildUnit(buildSession, node, "d".repeat(64), new PackageGraph(), "/workspace", state)
    ).rejects.toThrow("does not match its source");
    expect(hydrate).not.toHaveBeenCalled();
  });
});
