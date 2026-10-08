import { describe, expect, it, vi } from "vitest";
import type { BuildSourceProvider } from "./buildSource.js";
import type { WorkspaceStateSource } from "./stateTrigger.js";
import { BootstrapWorkspaceSource } from "./bootstrapWorkspaceSource.js";

const stateHash = `state:${"a".repeat(64)}`;
function fixture() {
  const source = {
    workspaceId: "workspace:test",
    ensureFresh: vi.fn(async () => ({ stateHash: `state:${"b".repeat(64)}` })),
    unitHashes: vi.fn(async () => ({ "apps/shell": "immutable-subtree" })),
    resolveContextState: vi.fn(async () => stateHash),
    readFile: vi.fn(async () => null),
    discoverGraph: vi.fn(),
    materializeForBuild: vi.fn(async () => ({ sourceRoot: "/immutable/materialization" })),
    onProtectedPublication: vi.fn(() => () => {}),
    recordBuild: vi.fn(async () => {}),
  } satisfies WorkspaceStateSource & BuildSourceProvider;
  const bootstrap = new BootstrapWorkspaceSource(source.workspaceId, source, stateHash, {
    kind: "bootstrap-snapshot",
    snapshotHash: stateHash,
  });
  return { source, bootstrap };
}

describe("BootstrapWorkspaceSource immutable publication", () => {
  it("keeps the acquired publication without rediscovering protected main", async () => {
    const { source, bootstrap } = fixture();
    await expect(bootstrap.ensureFresh()).resolves.toEqual({ stateHash });
    await expect(bootstrap.ensureFresh()).resolves.toEqual({ stateHash });
    expect(source.ensureFresh).not.toHaveBeenCalled();
  });

  it("uses the same exact content coordinate for hashes, reads, graph and materialization", async () => {
    const { source, bootstrap } = fixture();
    await bootstrap.unitHashes("main", ["apps/shell"]);
    await bootstrap.readFile(stateHash, "meta/vibestudio.yml");
    await bootstrap.discoverGraph("main");
    await expect(bootstrap.materializeForBuild([], "main", "/projection")).resolves.toEqual({
      sourceRoot: "/immutable/materialization",
    });
    expect(source.unitHashes).toHaveBeenCalledWith(stateHash, ["apps/shell"]);
    expect(source.readFile).toHaveBeenCalledWith(stateHash, "meta/vibestudio.yml");
    expect(source.discoverGraph).toHaveBeenCalledWith(stateHash);
    expect(source.materializeForBuild).toHaveBeenCalledWith([], stateHash, "/projection");
  });

  it("rejects other publications and contexts instead of substituting bootstrap content", async () => {
    const { source, bootstrap } = fixture();
    expect(() => bootstrap.unitHashes(`state:${"b".repeat(64)}`, [])).toThrow("cannot resolve");
    await expect(bootstrap.resolveContextState("ctx:test")).rejects.toThrow("no semantic contexts");
    expect(source.unitHashes).not.toHaveBeenCalled();
    expect(source.resolveContextState).not.toHaveBeenCalled();
  });

  it("preserves exact execution provenance and never reports another state as executable", () => {
    const { source, bootstrap } = fixture();
    expect(bootstrap.executionStateForContent(stateHash)).toEqual({
      kind: "bootstrap-snapshot",
      snapshotHash: stateHash,
    });
    expect(bootstrap.executionStateForContent(`state:${"b".repeat(64)}`)).toBeNull();
    const provenance = { kind: "event", eventId: "event:test" } as const;
    // A restored publication carries the semantic coordinate supplied by its owner.
    const restored = new BootstrapWorkspaceSource(
      source.workspaceId,
      source,
      stateHash,
      provenance
    );
    expect(restored.executionStateForContent(stateHash)).toBe(provenance);
  });

  it("propagates the original content-store failure", async () => {
    const { source, bootstrap } = fixture();
    const failure = new Error("missing retained content");
    source.materializeForBuild.mockRejectedValueOnce(failure);
    await expect(bootstrap.materializeForBuild([], "main", "/projection")).rejects.toBe(failure);
  });
});
