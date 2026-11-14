import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DurableObjectStorage,
  type DurableObjectStorageDeps,
  type ObjectOperation,
} from "./durableObjectStorage.js";

const ref = { source: "workers/board", className: "BoardDO", objectKey: "main" };

function harness(db = new DatabaseSync(":memory:")) {
  const events: string[] = [];
  const operations: ObjectOperation[] = [];
  const state = { failFork: null as null | { code?: string }, destroyed: [] as string[] };
  const deps: DurableObjectStorageDeps = {
    db,
    async objectOperation(input) {
      operations.push(input);
      events.push(`${input.op}:${input.to.objectKey}`);
      if (input.op === "fork" && state.failFork) {
        throw Object.assign(new Error("fork refused"), { code: state.failFork.code });
      }
    },
    async destroyCell(target) {
      state.destroyed.push(target.objectKey);
      events.push(`destroy:${target.objectKey}`);
    },
    async abortFacet() {
      events.push("abort");
    },
    async ensureNodeRunning() {},
    nodeRunning: () => true,
    async republishOwner() {
      events.push("republish");
    },
    async seal(_targetId, ownerId) {
      events.push(`seal:${ownerId.slice(0, 4)}`);
    },
    release: () => events.push("release"),
  };
  return { storage: new DurableObjectStorage(deps), db, events, operations, state };
}

describe("DurableObjectStorage", () => {
  it("adopts an earlier build's journal: an owed retirement moves to the outbox, the journal goes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE do_maintenance (
        operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL,
        source TEXT NOT NULL, class_name TEXT NOT NULL, object_key TEXT NOT NULL,
        intent TEXT NOT NULL, backup_operation_id TEXT, step TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO do_maintenance VALUES
        ('a', 'destroy', 'do:x', 'workers/board', 'BoardDO', 'retired', 'reclaim', NULL, 'journaled', 'open', 5, 5),
        ('b', 'reset', 'do:y', 'workers/board', 'BoardDO', 'mid-reset', 'reset', NULL, 'fenced', 'open', 6, 6),
        ('c', 'destroy', 'do:z', 'workers/board', 'BoardDO', 'done', 'reclaim', NULL, 'complete', 'complete', 7, 7);
    `);
    harness(db);
    expect(
      db.prepare(`SELECT object_key FROM do_storage_retired ORDER BY object_key`).all()
    ).toEqual([{ object_key: "retired" }]);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'do_maintenance'`).all()).toEqual(
      []
    );
    // Opening it again changes nothing.
    harness(db);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM do_storage_retired`).get()).toEqual({ n: 1 });
  });

  it("backs up before it replaces, and rotates the identity before the replacement", async () => {
    const { storage, events } = harness();
    const before = storage.incarnation(ref);
    const { operationId } = await storage.reset(ref, "recover");
    expect(events.filter((event) => !event.startsWith("seal"))).toEqual([
      "abort",
      `fork:__vibestudio_backup:${operationId}`,
      "destroy:main",
      "republish",
      "release",
    ]);
    expect(storage.incarnation(ref).generation).toBe(before.generation + 1);
    expect(storage.list(ref)).toEqual([
      expect.objectContaining({ operationId, intent: "recover" }),
    ]);
  });

  it("lists a backup only when its fork finished, and takes a finished fork (ERR_OBJECT_EXISTS) as done", async () => {
    const h = harness();
    h.state.failFork = { code: "ERR_OBJECT_UNFINISHED" };
    await expect(h.storage.reset(ref, "refused")).rejects.toThrow("fork refused");
    expect(h.storage.list(ref)).toEqual([]);
    // The identity was not rotated and the object was not replaced.
    expect(h.state.destroyed).toEqual([]);
    expect(h.storage.incarnation(ref).generation).toBe(1);

    h.state.failFork = { code: "ERR_OBJECT_EXISTS" };
    const { operationId } = await h.storage.reset(ref, "exists");
    expect(h.storage.list(ref).map((backup) => backup.operationId)).toEqual([operationId]);
  });

  it("restores only this object's finished backup, after backing up what it replaces", async () => {
    const h = harness();
    const { operationId: backup } = await h.storage.reset(ref, "first");
    await expect(
      h.storage.restore({ ...ref, objectKey: "other" }, backup, "wrong target")
    ).rejects.toThrow("does not belong to the exact requested target");
    h.operations.length = 0;
    const restored = await h.storage.restore(ref, backup, "restore it");
    expect(h.operations.map((operation) => operation.op)).toEqual(["fork", "restore"]);
    expect(h.operations[1]).toMatchObject({
      op: "restore",
      from: { objectKey: `__vibestudio_backup:${backup}` },
      to: ref,
      stop: true,
    });
    expect(h.storage.list(ref).map((entry) => entry.operationId)).toContain(restored.operationId);
  });

  it("runs the operations of one object one at a time", async () => {
    const h = harness();
    await Promise.all([h.storage.reset(ref, "one"), h.storage.reset(ref, "two")]);
    const order = h.events.filter((event) => event === "abort" || event === "republish");
    expect(order).toEqual(["abort", "republish", "abort", "republish"]);
  });
});
