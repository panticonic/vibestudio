import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { retainNativeStorageBeforeErase } from "./nativeStorageCapture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const hash = "a".repeat(64);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-capture-"));
  roots.push(root);
  const directory = path.join(root, "state/.databases/workerd-do/namespace");
  await fs.mkdir(directory, { recursive: true });
  const archiveRoot = path.join(root, "state/capture-evidence/native-storage");
  const target = {
    source: "vibestudio/internal",
    className: "EvalDO",
    objectKey: "failed-before-run",
  };
  const verifySqlite = async (paths: string[]) => {
    for (const file of paths) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        expect(Object.values(db.prepare("PRAGMA integrity_check").get()!)).toEqual(["ok"]);
      } finally {
        db.close();
      }
    }
  };
  return {
    root,
    directory,
    archiveRoot,
    hash,
    workspaceId: "owned-managed-workspace",
    target,
    verifySqlite,
  };
}
async function manifest(directory: string) {
  return JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
}

describe("native storage capture erase barrier", () => {
  it("retains exact pre-run SQLite plus WAL/SHM and every native-prefix variant", async () => {
    const f = await fixture(),
      file = path.join(f.directory, hash + ".sqlite");
    const writer = new DatabaseSync(file);
    try {
      writer.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE runs(id TEXT); CREATE TABLE diagnostics(value TEXT); INSERT INTO diagnostics VALUES ('prepared, no run or model capture');"
      );
      const extra = hash + ".opaque-journal";
      await fs.writeFile(path.join(f.directory, extra), "native auxiliary bytes");
      const unrelated = path.join(f.directory, "b".repeat(64) + ".sqlite");
      await fs.writeFile(unrelated, "other owner");
      const originals = new Map(
        await Promise.all(
          (await fs.readdir(f.directory))
            .filter((n) => n.startsWith(hash + "."))
            .map(async (n) => [n, await fs.readFile(path.join(f.directory, n))] as const)
        )
      );
      expect(originals.has(hash + ".sqlite-wal")).toBe(true);
      expect(originals.has(hash + ".sqlite-shm")).toBe(true);
      const snapshot = await retainNativeStorageBeforeErase(f),
        proof = await manifest(snapshot);
      expect(proof.identity.target).toEqual(f.target);
      expect(proof.identity.workspaceId).toBe(f.workspaceId);
      expect(proof.files).toHaveLength(originals.size);
      for (const entry of proof.files) {
        const bytes = await fs.readFile(path.join(snapshot, entry.name));
        expect(bytes).toEqual(originals.get(entry.name));
        expect(entry.sha256).toBe(sha(bytes));
        expect(entry.bytes).toBe(bytes.length);
      }
      // Query a reader copy; opening SQLite must not mutate immutable proof bytes.
      const read = path.join(f.root, "reader");
      await fs.cp(snapshot, read, { recursive: true });
      const db = new DatabaseSync(path.join(read, hash + ".sqlite"), { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT value FROM diagnostics").get()).toEqual({
          value: "prepared, no run or model capture",
        });
      } finally {
        db.close();
      }
      expect(await fs.readFile(unrelated, "utf8")).toBe("other owner");
    } finally {
      writer.close();
    }
  });
  it("keeps original hot-journal bytes while proving recovery in a disposable copy", async () => {
    const f = await fixture(),
      file = path.join(f.directory, hash + ".sqlite");
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=DELETE;CREATE TABLE diagnostic(value TEXT);INSERT INTO diagnostic VALUES ('committed');CREATE TABLE spill(value BLOB);PRAGMA cache_size=1;BEGIN IMMEDIATE;UPDATE diagnostic SET value='uncommitted';");
      const insert=db.prepare('INSERT INTO spill VALUES (?)');for(let i=0;i<32;i++)insert.run(Buffer.alloc(16384,i));
      process.kill(process.pid,'SIGKILL');
    `,
        file,
      ],
      { encoding: "utf8" }
    );
    expect(child.signal).toBe("SIGKILL");
    const raw = await fs.readFile(file),
      journal = await fs.readFile(file + "-journal");
    expect(journal.length).toBeGreaterThan(0);
    const snapshot = await retainNativeStorageBeforeErase({
      ...f,
      verifySqlite: async (paths) => {
        for (const file of paths) {
          const recovered = new DatabaseSync(file);
          try {
            expect(recovered.prepare("SELECT value FROM diagnostic").get()).toEqual({
              value: "committed",
            });
            expect(Object.values(recovered.prepare("PRAGMA integrity_check").get()!)).toEqual([
              "ok",
            ]);
          } finally {
            recovered.close();
          }
        }
      },
    });
    expect(await fs.readFile(file)).toEqual(raw);
    expect(await fs.readFile(file + "-journal")).toEqual(journal);
    expect(await fs.readFile(path.join(snapshot, hash + ".sqlite-journal"))).toEqual(journal);
  });

  it("publishes and reuses one immutable snapshot and rejects changed archive bytes", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.directory, hash + ".facets"), "native descriptor");
    const first = await retainNativeStorageBeforeErase(f);
    const second = await retainNativeStorageBeforeErase(f);
    expect(second).toBe(first);
    await fs.writeFile(path.join(first, hash + ".facets"), "tampered");
    await expect(retainNativeStorageBeforeErase(f)).rejects.toThrow("archive bytes changed");
    expect(await fs.readFile(path.join(f.directory, hash + ".facets"), "utf8")).toBe(
      "native descriptor"
    );
  });
  it("preserves all native files when verification fails before publication", async () => {
    const f = await fixture(),
      file = path.join(f.directory, hash + ".sqlite");
    await fs.writeFile(file, "incomplete native database");
    await expect(
      retainNativeStorageBeforeErase({
        ...f,
        verifySqlite: async () => {
          throw Error("database validation failed");
        },
      })
    ).rejects.toThrow("database validation failed");
    expect(await fs.readFile(file, "utf8")).toBe("incomplete native database");
    const owners = await fs.readdir(f.archiveRoot);
    expect(await fs.readdir(path.join(f.archiveRoot, owners[0]!))).toEqual([]);
  });
  it("detects source mutation during verification and does not publish misleading bytes", async () => {
    const f = await fixture(),
      file = path.join(f.directory, hash + ".facets");
    await fs.writeFile(file, "old");
    await expect(
      retainNativeStorageBeforeErase({
        ...f,
        verifySqlite: async () => {
          await fs.writeFile(file, "new");
        },
      })
    ).rejects.toThrow("source bytes changed");
    expect(await fs.readFile(file, "utf8")).toBe("new");
  });
  it("refuses native symlinks and records a no-files owner without inventing state", async () => {
    const f = await fixture(),
      foreign = path.join(f.root, "foreign");
    await fs.writeFile(foreign, "secret");
    await fs.symlink(foreign, path.join(f.directory, hash + ".sqlite"));
    await expect(retainNativeStorageBeforeErase(f)).rejects.toThrow("regular file");
    expect(await fs.readFile(foreign, "utf8")).toBe("secret");
    await fs.unlink(path.join(f.directory, hash + ".sqlite"));
    const empty = await retainNativeStorageBeforeErase(f);
    expect((await manifest(empty)).files).toEqual([]);
  });
});
