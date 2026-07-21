import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  openCanonicalSqliteDatabase,
  type CanonicalSqliteMigrationPlan,
  type CanonicalSqliteSchema,
} from "./index.js";

const PARENT_V7_SQL = `CREATE TABLE parent_records (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('a', 'b'))
)`;
// Exact text emitted by SQLite after the v7 ALTER TABLE. Keeping this as the
// canonical v8/current CREATE form makes fresh and upgraded files identical.
const PARENT_V8_SQL =
  "CREATE TABLE parent_records (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('a', 'b')), note TEXT)";
const CHILD_SQL = `CREATE TABLE child_records (
  id INTEGER PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES parent_records(id) ON DELETE CASCADE
)`;
const INDEX_SQL =
  "CREATE INDEX child_records_by_parent ON child_records(parent_id DESC) WHERE id > 0";
const SLUG_INDEX_SQL = "CREATE INDEX parent_records_by_slug ON parent_records(slug)";

const V7: CanonicalSqliteSchema = {
  version: 7,
  objects: [
    { type: "table", name: "parent_records", sql: PARENT_V7_SQL },
    { type: "table", name: "child_records", sql: CHILD_SQL },
    { type: "index", name: "child_records_by_parent", sql: INDEX_SQL },
  ],
};
const V8: CanonicalSqliteSchema = {
  version: 8,
  objects: [
    { type: "table", name: "parent_records", sql: PARENT_V8_SQL },
    { type: "table", name: "child_records", sql: CHILD_SQL },
    { type: "index", name: "child_records_by_parent", sql: INDEX_SQL },
  ],
};
const V9: CanonicalSqliteSchema = {
  version: 9,
  objects: [...V8.objects, { type: "index", name: "parent_records_by_slug", sql: SLUG_INDEX_SQL }],
};

const PLAN: CanonicalSqliteMigrationPlan = {
  current: V9,
  migrations: [
    {
      name: "add-parent-note",
      from: V7,
      to: V8,
      migrate(db) {
        db.exec("ALTER TABLE parent_records ADD COLUMN note TEXT");
      },
    },
    {
      name: "index-parent-slugs",
      from: V8,
      to: V9,
      migrate(db) {
        db.exec(SLUG_INDEX_SQL);
      },
    },
  ],
};

describe("canonical SQLite migration lifecycle", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function databasePath(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-sqlite-schema-"));
    roots.push(root);
    return path.join(root, "state.db");
  }

  function seedV7(file: string): void {
    const db = new DatabaseSync(file);
    db.exec(PARENT_V7_SQL);
    db.exec(CHILD_SQL);
    db.exec(INDEX_SQL);
    db.exec("PRAGMA user_version = 7");
    db.prepare("INSERT INTO parent_records (id, slug, kind) VALUES (?, ?, ?)").run(
      "preserved",
      "keep-me",
      "a"
    );
    db.prepare("INSERT INTO child_records (id, parent_id) VALUES (?, ?)").run(1, "preserved");
    db.close();
  }

  it("creates the current schema directly for a genuinely new database", () => {
    const db = new DatabaseSync(databasePath());
    expect(openCanonicalSqliteDatabase(db, PLAN, { description: "test database" })).toEqual({
      kind: "initialized",
      version: 9,
    });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    expect(db.prepare("PRAGMA table_info(parent_records)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "note" })])
    );
    db.close();
  });

  it("runs a named contiguous chain atomically and preserves domain rows", () => {
    const file = databasePath();
    seedV7(file);
    const db = new DatabaseSync(file);
    expect(openCanonicalSqliteDatabase(db, PLAN, { description: "test database" })).toEqual({
      kind: "migrated",
      fromVersion: 7,
      version: 9,
      migrations: ["add-parent-note", "index-parent-slugs"],
    });
    expect(db.prepare("SELECT * FROM parent_records").all()).toEqual([
      { id: "preserved", slug: "keep-me", kind: "a", note: null },
    ]);
    expect(db.prepare("SELECT * FROM child_records").all()).toEqual([
      { id: 1, parent_id: "preserved" },
    ]);
    db.close();
  });

  it("rechecks under the write lock when a concurrent owner wins migration", async () => {
    const file = databasePath();
    seedV7(file);
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(workerData.file);
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("BEGIN IMMEDIATE");
        db.exec("ALTER TABLE parent_records ADD COLUMN note TEXT");
        db.exec(${JSON.stringify(SLUG_INDEX_SQL)});
        db.exec("PRAGMA user_version = 9");
        parentPort.postMessage("locked-and-migrated");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
          parentPort.postMessage("committed");
        }, 100);
      `,
      { eval: true, workerData: { file } }
    );
    const exited = once(worker, "exit");
    await once(worker, "message");

    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000");
    expect(openCanonicalSqliteDatabase(db, PLAN, { description: "test database" })).toEqual({
      kind: "current",
      version: 9,
    });
    db.close();
    await exited;
  });

  it("rolls back schema, data, and version when a later migration fails", () => {
    const file = databasePath();
    seedV7(file);
    const failing: CanonicalSqliteMigrationPlan = {
      ...PLAN,
      migrations: [
        PLAN.migrations![0]!,
        {
          ...PLAN.migrations![1]!,
          migrate(db) {
            db.exec(SLUG_INDEX_SQL);
            db.prepare("UPDATE parent_records SET note = ?").run("must-roll-back");
            throw new Error("injected migration failure");
          },
        },
      ],
    };
    const db = new DatabaseSync(file);
    expect(() =>
      openCanonicalSqliteDatabase(db, failing, { description: "test database" })
    ).toThrow(/injected migration failure/);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(db.prepare("PRAGMA table_info(parent_records)").all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "note" })])
    );
    expect(db.prepare("SELECT * FROM parent_records").all()).toEqual([
      { id: "preserved", slug: "keep-me", kind: "a" },
    ]);
    db.close();
  });

  it("rejects thenable migrations and rolls back their synchronous work", () => {
    const file = databasePath();
    seedV7(file);
    const thenablePlan: CanonicalSqliteMigrationPlan = {
      current: V8,
      migrations: [
        {
          ...PLAN.migrations![0]!,
          migrate(db): undefined {
            db.exec("ALTER TABLE parent_records ADD COLUMN note TEXT");
            return Promise.resolve() as unknown as undefined;
          },
        },
      ],
    };
    const db = new DatabaseSync(file);
    expect(() =>
      openCanonicalSqliteDatabase(db, thenablePlan, { description: "test database" })
    ).toThrow(/must be synchronous and return undefined/);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(db.prepare("PRAGMA table_info(parent_records)").all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "note" })])
    );
    db.close();
  });

  it("rolls back when a migration does not produce its declared target", () => {
    const file = databasePath();
    seedV7(file);
    const invalidOutputPlan: CanonicalSqliteMigrationPlan = {
      current: V8,
      migrations: [
        {
          ...PLAN.migrations![0]!,
          migrate() {
            return undefined;
          },
        },
      ],
    };
    const db = new DatabaseSync(file);
    expect(() =>
      openCanonicalSqliteDatabase(db, invalidOutputPlan, { description: "test database" })
    ).toThrow(/table:parent_records definition is not canonical/);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    db.close();
  });

  it("rejects malformed source schemas before migration without repairing them", () => {
    const file = databasePath();
    seedV7(file);
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE extension_owned_data (value TEXT NOT NULL)");
    const before = fs.readFileSync(file);
    expect(() => openCanonicalSqliteDatabase(db, PLAN, { description: "test database" })).toThrow(
      /unexpected \[table:extension_owned_data\]/
    );
    db.close();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("rejects altered constraints and index semantics in a current-version database", () => {
    const variants = [
      {
        parent: PARENT_V8_SQL.replace("CHECK(kind IN ('a', 'b'))", "CHECK(kind IN ('a', 'c'))"),
        child: CHILD_SQL,
        index: INDEX_SQL,
        slugIndex: SLUG_INDEX_SQL,
      },
      {
        parent: PARENT_V8_SQL,
        child: CHILD_SQL.replace("ON DELETE CASCADE", "ON DELETE RESTRICT"),
        index: INDEX_SQL,
        slugIndex: SLUG_INDEX_SQL,
      },
      {
        parent: PARENT_V8_SQL,
        child: CHILD_SQL,
        index: "CREATE INDEX child_records_by_parent ON child_records(parent_id ASC)",
        slugIndex: SLUG_INDEX_SQL,
      },
    ];
    for (const variant of variants) {
      const file = databasePath();
      const db = new DatabaseSync(file);
      db.exec(variant.parent);
      db.exec(variant.child);
      db.exec(variant.index);
      db.exec(variant.slugIndex);
      db.exec("PRAGMA user_version = 9");
      const before = fs.readFileSync(file);
      expect(() => openCanonicalSqliteDatabase(db, PLAN, { description: "test database" })).toThrow(
        /definition is not canonical/
      );
      db.close();
      expect(fs.readFileSync(file)).toEqual(before);
    }
  });

  it("rejects pre-baseline and future versions with explicit no-loss diagnostics", () => {
    for (const version of [6, 10]) {
      const file = databasePath();
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE unknown_state (value TEXT NOT NULL)");
      db.prepare("INSERT INTO unknown_state VALUES (?)").run("keep-me");
      db.exec(`PRAGMA user_version = ${version}`);
      const before = fs.readFileSync(file);
      expect(() => openCanonicalSqliteDatabase(db, PLAN, { description: "test database" })).toThrow(
        version === 6 ? /predates production baseline 7/ : /newer than supported version 9/
      );
      db.close();
      expect(fs.readFileSync(file)).toEqual(before);
    }
  });

  it("does not mistake a dropped historical database for a new database", () => {
    const file = databasePath();
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE old_state (value TEXT NOT NULL)");
    db.prepare("INSERT INTO old_state VALUES (?)").run("retired-data");
    db.exec("DROP TABLE old_state");
    expect(Number(db.prepare("PRAGMA page_count").get()?.["page_count"])).toBeGreaterThan(0);
    expect(() => openCanonicalSqliteDatabase(db, PLAN, { description: "test database" })).toThrow(
      /predates production baseline 7/
    );
    db.close();
  });

  it("makes read-only ownership validation-only", () => {
    const file = databasePath();
    seedV7(file);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA query_only = ON");
    expect(() =>
      openCanonicalSqliteDatabase(db, PLAN, { description: "test database", readOnly: true })
    ).toThrow(/schema version 7 requires migration to 9, but a read-only owner cannot migrate it/);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    db.close();
  });

  it("rejects non-contiguous or incomplete plans before touching the database", () => {
    const db = new DatabaseSync(databasePath());
    expect(() =>
      openCanonicalSqliteDatabase(
        db,
        { current: V9, migrations: [PLAN.migrations![1]!, PLAN.migrations![0]!] },
        { description: "test database" }
      )
    ).toThrow(/does not continue/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get()).toEqual({ count: 0 });
    db.close();
  });
});
