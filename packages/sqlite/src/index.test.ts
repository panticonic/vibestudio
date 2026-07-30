import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  openCanonicalSqliteDatabase,
  type CanonicalSqliteSchema,
} from "./index.js";

const SCHEMA: CanonicalSqliteSchema = {
  version: 9,
  objects: [
    {
      type: "table",
      name: "notes",
      sql: `CREATE TABLE notes (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL
      )`,
    },
    {
      type: "index",
      name: "notes_by_body",
      sql: "CREATE INDEX notes_by_body ON notes(body)",
    },
  ],
};

function memoryDatabase(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

describe("openCanonicalSqliteDatabase", () => {
  it("initializes a truly empty database at the exact current schema", () => {
    const db = memoryDatabase();
    expect(openCanonicalSqliteDatabase(db, SCHEMA, { description: "test database" })).toEqual({
      kind: "initialized",
      version: 9,
    });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
    db.close();
  });

  it("accepts the exact current schema without rewriting it", () => {
    const db = memoryDatabase();
    openCanonicalSqliteDatabase(db, SCHEMA, { description: "test database" });
    db.prepare("INSERT INTO notes(id, body) VALUES (?, ?)").run(1, "kept");

    expect(openCanonicalSqliteDatabase(db, SCHEMA, { description: "test database" })).toEqual({
      kind: "current",
      version: 9,
    });
    expect(db.prepare("SELECT body FROM notes WHERE id = 1").get()).toEqual({ body: "kept" });
    db.close();
  });

  it("validates the exact current schema for a read-only owner", () => {
    const db = memoryDatabase();
    openCanonicalSqliteDatabase(db, SCHEMA, { description: "test database" });
    expect(
      openCanonicalSqliteDatabase(db, SCHEMA, {
        description: "test database",
        readOnly: true,
      })
    ).toEqual({ kind: "current", version: 9 });
    db.close();
  });

  it("refuses to initialize for a read-only owner", () => {
    const db = memoryDatabase();
    expect(() =>
      openCanonicalSqliteDatabase(db, SCHEMA, {
        description: "test database",
        readOnly: true,
      })
    ).toThrow("a read-only owner cannot initialize");
    db.close();
  });

  it.each([8, 10])("rejects schema version %s without changing it", (version) => {
    const db = memoryDatabase();
    db.exec(SCHEMA.objects[0]!.sql);
    db.exec(SCHEMA.objects[1]!.sql);
    db.exec(`PRAGMA user_version = ${version}`);

    expect(() =>
      openCanonicalSqliteDatabase(db, SCHEMA, { description: "test database" })
    ).toThrow(`schema version is ${version}, expected 9`);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
    db.close();
  });

  it("rejects a non-canonical object set at the current version", () => {
    const db = memoryDatabase();
    db.exec(SCHEMA.objects[0]!.sql);
    db.exec("PRAGMA user_version = 9");

    expect(() =>
      openCanonicalSqliteDatabase(db, SCHEMA, { description: "test database" })
    ).toThrow("schema object set is not canonical");
    db.close();
  });

  it("rejects a dropped historical database instead of repurposing it", () => {
    const db = memoryDatabase();
    db.exec("CREATE TABLE discarded(value TEXT)");
    db.exec("INSERT INTO discarded(value) VALUES ('history')");
    db.exec("DROP TABLE discarded");

    expect(() =>
      openCanonicalSqliteDatabase(db, SCHEMA, { description: "test database" })
    ).toThrow("schema version is 0, expected 9");
    db.close();
  });

  it("rejects invalid current schema declarations", () => {
    const db = memoryDatabase();
    expect(() =>
      openCanonicalSqliteDatabase(
        db,
        { version: 0, objects: [] },
        { description: "test database" }
      )
    ).toThrow("schema version must be a positive safe integer");
    db.close();
  });
});
