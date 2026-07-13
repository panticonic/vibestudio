import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCanonicalSqliteSchema,
  initializeCanonicalSqliteSchema,
  type CanonicalSqliteSchema,
} from "./index.js";

const PARENT_SQL = `CREATE TABLE parent_records (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('a', 'b'))
)`;
const CHILD_SQL = `CREATE TABLE child_records (
  id INTEGER PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES parent_records(id) ON DELETE CASCADE
)`;
const INDEX_SQL =
  "CREATE INDEX child_records_by_parent ON child_records(parent_id DESC) WHERE id > 0";

const SCHEMA: CanonicalSqliteSchema = {
  version: 7,
  objects: [
    { type: "table", name: "parent_records", sql: PARENT_SQL },
    { type: "table", name: "child_records", sql: CHILD_SQL },
    { type: "index", name: "child_records_by_parent", sql: INDEX_SQL },
  ],
};

describe("canonical SQLite schema cut", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function databasePath(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-sqlite-schema-"));
    roots.push(root);
    return path.join(root, "state.db");
  }

  function seed(
    file: string,
    input: { parent?: string; child?: string; index?: string; version?: number } = {}
  ): void {
    const db = new DatabaseSync(file);
    if (input.parent !== "") db.exec(input.parent ?? PARENT_SQL);
    if (input.child !== "") db.exec(input.child ?? CHILD_SQL);
    if (input.index !== "") db.exec(input.index ?? INDEX_SQL);
    db.exec(`PRAGMA user_version = ${input.version ?? SCHEMA.version}`);
    db.close();
  }

  function expectRejectedWithoutMutation(file: string): void {
    const before = fs.readFileSync(file);
    const db = new DatabaseSync(file);
    expect(() => assertCanonicalSqliteSchema(db, SCHEMA, "test schema")).toThrow(
      /Unsupported test schema/
    );
    db.close();
    expect(fs.readFileSync(file)).toEqual(before);
  }

  it("initializes only a truly empty database and stamps the exact version", () => {
    const file = databasePath();
    const db = new DatabaseSync(file);
    initializeCanonicalSqliteSchema(db, SCHEMA);
    expect(() => assertCanonicalSqliteSchema(db, SCHEMA, "test schema")).not.toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    db.close();
  });

  it("refuses to initialize nonempty state without changing it", () => {
    const file = databasePath();
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE old_state (value TEXT NOT NULL)");
    db.prepare("INSERT INTO old_state (value) VALUES (?)").run("keep-me");
    db.close();
    const before = fs.readFileSync(file);

    const reopened = new DatabaseSync(file);
    expect(() => initializeCanonicalSqliteSchema(reopened, SCHEMA)).toThrow(
      /Refusing to initialize a nonempty SQLite database/
    );
    reopened.close();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("does not mistake a dropped pre-cutover schema for a new database", () => {
    const file = databasePath();
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE old_state (value TEXT NOT NULL)");
    db.prepare("INSERT INTO old_state (value) VALUES (?)").run("retired-data");
    db.exec("DROP TABLE old_state");
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get()).toEqual({ count: 0 });
    expect(Number(db.prepare("PRAGMA page_count").get()?.["page_count"])).toBeGreaterThan(0);
    db.close();
    const before = fs.readFileSync(file);

    const reopened = new DatabaseSync(file);
    expect(() => initializeCanonicalSqliteSchema(reopened, SCHEMA)).toThrow(
      /Refusing to initialize a nonempty SQLite database/
    );
    reopened.close();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("rejects missing objects and every altered constraint/index semantic without mutation", () => {
    const variants: Array<NonNullable<Parameters<typeof seed>[1]>> = [
      { child: "", index: "" },
      {
        parent: PARENT_SQL.replace("id TEXT PRIMARY KEY", "id TEXT NOT NULL"),
      },
      {
        parent: PARENT_SQL.replace("slug TEXT NOT NULL UNIQUE", "slug TEXT NOT NULL"),
      },
      {
        parent: PARENT_SQL.replace("CHECK(kind IN ('a', 'b'))", "CHECK(kind IN ('a', 'c'))"),
      },
      {
        child: CHILD_SQL.replace("ON DELETE CASCADE", "ON DELETE RESTRICT"),
      },
      {
        index: "CREATE INDEX child_records_by_parent ON child_records(parent_id ASC)",
      },
      { version: 6 },
    ];

    for (const variant of variants) {
      const file = databasePath();
      seed(file, variant);
      expectRejectedWithoutMutation(file);
    }
  });
});
