import { describe, expect, it } from "vitest";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import { createWorkspaceStateMigration } from "./workspaceStateMigration.js";

const ref = (className: string) => ({
  source: INTERNAL_DO_SOURCE,
  className,
  objectKey: "ws-1",
});
const status = (phase: string) => ({
  phase,
  staged: {},
  applied: 0,
  total: 0,
  manifestDigest: null,
});

function fakeStore(options: { phase?: string; failFirstStatus?: boolean } = {}) {
  const calls: string[] = [];
  let failures = options.failFirstStatus ? 1 : 0;
  let phase = options.phase ?? "none";
  const dispatch = async (target: { className: string }, method: string) => {
    calls.push(`${target.className}.${method}`);
    if (method === "legacyImportStatus") {
      if (failures-- > 0) throw new Error("the node is not ready");
      return status(phase);
    }
    if (method === "legacyManifest") {
      return { present: false, schemaVersion: null, tables: [], digest: "0".repeat(64) };
    }
    if (method === "legacyImportSkip") {
      phase = "skipped";
      return status(phase);
    }
    throw new Error(`unexpected ${method}`);
  };
  return { calls, dispatch: dispatch as never };
}

describe("the workspace state migration", () => {
  it("holds every call to the Dolt store until the one import settled, and asks the retired store once", async () => {
    const store = fakeStore();
    const migration = createWorkspaceStateMigration({
      workspaceId: "ws-1",
      dispatch: store.dispatch,
    });
    const waits = [
      migration.readyFor(ref("WorkspaceStateDO")),
      migration.readyFor(ref("WorkspaceStateDO")),
    ];
    expect(waits[0]).toBe(waits[1]);
    await Promise.all(waits);
    expect(store.calls).toEqual([
      "WorkspaceStateDO.legacyImportStatus",
      "WorkspaceDO.legacyManifest",
      "WorkspaceStateDO.legacyImportSkip",
    ]);
    // Settled: nothing is owed any more.
    expect(migration.readyFor(ref("WorkspaceStateDO"))).toBeUndefined();
  });

  it("owes nothing to any other object, nor to the retired class", () => {
    const migration = createWorkspaceStateMigration({
      workspaceId: "ws-1",
      dispatch: fakeStore().dispatch,
    });
    expect(migration.readyFor(ref("EvalDO"))).toBeUndefined();
    expect(migration.readyFor(ref("WorkspaceDO"))).toBeUndefined();
    expect(
      migration.readyFor({ source: "workers/x", className: "WorkspaceStateDO", objectKey: "k" })
    ).toBeUndefined();
  });

  it("does not remember a failure: the next call resumes the import", async () => {
    const store = fakeStore({ failFirstStatus: true });
    const migration = createWorkspaceStateMigration({
      workspaceId: "ws-1",
      dispatch: store.dispatch,
    });
    await expect(migration.readyFor(ref("WorkspaceStateDO"))).rejects.toThrow("not ready");
    await expect(migration.readyFor(ref("WorkspaceStateDO"))).resolves.toBeDefined();
    expect(migration.readyFor(ref("WorkspaceStateDO"))).toBeUndefined();
  });

  it("settles a workspace whose store was already imported with one status call", async () => {
    const store = fakeStore({ phase: "verified" });
    const migration = createWorkspaceStateMigration({
      workspaceId: "ws-1",
      dispatch: store.dispatch,
    });
    await migration.readyFor(ref("WorkspaceStateDO"));
    expect(store.calls).toEqual(["WorkspaceStateDO.legacyImportStatus"]);
  });
});
