import { describe, expect, it } from "vitest";
import { createInMemorySql } from "./test-utils.js";
import {
  DurableObjectSchemaError,
  durableObjectSchemaDescriptor,
  installDurableObjectSchema,
  type DurableObjectSchemaDefinition,
} from "./schema.js";

type Sql = Awaited<ReturnType<typeof createInMemorySql>>;

function definition(
  sql: Sql,
  input: {
    className?: string;
    version?: number;
    table?: string;
    columns?: string;
    schemaTables?: string[];
  } = {}
): DurableObjectSchemaDefinition {
  const table = input.table ?? "items";
  const columns = input.columns ?? "id TEXT PRIMARY KEY";
  return {
    className: input.className ?? "ItemsDO",
    version: input.version ?? 1,
    storage: { sql, transactionSync: (callback) => sql.transactionSync(callback) },
    schemaTables: input.schemaTables ?? [table],
    createSchema: () => sql.exec(`CREATE TABLE ${table} (${columns})`),
    validateSchema: () => {
      if (sql.exec(`PRAGMA table_info(${table})`).toArray().length === 0) {
        throw new Error(`${table} is missing`);
      }
    },
  };
}

describe("current-only durable-object schema identity", () => {
  it("describes only the exact fresh schema created by this build", async () => {
    const sql = await createInMemorySql();
    sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY)`);

    expect(durableObjectSchemaDescriptor(definition(sql))).toEqual({
      className: "ItemsDO",
      version: 1,
      freshSchemaFingerprint: expect.stringContaining('"name":"items"'),
    });
  });

  it("initializes truly empty storage at the exact current schema", async () => {
    const sql = await createInMemorySql();
    installDurableObjectSchema(definition(sql, { version: 7 }));

    expect(sql.exec(`SELECT version FROM _vibestudio_schema`).one()).toEqual({ version: 7 });
    expect(
      sql.exec(`SELECT name FROM sqlite_master WHERE name='_vibestudio_schema_migrations'`).toArray()
    ).toEqual([]);
    expect(
      sql
        .exec(`PRAGMA table_info(_vibestudio_schema)`)
        .toArray()
        .map((row) => row["name"])
    ).toEqual(["singleton", "version", "shape_json"]);
  });

  it("opens exact current storage without changing application rows", async () => {
    const sql = await createInMemorySql();
    const current = definition(sql);
    installDurableObjectSchema(current);
    sql.exec(`INSERT INTO items (id) VALUES ('kept')`);

    expect(() => installDurableObjectSchema(current)).not.toThrow();
    expect(sql.exec(`SELECT id FROM items`).toArray()).toEqual([{ id: "kept" }]);
  });

  it("ignores undeclared product tables but detects owned shape drift", async () => {
    const sql = await createInMemorySql();
    const current = definition(sql, { schemaTables: ["items"] });
    installDurableObjectSchema(current);
    sql.exec(`CREATE TABLE unrelated (value TEXT)`);
    expect(() => installDurableObjectSchema(current)).not.toThrow();

    sql.exec(`DROP TABLE items`);
    sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, changed INTEGER)`);
    expect(() => installDurableObjectSchema(current)).toThrow(DurableObjectSchemaError);
    try {
      installDurableObjectSchema(current);
    } catch (error) {
      expect(error).toMatchObject({
        code: "DO_SCHEMA_INCOMPATIBLE",
        errorData: { reason: "shape-drift", persistedVersion: 1, targetVersion: 1 },
      });
    }
  });

  it("rejects every different version unchanged", async () => {
    const sql = await createInMemorySql();
    installDurableObjectSchema(definition(sql, { version: 2 }));
    sql.exec(`INSERT INTO items (id) VALUES ('kept')`);

    expect(() => installDurableObjectSchema(definition(sql, { version: 3 }))).toThrow(
      /only exact current schema v3 is supported/u
    );
    expect(sql.exec(`SELECT version FROM _vibestudio_schema`).one()).toEqual({ version: 2 });
    expect(sql.exec(`SELECT id FROM items`).toArray()).toEqual([{ id: "kept" }]);
  });

  it("rejects nonempty unversioned storage without mutation", async () => {
    const sql = await createInMemorySql();
    sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY)`);
    expect(() => installDurableObjectSchema(definition(sql))).toThrow(
      /no current schema identity is recorded/u
    );
    expect(sql.exec(`PRAGMA table_info(items)`).toArray()).toHaveLength(1);
  });

  it("rejects the retired migration-ledger metadata shape", async () => {
    const sql = await createInMemorySql();
    sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY)`);
    sql.exec(`CREATE TABLE _vibestudio_schema (
      singleton INTEGER PRIMARY KEY,
      version INTEGER NOT NULL,
      installed_version INTEGER NOT NULL,
      shape_json TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE _vibestudio_schema_migrations (version INTEGER, name TEXT)`);
    sql.exec(`INSERT INTO _vibestudio_schema VALUES (1, 1, 1, 'retired')`);

    expect(() => installDurableObjectSchema(definition(sql))).toThrow(
      /schema identity table is malformed/u
    );
    expect(
      sql.exec(`SELECT name FROM sqlite_master WHERE name='_vibestudio_schema_migrations'`).toArray()
    ).toEqual([{ name: "_vibestudio_schema_migrations" }]);
  });

  it("rejects invalid current declarations before touching storage", async () => {
    const sql = await createInMemorySql();
    expect(() => installDurableObjectSchema(definition(sql, { version: 0 }))).toThrow(
      /invalid schema version/u
    );
    expect(sql.exec(`SELECT name FROM sqlite_master`).toArray()).toEqual([]);
  });
});
