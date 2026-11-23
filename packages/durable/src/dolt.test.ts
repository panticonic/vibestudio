import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOLT_GC_POLICY,
  DOLT_FRAMEWORK_LOCAL_PATTERNS,
  DoltDriftError,
  assertCleanWorkingSet,
  collectDoltGarbage,
  committedTransaction,
  committedTransactionSync,
  dirtyApplicationTables,
  doltGcDue,
  doltGcThreshold,
  doltLocalPatternProblem,
  doltLocalPatterns,
  doltRemotesOf,
  doltStorageOf,
  isDoltRemoteError,
  isDoltSystemTable,
  matchesDoltLocalPattern,
  type DoltCapableStorage,
  type DoltStorage,
} from "./dolt.js";
import { FakeDoltStorage } from "./test-dolt.js";

describe("the Dolt surface helpers", () => {
  it("finds the store of a Dolt cell and none on a SQLite cell", async () => {
    const fake = await FakeDoltStorage.create();
    expect(doltStorageOf(fake.storage)).toBe(fake.dolt);
    expect(doltStorageOf({})).toBeNull();
    expect(doltStorageOf(null)).toBeNull();
    expect(doltRemotesOf(fake.storage)).not.toBeNull();
    const without = await FakeDoltStorage.create({ remotes: false });
    expect(doltStorageOf(without.storage)).not.toBeNull();
    expect(doltRemotesOf(without.storage)).toBeNull();
  });

  it("classifies remote errors by their stable code", () => {
    const error = Object.assign(new Error("x"), { code: "ERR_DOLT_NON_FAST_FORWARD" });
    expect(isDoltRemoteError(error)).toBe(true);
    expect(isDoltRemoteError(error, "ERR_DOLT_NON_FAST_FORWARD")).toBe(true);
    expect(isDoltRemoteError(error, "ERR_DOLT_TARGET_DIRTY")).toBe(false);
    expect(isDoltRemoteError(new Error("x"))).toBe(false);
    expect(isDoltRemoteError("ERR_DOLT_NON_FAST_FORWARD")).toBe(false);
  });

  it("names the tables celld and Dolt own", () => {
    for (const name of [
      "_cf_KV",
      "_litestream_seq",
      "dolt_ignore",
      "doltlite_x",
      "sqlite_master",
    ]) {
      expect(isDoltSystemTable(name)).toBe(true);
    }
    for (const name of ["notes", "state", "vsl_direct_rpc_nonces", "_vibestudio_schema"]) {
      expect(isDoltSystemTable(name)).toBe(false);
    }
  });
});

describe("doltLocal patterns", () => {
  it("accepts what the fork accepts", () => {
    for (const pattern of ["outbox_%", "local_%", "state", "vsl_%", "a%b", "Receipts"]) {
      expect(doltLocalPatternProblem(pattern)).toBeNull();
    }
  });

  it("refuses patterns that could cover a table celld or Dolt owns, and malformed ones", () => {
    for (const pattern of [
      "%",
      "d%",
      "do%",
      "dolt_%",
      "dolt_x",
      "doltlite_%",
      "s%",
      "sqlite_%",
      "_cf_%",
      "_x",
      "1abc",
      "a-b",
      "",
      `a${"b".repeat(64)}`,
    ]) {
      expect(doltLocalPatternProblem(pattern), pattern).not.toBeNull();
    }
  });

  it("merges the framework patterns with a class's and validates them", () => {
    expect(doltLocalPatterns(["outbox_%"])).toEqual([...DOLT_FRAMEWORK_LOCAL_PATTERNS, "outbox_%"]);
    expect(doltLocalPatterns()).toEqual([...DOLT_FRAMEWORK_LOCAL_PATTERNS]);
    expect(() => doltLocalPatterns(["dolt_%"])).toThrow(/invalid doltLocal pattern/);
  });

  it("matches names with % as any run, case-sensitively", () => {
    expect(matchesDoltLocalPattern("outbox_a", "outbox_%")).toBe(true);
    expect(matchesDoltLocalPattern("outbox_", "outbox_%")).toBe(true);
    expect(matchesDoltLocalPattern("Outbox_a", "outbox_%")).toBe(false);
    expect(matchesDoltLocalPattern("state", "state")).toBe(true);
    expect(matchesDoltLocalPattern("states", "state")).toBe(false);
    expect(matchesDoltLocalPattern("a.b", "a_b")).toBe(false);
  });
});

describe("committedTransaction", () => {
  async function notes() {
    const fake = await FakeDoltStorage.create();
    fake.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    fake.dolt.commit("create notes");
    return fake;
  }

  it("writes and commits in one step, rendering the message from the result", async () => {
    const fake = await notes();
    const id = committedTransactionSync(
      fake.storage,
      (result) => `add note ${result}`,
      () => {
        fake.sql.exec("INSERT INTO notes(body) VALUES (?)", "one");
        return Number(fake.sql.exec("SELECT max(id) AS id FROM notes").one()["id"]);
      }
    );
    expect(id).toBe(1);
    expect(fake.dolt.log({ limit: 1 })[0]?.message).toBe("add note 1");
    expect(fake.dolt.status()).toEqual([]);
  });

  it("leaves no rows and no commit when the callback throws", async () => {
    const fake = await notes();
    const head = fake.dolt.hashOf("HEAD");
    expect(() =>
      committedTransactionSync(fake.storage, "never", () => {
        fake.sql.exec("INSERT INTO notes(body) VALUES ('doomed')");
        throw new Error("callback failed");
      })
    ).toThrow("callback failed");
    expect(fake.sql.exec("SELECT count(*) AS n FROM notes").one()["n"]).toBe(0);
    expect(fake.dolt.hashOf("HEAD")).toBe(head);
  });

  it("leaves the writes uncommitted when the message function returns null", async () => {
    const fake = await notes();
    const head = fake.dolt.hashOf("HEAD");
    committedTransactionSync(
      fake.storage,
      () => null,
      () => {
        fake.sql.exec("INSERT INTO notes(body) VALUES ('kept')");
      }
    );
    expect(fake.dolt.hashOf("HEAD")).toBe(head);
    expect(fake.dolt.status().map((entry) => entry.table)).toEqual(["notes"]);
  });

  it("rolls the writes back when the commit itself is refused", async () => {
    const fake = await notes();
    expect(() =>
      committedTransactionSync(fake.storage, "nothing changed", () => undefined)
    ).toThrow("nothing to commit");
    expect(() =>
      committedTransactionSync(fake.storage, { message: "bad author", author: "no-email" }, () => {
        fake.sql.exec("INSERT INTO notes(body) VALUES ('x')");
      })
    ).toThrow("author must look like");
    expect(fake.sql.exec("SELECT count(*) AS n FROM notes").one()["n"]).toBe(0);
  });

  it("is a plain transaction on a SQLite cell, where the commit point is a no-op", () => {
    const transactionSync = vi.fn(<T>(callback: () => T) => callback());
    const transaction = vi.fn(async <T>(callback: () => Promise<T>) => callback());
    const storage = { transactionSync, transaction } as unknown as DoltCapableStorage;
    expect(committedTransactionSync(storage, "ignored", () => 7)).toBe(7);
    expect(transactionSync).toHaveBeenCalledWith(expect.any(Function));
    expect(transactionSync.mock.calls[0]).toHaveLength(1);
    return committedTransaction(storage, "ignored", async () => 9).then((value) => {
      expect(value).toBe(9);
      expect(transaction.mock.calls[0]).toHaveLength(1);
    });
  });

  it("has an asynchronous form that commits when the callback resolves", async () => {
    const fake = await notes();
    await committedTransaction(
      fake.storage,
      (n: number) => `async ${n}`,
      async () => {
        fake.sql.exec("INSERT INTO notes(body) VALUES ('a')");
        await Promise.resolve();
        return 1;
      }
    );
    expect(fake.dolt.log({ limit: 1 })[0]?.message).toBe("async 1");
    await expect(
      committedTransaction(fake.storage, "x", async () => {
        fake.sql.exec("INSERT INTO notes(body) VALUES ('b')");
        throw new Error("late failure");
      })
    ).rejects.toThrow("late failure");
    expect(fake.sql.exec("SELECT count(*) AS n FROM notes").one()["n"]).toBe(1);
  });

  it("refuses a nested transaction on a Dolt cell, as the fork does", async () => {
    const fake = await notes();
    expect(() =>
      fake.storage.transactionSync(() => {
        committedTransactionSync(fake.storage, "inner", () => {
          fake.sql.exec("INSERT INTO notes(body) VALUES ('x')");
        });
      })
    ).toThrow(/only for the outermost transaction/);
    expect(fake.sql.exec("SELECT count(*) AS n FROM notes").one()["n"]).toBe(0);
  });
});

describe("the drift check", () => {
  it("ignores system tables and reports dirty application tables", async () => {
    const fake = await FakeDoltStorage.create({ doltLocal: ["local_%"] });
    fake.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
    fake.sql.exec("CREATE TABLE local_marks (id INTEGER PRIMARY KEY)");
    expect(() => assertCleanWorkingSet(fake.dolt)).toThrow(DoltDriftError);
    expect(dirtyApplicationTables(fake.dolt).map((entry) => entry.table)).toEqual(["notes"]);
    fake.dolt.commit("create");
    fake.sql.exec("INSERT INTO local_marks VALUES (1)");
    expect(() => assertCleanWorkingSet(fake.dolt)).not.toThrow();
    const stub = {
      status: () => [{ table: "dolt_ignore", staged: 0, status: "modified" }],
    } as unknown as DoltStorage;
    expect(() => assertCleanWorkingSet(stub)).not.toThrow();
  });
});

describe("the compaction schedule of a Dolt cell (§6.11.8)", () => {
  const memoryOf = () => {
    const map = new Map<string, string>();
    return {
      map,
      get: (key: string) => map.get(key) ?? null,
      set: (k: string, v: string) => void map.set(k, v),
    };
  };
  async function cell(commits: number) {
    const fake = await FakeDoltStorage.create();
    fake.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    fake.dolt.commit("create notes");
    for (let i = 0; i < commits; i++) {
      fake.sql.exec("INSERT OR REPLACE INTO notes(id, body) VALUES (1, ?)", `v${i}`);
      fake.dolt.commit(`note ${i}`);
    }
    return fake;
  }
  const policy = { minCommits: 5, growth: 0.5 };

  it("is due after the minimum number of commits, and not before", async () => {
    const memory = memoryOf();
    const young = await cell(2);
    expect(doltGcDue(young.dolt, memory, policy)).toBe(false);
    const grown = await cell(6);
    expect(doltGcDue(grown.dolt, memory, policy)).toBe(true);
    expect(doltGcThreshold(memory, DEFAULT_DOLT_GC_POLICY)).toBe(DEFAULT_DOLT_GC_POLICY.minCommits);
  });

  it("collects, remembers where, and is then due again after half as many commits as it held", async () => {
    const memory = memoryOf();
    const fake = await cell(10);
    const gc = vi.spyOn(fake.dolt, "gc");
    const outcome = collectDoltGarbage(fake.dolt, memory, policy);
    expect(outcome.ran).toBe(true);
    expect(gc).toHaveBeenCalledOnce();
    expect(memory.map.get("__dolt_gc_head")).toBe(fake.dolt.hashOf("HEAD"));
    const held = Number(memory.map.get("__dolt_gc_commits"));
    expect(held).toBeGreaterThanOrEqual(11);
    // Not due again until half the commits it then held have landed (the schedule grows with the history).
    const wanted = Math.ceil(held * policy.growth);
    expect(doltGcThreshold(memory, policy)).toBe(wanted);
    for (let i = 0; i < wanted - 1; i++) {
      fake.sql.exec("INSERT OR REPLACE INTO notes(id, body) VALUES (1, ?)", `later${i}`);
      fake.dolt.commit(`later ${i}`);
    }
    expect(collectDoltGarbage(fake.dolt, memory, policy)).toEqual({
      ran: false,
      reason: "not-due",
    });
    fake.sql.exec("INSERT OR REPLACE INTO notes(id, body) VALUES (1, 'last')");
    fake.dolt.commit("last");
    expect(collectDoltGarbage(fake.dolt, memory, policy).ran).toBe(true);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it("leaves a cell with uncommitted application changes alone, and collects it once they are committed", async () => {
    const memory = memoryOf();
    const fake = await cell(8);
    const gc = vi.spyOn(fake.dolt, "gc");
    fake.sql.exec("INSERT OR REPLACE INTO notes(id, body) VALUES (1, 'pending')");
    expect(collectDoltGarbage(fake.dolt, memory, policy)).toEqual({ ran: false, reason: "dirty" });
    expect(gc).not.toHaveBeenCalled();
    fake.dolt.commit("keep pending");
    expect(collectDoltGarbage(fake.dolt, memory, policy).ran).toBe(true);
  });
});
