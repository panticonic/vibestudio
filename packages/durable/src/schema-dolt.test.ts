import { describe, expect, it } from "vitest";
import { doltLocalPatterns } from "./dolt.js";
import {
  DurableObjectSchemaError,
  durableObjectSchemaFingerprint,
  installDurableObjectSchema,
  validateDurableObjectSchemaIndexes,
  type DurableObjectSchemaDefinition,
} from "./schema.js";
import { FakeDoltStorage } from "./test-dolt.js";
import { createInMemorySql } from "./test-utils.js";

const V1 =
  "CREATE TABLE items (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT 'x' CHECK (length(body) < 50))";
const V2 =
  "CREATE TABLE items (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT 'x' CHECK (length(body) < 50), tag TEXT)";
const INDEX = "CREATE INDEX items_body ON items (body)";

/** The fresh fingerprint a build trusts: taken by the isolated probe, on SQLite. */
async function trustedFingerprint(version: 1 | 2): Promise<string> {
  const sql = await createInMemorySql();
  sql.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sql.exec(version === 1 ? V1 : V2);
  sql.exec(INDEX);
  return durableObjectSchemaFingerprint(sql, ["items"]);
}

async function dolt(options: Parameters<typeof FakeDoltStorage.create>[0] = {}) {
  return FakeDoltStorage.create({ doltLocal: doltLocalPatterns(), ...options });
}

function definition(
  fake: FakeDoltStorage,
  input: {
    version?: 1 | 2;
    expectedFingerprint?: string;
    upgrades?: DurableObjectSchemaDefinition["upgrades"];
    fail?: "validate" | "upgrade";
  } = {}
): DurableObjectSchemaDefinition {
  const version = input.version ?? 1;
  return {
    className: "ItemsDO",
    version,
    storage: fake.storage,
    schemaTables: ["items"],
    ...(input.expectedFingerprint ? { expectedFingerprint: input.expectedFingerprint } : {}),
    ...(input.upgrades ? { upgrades: input.upgrades } : {}),
    createSchema: () => {
      fake.sql.exec(version === 1 ? V1 : V2);
      fake.sql.exec(INDEX);
    },
    validateSchema: () => {
      if (input.fail === "validate") throw new Error("validation failed");
      validateDurableObjectSchemaIndexes(fake.sql, ["items"], [INDEX]);
    },
  };
}

const messages = (fake: FakeDoltStorage) => fake.dolt.log().map((entry) => entry.message);

describe("installing a schema on a Dolt store", () => {
  it("commits a fresh install as `schema: C vN`, ignoring what celld and Dolt keep in the database", async () => {
    const fake = await dolt();
    // `_cf_*` and `dolt_ignore` are in sqlite_master before the class creates anything.
    const before = fake.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
    expect(before.map((row) => row["name"])).toEqual(
      expect.arrayContaining(["_cf_KV", "_cf_DOLT", "dolt_ignore"])
    );
    await installDurableObjectSchema(definition(fake));
    expect(messages(fake)[0]).toBe("schema: ItemsDO v1");
    expect(fake.dolt.status()).toEqual([]);
    expect(fake.sql.exec("SELECT version FROM _vibestudio_schema").one()).toEqual({ version: 1 });
    // `state` is a framework table, local by default (L3): the schema commit holds the
    // class's tables and the schema fact, not the per-object key-value state.
    expect(
      fake.dolt.diff({ from: "HEAD~1", to: "HEAD" }).summary.map((entry) => entry.toTable)
    ).toEqual(["_vibestudio_schema", "items"]);
  });

  it("commits nothing when the install finds the schema current", async () => {
    const fake = await dolt();
    await installDurableObjectSchema(definition(fake));
    const head = fake.dolt.hashOf("HEAD");
    await installDurableObjectSchema(definition(fake));
    expect(fake.dolt.hashOf("HEAD")).toBe(head);
  });

  it("commits nothing when the install fails: no tables, no metadata, no commit", async () => {
    const fake = await dolt();
    const head = fake.dolt.hashOf("HEAD");
    await expect(
      installDurableObjectSchema(definition(fake, { fail: "validate" }))
    ).rejects.toThrow("validation failed");
    expect(fake.dolt.hashOf("HEAD")).toBe(head);
    expect(
      fake.sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name IN ('items', 'state', '_vibestudio_schema')"
        )
        .toArray()
    ).toEqual([]);
    const wrong = await dolt();
    await expect(
      installDurableObjectSchema(definition(wrong, { expectedFingerprint: "[]" }))
    ).rejects.toBeInstanceOf(DurableObjectSchemaError);
    expect(wrong.dolt.log()).toHaveLength(1);
  });

  it("takes the shape inside the creating transaction and still agrees at the next activation, where the engine re-renders the text", async () => {
    const fake = await dolt();
    const expectedFingerprint = await trustedFingerprint(1);
    await installDurableObjectSchema(definition(fake, { expectedFingerprint }));
    // The engine has re-rendered `items (id` as `items(id` by now.
    expect(
      fake.sql.exec("SELECT sql FROM sqlite_master WHERE name = 'items'").one()["sql"]
    ).toContain("items(id");
    // A later activation (a restarted process) must not read that as drift.
    const restarted = await fake.restart();
    await expect(
      installDurableObjectSchema(definition(restarted, { expectedFingerprint }))
    ).resolves.toBeUndefined();
    expect(messages(restarted)[0]).toBe("schema: ItemsDO v1");
    expect(restarted.dolt.log()).toHaveLength(2);
  });

  it("detects real drift on a Dolt store, not only a spacing difference", async () => {
    const fake = await dolt();
    const expectedFingerprint = await trustedFingerprint(1);
    await installDurableObjectSchema(definition(fake, { expectedFingerprint }));
    fake.sql.exec("ALTER TABLE items ADD COLUMN sneaky TEXT");
    fake.dolt.commit("drift");
    await expect(
      installDurableObjectSchema(definition(fake, { expectedFingerprint }))
    ).rejects.toMatchObject({
      code: "DO_SCHEMA_INCOMPATIBLE",
      errorData: { reason: "shape-drift" },
    });
  });

  describe("upgrades", () => {
    const upgrades = (fake: FakeDoltStorage, v1: string, fail = false) => [
      {
        fromVersion: 1,
        fromFingerprint: v1,
        upgrade: () => {
          fake.sql.exec("ALTER TABLE items ADD COLUMN tag TEXT");
          if (fail) throw new Error("upgrade failed");
        },
      },
    ];

    it("is its own commit, after a checkpoint of state the class had not committed", async () => {
      const fake = await dolt();
      const v1 = await trustedFingerprint(1);
      const v2 = await trustedFingerprint(2);
      await installDurableObjectSchema(definition(fake, { expectedFingerprint: v1 }));
      // A `keep` class (the agent) holds uncommitted state between commits.
      fake.sql.exec("INSERT INTO items(id, body) VALUES ('pending', 'held')");
      expect(fake.dolt.status().map((entry) => entry.table)).toEqual(["items"]);

      await installDurableObjectSchema(
        definition(fake, { version: 2, expectedFingerprint: v2, upgrades: upgrades(fake, v1) })
      );
      expect(messages(fake).slice(0, 3)).toEqual([
        "schema: ItemsDO v1→v2",
        "schema: checkpoint before ItemsDO v1→v2",
        "schema: ItemsDO v1",
      ]);
      expect(fake.sql.exec("SELECT version FROM _vibestudio_schema").one()).toEqual({ version: 2 });
      expect(fake.sql.exec("SELECT id, tag FROM items").toArray()).toEqual([
        { id: "pending", tag: null },
      ]);
      expect(fake.dolt.status()).toEqual([]);
      // The checkpoint is a known restore point holding the pre-upgrade rows.
      expect(fake.sql.exec("SELECT count(*) AS n FROM dolt_at_items('HEAD~1')").one()["n"]).toBe(1);
      // The migration commit contains only the migration.
      expect(
        fake.dolt
          .diff({ from: "HEAD~1", to: "HEAD" })
          .summary.map((entry) => [entry.toTable, entry.schemaChange])
      ).toEqual(expect.arrayContaining([["items", true]]));
    });

    it("takes no checkpoint when the working set is clean", async () => {
      const fake = await dolt();
      const v1 = await trustedFingerprint(1);
      const v2 = await trustedFingerprint(2);
      await installDurableObjectSchema(definition(fake, { expectedFingerprint: v1 }));
      await installDurableObjectSchema(
        definition(fake, { version: 2, expectedFingerprint: v2, upgrades: upgrades(fake, v1) })
      );
      expect(messages(fake).slice(0, 2)).toEqual(["schema: ItemsDO v1→v2", "schema: ItemsDO v1"]);
    });

    it("treats an uncommitted dolt_ignore rule as clean, not as state to checkpoint", async () => {
      const fake = await dolt();
      const v1 = await trustedFingerprint(1);
      const v2 = await trustedFingerprint(2);
      await installDurableObjectSchema(definition(fake, { expectedFingerprint: v1 }));
      fake.sql.exec("UPDATE dolt_ignore SET ignored = 1");
      await installDurableObjectSchema(
        definition(fake, { version: 2, expectedFingerprint: v2, upgrades: upgrades(fake, v1) })
      );
      expect(messages(fake).filter((message) => message.includes("checkpoint"))).toEqual([]);
    });

    it("commits nothing and changes nothing when the upgrade throws, but keeps the checkpoint", async () => {
      const fake = await dolt();
      const v1 = await trustedFingerprint(1);
      const v2 = await trustedFingerprint(2);
      await installDurableObjectSchema(definition(fake, { expectedFingerprint: v1 }));
      fake.sql.exec("INSERT INTO items(id, body) VALUES ('pending', 'held')");
      await expect(
        installDurableObjectSchema(
          definition(fake, {
            version: 2,
            expectedFingerprint: v2,
            upgrades: upgrades(fake, v1, true),
          })
        )
      ).rejects.toThrow("upgrade failed");
      expect(messages(fake).slice(0, 2)).toEqual([
        "schema: checkpoint before ItemsDO v1→v2",
        "schema: ItemsDO v1",
      ]);
      expect(fake.sql.exec("SELECT version FROM _vibestudio_schema").one()).toEqual({ version: 1 });
      expect(
        fake.sql
          .exec("PRAGMA table_info(items)")
          .toArray()
          .map((row) => row["name"])
      ).not.toContain("tag");
      expect(fake.dolt.status()).toEqual([]);
    });

    it("commits nothing when the upgraded shape differs from its trusted target", async () => {
      const fake = await dolt();
      const v1 = await trustedFingerprint(1);
      await installDurableObjectSchema(definition(fake, { expectedFingerprint: v1 }));
      const head = fake.dolt.hashOf("HEAD");
      await expect(
        installDurableObjectSchema(
          definition(fake, { version: 2, expectedFingerprint: v1, upgrades: upgrades(fake, v1) })
        )
      ).rejects.toMatchObject({ errorData: { reason: "shape-drift" } });
      expect(fake.dolt.hashOf("HEAD")).toBe(head);
      expect(
        fake.sql
          .exec("PRAGMA table_info(items)")
          .toArray()
          .map((row) => row["name"])
      ).not.toContain("tag");
    });
  });

  it("leaves the base's local framework tables out of the fingerprint and out of commits", async () => {
    const fake = await dolt();
    await installDurableObjectSchema(definition(fake));
    fake.sql.exec(
      "CREATE TABLE vsl_direct_rpc_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)"
    );
    fake.sql.exec("INSERT INTO vsl_direct_rpc_nonces VALUES ('n', 1)");
    expect(fake.dolt.status()).toEqual([]);
    const fingerprint = durableObjectSchemaFingerprint(fake.sql, ["items"]);
    expect(fingerprint).not.toContain("vsl_direct_rpc_nonces");
    expect(fingerprint).not.toContain("dolt_ignore");
    expect(fingerprint).not.toContain("_cf_");
  });

  it("keeps SQLite stores byte-exact: a changed spacing there is still drift", async () => {
    const sql = await createInMemorySql();
    const storage = {
      sql,
      transaction: async <T>(callback: () => Promise<T>) => callback(),
    };
    const base = (): DurableObjectSchemaDefinition => ({
      className: "ItemsDO",
      version: 1,
      storage,
      schemaTables: ["items"],
      createSchema: () => {
        sql.exec(V1);
      },
      validateSchema: () => undefined,
    });
    await installDurableObjectSchema(base());
    sql.exec(
      "UPDATE _vibestudio_schema SET shape_json = replace(shape_json, 'items (id', 'items(id')"
    );
    await expect(installDurableObjectSchema(base())).rejects.toMatchObject({
      errorData: { reason: "shape-drift" },
    });
  });
});

describe("the schema guard's filter", () => {
  it("ignores _cf_, _litestream, dolt_ and doltlite_ names and sqlite_ internals, and nothing else", async () => {
    const sql = await createInMemorySql();
    sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
    const base = durableObjectSchemaFingerprint(sql);
    for (const name of [
      "_cf_KV",
      "_litestream_seq",
      "dolt_ignore",
      "dolt_schemas",
      "doltlite_meta",
    ]) {
      sql.exec(`CREATE TABLE ${name} (a TEXT)`);
    }
    expect(durableObjectSchemaFingerprint(sql)).toBe(base);
    // Names that merely resemble them are the class's.
    sql.exec("CREATE TABLE doltish (a TEXT)");
    expect(durableObjectSchemaFingerprint(sql)).not.toBe(base);
  });
});
