import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectContext, SqlResult } from "@vibestudio/durable";
import { BrowserDataDO } from "./browserDataDO.js";

describe("BrowserDataDO schema migrations", () => {
  it("cuts pre-release profile data over to the canonical v7 environment schema", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(V1_BROWSER_DATA_SCHEMA);
    db.prepare(`INSERT INTO state (key, value) VALUES ('schema_version', '1')`).run();
    db.prepare(
      `INSERT INTO history (id, url, title, visit_count, typed_count, first_visit, last_visit)
       VALUES (1, 'https://example.test/', 'Example', 2, 1, 100, 200)`
    ).run();
    db.prepare(
      `INSERT INTO history_visits (id, history_id, visit_time, transition) VALUES
       (10, 1, 200, 'typed'), (11, 1, 200, 'typed')`
    ).run();
    db.prepare(
      `INSERT INTO bookmarks (id, title, url, folder_path, date_added, source_browser)
       VALUES (20, 'Saved', 'https://example.test/', '/', 100, 'chrome')`
    ).run();
    db.prepare(
      `INSERT INTO passwords (
         id, origin_url, username_hash, username_encrypted, password_encrypted
       ) VALUES (30, 'https://example.test/', x'01', x'02', x'03')`
    ).run();
    db.prepare(
      `INSERT INTO import_log (
         id, browser, profile_path, data_type, items_imported, items_skipped, imported_at, warnings
       ) VALUES (40, 'chrome', '/profile', 'history', 2, 1, 300, 'one warning')`
    ).run();

    const ctx = sqliteContext(db);
    new BrowserDataDO(ctx, {});

    expect(db.prepare(`SELECT value FROM state WHERE key = 'schema_version'`).get()).toEqual({
      value: "7",
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM history`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM bookmarks`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM passwords`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM site_preferences`).get()).toEqual({
      count: 0,
    });
    expect(
      db.prepare(`SELECT version, name FROM _vibestudio_schema_migrations ORDER BY version`).all()
    ).toEqual([
      { version: 1, name: "adopted:browser-data-v1" },
      { version: 2, name: "preserve-history-visit-provenance" },
      { version: 3, name: "preserve-import-source-identity" },
      { version: 4, name: "preserve-import-runs-and-secret-metadata" },
      { version: 5, name: "canonical-browser-environment-cutover" },
      { version: 6, name: "browser-site-preferences" },
      { version: 7, name: "canonical-download-metadata" },
    ]);
    db.close();
  });

  it("drops unrecognized pre-release v1 shape instead of translating it", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(V1_BROWSER_DATA_SCHEMA);
    db.prepare(`INSERT INTO state (key, value) VALUES ('schema_version', '1')`).run();
    db.exec(`ALTER TABLE history_visits ADD COLUMN unexpected TEXT`);

    new BrowserDataDO(sqliteContext(db), {});
    expect(db.prepare(`SELECT value FROM state WHERE key = 'schema_version'`).get()).toEqual({
      value: "7",
    });
    expect(
      db
        .prepare(`PRAGMA table_info(history_visits)`)
        .all()
        .map((column) => column["name"])
    ).not.toContain("unexpected");
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

function sqliteContext(db: DatabaseSync): DurableObjectContext {
  const sql = {
    exec(query: string, ...bindings: unknown[]): SqlResult {
      const statement = db.prepare(query);
      const rows = /^\s*(?:SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query)
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

const V1_BROWSER_DATA_SCHEMA = `
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE favicons (
    id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, data BLOB,
    mime_type TEXT DEFAULT 'image/png', last_updated INTEGER
  );
  CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, url TEXT,
    folder_path TEXT NOT NULL DEFAULT '/', date_added INTEGER NOT NULL,
    date_modified INTEGER, favicon_id INTEGER REFERENCES favicons(id),
    position INTEGER NOT NULL DEFAULT 0, source_browser TEXT, tags TEXT, keyword TEXT
  );
  CREATE INDEX idx_bookmarks_url ON bookmarks(url);
  CREATE INDEX idx_bookmarks_folder ON bookmarks(folder_path);
  CREATE TABLE history (
    id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT,
    visit_count INTEGER NOT NULL DEFAULT 0, typed_count INTEGER NOT NULL DEFAULT 0,
    first_visit INTEGER, last_visit INTEGER NOT NULL,
    favicon_id INTEGER REFERENCES favicons(id)
  );
  CREATE INDEX idx_history_url ON history(url);
  CREATE INDEX idx_history_last_visit ON history(last_visit);
  CREATE TABLE history_visits (
    id INTEGER PRIMARY KEY, history_id INTEGER NOT NULL REFERENCES history(id) ON DELETE CASCADE,
    visit_time INTEGER NOT NULL, transition TEXT DEFAULT 'link',
    from_visit_id INTEGER REFERENCES history_visits(id)
  );
  CREATE INDEX idx_history_visits_history_id ON history_visits(history_id);
  CREATE VIRTUAL TABLE history_fts USING fts5(url, title, content=history, content_rowid=id);
  CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN
    INSERT INTO history_fts(rowid, url, title) VALUES (new.id, new.url, new.title);
  END;
  CREATE TRIGGER history_ad AFTER DELETE ON history BEGIN
    INSERT INTO history_fts(history_fts, rowid, url, title) VALUES('delete', old.id, old.url, old.title);
  END;
  CREATE TRIGGER history_au AFTER UPDATE ON history BEGIN
    INSERT INTO history_fts(history_fts, rowid, url, title) VALUES('delete', old.id, old.url, old.title);
    INSERT INTO history_fts(rowid, url, title) VALUES (new.id, new.url, new.title);
  END;
  CREATE TABLE passwords (
    id INTEGER PRIMARY KEY, origin_url TEXT NOT NULL, username_hash BLOB NOT NULL,
    username_encrypted BLOB NOT NULL, password_encrypted BLOB NOT NULL,
    action_url TEXT NOT NULL DEFAULT '', realm TEXT NOT NULL DEFAULT '', date_created INTEGER,
    date_last_used INTEGER, date_password_changed INTEGER, times_used INTEGER DEFAULT 0,
    UNIQUE(origin_url, username_hash, action_url, realm)
  );
  CREATE TABLE password_never_save (
    id INTEGER PRIMARY KEY, origin TEXT NOT NULL UNIQUE, date_added INTEGER NOT NULL
  );
  CREATE TABLE cookies (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL, domain TEXT NOT NULL,
    host_only INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '/', expiration_date INTEGER,
    secure INTEGER NOT NULL DEFAULT 0, http_only INTEGER NOT NULL DEFAULT 0,
    same_site TEXT NOT NULL DEFAULT 'unspecified', source_scheme TEXT DEFAULT 'unset',
    source_port INTEGER DEFAULT -1, source_browser TEXT, created_at INTEGER NOT NULL,
    last_accessed INTEGER, UNIQUE(name, domain, path)
  );
  CREATE INDEX idx_cookies_domain ON cookies(domain);
  CREATE TABLE autofill (
    id INTEGER PRIMARY KEY, field_name TEXT NOT NULL, value TEXT NOT NULL,
    date_created INTEGER, date_last_used INTEGER, times_used INTEGER NOT NULL DEFAULT 1,
    UNIQUE(field_name, value)
  );
  CREATE INDEX idx_autofill_field ON autofill(field_name);
  CREATE TABLE search_engines (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, keyword TEXT, search_url TEXT NOT NULL,
    suggest_url TEXT, favicon_url TEXT, is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE permissions (
    id INTEGER PRIMARY KEY, origin TEXT NOT NULL, permission TEXT NOT NULL,
    setting TEXT NOT NULL DEFAULT 'ask', date_set INTEGER, UNIQUE(origin, permission)
  );
  CREATE TABLE import_log (
    id INTEGER PRIMARY KEY, browser TEXT NOT NULL, profile_path TEXT NOT NULL,
    data_type TEXT NOT NULL, items_imported INTEGER NOT NULL DEFAULT 0,
    items_skipped INTEGER NOT NULL DEFAULT 0, imported_at INTEGER NOT NULL, warnings TEXT
  );
`;
