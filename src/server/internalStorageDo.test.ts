import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { DurableObjectBase, rpc } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";

class ExactSchemaProbeDO extends DurableObjectBase {
  protected schemaProductionBaseline() {
    return { version: 2, name: "exact-schema-probe-v2" } as const;
  }
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
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).toArray()).toEqual([
      { value: "2" },
    ]);
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
    const { call } = await createTestDO(ExactSchemaProbeDO, undefined, {
      db,
      initialize: false,
    });
    await expect(call("countRows")).rejects.toThrow(/schema identity table is malformed/);
  });

  it("returns a correlated structured schema error envelope from __rpc", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`CREATE TABLE _vibestudio_schema (singleton INTEGER PRIMARY KEY, version INTEGER)`);
    db.run(`INSERT INTO _vibestudio_schema (singleton, version) VALUES (1, 1)`);
    const { instance } = await createTestDO(ExactSchemaProbeDO, undefined, {
      db,
      initialize: false,
    });
    const response = await instance.fetch(
      new Request("http://test/test-key/__rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "main",
          target: "do:test:TestDO:test-key",
          delivery: { caller: { callerId: "main", callerKind: "server" } },
          provenance: [],
          message: {
            type: "request",
            requestId: "schema-product-1",
            fromId: "main",
            method: "countRows",
            args: [],
          },
        }),
      })
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      message: {
        type: "response",
        requestId: "schema-product-1",
        errorKind: "service",
        errorCode: "DO_SCHEMA_INCOMPATIBLE",
        errorData: {
          reason: "ledger-drift",
          source: "test",
          className: "TestDO",
          objectKey: "test-key",
        },
      },
    });
  });
});
