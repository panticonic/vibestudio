import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import initSqlJs from "sql.js";
import { afterEach, describe, expect, it } from "vitest";
import { FirefoxReader } from "../readers/firefoxReader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("FirefoxReader", () => {
  it("treats category databases absent from a registered profile as empty", async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-firefox-profile-"));
    roots.push(profile);
    const reader = new FirefoxReader();

    await expect(reader.readBookmarks(profile)).resolves.toEqual([]);
    await expect(reader.readHistory(profile)).resolves.toEqual([]);
    await expect(reader.readCookies(profile)).resolves.toEqual([]);
  });

  it("imports a tagged bookmark once, not again under each tag", async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-firefox-profile-"));
    roots.push(profile);
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER,
        parent INTEGER, title TEXT, dateAdded INTEGER, lastModified INTEGER,
        keyword_id INTEGER, guid TEXT);
      INSERT INTO moz_places VALUES (1, 'https://example.com/');
      INSERT INTO moz_bookmarks VALUES (1, 2, NULL, 0, '', 0, 0, NULL, 'root________');
      INSERT INTO moz_bookmarks VALUES (2, 2, NULL, 1, 'menu', 0, 0, NULL, 'menu________');
      INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 'toolbar', 0, 0, NULL, 'toolbar_____');
      INSERT INTO moz_bookmarks VALUES (4, 2, NULL, 1, 'tags', 0, 0, NULL, 'tags________');
      INSERT INTO moz_bookmarks VALUES (5, 2, NULL, 1, 'unfiled', 0, 0, NULL, 'unfiled_____');
      INSERT INTO moz_bookmarks VALUES (10, 1, 1, 3, 'Example', 0, 0, NULL, 'bookmark____');
      INSERT INTO moz_bookmarks VALUES (11, 2, NULL, 4, 'work', 0, 0, NULL, 'tagfolder___');
      INSERT INTO moz_bookmarks VALUES (12, 1, 1, 11, NULL, 0, 0, NULL, 'tagentry____');
    `);
    fs.writeFileSync(path.join(profile, "places.sqlite"), Buffer.from(db.export()));
    db.close();

    const bookmarks = await new FirefoxReader().readBookmarks(profile);

    expect(bookmarks).toEqual([
      expect.objectContaining({ url: "https://example.com/", title: "Example", folder: [] }),
    ]);
  });
});
