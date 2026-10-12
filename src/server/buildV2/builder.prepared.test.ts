import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUnit, resolveBuildUnitKey } from "./builder.js";
import * as buildStore from "./buildStore.js";
import { setBuildSourceProvider } from "./buildSource.js";
import { PackageGraph, type GraphNode } from "./packageGraph.js";

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
function provider() {
  const materializeForBuild = vi.fn().mockRejectedValue(new Error("Compilation must not run"));
  setBuildSourceProvider({
    preparedBuildForContent: () => ({ buildKey: key, effectiveVersion: ev }),
    materializeForBuild,
  });
  return materializeForBuild;
}
afterEach(() => {
  setBuildSourceProvider(null);
  vi.restoreAllMocks();
});

describe("prepared template artifacts", () => {
  it("uses the published artifact key independently of the consumer dependency installation", async () => {
    const materialize = provider();
    const result = {
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
    } satisfies buildStore.StoredBuildResult;
    const hydrate = vi.spyOn(buildStore, "getOrHydrate").mockResolvedValue(result);
    const built = await buildUnit(
      node,
      ev,
      new PackageGraph(),
      "/consumer-with-different-dependencies",
      state
    );
    expect(built).toMatchObject({ buildKey: key, sourceStateHash: state, artifacts: [] });
    expect(hydrate).toHaveBeenCalledWith(key, state);
    expect(resolveBuildUnitKey(node, ev, state)).toBe(key);
    expect(materialize).not.toHaveBeenCalled();
  });
  it("propagates a missing installed artifact rather than compiling during startup", async () => {
    const materialize = provider();
    vi.spyOn(buildStore, "getOrHydrate").mockResolvedValue(null);
    await expect(buildUnit(node, ev, new PackageGraph(), "/workspace", state)).rejects.toThrow(
      "Installed template artifact is missing"
    );
    expect(materialize).not.toHaveBeenCalled();
  });
  it("rejects an artifact manifest for different source before hydration", async () => {
    provider();
    const hydrate = vi.spyOn(buildStore, "getOrHydrate");
    await expect(
      buildUnit(node, "d".repeat(64), new PackageGraph(), "/workspace", state)
    ).rejects.toThrow("does not match its source");
    expect(hydrate).not.toHaveBeenCalled();
  });
});
