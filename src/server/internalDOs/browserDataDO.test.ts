import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectContext, SqlResult } from "@vibestudio/durable";
import type { AuthenticatedCaller } from "@vibestudio/rpc";
import { BrowserDataDO, isBrowserDataDirectCaller } from "./browserDataDO.js";

const caller = (callerKind: string, callerId = "x"): AuthenticatedCaller =>
  ({ callerId, callerKind }) as AuthenticatedCaller;
const BROKER = "@workspace-extensions/browser-data";

describe("BrowserDataDO direct authority", () => {
  it("keeps shell and server access independent of a declared broker", () => {
    expect(isBrowserDataDirectCaller(caller("shell", "shell"), BROKER)).toBe(true);
    expect(isBrowserDataDirectCaller(caller("server", "main"), BROKER)).toBe(true);
    expect(isBrowserDataDirectCaller(caller("shell", "shell"), null)).toBe(true);
    expect(isBrowserDataDirectCaller(caller("server", "main"), null)).toBe(true);
  });

  it("allows only the exact declared broker extension", () => {
    expect(isBrowserDataDirectCaller(caller("extension", BROKER), BROKER)).toBe(true);
    expect(
      isBrowserDataDirectCaller(caller("extension", "@workspace-extensions/evil"), BROKER)
    ).toBe(false);
    expect(isBrowserDataDirectCaller(caller("extension", BROKER), null)).toBe(false);
  });

  it("refuses panel, durable-object, worker, and unattributed callers", () => {
    expect(isBrowserDataDirectCaller(caller("panel", "panel:1"), BROKER)).toBe(false);
    expect(isBrowserDataDirectCaller(caller("do", "do:agent"), BROKER)).toBe(false);
    expect(isBrowserDataDirectCaller(caller("worker", "worker:1"), BROKER)).toBe(false);
    expect(isBrowserDataDirectCaller(null, BROKER)).toBe(false);
  });
});

describe("BrowserDataDO schema migrations", () => {
  it("migrates the exact v1 database through v4 without losing browser data", () => {
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
      value: "4",
    });
    expect(
      db
        .prepare(
          `SELECT id, history_id, visit_time, transition, source, source_browser,
                  source_profile_path, panel_id, title, typed
             FROM history_visits ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 10,
        history_id: 1,
        visit_time: 200,
        transition: "typed",
        source: "vibestudio",
        source_browser: "",
        source_profile_path: "",
        panel_id: "legacy:10",
        title: "Example",
        typed: 0,
      },
      {
        id: 11,
        history_id: 1,
        visit_time: 200,
        transition: "typed",
        source: "vibestudio",
        source_browser: "",
        source_profile_path: "",
        panel_id: "legacy:11",
        title: "Example",
        typed: 0,
      },
    ]);
    expect(db.prepare(`SELECT id, title, source_browser FROM bookmarks`).get()).toEqual({
      id: 20,
      title: "Saved",
      source_browser: "chrome",
    });
    expect(
      db
        .prepare(
          `SELECT hex(username_hash) AS hash, hex(password_encrypted) AS password FROM passwords`
        )
        .get()
    ).toEqual({ hash: "01", password: "03" });
    expect(db.prepare(`SELECT * FROM import_runs`).get()).toMatchObject({
      id: 40,
      browser: "chrome",
      profile_path: "/profile",
      started_at: 300,
      finished_at: 300,
      data_types: '["history"]',
      warnings: "one warning",
    });
    expect(db.prepare(`SELECT * FROM import_run_summaries`).get()).toMatchObject({
      run_id: 40,
      data_type: "history",
      scanned: 3,
      added: 2,
      skipped: 1,
    });
    expect(
      db.prepare(`SELECT rowid FROM history_fts WHERE history_fts MATCH 'Example'`).all()
    ).toEqual([{ rowid: 1 }]);
    expect(
      db.prepare(`SELECT version, name FROM _vibestudio_schema_migrations ORDER BY version`).all()
    ).toEqual([
      { version: 1, name: "adopted:browser-data-v1" },
      { version: 2, name: "preserve-history-visit-provenance" },
      { version: 3, name: "preserve-import-source-identity" },
      { version: 4, name: "preserve-import-runs-and-secret-metadata" },
    ]);
    db.close();
  });

  it("rejects v1 source-shape drift before mutating the database", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(V1_BROWSER_DATA_SCHEMA);
    db.prepare(`INSERT INTO state (key, value) VALUES ('schema_version', '1')`).run();
    db.exec(`ALTER TABLE history_visits ADD COLUMN unexpected TEXT`);

    expect(() => new BrowserDataDO(sqliteContext(db), {})).toThrow(
      /history_visits does not match its exact recognized shape/
    );
    expect(db.prepare(`SELECT value FROM state WHERE key = 'schema_version'`).get()).toEqual({
      value: "1",
    });
    expect(
      db
        .prepare(`PRAGMA table_info(history_visits)`)
        .all()
        .map((column) => column["name"])
    ).toContain("unexpected");
    expect(
      db
        .prepare(`PRAGMA table_info(history_visits)`)
        .all()
        .map((column) => column["name"])
    ).not.toContain("source");
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
