import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectContext, SqlResult } from "@vibestudio/durable";
import { BrowserDataDO } from "./browserDataDO.js";

describe("BrowserDataDO schema", () => {
  it("creates the one canonical pre-release schema directly", () => {
    const db = new DatabaseSync(":memory:");
    new BrowserDataDO(sqliteContext(db), {});

    expect(db.prepare(`SELECT value FROM state WHERE key = 'schema_version'`).get()).toEqual({
      value: "1",
    });
    expect(
      db.prepare(`SELECT version, name FROM _vibestudio_schema_migrations ORDER BY version`).all()
    ).toEqual([{ version: 1, name: "fresh-install:browserdatado-production-baseline" }]);
    expect(
      db
        .prepare(`PRAGMA table_info(page_favicons)`)
        .all()
        .map((column) => column["name"])
    ).toContain("image_data");
    expect(
      db
        .prepare(`PRAGMA table_info(form_fill_values)`)
        .all()
        .map((column) => column["name"])
    ).toEqual(expect.arrayContaining(["field_name", "field_key", "type"]));
    db.close();
  });
});

describe("BrowserDataDO form-fill field identity", () => {
  it("rejects credentials and transient secrets from reusable form history", async () => {
    const db = new DatabaseSync(":memory:");
    const store = new BrowserDataDO(sqliteContext(db), {});

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
    const store = new BrowserDataDO(sqliteContext(db), {});

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
    const store = new BrowserDataDO(sqliteContext(db), {});

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

describe("BrowserDataDO partitioned cookies", () => {
  it("stores identical cookie triples independently by structured partition key", async () => {
    const db = new DatabaseSync(":memory:");
    const store = new BrowserDataDO(sqliteContext(db), {});
    const base = {
      name: "sid",
      value: "one",
      domain: ".embedded.example",
      hostOnly: false,
      path: "/",
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

    await expect(store.getCookieSnapshot()).resolves.toMatchObject({
      cookies: [
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
      ],
    });
    db.close();
  });
});

describe("BrowserDataDO download metadata", () => {
  it("persists download metadata by host inside the canonical environment", () => {
    const db = new DatabaseSync(":memory:");
    const store = new BrowserDataDO(sqliteContext(db), {});
    const record = {
      id: "download-1",
      environmentKey: "environment-1",
      hostId: "desktop:host-1",
      panelId: "panel-1",
      origin: "https://example.test",
      url: "https://example.test/archive.zip",
      filename: "archive.zip",
      savePath: "/tmp/archive.zip",
      receivedBytes: 25,
      totalBytes: 100,
      state: "progressing" as const,
      startedAt: 100,
      updatedAt: 110,
    };

    store.upsertDownloadRecord(record);
    store.upsertDownloadRecord({
      ...record,
      receivedBytes: 100,
      state: "completed",
      updatedAt: 120,
    });

    expect(store.listDownloadRecords("desktop:host-1")).toEqual([
      {
        ...record,
        receivedBytes: 100,
        state: "completed",
        updatedAt: 120,
      },
    ]);
    expect(store.listDownloadRecords("desktop:other-host")).toEqual([]);
    db.close();
  });
});

describe("BrowserDataDO native favicon formats", () => {
  it("stores validated source bytes and serves them by page or origin", () => {
    const db = new DatabaseSync(":memory:");
    const store = new BrowserDataDO(sqliteContext(db), {});
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`);

    store.putPageFavicon({
      pageUrl: "https://example.test/one",
      origin: "https://example.test",
      sourceUrl: "https://example.test/favicon.svg",
      data: svg.toString("base64"),
      mimeType: "image/svg+xml",
      updatedAt: 123,
    });

    expect(store.getPageFavicon("https://example.test/one")).toMatchObject({
      page_url: "https://example.test/one",
      image_data: svg.toString("base64"),
      mime_type: "image/svg+xml",
      updated_at: 123,
    });
    expect(store.getPageFavicon("https://example.test/two")).toMatchObject({
      page_url: "https://example.test/one",
      mime_type: "image/svg+xml",
    });
    db.close();
  });

  it("rejects MIME labels that disagree with the icon bytes", () => {
    const db = new DatabaseSync(":memory:");
    const store = new BrowserDataDO(sqliteContext(db), {});
    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

    expect(() =>
      store.putPageFavicon({
        pageUrl: "https://example.test/",
        origin: "https://example.test",
        data: ico.toString("base64"),
        mimeType: "image/png",
        updatedAt: 123,
      })
    ).toThrow(/bytes are image\/x-icon, not image\/png/);
    db.close();
  });
});

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
    id: { toString: () => "browser-data-test", name: "browser-data-test" },
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
