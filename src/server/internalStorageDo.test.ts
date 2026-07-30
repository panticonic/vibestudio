import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { DurableObjectBase, rpc } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";

class ExactSchemaProbeDO extends DurableObjectBase {
  static override schemaVersion = 2;

  protected createTables(): void {
    this.sql.exec(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY, payload TEXT)`);
  }

  protected override requiredTables(): readonly string[] {
    return ["epoch_rows"];
  }

  @rpc({
    effect: {
      kind: "host-capability",
      capability: "test.storage.read",
      resource: { kind: "receiver-object" },
    },
    tier: "gated",
    principals: ["host"],
    sensitivity: "read",
  })
  countRows(): number {
    return (this.sql.exec(`SELECT COUNT(*) as count FROM epoch_rows`).one() as { count: number })
      .count;
  }
}

describe("DurableObjectBase exact schema identity", () => {
  it("creates only the current schema on a fresh database", async () => {
    const { call, sql } = await createTestDO(ExactSchemaProbeDO);
    expect(await call("countRows")).toBe(0);
    expect(sql.exec(`SELECT singleton, version FROM _vibestudio_schema`).one()).toEqual({
      singleton: 1,
      version: 2,
    });
    expect(sql.exec(`SELECT 1 FROM state WHERE key = 'schema_version'`).toArray()).toEqual([]);
  });

  it("rejects a non-current schema identity", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(
      `CREATE TABLE _vibestudio_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      )`
    );
    db.run(`INSERT INTO _vibestudio_schema (singleton, version) VALUES (1, 1)`);
    db.run(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY, payload TEXT)`);
    const { call } = await createTestDO(ExactSchemaProbeDO, undefined, { db });
    await expect(call("countRows")).rejects.toThrow(/does not match the current exact format/);
  });
});
