import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openReadonlySqlite } from "../readers/sqliteReader.js";

async function database() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-reader-test-"));
  const file = path.join(root, "browser.db");
  const writer = new DatabaseSync(file);
  writer.exec("CREATE TABLE fixture(n INTEGER); INSERT INTO fixture VALUES (1)");
  writer.close();
  const reader = await openReadonlySqlite(file);
  return {
    ...reader,
    close() {
      reader.close();
      fs.rmSync(root, { recursive: true });
    },
  };
}

describe("browser SQLite reader", () => {
  it("returns the first row without evaluating subsequent rows", async () => {
    const db = await database();
    try {
      const statement = db.prepare(`
        WITH rows(n) AS (VALUES (1), (2))
        SELECT CASE WHEN n = 1 THEN n ELSE abs(-9223372036854775808) END AS value
        FROM rows
      `);
      expect(statement.get()).toEqual({ value: 1 });
      expect(() => statement.all()).toThrow(/integer overflow/);
      expect(statement.get()).toEqual({ value: 1 });
    } finally {
      db.close();
    }
  });

  it("binds single-row queries and returns undefined for an empty result", async () => {
    const db = await database();
    try {
      const statement = db.prepare("SELECT ? AS value WHERE ?");
      expect(statement.get("first", 1)).toEqual({ value: "first" });
      expect(statement.get("empty", 0)).toBeUndefined();
      expect(statement.all("all", 1)).toEqual([{ value: "all" }]);
    } finally {
      db.close();
    }
  });
  it("iterates lazily, releases an early-stopped query, and preserves wide timestamps", async () => {
    const db = await database();
    try {
      const rows = db.prepare(`WITH rows(n) AS (VALUES (1), (2))
        SELECT CASE WHEN n = 1 THEN n ELSE abs(-9223372036854775808) END AS value FROM rows`);
      for (const row of rows.iterate()) {
        expect(row["value"]).toBe(1);
        break;
      }
      expect(db.prepare("SELECT 13300000000000001 AS stamp, 42 AS id").get()).toEqual({
        stamp: 13300000000000001n,
        id: 42,
      });
      expect(() => db.prepare("DELETE FROM fixture").get()).toThrow(/readonly/);
    } finally {
      db.close();
    }
  });
});
