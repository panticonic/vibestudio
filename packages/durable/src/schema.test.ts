import { describe, expect, it } from "vitest";
import { createInMemorySql } from "./test-utils.js";
import {
  DurableObjectSchemaError,
  durableObjectSchemaDescriptor,
  durableObjectSchemaFingerprint,
  installDurableObjectSchema,
  installExactDurableObjectSchema,
} from "./schema.js";

function storage(sql: Awaited<ReturnType<typeof createInMemorySql>>) {
  return {
    sql,
    transactionSync: <T>(callback: () => T): T => sql.transactionSync(callback),
  };
}

describe("exact durable-object schema identity", () => {
  it("normalizes exact fixture keys and rejects reserved probe identities", async () => {
    const sql = await createInMemorySql();
    sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const definition = {
      className: "FixtureProbeDO",
      version: 1,
      productionBaseline: { version: 1, name: "fixture-v1" },
      storage: storage(sql),
      createSchema: () => undefined,
      validateSchema: () => undefined,
    };
    expect(durableObjectSchemaDescriptor(definition, [" b ", "a", "a"]).fixtureObjectKeys).toEqual([
      "a",
      "b",
    ]);
    expect(() =>
      durableObjectSchemaDescriptor(definition, ["__vibestudio_schema_probe:forbidden"])
    ).toThrow(/invalid schema fixture object key/u);
  });

  it("ignores lazy and user-owned tables while retaining implementation drift checks", async () => {
    const sql = await createInMemorySql();
    const definition = {
      className: "EvalProbeDO",
      version: 1,
      productionBaseline: { version: 1, name: "eval-probe-v1" },
      storage: storage(sql),
      schemaTables: ["runs"],
      createSchema: () => {
        sql.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY)");
      },
      validateSchema: () => undefined,
    };

    installExactDurableObjectSchema(definition);
    sql.exec("CREATE TABLE repl_scopes (id TEXT PRIMARY KEY)");
    sql.exec("CREATE TABLE user_data (value TEXT)");

    expect(() => installExactDurableObjectSchema(definition)).not.toThrow();
  });

  it("still rejects a changed implementation-owned table", async () => {
    const sql = await createInMemorySql();
    const definition = {
      className: "DriftProbeDO",
      version: 1,
      productionBaseline: { version: 1, name: "drift-probe-v1" },
      storage: storage(sql),
      schemaTables: ["runs"],
      createSchema: () => {
        sql.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY)");
      },
      validateSchema: () => undefined,
    };

    installExactDurableObjectSchema(definition);
    sql.exec("DROP TABLE runs");
    sql.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY, changed INTEGER)");

    expect(() => installExactDurableObjectSchema(definition)).toThrow(DurableObjectSchemaError);
    try {
      installExactDurableObjectSchema(definition);
    } catch (error) {
      expect(error).toMatchObject({
        code: "DO_SCHEMA_INCOMPATIBLE",
        errorKind: "service",
        errorData: { reason: "shape-drift", persistedVersion: 1, targetVersion: 1 },
      });
    }
  });

  it("runs a contiguous migration and records its stable name", async () => {
    const sql = await createInMemorySql();
    installDurableObjectSchema({
      className: "ItemsDO",
      version: 1,
      productionBaseline: { version: 1, name: "items-v1" },
      storage: storage(sql),
      schemaTables: ["items"],
      createSchema: () => sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)"),
      validateSchema: () => undefined,
    });

    installDurableObjectSchema({
      className: "ItemsDO",
      version: 2,
      productionBaseline: { version: 1, name: "items-v1" },
      migrations: [
        {
          version: 2,
          name: "add-archived",
          validateSource: (source) => {
            expect(source.exec("PRAGMA table_info(items)").toArray()).toHaveLength(1);
          },
          migrate: (target) =>
            target.exec("ALTER TABLE items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"),
        },
      ],
      storage: storage(sql),
      schemaTables: ["items"],
      createSchema: () =>
        sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)"),
      validateSchema: () => {
        expect(sql.exec("PRAGMA table_info(items)").toArray()).toHaveLength(2);
      },
    });

    expect(
      sql.exec("SELECT version, name FROM _vibestudio_schema_migrations ORDER BY version").toArray()
    ).toEqual([
      { version: 1, name: "fresh-install:items-v1" },
      { version: 2, name: "add-archived" },
    ]);
    expect(sql.exec("SELECT version FROM _vibestudio_schema").one()).toEqual({ version: 2 });
  });

  it("treats ledger rows at or below a raised baseline as history, not drift", async () => {
    const sql = await createInMemorySql();
    const v1 = {
      className: "RaisedDO",
      version: 1,
      productionBaseline: { version: 1, name: "raised-v1" },
      storage: storage(sql),
      schemaTables: ["items"],
      createSchema: () => {
        sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
      },
      validateSchema: () => undefined,
    };
    installDurableObjectSchema(v1);
    installDurableObjectSchema({
      ...v1,
      version: 2,
      migrations: [
        {
          version: 2,
          name: "add-archived",
          validateSource: () => undefined,
          migrate: (target) => {
            target.exec("ALTER TABLE items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
            return undefined;
          },
        },
      ],
      createSchema: () => {
        sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)");
      },
    });

    // A later build raises the baseline to v2 and retires the 1→2 migration.
    // The migrated database's historical ledger rows (v1 baseline, v2 step)
    // stay valid without matching definitions.
    const raised = {
      ...v1,
      version: 2,
      productionBaseline: { version: 2, name: "raised-v2" },
      createSchema: () => {
        sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)");
      },
    };
    expect(() => installDurableObjectSchema(raised)).not.toThrow();

    // A database still below the raised baseline is rejected intact.
    const behind = await createInMemorySql();
    installDurableObjectSchema({
      ...v1,
      storage: storage(behind),
      createSchema: () => {
        behind.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
      },
    });
    expect(() =>
      installDurableObjectSchema({
        ...raised,
        storage: storage(behind),
        createSchema: () => {
          behind.exec(
            "CREATE TABLE items (id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)"
          );
        },
      })
    ).toThrow(DurableObjectSchemaError);
  });

  it("fails closed when a migration step is missing", async () => {
    const sql = await createInMemorySql();
    installDurableObjectSchema({
      className: "MissingDO",
      version: 1,
      productionBaseline: { version: 1, name: "missing-v1" },
      storage: storage(sql),
      createSchema: () => sql.exec("CREATE TABLE items (id TEXT)"),
      validateSchema: () => undefined,
    });
    expect(() =>
      installDurableObjectSchema({
        className: "MissingDO",
        version: 2,
        productionBaseline: { version: 1, name: "missing-v1" },
        storage: storage(sql),
        createSchema: () => undefined,
        validateSchema: () => undefined,
      })
    ).toThrow(/must declare every version from 2 through 2/);
  });

  it("rolls back a failed migration including its ledger row", async () => {
    const sql = await createInMemorySql();
    const v1 = {
      className: "RollbackDO",
      version: 1,
      productionBaseline: { version: 1, name: "rollback-v1" },
      storage: storage(sql),
      schemaTables: ["items"],
      createSchema: () => sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY)`),
      validateSchema: () => undefined,
    } as const;
    installDurableObjectSchema(v1);
    expect(() =>
      installDurableObjectSchema({
        ...v1,
        version: 2,
        migrations: [
          {
            version: 2,
            name: "broken-step",
            validateSource: () => undefined,
            migrate: (target) => {
              target.exec(`ALTER TABLE items ADD COLUMN changed INTEGER`);
              throw new Error("injected failure");
            },
          },
        ],
      })
    ).toThrow(DurableObjectSchemaError);
    expect(
      sql
        .exec(`PRAGMA table_info(items)`)
        .toArray()
        .map((row) => row["name"])
    ).toEqual(["id"]);
    expect(sql.exec(`SELECT version, name FROM _vibestudio_schema_migrations`).toArray()).toEqual([
      { version: 1, name: "fresh-install:rollback-v1" },
    ]);
  });

  it("adopts a healthy legacy fingerprint only when complete validation accepts indexes", async () => {
    const sql = await createInMemorySql();
    sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)`);
    sql.exec(`CREATE INDEX items_label_idx ON items(label)`);
    const legacyShape = JSON.stringify([
      {
        type: "table",
        name: "items",
        sql: "CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)",
      },
      {
        type: "table",
        name: "state",
        sql: "CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      },
    ]);
    sql.exec(
      `CREATE TABLE _vibestudio_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, shape_json TEXT NOT NULL)`
    );
    sql.exec(`INSERT INTO _vibestudio_schema VALUES (1, 1, ?)`, legacyShape);
    installDurableObjectSchema({
      className: "LegacyDO",
      version: 1,
      productionBaseline: { version: 1, name: "legacy-v1" },
      storage: storage(sql),
      schemaTables: ["items"],
      createSchema: () => undefined,
      validateSchema: () => {
        const named = sql
          .exec(`PRAGMA index_list(items)`)
          .toArray()
          .map((row) => row["name"])
          .filter((name) => name !== "sqlite_autoindex_items_1");
        if (named.join(",") !== "items_label_idx") throw new Error("unexpected items indexes");
      },
    });
    expect(sql.exec(`SELECT name FROM _vibestudio_schema_migrations`).one()).toEqual({
      name: "adopted:legacy-v1",
    });
  });

  it("rejects legacy adoption when the publication fingerprint exposes index drift", async () => {
    const fresh = await createInMemorySql();
    fresh.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    fresh.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)`);
    fresh.exec(`CREATE INDEX items_label_idx ON items(label)`);
    const expectedSchemaFingerprint = durableObjectSchemaFingerprint(fresh, ["items"]);

    const sql = await createInMemorySql();
    sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)`);
    const legacyShape = JSON.stringify([
      {
        type: "table",
        name: "items",
        sql: "CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)",
      },
      {
        type: "table",
        name: "state",
        sql: "CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      },
    ]);
    sql.exec(
      `CREATE TABLE _vibestudio_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, shape_json TEXT NOT NULL)`
    );
    sql.exec(`INSERT INTO _vibestudio_schema VALUES (1, 1, ?)`, legacyShape);

    expect(() =>
      installDurableObjectSchema({
        className: "LegacyDriftDO",
        version: 1,
        productionBaseline: { version: 1, name: "legacy-drift-v1" },
        storage: storage(sql),
        schemaTables: ["items"],
        expectedSchemaFingerprint,
        createSchema: () => undefined,
        validateSchema: () => undefined,
      })
    ).toThrow(/probed fresh schema/);
    expect(
      sql
        .exec(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_vibestudio_schema_migrations'`
        )
        .toArray()
    ).toEqual([]);
  });

  it("rejects async migration callbacks before they can mutate storage", async () => {
    const sql = await createInMemorySql();
    installDurableObjectSchema({
      className: "AsyncDO",
      version: 1,
      productionBaseline: { version: 1, name: "async-v1" },
      storage: storage(sql),
      schemaTables: ["items"],
      createSchema: () => sql.exec(`CREATE TABLE items (id TEXT PRIMARY KEY)`),
      validateSchema: () => undefined,
    });
    let failure: unknown;
    try {
      installDurableObjectSchema({
        className: "AsyncDO",
        version: 2,
        productionBaseline: { version: 1, name: "async-v1" },
        storage: storage(sql),
        schemaTables: ["items"],
        migrations: [
          {
            version: 2,
            name: "async-step",
            validateSource: () => undefined,
            migrate: async (target) => {
              await Promise.resolve();
              target.exec(`ALTER TABLE items ADD COLUMN escaped INTEGER`);
            },
          },
        ],
        createSchema: () => undefined,
        validateSchema: () => undefined,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DurableObjectSchemaError);
    expect((failure as Error).cause).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/must not be an async function/) })
    );
    await Promise.resolve();
    expect(
      sql
        .exec(`PRAGMA table_info(items)`)
        .toArray()
        .map((row) => row["name"])
    ).toEqual(["id"]);
  });

  it("rejects unversioned persistence and newer persisted versions intact", async () => {
    const unversioned = await createInMemorySql();
    unversioned.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    expect(() =>
      installDurableObjectSchema({
        className: "UnversionedDO",
        version: 1,
        productionBaseline: { version: 1, name: "unversioned-v1" },
        storage: storage(unversioned),
        createSchema: () => undefined,
        validateSchema: () => undefined,
      })
    ).toThrow(/no schema identity/);

    const future = await createInMemorySql();
    installDurableObjectSchema({
      className: "FutureDO",
      version: 2,
      productionBaseline: { version: 2, name: "future-v2" },
      storage: storage(future),
      createSchema: () => future.exec(`CREATE TABLE data (id TEXT)`),
      validateSchema: () => undefined,
    });
    expect(() =>
      installDurableObjectSchema({
        className: "FutureDO",
        version: 1,
        productionBaseline: { version: 1, name: "future-v1" },
        storage: storage(future),
        createSchema: () => undefined,
        validateSchema: () => undefined,
      })
    ).toThrow(/newer than this build/);
    expect(future.exec(`SELECT version FROM _vibestudio_schema`).one()).toEqual({ version: 2 });
  });
});
