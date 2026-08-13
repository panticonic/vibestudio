import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  DURABLE_OBJECT_FRAMEWORK_RPC_METHODS,
  type DurableObjectContext,
  type SqlResult,
} from "@vibestudio/durable";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { browserVaultMethods } from "@vibestudio/service-schemas/browserData";
import { BrowserVaultDO } from "./BrowserVaultDO.js";

describe("BrowserVaultDO schema", () => {
  it("admits protected material only to the host principal", () => {
    for (const method of Object.values(browserVaultMethods)) {
      expect(method.authority).toEqual({ principals: ["host"] });
      expect(method.agentFacing).toBe(false);
    }
  });

  it("has one typed declaration for every exposed data method", () => {
    const db = new DatabaseSync(":memory:");
    const instance = createBrowserVaultDO(db);
    const productMethods = [...rpcExposedMethodNames(instance)].filter(
      (method) => !DURABLE_OBJECT_FRAMEWORK_RPC_METHODS.has(method)
    );
    expect(productMethods.sort()).toEqual(Object.keys(browserVaultMethods).sort());
  });

  it("creates the one canonical pre-release schema directly", () => {
    const db = new DatabaseSync(":memory:");
    createBrowserVaultDO(db);

    expect(db.prepare(`SELECT singleton, version FROM _vibestudio_schema`).get()).toEqual({
      singleton: 1,
      version: 1,
    });
    expect(db.prepare(`SELECT 1 FROM state WHERE key = 'schema_version'`).get()).toBeUndefined();
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'page_favicons'`).get()
    ).toBeUndefined();
    expect(
      db
        .prepare(`PRAGMA table_info(form_fill_values)`)
        .all()
        .map((column) => column["name"])
    ).toEqual(expect.arrayContaining(["field_name", "field_key", "type"]));
    db.close();
  });

  it("enforces tier, sensitivity, and principals from the typed method table", () => {
    const db = new DatabaseSync(":memory:");
    const instance = createBrowserVaultDO(db);
    const resolve = (
      method: keyof typeof browserVaultMethods
    ): import("@vibestudio/rpc").ResolvedRpcAuthority | null =>
      (
        instance as unknown as {
          rpcAuthorityDeclaration(
            name: string,
            schema: (typeof browserVaultMethods)[keyof typeof browserVaultMethods]
          ): import("@vibestudio/rpc").ResolvedRpcAuthority | null;
        }
      ).rpcAuthorityDeclaration(method, browserVaultMethods[method]!);

    expect(resolve("listPasswordSummaries")).toMatchObject({
      tier: "gated",
      sensitivity: "read",
      effect: { kind: "host-capability", capability: "browser-data.read" },
    });
    expect(resolve("getCookiesForOrigin")).toMatchObject({
      tier: "gated",
      sensitivity: "read",
      effect: { kind: "host-capability", capability: "browser-data.read" },
    });
    expect(resolve("clearAllCookies")).toMatchObject({
      tier: "gated",
      sensitivity: "destructive",
      effect: { kind: "host-capability", capability: "browser-data.delete" },
    });
    expect(resolve("listPasswordSummaries")).toMatchObject({ principals: ["host"] });
    db.close();
  });
});

describe("BrowserVaultDO form-fill field identity", () => {
  it("rejects credentials and transient secrets from reusable form history", async () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserVaultDO(db);

    for (const type of ["current-password", "new-password", "one-time-code", "cc-csc"] as const) {
      await expect(
        store.addFormFillValue({ fieldName: type, type, value: "not-stored" })
      ).rejects.toThrow("is not reusable form history");
    }
    expect(db.prepare(`SELECT COUNT(*) AS count FROM form_fill_values`).get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it("stores and retrieves arbitrary browser-native field names", async () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserVaultDO(db);

    await store.addFormFillValue({
      fieldName: "favorite_pizza_topping",
      value: "artichoke",
      useCount: 7,
    });

    await expect(
      store.getFormFillSuggestions({ fieldName: "FAVORITE_PIZZA_TOPPING" })
    ).resolves.toMatchObject([
      {
        fieldName: "favorite_pizza_topping",
        type: null,
        value: "artichoke",
        useCount: 7,
      },
    ]);
    db.close();
  });

  it("deduplicates semantic equivalents while retaining their native aliases", async () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserVaultDO(db);

    const firstId = await store.addFormFillValue({
      fieldName: "email_address",
      type: "email",
      value: "person@example.test",
      useCount: 2,
    });
    const secondId = await store.addFormFillValue({
      fieldName: "contactEmail",
      type: "email",
      value: "person@example.test",
      useCount: 5,
    });

    expect(secondId).toBe(firstId);
    await expect(store.getFormFillSuggestions({ type: "email" })).resolves.toMatchObject([
      {
        fieldName: "email_address",
        type: "email",
        aliases: ["email_address", "contactEmail"],
        useCount: 5,
      },
    ]);
    db.close();
  });
});

describe("BrowserVaultDO partitioned cookies", () => {
  it("stores identical cookie triples independently by structured partition key", async () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserVaultDO(db);
    const base = {
      name: "sid",
      value: "one",
      domain: ".embedded.example",
      hostOnly: false,
      path: "/embedded/app",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction" as const,
    };

    await store.applyCookieMutations({
      mutations: [
        {
          op: "put",
          mutationId: "partition-one",
          cookie: {
            ...base,
            partitionKey: {
              topLevelSite: "https://one.example",
              hasCrossSiteAncestor: true,
            },
          },
        },
        {
          op: "put",
          mutationId: "partition-two",
          cookie: {
            ...base,
            value: "two",
            partitionKey: {
              topLevelSite: "https://two.example",
              hasCrossSiteAncestor: true,
            },
          },
        },
      ],
    });

    await expect(store.getCookiesForOrigin("https://embedded.example")).resolves.toMatchObject([
      {
        value: "one",
        partitionKey: {
          topLevelSite: "https://one.example",
          hasCrossSiteAncestor: true,
        },
      },
      {
        value: "two",
        partitionKey: {
          topLevelSite: "https://two.example",
          hasCrossSiteAncestor: true,
        },
      },
    ]);
    db.close();
  });
});

function createBrowserVaultDO(db: DatabaseSync, env: Record<string, unknown> = {}): BrowserVaultDO {
  const instance = new BrowserVaultDO(sqliteContext(db), env);
  (instance as unknown as { ensureReady(): void }).ensureReady();
  return instance;
}

function sqliteContext(db: DatabaseSync): DurableObjectContext {
  const sql = {
    exec(query: string, ...bindings: unknown[]): SqlResult {
      const statement = db.prepare(query);
      const rows =
        /^\s*(?:SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) || /\bRETURNING\b/i.test(query)
          ? (statement.all(...(bindings as [])) as Record<string, unknown>[])
          : (statement.run(...(bindings as [])), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one row, received ${rows.length}`);
          return rows[0]!;
        },
      };
    },
  };
  return {
    id: { toString: () => "browser-vault-test", name: "browser-vault-test" },
    storage: {
      sql,
      setAlarm() {},
      async getAlarm() {
        return null;
      },
      deleteAlarm() {},
      transactionSync<T>(callback: () => T): T {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = callback();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    acceptWebSocket() {},
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn) => fn(),
  };
}
