import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";

import { DurableObjectBase, rpc } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";

class SchemaEpochProbeDO extends DurableObjectBase {
  static override schemaVersion = 2;

  protected createTables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS epoch_rows (id TEXT PRIMARY KEY)`);
  }

  protected override requiredTables(): readonly string[] {
    return ["epoch_rows"];
  }

  @rpc
  countRows(): number {
    return (this.sql.exec(`SELECT COUNT(*) as count FROM epoch_rows`).one() as { count: number })
      .count;
  }
}

describe("DurableObjectBase schema epochs", () => {
  it("initializes and stamps the exact current schema", async () => {
    const { call, sql } = await createTestDO(SchemaEpochProbeDO);

    expect(await call("countRows")).toBe(0);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
  });

  it("replaces an older epoch wholesale before recording the current epoch", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["1"]);
    db.run(`INSERT INTO state (key, value) VALUES ('application-state', 'obsolete')`);
    db.run(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY)`);
    db.run(`INSERT INTO epoch_rows (id) VALUES ('old-row')`);
    db.run(`CREATE TABLE retired_shape (id TEXT PRIMARY KEY)`);
    db.run(`CREATE VIEW retired_view AS SELECT id FROM retired_shape`);

    const { call, sql } = await createTestDO(SchemaEpochProbeDO, undefined, { db });

    expect(await call("countRows")).toBe(0);
    expect(
      sql
        .exec(`SELECT name FROM sqlite_master WHERE name IN ('retired_shape', 'retired_view')`)
        .toArray()
    ).toEqual([]);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'application-state'`).toArray()).toEqual(
      []
    );
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
  });

  it("repairs a current-version schema that is missing required idempotent tables", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["2"]);

    const { call, sql } = await createTestDO(SchemaEpochProbeDO, undefined, { db });

    expect(await call("countRows")).toBe(0);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
  });

  it("rejects persisted schemas newer than the running code supports", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["3"]);

    const { call } = await createTestDO(SchemaEpochProbeDO, undefined, { db });

    await expect(call("countRows")).rejects.toThrow(/newer than supported version 2/);
  });
});
