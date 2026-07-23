import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";

import { DurableObjectBase, rpc, type DurableObjectSchemaMigration } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";

class SchemaEpochProbeDO extends DurableObjectBase {
  static override schemaVersion = 2;

  protected createTables(): void {
    this.sql.exec(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY, payload TEXT)`);
  }

  protected override schemaMigrations(): readonly DurableObjectSchemaMigration[] {
    return [
      {
        version: 2,
        name: "add-epoch-row-payload",
        validateSource: (sql) => {
          const columns = sql.exec(`PRAGMA table_info(epoch_rows)`).toArray();
          if (columns.length !== 1 || columns[0]?.["name"] !== "id" || columns[0]?.["pk"] !== 1) {
            throw new Error("epoch_rows does not match the exact v1 shape");
          }
        },
        migrate: (sql) => sql.exec(`ALTER TABLE epoch_rows ADD COLUMN payload TEXT`),
      },
    ];
  }

  protected override requiredTables(): readonly string[] {
    return ["epoch_rows"];
  }

  protected override validateSchema(): void {
    super.validateSchema();
    if (
      !this.sql
        .exec(`PRAGMA table_info(epoch_rows)`)
        .toArray()
        .some((column) => column["name"] === "payload")
    ) {
      throw new Error("SchemaEpochProbeDO schema validation failed: epoch_rows.payload is missing");
    }
  }

  @rpc({
    effect: { kind: "semantic", capability: "test.storage.read" },
    tier: "gated",
    principals: ["host"],
    sensitivity: "read",
  })
  countRows(): number {
    return (this.sql.exec(`SELECT COUNT(*) as count FROM epoch_rows`).one() as { count: number })
      .count;
  }
}

describe("DurableObjectBase schema migrations", () => {
  it("creates the current schema directly on a fresh install", async () => {
    const { call, sql } = await createTestDO(SchemaEpochProbeDO);

    expect(await call("countRows")).toBe(0);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
    expect(sql.exec(`SELECT version, name FROM _vibestudio_schema_migrations`).toArray()).toEqual([
      { version: 2, name: "fresh-install:schemaepochprobedo-production-baseline" },
    ]);
  });

  it("upgrades an older schema without deleting rows, unrelated tables, or state", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["1"]);
    db.run(`INSERT INTO state (key, value) VALUES ('application-state', 'preserved')`);
    db.run(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY)`);
    db.run(`INSERT INTO epoch_rows (id) VALUES ('old-row')`);
    db.run(`CREATE TABLE extension_owned_rows (id TEXT PRIMARY KEY)`);
    db.run(`INSERT INTO extension_owned_rows (id) VALUES ('keep-me')`);

    const { call, sql } = await createTestDO(SchemaEpochProbeDO, undefined, { db });

    expect(await call("countRows")).toBe(1);
    expect(sql.exec(`SELECT id, payload FROM epoch_rows`).toArray()).toEqual([
      { id: "old-row", payload: null },
    ]);
    expect(sql.exec(`SELECT * FROM extension_owned_rows`).toArray()).toEqual([{ id: "keep-me" }]);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'application-state'`).one()).toEqual({
      value: "preserved",
    });
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
    expect(
      sql.exec(`SELECT version, name FROM _vibestudio_schema_migrations ORDER BY version`).toArray()
    ).toEqual([
      { version: 1, name: "adopted:schemaepochprobedo-production-baseline" },
      { version: 2, name: "add-epoch-row-payload" },
    ]);
  });

  it("rejects a malformed current schema instead of mutating it silently", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["2"]);

    const { call } = await createTestDO(SchemaEpochProbeDO, undefined, { db });

    await expect(call("countRows")).rejects.toThrow(/missing table\(s\): epoch_rows/);
  });

  it("rejects persisted schemas newer than the running code supports", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["3"]);

    const { call } = await createTestDO(SchemaEpochProbeDO, undefined, { db });

    await expect(call("countRows")).rejects.toThrow(/newer than supported version 2/);
  });

  it("rejects unversioned persistence instead of guessing its schema", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE unknown_rows (id TEXT PRIMARY KEY)`);

    const { call } = await createTestDO(SchemaEpochProbeDO, undefined, { db });

    await expect(call("countRows")).rejects.toThrow(/persisted data without a schema version/);
  });

  it("rejects an incomplete migration chain without changing the database", async () => {
    class MissingMigrationDO extends SchemaEpochProbeDO {
      protected override schemaMigrations(): readonly DurableObjectSchemaMigration[] {
        return [];
      }
    }
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', '1')`);
    db.run(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY)`);

    const { call, sql } = await createTestDO(MissingMigrationDO, undefined, { db });
    await expect(call("countRows")).rejects.toThrow(/predates production baseline 2/);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "1",
    });
  });

  it("rejects conflicting or non-contiguous migration metadata", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', '2')`);
    db.run(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY, payload TEXT)`);
    db.run(`
      CREATE TABLE _vibestudio_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO _vibestudio_schema_migrations (version, name, applied_at) VALUES (1, 'legacy-baseline', 1), (3, 'unknown-gap', 2)`
    );

    const { call } = await createTestDO(SchemaEpochProbeDO, undefined, { db });
    await expect(call("countRows")).rejects.toThrow(/migration ledger is not contiguous/);
  });

  it("rolls back an interrupted migration and retries from the last committed version", async () => {
    class FailingMigrationDO extends SchemaEpochProbeDO {
      protected override schemaMigrations(): readonly DurableObjectSchemaMigration[] {
        return [
          {
            version: 2,
            name: "failing-migration",
            validateSource: () => undefined,
            migrate: (sql) => {
              sql.exec(`INSERT INTO epoch_rows (id) VALUES ('partial')`);
              throw new Error("simulated interruption");
            },
          },
        ];
      }
    }

    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', '1')`);
    db.run(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY)`);

    const failed = await createTestDO(FailingMigrationDO, undefined, { db });
    await expect(failed.call("countRows")).rejects.toThrow(/simulated interruption/);
    expect(failed.sql.exec(`SELECT * FROM epoch_rows`).toArray()).toEqual([]);
    expect(failed.sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "1",
    });

    const retried = await createTestDO(SchemaEpochProbeDO, undefined, { db });
    await expect(retried.call("countRows")).resolves.toBe(0);
    expect(retried.sql.exec(`PRAGMA table_info(epoch_rows)`).toArray()).toContainEqual(
      expect.objectContaining({ name: "payload" })
    );
  });

  it("rejects source-shape drift before a migration can mutate the database", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', '1')`);
    db.run(`CREATE TABLE epoch_rows (id TEXT PRIMARY KEY, unexpected TEXT)`);
    db.run(`INSERT INTO epoch_rows (id, unexpected) VALUES ('preserved', 'drift')`);

    const { call, sql } = await createTestDO(SchemaEpochProbeDO, undefined, { db });

    await expect(call("countRows")).rejects.toThrow(/exact v1 shape/);
    expect(sql.exec(`PRAGMA table_info(epoch_rows)`).toArray()).toHaveLength(2);
    expect(sql.exec(`SELECT * FROM epoch_rows`).one()).toEqual({
      id: "preserved",
      unexpected: "drift",
    });
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "1",
    });
  });
});
