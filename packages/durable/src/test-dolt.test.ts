import { describe, expect, it } from "vitest";
import {
  isDoltRemoteError,
  type DoltRemoteStorage,
  type DoltResolvingMergeResult,
} from "./dolt.js";
import { FakeDoltNetwork, FakeDoltStorage, FakeDoltUnsupportedError } from "./test-dolt.js";

async function withNotes(options: Parameters<typeof FakeDoltStorage.create>[0] = {}) {
  const fake = await FakeDoltStorage.create(options);
  fake.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, rank INTEGER)");
  fake.dolt.commit("create notes");
  return fake;
}

const insert = (fake: FakeDoltStorage, id: number, body: string, rank: number | null = null) =>
  fake.sql.exec("INSERT INTO notes(id, body, rank) VALUES (?, ?, ?)", id, body, rank);
const bodies = (fake: FakeDoltStorage) =>
  fake.sql
    .exec("SELECT body FROM notes ORDER BY id")
    .toArray()
    .map((row) => row["body"]);

describe("commits, history and branches", () => {
  it("starts on main with an initial commit and lists history newest first", async () => {
    const fake = await withNotes();
    insert(fake, 1, "one");
    const first = fake.dolt.commit({
      message: "add one",
      author: "Ann <ann@example.com>",
      date: 1_700_000_000_000,
    });
    insert(fake, 2, "two");
    const second = fake.dolt.commit("add two");
    expect(fake.dolt.branch.current()).toBe("main");
    expect(first).toMatch(/^[0-9a-v]{32}$/);
    const log = fake.dolt.log();
    expect(log.map((entry) => entry.message)).toEqual([
      "add two",
      "add one",
      "create notes",
      expect.stringMatching(/^Initialize data repository/),
    ]);
    expect(log[0]?.hash).toBe(second);
    expect(log[1]).toMatchObject({
      committer: "Ann",
      email: "ann@example.com",
      date: "2023-11-14T22:13:20.000Z",
    });
    expect(fake.dolt.log({ limit: 1 })).toHaveLength(1);
    expect(fake.dolt.hashOf("HEAD~1")).toBe(first);
    expect(fake.dolt.hashOf("main")).toBe(second);
  });

  it("refuses an empty commit, an empty message and a malformed author", async () => {
    const fake = await withNotes();
    expect(() => fake.dolt.commit("nothing")).toThrow("nothing to commit");
    expect(fake.dolt.commit({ message: "allowed", allowEmpty: true })).toMatch(/^[0-9a-v]{32}$/);
    insert(fake, 1, "x");
    expect(() => fake.dolt.commit("")).toThrow("non-empty message");
    expect(() => fake.dolt.commit({ message: "m", author: "nobody" })).toThrow("Name <email>");
  });

  it("keeps a working set per branch and carries local tables across checkout", async () => {
    const fake = await withNotes({ doltLocal: ["local_%"] });
    fake.sql.exec("CREATE TABLE local_marks (id INTEGER PRIMARY KEY, note TEXT)");
    insert(fake, 1, "main-one");
    fake.dolt.commit("main one");
    fake.dolt.branch.create("side");
    fake.dolt.checkout("side");
    insert(fake, 2, "side-two");
    fake.sql.exec("INSERT INTO local_marks VALUES (1, 'written on side')");
    expect(bodies(fake)).toEqual(["main-one", "side-two"]);
    // The side branch has an uncommitted row; switching saves it with the branch.
    fake.dolt.checkout("main");
    expect(bodies(fake)).toEqual(["main-one"]);
    expect(fake.sql.exec("SELECT note FROM local_marks").toArray()).toEqual([
      { note: "written on side" },
    ]);
    fake.dolt.checkout("side");
    expect(bodies(fake)).toEqual(["main-one", "side-two"]);
    expect(fake.dolt.status().map((entry) => entry.table)).toEqual(["notes"]);
    expect(fake.dolt.branch.list().map((branch) => branch.name)).toEqual(["main", "side"]);
    expect(() => fake.dolt.checkout("missing")).toThrow("branch not found");
    expect(fake.dolt.checkout("fresh", { create: true })).toBe("fresh");
  });

  it("deletes branches by the fork's rules", async () => {
    const fake = await withNotes();
    fake.dolt.branch.create("merged");
    fake.dolt.branch.create("ahead");
    fake.dolt.checkout("ahead");
    insert(fake, 1, "only here");
    fake.dolt.commit("ahead commit");
    fake.dolt.checkout("main");
    fake.dolt.branch.delete("merged");
    expect(() => fake.dolt.branch.delete("ahead")).toThrow("not fully merged");
    fake.dolt.branch.delete("ahead", { force: true });
    expect(() => fake.dolt.branch.delete("main")).toThrow("main");
    fake.dolt.branch.create("here");
    fake.dolt.checkout("here");
    expect(() => fake.dolt.branch.delete("here", { force: true })).toThrow("checked-out");
    expect(() => fake.dolt.branch.create("here")).toThrow("already exists");
  });

  it("resets soft by default and hard on request, leaving local tables alone", async () => {
    const fake = await withNotes({ doltLocal: ["local_%"] });
    fake.sql.exec("CREATE TABLE local_marks (id INTEGER PRIMARY KEY, note TEXT)");
    insert(fake, 1, "one");
    const one = fake.dolt.commit("one");
    insert(fake, 2, "two");
    fake.dolt.commit("two");
    fake.sql.exec("INSERT INTO local_marks VALUES (1, 'mark')");
    expect(fake.dolt.reset({ to: "HEAD~1" })).toBe(one);
    expect(bodies(fake)).toEqual(["one", "two"]);
    expect(fake.dolt.status().map((entry) => entry.status)).toEqual(["modified"]);
    insert(fake, 3, "three");
    fake.dolt.reset({ hard: true, to: one });
    expect(bodies(fake)).toEqual(["one"]);
    expect(fake.sql.exec("SELECT count(*) AS n FROM local_marks").one()["n"]).toBe(1);
    expect(fake.dolt.status()).toEqual([]);
  });

  it("throws every Dolt operation inside a transaction and treats a Dolt write as nothing of SQL's", async () => {
    const fake = await withNotes();
    for (const operation of [
      () => fake.dolt.commit("x"),
      () => fake.dolt.branch.create("b"),
      () => fake.dolt.checkout("main"),
      () => fake.dolt.reset(),
      () => fake.dolt.log(),
      () => fake.dolt.hashOf(),
      () => fake.dolt.status(),
      () => fake.dolt.merge("main"),
    ]) {
      expect(() => fake.storage.transactionSync(operation)).toThrow(
        /cannot run inside a storage transaction/
      );
    }
    const handle = fake.storage.beginTransactionSync();
    expect(() => fake.dolt.status()).toThrow(/cannot run inside/);
    handle.rollback();
    expect(fake.dolt.status()).toEqual([]);
  });
});

describe("SQL, system tables and the schema text", () => {
  it("reads other commits without a checkout, and the commit graph", async () => {
    const fake = await withNotes();
    insert(fake, 1, "one");
    fake.dolt.commit("one");
    fake.sql.exec("UPDATE notes SET body = 'ONE' WHERE id = 1");
    fake.dolt.commit("upper");
    expect(
      fake.sql.exec("SELECT body FROM dolt_at_notes('HEAD~1') WHERE id = 1").one()["body"]
    ).toBe("one");
    expect(fake.sql.exec("SELECT body FROM dolt_at_notes('main') WHERE id = 1").one()["body"]).toBe(
      "ONE"
    );
    expect(() => fake.sql.exec("SELECT * FROM dolt_at_missing('HEAD')")).toThrow("table not found");
    expect(fake.sql.exec("SELECT message FROM dolt_log LIMIT 1").one()["message"]).toBe("upper");
    expect(fake.sql.exec("SELECT name FROM dolt_branches").toArray()).toEqual([{ name: "main" }]);
    expect(fake.sql.exec("SELECT dolt_hashof('HEAD') AS h").one()["h"]).toBe(
      fake.dolt.hashOf("HEAD")
    );
    expect(fake.sql.exec("SELECT active_branch() AS b").one()["b"]).toBe("main");
    fake.dolt.branch.create("b", { from: "HEAD~1" });
    expect(fake.sql.exec("SELECT dolt_merge_base('main', 'b') AS base").one()["base"]).toBe(
      fake.dolt.hashOf("b")
    );
    fake.sql.exec("INSERT INTO notes(id, body) VALUES (2, 'dirty')");
    expect(fake.sql.exec("SELECT table_name, status FROM dolt_status").toArray()).toEqual([
      { table_name: "notes", status: "modified" },
    ]);
  });

  it("refuses what it does not model instead of answering wrongly", async () => {
    const fake = await withNotes();
    for (const query of [
      "SELECT * FROM dolt_history_notes",
      "SELECT * FROM dolt_diff_notes",
      "SELECT * FROM dolt_blame_notes",
      "SELECT * FROM dolt_conflicts_notes",
      "SELECT * FROM dolt_diff_summary('HEAD', 'HEAD')",
    ]) {
      expect(() => fake.sql.exec(query), query).toThrow(FakeDoltUnsupportedError);
    }
    expect(() => fake.dolt.execute("SELECT 1", { nowMs: 1, seed: 1 })).toThrow(
      FakeDoltUnsupportedError
    );
    expect(() => fake.sql.exec("CREATE TABLE dolt_mine (a)")).toThrow("cannot be created");
    expect(() => fake.sql.exec("CREATE TABLE doltlite_mine (a)")).toThrow("cannot be created");
  });

  it("lists celld's and Dolt's own tables in sqlite_master, as the fork does", async () => {
    const fake = await withNotes();
    const names = fake.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray()
      .map((row) => row["name"]);
    expect(names).toEqual(expect.arrayContaining(["_cf_KV", "_cf_DOLT", "dolt_ignore", "notes"]));
  });

  it("re-renders table text once the creating transaction ends, as the engine does", async () => {
    const fake = await FakeDoltStorage.create();
    fake.storage.transactionSync(() => {
      fake.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT CHECK (length(v) < 9))");
      expect(fake.sql.exec("SELECT sql FROM sqlite_master WHERE name = 't'").one()["sql"]).toBe(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT CHECK (length(v) < 9))"
      );
    });
    expect(fake.sql.exec("SELECT sql FROM sqlite_master WHERE name = 't'").one()["sql"]).toBe(
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT CHECK(length(v) < 9))"
    );
    const exact = await FakeDoltStorage.create({ renderSchemaText: false });
    exact.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(exact.sql.exec("SELECT sql FROM sqlite_master WHERE name = 't'").one()["sql"]).toBe(
      "CREATE TABLE t (id INTEGER PRIMARY KEY)"
    );
  });

  it("answers dolt.query with INTEGER as bigint and refuses a write", async () => {
    const fake = await withNotes();
    insert(fake, 1, "one", 5);
    const result = fake.dolt.query("SELECT id, body, rank FROM notes");
    expect(result.columns).toEqual(["id", "body", "rank"]);
    expect(result.rows).toEqual([[1n, "one", 5n]]);
    expect(() => fake.dolt.query("DELETE FROM notes")).toThrowError(
      expect.objectContaining({ code: "SQL_PROFILE_VIOLATION" })
    );
  });

  it("reports the diff of two commits and of the working set", async () => {
    const fake = await withNotes();
    insert(fake, 1, "one");
    const one = fake.dolt.commit("one");
    insert(fake, 2, "two");
    fake.sql.exec("UPDATE notes SET body = 'uno' WHERE id = 1");
    fake.sql.exec("CREATE TABLE extra (a INTEGER)");
    const diff = fake.dolt.diff({ from: one });
    expect(diff.summary.map((entry) => [entry.toTable ?? entry.fromTable, entry.diffType])).toEqual(
      [
        ["extra", "added"],
        ["notes", "modified"],
      ]
    );
    expect(diff.patch.map((entry) => entry.statement)).toEqual(
      expect.arrayContaining([
        "CREATE TABLE extra(a INTEGER);",
        "INSERT INTO `notes` (`id`, `body`, `rank`) VALUES (2, 'two', NULL);",
        "UPDATE `notes` SET `id` = 1, `body` = 'uno', `rank` = NULL WHERE `id` = 1;",
      ])
    );
    expect(fake.dolt.diff({ from: one, table: "extra" }).summary).toHaveLength(1);
  });

  it("gives the reverse patch of a commit, which is how a class undoes one (revert is not exposed)", async () => {
    const fake = await withNotes();
    insert(fake, 1, "one");
    const one = fake.dolt.commit("one");
    insert(fake, 2, "two");
    fake.sql.exec("UPDATE notes SET body = 'uno' WHERE id = 1");
    fake.dolt.commit("two and uno");
    const reverse = fake.dolt.diff({ from: "HEAD", to: one });
    fake.storage.transactionSync(
      () => {
        for (const entry of reverse.patch) fake.sql.exec(entry.statement);
      },
      { commit: "undo two and uno" }
    );
    expect(bodies(fake)).toEqual(["one"]);
    expect(fake.dolt.diff({ from: one, to: "HEAD" }).summary).toEqual([]);
  });
});

describe("merge", () => {
  async function diverged() {
    const fake = await withNotes();
    insert(fake, 1, "base-one", 1);
    insert(fake, 2, "base-two", 2);
    fake.dolt.commit("base");
    fake.dolt.branch.create("side");
    return fake;
  }

  it("fast-forwards when ours is behind, and reports up to date", async () => {
    const fake = await diverged();
    fake.dolt.checkout("side");
    insert(fake, 3, "side-three");
    const tip = fake.dolt.commit("side three");
    fake.dolt.checkout("main");
    expect(fake.dolt.merge("side")).toEqual({ hash: tip, conflicts: [] });
    expect(bodies(fake)).toEqual(["base-one", "base-two", "side-three"]);
    expect(fake.dolt.merge("side", { resolve: () => undefined })).toMatchObject({
      upToDate: true,
      fastForward: false,
    });
    fake.dolt.branch.create("again", { from: "HEAD~1" });
    const forced = fake.dolt.merge("again", { resolve: () => undefined, fastForward: true });
    expect(forced.upToDate).toBe(true);
  });

  it("merges rows that changed on one side only, cell by cell, with a merge commit of two parents", async () => {
    const fake = await diverged();
    fake.dolt.checkout("side");
    fake.sql.exec("UPDATE notes SET rank = 20 WHERE id = 2");
    insert(fake, 4, "side-four");
    fake.dolt.commit("side");
    fake.dolt.checkout("main");
    fake.sql.exec("UPDATE notes SET body = 'main-two' WHERE id = 2");
    insert(fake, 3, "main-three");
    const mainTip = fake.dolt.commit("main");
    const result = fake.dolt.merge("side", { message: "merge side" });
    expect(result.hash).toMatch(/^[0-9a-v]{32}$/);
    expect(result.conflicts).toEqual([]);
    expect(fake.sql.exec("SELECT body, rank FROM notes WHERE id = 2").one()).toEqual({
      body: "main-two",
      rank: 20,
    });
    expect(bodies(fake)).toEqual(["base-one", "main-two", "main-three", "side-four"]);
    expect(fake.dolt.log({ limit: 1 })[0]?.message).toBe("merge side");
    expect(fake.sql.exec("SELECT dolt_merge_base('main', 'side') AS base").one()["base"]).toBe(
      fake.dolt.hashOf("side")
    );
    expect(fake.dolt.hashOf("HEAD~1")).toBe(mainTip);
    expect(fake.dolt.status()).toEqual([]);
  });

  it("rolls a conflicting plain merge back and names the tables", async () => {
    const fake = await diverged();
    fake.dolt.checkout("side");
    fake.sql.exec("UPDATE notes SET body = 'side' WHERE id = 1");
    fake.dolt.commit("side");
    fake.dolt.checkout("main");
    fake.sql.exec("UPDATE notes SET body = 'main' WHERE id = 1");
    const head = fake.dolt.commit("main");
    const result = fake.dolt.merge("side");
    expect(result).toEqual({ hash: null, conflicts: [{ table: "notes", conflicts: 1 }] });
    expect(fake.dolt.hashOf("HEAD")).toBe(head);
    expect(bodies(fake)).toEqual(["main", "base-two"]);
    expect(fake.dolt.status()).toEqual([]);
  });

  it("resolves conflicts inside the merge: keep ours, take theirs, or write the row", async () => {
    const fake = await diverged();
    insert(fake, 3, "base-three");
    insert(fake, 4, "base-four");
    fake.dolt.commit("more base");
    fake.dolt.branch.create("feature");
    fake.dolt.checkout("feature");
    fake.sql.exec("UPDATE notes SET body = 'feature-1' WHERE id = 1");
    fake.sql.exec("UPDATE notes SET body = 'feature-3' WHERE id = 3");
    fake.sql.exec("DELETE FROM notes WHERE id = 4");
    fake.dolt.commit("feature");
    fake.dolt.checkout("main");
    fake.sql.exec("UPDATE notes SET body = 'main-1' WHERE id = 1");
    fake.sql.exec("UPDATE notes SET body = 'main-3' WHERE id = 3");
    fake.sql.exec("UPDATE notes SET body = 'main-4' WHERE id = 4");
    fake.dolt.commit("main");
    let seen: string[] = [];
    const baseHash = fake.dolt.hashOf("HEAD~1");
    const result = fake.dolt.merge("feature", {
      message: "merge feature",
      author: "Ann <ann@example.com>",
      date: 1_700_000_000_000,
      resolve(merge) {
        seen = merge.conflicts.map(
          (row) => `${row.table}:${String(row.key["id"])}:${row.ourChange}/${row.theirChange}`
        );
        expect(merge.violations).toEqual([]);
        expect(merge.base).toBe(baseHash);
        for (const row of merge.conflicts) {
          if (row.key["id"] === 1) {
            expect(row.base?.["body"]).toBe("base-one");
            expect(row.ours?.["body"]).toBe("main-1");
            expect(row.theirs?.["body"]).toBe("feature-1");
            row.keepOurs();
          } else if (row.key["id"] === 3) {
            fake.sql.exec(
              "UPDATE notes SET body = ? WHERE id = 3",
              `${String(row.ours?.["body"])}+${String(row.theirs?.["body"])}`
            );
            row.resolve();
          } else {
            expect(row.theirs).toBeNull();
            row.takeTheirs();
          }
        }
      },
    });
    expect(seen).toEqual([
      "notes:1:modified/modified",
      "notes:3:modified/modified",
      "notes:4:modified/removed",
    ]);
    expect(result).toMatchObject({
      conflicts: [],
      fastForward: false,
      upToDate: false,
      resolved: { conflicts: 3, violations: 0 },
    });
    expect(bodies(fake)).toEqual(["main-1", "base-two", "main-3+feature-3"]);
    expect(fake.dolt.log({ limit: 1 })[0]).toMatchObject({
      message: "merge feature",
      committer: "Ann",
      date: "2023-11-14T22:13:20.000Z",
    });
  });

  it("calls the resolver once even when Dolt finds nothing to resolve, so it can add its own rows", async () => {
    const fake = await diverged();
    fake.sql.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, note TEXT)");
    fake.dolt.commit("events");
    fake.dolt.branch.create("clean");
    fake.dolt.checkout("clean");
    insert(fake, 9, "clean-nine");
    fake.dolt.commit("clean");
    fake.dolt.checkout("main");
    insert(fake, 8, "main-eight");
    fake.dolt.commit("diverge");
    let calls = 0;
    const result = fake.dolt.merge("clean", {
      resolve(merge) {
        calls++;
        expect(merge.conflicts).toEqual([]);
        fake.sql.exec("INSERT INTO events VALUES (1, 'integration')");
      },
    });
    expect(calls).toBe(1);
    expect(result.resolved).toEqual({ conflicts: 0, violations: 0 });
    expect(fake.sql.exec("SELECT note FROM events").toArray()).toEqual([{ note: "integration" }]);
    expect(bodies(fake)).toContain("clean-nine");
  });

  it("rolls everything back on a throw, a promise, or an unanswered conflict", async () => {
    const fake = await diverged();
    fake.dolt.checkout("side");
    fake.sql.exec("UPDATE notes SET body = 'side' WHERE id = 1");
    fake.dolt.commit("side");
    fake.dolt.checkout("main");
    fake.sql.exec("UPDATE notes SET body = 'main' WHERE id = 1");
    const head = fake.dolt.commit("main");
    const intact = () => {
      expect(fake.dolt.hashOf("HEAD")).toBe(head);
      expect(bodies(fake)).toEqual(["main", "base-two"]);
      expect(fake.dolt.status()).toEqual([]);
      // A merge that failed leaves no transaction open and can run again.
      expect(() => fake.dolt.status()).not.toThrow();
    };
    expect(() =>
      fake.dolt.merge("side", {
        resolve(merge) {
          fake.sql.exec("INSERT INTO notes(id, body) VALUES (50, 'written then thrown away')");
          merge.conflicts[0]?.resolve();
          throw new Error("resolver failed");
        },
      })
    ).toThrow("resolver failed");
    intact();
    expect(() => fake.dolt.merge("side", { resolve: (() => Promise.resolve()) as never })).toThrow(
      "synchronous"
    );
    intact();
    expect(() => fake.dolt.merge("side", { resolve: () => undefined })).toThrow("unanswered");
    intact();
    expect(() =>
      fake.dolt.merge("side", {
        message: "m",
        author: "bad",
        resolve: (merge) => merge.conflicts[0]?.keepOurs(),
      })
    ).toThrow("Name <email>");
    intact();
    expect(() =>
      fake.dolt.merge("side", { resolve: (merge) => merge.conflicts[0]?.keepOurs() })
    ).not.toThrow();
  });

  it("refuses a resolver that is not a function, an answer after the resolver returned, and a dirty working set", async () => {
    const fake = await diverged();
    fake.dolt.checkout("side");
    fake.sql.exec("UPDATE notes SET body = 'side' WHERE id = 1");
    fake.dolt.commit("side");
    fake.dolt.checkout("main");
    fake.sql.exec("UPDATE notes SET body = 'main' WHERE id = 1");
    expect(() => fake.dolt.merge("side", { resolve: "nope" as never })).toThrow(
      "must be a function"
    );
    expect(() => fake.dolt.merge("side", { resolve: () => undefined })).toThrow(
      "uncommitted changes"
    );
    fake.dolt.commit("main");
    let late: (() => void) | undefined;
    expect(() =>
      fake.dolt.merge("side", {
        resolve(merge) {
          late = () => merge.conflicts[0]?.resolve();
        },
      })
    ).toThrow("unanswered");
    expect(late).toThrow("can no longer be answered");
  });

  it("hands unique-index violations to the resolver", async () => {
    const fake = await FakeDoltStorage.create();
    fake.sql.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL)");
    fake.sql.exec("CREATE UNIQUE INDEX files_path ON files (path)");
    fake.dolt.commit("files");
    fake.dolt.branch.create("side");
    fake.sql.exec("INSERT INTO files VALUES ('a', 'src/x.ts')");
    fake.dolt.commit("main places x");
    fake.dolt.checkout("side");
    fake.sql.exec("INSERT INTO files VALUES ('b', 'src/x.ts')");
    fake.dolt.commit("side places x");
    fake.dolt.checkout("main");
    expect(fake.dolt.merge("side")).toEqual({
      hash: null,
      conflicts: [{ table: "files", conflicts: 2 }],
    });
    expect(fake.sql.exec("SELECT count(*) AS n FROM files").one()["n"]).toBe(1);
    expect(() => fake.dolt.merge("side", { resolve: () => undefined })).toThrow("unanswered");
    const result = fake.dolt.merge("side", {
      resolve(merge) {
        expect(merge.conflicts).toEqual([]);
        expect(merge.violations.map((v) => [v.table, v.type, v.row["id"]])).toEqual([
          ["files", "unique index", "a"],
          ["files", "unique index", "b"],
        ]);
        fake.sql.exec("UPDATE files SET path = 'src/x-2.ts' WHERE id = 'b'");
        for (const violation of merge.violations) violation.resolve();
      },
    });
    expect(result.resolved).toEqual({ conflicts: 0, violations: 2 });
    expect(fake.sql.exec("SELECT path FROM files ORDER BY id").toArray()).toEqual([
      { path: "src/x.ts" },
      { path: "src/x-2.ts" },
    ]);
    // A violation answered without fixing the rows fails the merge.
    const again = await FakeDoltStorage.create();
    again.sql.exec("CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL)");
    again.sql.exec("CREATE UNIQUE INDEX files_path ON files (path)");
    again.dolt.commit("files");
    again.dolt.branch.create("side");
    again.sql.exec("INSERT INTO files VALUES ('a', 'p')");
    again.dolt.commit("a");
    again.dolt.checkout("side");
    again.sql.exec("INSERT INTO files VALUES ('b', 'p')");
    again.dolt.commit("b");
    again.dolt.checkout("main");
    expect(() =>
      again.dolt.merge("side", { resolve: (merge) => merge.violations.forEach((v) => v.resolve()) })
    ).toThrow("still has duplicates");
    expect(again.sql.exec("SELECT count(*) AS n FROM files").one()["n"]).toBe(1);
  });

  it("fails on a schema conflict, takes a one-sided schema change, and keeps local tables", async () => {
    const fake = await withNotes({ doltLocal: ["local_%"] });
    fake.sql.exec("CREATE TABLE local_marks (id INTEGER PRIMARY KEY)");
    insert(fake, 1, "one");
    fake.dolt.commit("one");
    fake.dolt.branch.create("side");
    fake.dolt.branch.create("both");
    fake.dolt.checkout("side");
    fake.sql.exec("ALTER TABLE notes ADD COLUMN tag TEXT");
    fake.sql.exec("UPDATE notes SET tag = 'x'");
    fake.dolt.commit("side adds tag");
    fake.dolt.checkout("both");
    fake.sql.exec("ALTER TABLE notes ADD COLUMN other TEXT");
    fake.dolt.commit("both adds other");
    fake.dolt.checkout("main");
    insert(fake, 2, "main-two");
    fake.dolt.commit("main two");
    fake.sql.exec("INSERT INTO local_marks VALUES (7)");
    expect(() => fake.dolt.merge("side", { resolve: () => undefined })).not.toThrow();
    expect(fake.sql.exec("SELECT tag FROM notes ORDER BY id").toArray()).toEqual([
      { tag: "x" },
      { tag: null },
    ]);
    expect(fake.sql.exec("SELECT id FROM local_marks").toArray()).toEqual([{ id: 7 }]);
    expect(() => fake.dolt.merge("both", { resolve: () => undefined })).toThrow(
      "schema conflicts in notes"
    );
  });
});

describe("forks and restarts", () => {
  it("forks a new identity: history kept, local tables emptied, remotes and grants cleared", async () => {
    const network = new FakeDoltNetwork();
    const source = await withNotes({ doltLocal: ["local_%"], network, id: "Graph:src" });
    source.sql.exec("CREATE TABLE local_marks (id INTEGER PRIMARY KEY)");
    insert(source, 1, "one");
    const one = source.dolt.commit("one");
    insert(source, 2, "two");
    source.dolt.commit("two");
    source.sql.exec("INSERT INTO local_marks VALUES (1)");
    (source.dolt as DoltRemoteStorage).remote.grant({ fetch: true });
    const fork = await source.fork({ at: one, id: "Graph:fork" });
    expect(fork.id).toBe("Graph:fork");
    expect(bodies(fork)).toEqual(["one"]);
    expect(fork.dolt.log().map((entry) => entry.message)).toEqual([
      "one",
      "create notes",
      expect.stringMatching(/^Initialize/),
    ]);
    expect(fork.sql.exec("SELECT count(*) AS n FROM local_marks").one()["n"]).toBe(0);
    expect((fork.dolt as DoltRemoteStorage).remote.grants()).toEqual([]);
    expect((fork.dolt as DoltRemoteStorage).remote.list()).toEqual([]);
    // The fork and its source are independent.
    insert(fork, 5, "fork-only");
    expect(bodies(source)).toEqual(["one", "two"]);
    // A fork without `at` keeps the checked-out branch's head.
    const whole = await source.fork();
    expect(bodies(whole)).toEqual(["one", "two"]);
  });

  it("restarts with committed and autocommitted state, losing only an open transaction", async () => {
    const fake = await withNotes();
    insert(fake, 1, "committed");
    fake.dolt.commit("one");
    insert(fake, 2, "autocommitted but uncommitted");
    fake.dolt.branch.create("side");
    fake.dolt.checkout("side");
    const restarted = await fake.restart();
    expect(restarted.dolt.branch.current()).toBe("side");
    expect(restarted.dolt.log()[0]?.message).toBe("one");
    expect(bodies(restarted)).toEqual(["committed"]);
    // main's uncommitted row was saved with its working set and survives the restart.
    restarted.dolt.checkout("main");
    expect(bodies(restarted)).toEqual(["committed", "autocommitted but uncommitted"]);
    expect(restarted.dolt.branch.list().map((branch) => branch.name)).toEqual(["main", "side"]);
    expect(() => fake.storage.transactionSync(() => fake.exportState())).toThrow(
      /cannot run inside/
    );
  });
});

describe("remotes (F7)", () => {
  async function pair() {
    const network = new FakeDoltNetwork();
    const graph = await withNotes({ network, id: "Graph:main" });
    insert(graph, 1, "one");
    graph.dolt.commit("one");
    const agent = await graph.fork({ id: "Graph:agent-a" });
    const source = graph.dolt as DoltRemoteStorage;
    const holder = agent.dolt as DoltRemoteStorage;
    return { network, graph, agent, source, holder };
  }

  it("fetches the branches a grant shows into tracking branches and changes nothing else", async () => {
    const { graph, agent, source, holder } = await pair();
    graph.dolt.branch.create("private");
    insert(graph, 2, "two");
    const tip = graph.dolt.commit("two");
    const grant = source.remote.grant({ label: "agent-a", fetch: true, branches: ["main"] });
    expect(source.remote.grants()).toEqual([
      expect.not.objectContaining({ token: expect.anything() }),
    ]);
    holder.remote.add("origin", { id: graph.id, token: grant.token });
    expect(holder.remote.list()).toEqual([{ name: "origin", ref: "Graph:main" }]);
    const fetched = await holder.fetch("origin");
    expect(fetched).toMatchObject({ remote: "origin", branches: { main: tip } });
    expect(holder.remote.branches()).toEqual([{ name: "origin/main", hash: tip }]);
    expect(agent.dolt.hashOf("origin/main")).toBe(tip);
    expect(bodies(agent)).toEqual(["one"]);
    expect(agent.dolt.hashOf("main")).not.toBe(tip);
    await expect(holder.fetch("origin", { branches: ["private"] })).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_NOT_FOUND",
    });
  });

  it("refuses a missing, wrong, revoked, expired or wrong-peer grant", async () => {
    let now = 1_000;
    const network = new FakeDoltNetwork();
    const graph = await withNotes({ network, id: "Graph:main", now: () => now });
    const agent = await graph.fork({ id: "Graph:a" });
    const source = graph.dolt as DoltRemoteStorage;
    const holder = agent.dolt as DoltRemoteStorage;
    holder.remote.add("origin", { id: graph.id, token: "not a token" });
    await expect(holder.fetch("origin")).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_FORBIDDEN",
    });
    const revoked = source.remote.grant({ fetch: true });
    holder.remote.add("origin", { id: graph.id, token: revoked.token });
    await holder.fetch("origin");
    source.remote.revoke(revoked.id);
    await expect(holder.fetch("origin")).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_FORBIDDEN",
    });
    const expiring = source.remote.grant({ fetch: true, expiresAt: 5_000 });
    holder.remote.add("origin", { id: graph.id, token: expiring.token });
    await holder.fetch("origin");
    now = 6_000;
    await expect(holder.fetch("origin")).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_FORBIDDEN",
    });
    const bound = source.remote.grant({ fetch: true, peer: "peer-a" });
    holder.remote.add("origin", { id: graph.id, token: bound.token });
    await expect(holder.fetch("origin")).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_FORBIDDEN",
    });
    const request = new TextEncoder().encode(JSON.stringify({ op: "refs", token: bound.token }));
    expect(
      JSON.parse(new TextDecoder().decode(source.remote.serve(request, { peer: "peer-a" })))
    ).toMatchObject({ ok: true });
    expect(
      JSON.parse(new TextDecoder().decode(source.remote.serve(request, { peer: "peer-b" })))
    ).toMatchObject({ ok: false, code: "ERR_DOLT_REMOTE_FORBIDDEN" });
    expect(
      JSON.parse(new TextDecoder().decode(source.remote.serve(new Uint8Array([1, 2, 3]))))
    ).toMatchObject({
      code: "ERR_DOLT_REMOTE_BAD_REQUEST",
    });
  });

  it("pushes only fast-forwards, only where the grant allows, and tells the stale pusher to merge", async () => {
    const { graph, agent, source, holder } = await pair();
    const other = await graph.fork({ id: "Graph:agent-b" });
    const grantA = source.remote.grant({ fetch: true, push: ["main", "pub/a/*"] });
    const grantB = source.remote.grant({ fetch: true, push: ["main"] });
    holder.remote.add("origin", { id: graph.id, token: grantA.token });
    const b = other.dolt as DoltRemoteStorage;
    b.remote.add("origin", { id: graph.id, token: grantB.token });

    insert(agent, 10, "from-a");
    agent.dolt.commit("a work");
    expect(await holder.push("origin", "main")).toMatchObject({
      branch: "main",
      created: false,
      unchanged: false,
    });
    expect(bodies(graph)).toEqual(["one", "from-a"]);
    const pushedByA = graph.dolt.hashOf("main");
    expect(await holder.push("origin", "main")).toMatchObject({ unchanged: true });
    await expect(holder.push("origin", "main", { to: "secret" })).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_FORBIDDEN",
    });
    expect(await holder.push("origin", "main", { to: "pub/a/work" })).toMatchObject({
      created: true,
    });
    expect(graph.dolt.branch.list().map((branch) => branch.name)).toEqual(["main", "pub/a/work"]);

    // B did not see A's push, so its push is not a fast-forward.
    insert(other, 20, "from-b");
    other.dolt.commit("b work");
    const stale = await b.push("origin", "main").catch((error: unknown) => error);
    expect(isDoltRemoteError(stale, "ERR_DOLT_NON_FAST_FORWARD")).toBe(true);
    // The documented recovery: pull with a resolver, then push (now a fast-forward).
    const pulled = await b.pull("origin", "main", {
      message: "merge main",
      resolve: (merge) => expect(merge.conflicts).toEqual([]),
    });
    expect(pulled).toMatchObject({ fastForward: false, fetched: { remote: "origin" } });
    expect(await b.push("origin", "main")).toMatchObject({ unchanged: false });
    expect(bodies(graph)).toEqual(["one", "from-a", "from-b"]);
    // Accepted pushes leave bookkeeping refs that revoking the grant removes.
    expect(graph.dolt.hashOf(`pushed-${grantA.id}/main`)).toBe(pushedByA);
    source.remote.revoke(grantA.id);
    expect(() => graph.dolt.hashOf(`pushed-${grantA.id}/main`)).toThrow("unknown ref");
    insert(agent, 11, "late");
    agent.dolt.commit("late");
    await expect(holder.push("origin", "main")).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_FORBIDDEN",
    });
  });

  it("refuses a push to a checked-out branch with uncommitted changes", async () => {
    const { graph, agent, source, holder } = await pair();
    const grant = source.remote.grant({ fetch: true, push: ["main"] });
    holder.remote.add("origin", { id: graph.id, token: grant.token });
    insert(agent, 10, "from-agent");
    agent.dolt.commit("agent");
    insert(graph, 99, "uncommitted on the target");
    await expect(holder.push("origin", "main")).rejects.toMatchObject({
      code: "ERR_DOLT_TARGET_DIRTY",
    });
    graph.dolt.commit("target commits first");
    await expect(holder.push("origin", "main")).rejects.toMatchObject({
      code: "ERR_DOLT_NON_FAST_FORWARD",
    });
  });

  it("resolves a conflicting pull with the F1 resolver, then pushes the merge as a fast-forward", async () => {
    const { graph, agent, source, holder } = await pair();
    const grant = source.remote.grant({ fetch: true, push: ["main"] });
    holder.remote.add("origin", { id: graph.id, token: grant.token });
    graph.sql.exec("UPDATE notes SET body = 'graph' WHERE id = 1");
    graph.dolt.commit("graph edit");
    agent.sql.exec("UPDATE notes SET body = 'agent' WHERE id = 1");
    agent.dolt.commit("agent edit");
    await expect(holder.push("origin", "main")).rejects.toMatchObject({
      code: "ERR_DOLT_NON_FAST_FORWARD",
    });
    const pulled = await holder.pull("origin", "main", {
      message: "merge main",
      resolve(merge) {
        for (const row of merge.conflicts) {
          agent.sql.exec(
            "UPDATE notes SET body = ? WHERE id = ?",
            "resolved",
            Number(row.key["id"])
          );
          row.resolve();
        }
      },
    });
    expect((pulled as DoltResolvingMergeResult).resolved).toEqual({ conflicts: 1, violations: 0 });
    await holder.push("origin", "main");
    expect(bodies(graph)).toEqual(["resolved"]);
    expect(graph.dolt.hashOf("main")).toBe(agent.dolt.hashOf("main"));
  });

  it("carries requests over any transport, which is how a facet's root relays them", async () => {
    const { graph, agent, source, holder } = await pair();
    const grant = source.remote.grant({ fetch: true });
    holder.remote.add("origin", { id: "Facet:not-routable", token: grant.token });
    const seen: string[] = [];
    const transport = async (request: Uint8Array) => {
      seen.push((JSON.parse(new TextDecoder().decode(request)) as { op: string }).op);
      return source.remote.serve(request);
    };
    insert(graph, 2, "two");
    graph.dolt.commit("two");
    await holder.fetch("origin", { transport });
    expect(seen).toEqual(["fetch"]);
    expect(agent.dolt.hashOf("origin/main")).toBe(graph.dolt.hashOf("main"));
    await expect(holder.fetch("origin")).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_NOT_FOUND",
    });
  });

  it("serves nothing for a class that did not declare doltRemotes, and has no remote surface", async () => {
    const network = new FakeDoltNetwork();
    const closed = await withNotes({ network, id: "Closed:1", remotes: false });
    expect((closed.dolt as Partial<DoltRemoteStorage>).remote).toBeUndefined();
    const agent = await withNotes({ network, id: "Graph:a" });
    (agent.dolt as DoltRemoteStorage).remote.add("origin", { id: "Closed:1", token: "x" });
    await expect((agent.dolt as DoltRemoteStorage).fetch("origin")).rejects.toMatchObject({
      code: "ERR_DOLT_REMOTE_FORBIDDEN",
    });
  });
});
