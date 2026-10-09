import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { DurableObjectStorageClone } from "./durableObjectStorageClone.js";

describe("DurableObjectStorageClone", () => {
  let root: string;
  let db: DatabaseSync;
  let clones: DurableObjectStorageClone;
  const source = { source: "workers/counter", className: "Counter", objectKey: "source" };
  const reservation: EntityRecord = {
    id: "do:workers/counter:Counter:child",
    kind: "do",
    source: { repoPath: source.source, effectiveVersion: "" },
    className: "Counter",
    key: "child",
    contextId: "child-context",
    authoritySessionId: "child-session",
    status: "preparing",
    createdAt: 1,
    cleanupComplete: true,
    cloneProvenance: {
      storage: "snapshot",
      operationContextId: "child-context",
      sourceEntityId: "do:workers/counter:Counter:source",
      sourceContextId: "source-context",
      sourceAuthoritySessionId: "source-session",
      sourceBuildKey: "b".repeat(64),
      sourceExecutionDigest: "e".repeat(64),
    },
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-do-clone-"));
    await fs.mkdir(path.join(root, "storage"));
    db = new DatabaseSync(path.join(root, "journal.sqlite"));
    clones = new DurableObjectStorageClone(db, path.join(root, "staging"));
  });
  afterEach(async () => {
    await clones.join();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const snapshot = async (stage: string) => {
    await fs.writeFile(path.join(stage, ".sqlite"), "original coherent snapshot");
    await fs.writeFile(path.join(stage, ".facets"), "original descriptor");
  };
  function input(snapshotOwner = snapshot) {
    return {
      source,
      reservation,
      storageDir: path.join(root, "storage"),
      targetHash: "target",
      snapshot: snapshotOwner,
    };
  }

  it("joins one live snapshot and preserves changed target bytes on completed replay", async () => {
    let entered!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = vi.fn(async (stage: string) => {
      entered();
      await held;
      await snapshot(stage);
    });
    const first = clones.copy(input(owner));
    await admitted;
    const second = clones.copy(input(owner));
    expect(owner).toHaveBeenCalledOnce();
    release();
    expect(() => clones.requireComplete(reservation)).toThrow(/completion/);
    await Promise.all([first, second]);
    expect(() => clones.requireComplete(reservation)).not.toThrow();
    await fs.writeFile(path.join(root, "storage", "target.sqlite"), "initialized receiver state");
    await clones.copy(input(owner));
    expect(owner).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(root, "storage", "target.sqlite"), "utf8")).toBe(
      "initialized receiver state"
    );
    expect(await fs.readdir(path.join(root, "staging"))).toEqual([]);
  });

  it("re-adopts an interrupted publication using its original immutable snapshot", async () => {
    const original = vi.fn(async (stage: string) => {
      await snapshot(stage);
      await fs.mkdir(path.join(root, "storage", "target.sqlite"));
    });
    await expect(clones.copy(input(original))).rejects.toMatchObject({ code: "EISDIR" });
    expect(db.prepare(`SELECT phase FROM do_storage_clones`).get()).toMatchObject({
      phase: "staged",
    });
    await fs.rm(path.join(root, "storage", "target.sqlite"), { recursive: true });
    clones = new DurableObjectStorageClone(db, path.join(root, "staging"));
    const newer = vi.fn(async () => {
      throw new Error("must not select a newer source snapshot");
    });
    await clones.copy(input(newer));
    expect(newer).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, "storage", "target.sqlite"), "utf8")).toBe(
      "original coherent snapshot"
    );
    expect(db.prepare(`SELECT phase FROM do_storage_clones`).get()).toMatchObject({
      phase: "complete",
    });
  });

  it("never treats unowned or partially present target files as completion", async () => {
    await fs.writeFile(path.join(root, "storage", "target.sqlite"), "foreign partial target");
    const owner = vi.fn(snapshot);
    await expect(clones.copy(input(owner))).rejects.toThrow("without an owned completion receipt");
    expect(owner).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, "storage", "target.sqlite"), "utf8")).toBe(
      "foreign partial target"
    );
  });

  it("rejects foreign reservation lifetimes and joins owned staging retirement", async () => {
    const failure = new Error("original snapshot failure");
    await expect(
      clones.copy(
        input(async (stage) => {
          await fs.writeFile(path.join(stage, ".sqlite"), "unfinished snapshot");
          throw failure;
        })
      )
    ).rejects.toBe(failure);
    await expect(
      clones.copy({ ...input(), reservation: { ...reservation, authoritySessionId: "foreign" } })
    ).rejects.toThrow("storageCloneOwner");
    await clones.retire(reservation.id);
    expect(db.prepare(`SELECT * FROM do_storage_clones`).all()).toEqual([]);
    expect(await fs.readdir(path.join(root, "staging"))).toEqual([]);
  });
});
