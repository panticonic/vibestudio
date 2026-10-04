import { describe, expect, it } from "vitest";
import { createInMemorySql } from "./test-utils.js";
import {
  DurableObjectSchemaError,
  durableObjectSchemaDescriptor,
  durableObjectSchemaFingerprint,
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
    storage: {
      sql,
      transaction: async (callback) => {
        sql.exec("SAVEPOINT schema_test");
        try {
          const result = await callback();
          sql.exec("RELEASE schema_test");
          return result;
        } catch (error) {
          sql.exec("ROLLBACK TO schema_test");
          sql.exec("RELEASE schema_test");
          throw error;
        }
      },
    },
    schemaTables: input.schemaTables ?? [table],
    createSchema: () => {
      sql.exec(`CREATE TABLE ${table} (${columns})`);
    },
    validateSchema: () => {
      if (sql.exec(`PRAGMA table_info(${table})`).toArray().length === 0) {
        throw new Error(`${table} is missing`);
      }
    },
  };
}

describe("current-only durable-object schema identity", () => {
  it("probes an upgrade-bearing fresh build but refuses a persisted upgrade without a trusted target", async () => {
    const source = await createInMemorySql();
    await installDurableObjectSchema(definition(source));
    source.exec("INSERT INTO items VALUES ('kept')");
    const oldShape = durableObjectSchemaFingerprint(source, ["items"]);
    let calls = 0;
    const upgrading = (sql: Sql) => ({
      ...definition(sql, { version: 2, columns: "id TEXT PRIMARY KEY, value TEXT" }),
      upgrades: [
        {
          fromVersion: 1,
          fromFingerprint: oldShape,
          upgrade: () => {
            calls++;
            sql.exec("ALTER TABLE items ADD COLUMN value TEXT");
          },
        },
      ],
    });
    const probe = await createInMemorySql();
    await installDurableObjectSchema(upgrading(probe));
    const descriptor = durableObjectSchemaDescriptor(upgrading(probe));
    expect(descriptor.version).toBe(2);
    expect(calls).toBe(0);
    await expect(installDurableObjectSchema(upgrading(source))).rejects.toThrow(
      "trusted target fingerprint"
    );
    expect(calls).toBe(0);
    expect(durableObjectSchemaFingerprint(source, ["items"])).toBe(oldShape);
    expect(source.exec("SELECT * FROM items").toArray()).toEqual([{ id: "kept" }]);
    await installDurableObjectSchema({
      ...upgrading(source),
      expectedFingerprint: descriptor.freshSchemaFingerprint,
    });
    expect(calls).toBe(1);
    expect(source.exec("SELECT * FROM items").toArray()).toEqual([{ id: "kept", value: null }]);
  });
  it("rolls back asynchronous dependency and domain initialization together", async () => {
    const sql = await createInMemorySql();
    const failure = new Error("domain failed");
    await expect(
      installDurableObjectSchema({
        ...definition(sql),
        createSchema: async () => {
          sql.exec("CREATE TABLE dependency (id TEXT PRIMARY KEY)");
          await Promise.resolve();
          sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([]);
    await installDurableObjectSchema(definition(sql));
  });

  it("admits only trusted source and target shapes and rolls back a failed upgrade", async () => {
    const sql = await createInMemorySql();
    await installDurableObjectSchema(definition(sql));
    sql.exec("INSERT INTO items VALUES ('retained')");
    const v1 = durableObjectSchemaFingerprint(sql, ["items"]);
    const probe = await createInMemorySql();
    await installDurableObjectSchema(
      definition(probe, { version: 2, columns: "id TEXT PRIMARY KEY, value TEXT" })
    );
    const v2 = durableObjectSchemaFingerprint(probe, ["items"]);
    let fail = true;
    const upgrade = {
      ...definition(sql, { version: 2, columns: "id TEXT PRIMARY KEY, value TEXT" }),
      expectedFingerprint: v2,
      upgrades: [
        {
          fromVersion: 1,
          fromFingerprint: v1,
          upgrade: async () => {
            sql.exec("ALTER TABLE items ADD COLUMN value TEXT");
            await Promise.resolve();
            if (fail) throw new Error("upgrade failed");
          },
        },
      ],
    };
    await expect(installDurableObjectSchema(upgrade)).rejects.toThrow("upgrade failed");
    expect(durableObjectSchemaFingerprint(sql, ["items"])).toBe(v1);
    expect(sql.exec("SELECT version FROM _vibestudio_schema").one()).toEqual({ version: 1 });
    fail = false;
    await installDurableObjectSchema(upgrade);
    expect(sql.exec("SELECT * FROM items").toArray()).toEqual([{ id: "retained", value: null }]);
    await installDurableObjectSchema(upgrade);
    await expect(installDurableObjectSchema(definition(sql))).rejects.toThrow(
      "no supported upgrade"
    );
  });

  it("rejects self-attested drift against the trusted build even if metadata is rewritten", async () => {
    const sql = await createInMemorySql();
    await installDurableObjectSchema(definition(sql));
    const fingerprint = durableObjectSchemaFingerprint(sql, ["items"]);
    sql.exec("ALTER TABLE items ADD COLUMN unexpected TEXT");
    sql.exec(
      "UPDATE _vibestudio_schema SET shape_json = ?",
      durableObjectSchemaFingerprint(sql, ["items"])
    );
    const before = sql.exec("SELECT * FROM _vibestudio_schema").toArray();
    await expect(
      installDurableObjectSchema({ ...definition(sql), expectedFingerprint: fingerprint })
    ).rejects.toBeInstanceOf(DurableObjectSchemaError);
    expect(sql.exec("SELECT * FROM _vibestudio_schema").toArray()).toEqual(before);
  });

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
    await installDurableObjectSchema(definition(sql, { version: 7 }));

    expect(sql.exec(`SELECT version FROM _vibestudio_schema`).one()).toEqual({ version: 7 });
    expect(
      sql
        .exec(`SELECT name FROM sqlite_master WHERE name='_vibestudio_schema_migrations'`)
        .toArray()
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
    await installDurableObjectSchema(current);
    sql.exec(`INSERT INTO items (id) VALUES ('kept')`);

    await expect(installDurableObjectSchema(current)).resolves.toBeUndefined();
    expect(sql.exec(`SELECT id FROM items`).toArray()).toEqual([{ id: "kept" }]);
  });

  it("ignores undeclared product tables but detects owned shape drift", async () => {
    const sql = await createInMemorySql();
    const current = definition(sql, { schemaTables: ["items"] });
    await installDurableObjectSchema(current);
    sql.exec(`CREATE TABLE unrelated (value TEXT)`);
    await expect(installDurableObjectSchema(current)).resolves.toBeUndefined();

    sql.exec(`DROP TABLE items`);
    sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, changed INTEGER)`);
    await expect(installDurableObjectSchema(current)).rejects.toBeInstanceOf(
      DurableObjectSchemaError
    );
    try {
      await installDurableObjectSchema(current);
    } catch (error) {
      expect(error).toMatchObject({
        code: "DO_SCHEMA_INCOMPATIBLE",
        errorData: { reason: "shape-drift", persistedVersion: 1, targetVersion: 1 },
      });
    }
  });

  it("rejects every different version unchanged", async () => {
    const sql = await createInMemorySql();
    await installDurableObjectSchema(definition(sql, { version: 2 }));
    sql.exec(`INSERT INTO items (id) VALUES ('kept')`);

    await expect(installDurableObjectSchema(definition(sql, { version: 3 }))).rejects.toThrow(
      /no supported upgrade from v2 to v3/u
    );
    expect(sql.exec(`SELECT version FROM _vibestudio_schema`).one()).toEqual({ version: 2 });
    expect(sql.exec(`SELECT id FROM items`).toArray()).toEqual([{ id: "kept" }]);
  });

  it("rejects nonempty unversioned storage without mutation", async () => {
    const sql = await createInMemorySql();
    sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY)`);
    await expect(installDurableObjectSchema(definition(sql))).rejects.toThrow(
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

    await expect(installDurableObjectSchema(definition(sql))).rejects.toThrow(
      /schema identity table is malformed/u
    );
    expect(
      sql
        .exec(`SELECT name FROM sqlite_master WHERE name='_vibestudio_schema_migrations'`)
        .toArray()
    ).toEqual([{ name: "_vibestudio_schema_migrations" }]);
  });

  it("rejects invalid current declarations before touching storage", async () => {
    const sql = await createInMemorySql();
    await expect(installDurableObjectSchema(definition(sql, { version: 0 }))).rejects.toThrow(
      /invalid schema version/u
    );
    expect(sql.exec(`SELECT name FROM sqlite_master`).toArray()).toEqual([]);
  });
});
