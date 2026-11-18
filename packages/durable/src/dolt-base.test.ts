import { describe, expect, it, vi } from "vitest";
import { DurableObjectBase } from "./index.js";
import { DoltDriftError, doltLocalPatterns } from "./dolt.js";
import { FakeDoltStorage } from "./test-dolt.js";
import { createTestDO } from "./test-utils.js";

class NotesDO extends DurableObjectBase {
  protected createTables(): void {
    this.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE local_marks (id INTEGER PRIMARY KEY, note TEXT)");
  }
  protected override requiredTables(): readonly string[] {
    return ["notes", "local_marks"];
  }
  add(body: string): number {
    return this.committedTransaction(
      (id) => `add note ${id}`,
      () => {
        this.sql.exec("INSERT INTO notes(body) VALUES (?)", body);
        return Number(this.sql.exec("SELECT max(id) AS id FROM notes").one()["id"]);
      }
    );
  }
  addUncommitted(body: string): void {
    this.sql.exec("INSERT INTO notes(body) VALUES (?)", body);
  }
  noopTransaction(): void {
    this.transactionSync(() => {
      this.sql.exec("SELECT count(*) FROM notes").toArray();
    });
  }
  mark(note: string): void {
    this.sql.exec("INSERT INTO local_marks(note) VALUES (?)", note);
  }
  check(): void {
    this.assertCleanWorkingSet();
  }
  engine(): boolean {
    return this.dolt !== null;
  }
  compaction() {
    return this.doltGcState();
  }
  /** Admit a call the way the inbound envelope does, then run `fn` as that call. */
  runCall<T>(
    nonce: string,
    mutating: boolean,
    fn: () => T
  ): { result: T; persisted: boolean | null } {
    const internals = this as unknown as {
      directCalls: {
        admit(
          a: { nonce: string; issuedAt: number; expiresAt: number },
          mutating: boolean
        ): {
          ok: boolean;
          pending: { persisted: boolean; baseline: number | null } | null;
          reason?: string;
        };
      };
      totalChanges(): number;
      invocationContext: { run<R>(context: unknown, operation: () => R): R };
    };
    const now = Date.now();
    const admitted = internals.directCalls.admit(
      { nonce, issuedAt: now + 1, expiresAt: now + 60_000 },
      mutating
    );
    if (!admitted.ok) throw new Error(`refused: ${admitted.reason}`);
    if (admitted.pending) admitted.pending.baseline = internals.totalChanges();
    const result = internals.invocationContext.run(
      admitted.pending ? { pendingNonce: admitted.pending } : {},
      fn
    );
    return { result, persisted: admitted.pending ? admitted.pending.persisted : null };
  }
  consumeNonce(nonce: string): boolean {
    const ledger = (
      this as unknown as { directRpcNonces: { consume(n: string, e: number): boolean } }
    ).directRpcNonces;
    return ledger.consume(nonce, Date.now() + 60_000);
  }
}

async function onDolt() {
  const fake = await FakeDoltStorage.create({ doltLocal: doltLocalPatterns(["local_%"]) });
  const probe = await createTestDO(NotesDO, undefined, { storage: fake.storage });
  return { fake, ...probe };
}

describe("DurableObjectBase on a Dolt cell", () => {
  it("counts commits made while a compaction check is pending", async () => {
    const { instance } = await onDolt();
    vi.useFakeTimers();
    try {
      // One queued check must cover this burst, which is still below the
      // default threshold. The next eight-commit boundary crosses it.
      for (let n = 1; n <= 60; n++) instance.add(`note ${n}`);
      await vi.runOnlyPendingTimersAsync();
      expect(instance.compaction()?.lastCollectedHead).toBeNull();

      for (let n = 61; n <= 64; n++) instance.add(`note ${n}`);
      await vi.runOnlyPendingTimersAsync();
      expect(instance.compaction()?.lastCollectedHead).toBe(instance.compaction()?.head);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs its schema as a commit and exposes the store", async () => {
    const { fake, instance } = await onDolt();
    expect(instance.engine()).toBe(true);
    expect(fake.dolt.log()[0]?.message).toBe("schema: TestDO v1");
    expect(fake.dolt.status()).toEqual([]);
  });

  it("commits through committedTransaction and leaves a clean working set", async () => {
    const { fake, instance } = await onDolt();
    expect(instance.add("one")).toBe(1);
    expect(instance.add("two")).toBe(2);
    expect(fake.dolt.log({ limit: 2 }).map((entry) => entry.message)).toEqual([
      "add note 2",
      "add note 1",
    ]);
    expect(() => instance.check()).not.toThrow();
  });

  it("reports a versioned write outside committedTransaction as drift, and not a local one", async () => {
    const { fake, instance } = await onDolt();
    instance.mark("local");
    expect(() => instance.check()).not.toThrow();
    instance.addUncommitted("loose");
    expect(() => instance.check()).toThrow(DoltDriftError);
    expect(fake.dolt.status().map((entry) => entry.table)).toEqual(["notes"]);
  });

  it("keeps the direct RPC nonce ledger in a local table that no commit, reset or fork carries", async () => {
    const { fake, instance } = await onDolt();
    const nonce = "123e4567-e89b-42d3-a456-426614174000";
    expect(instance.consumeNonce(nonce)).toBe(true);
    expect(instance.consumeNonce(nonce)).toBe(false);
    const tables = fake.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray()
      .map((row) => row["name"]);
    expect(tables).toContain("vsl_direct_rpc_nonces");
    expect(tables).not.toContain("_vibestudio_direct_rpc_nonces");
    expect(fake.dolt.status()).toEqual([]);
    fake.dolt.reset({ hard: true, to: "HEAD" });
    expect(instance.consumeNonce(nonce)).toBe(false);
    const fork = await fake.fork();
    expect(fork.sql.exec("SELECT count(*) AS n FROM vsl_direct_rpc_nonces").one()["n"]).toBe(0);
  });

  it("records a mutating call's nonce in the call's own commit and a read's nowhere", async () => {
    const { fake, instance } = await onDolt();
    const count = () =>
      fake.sql.exec("SELECT name FROM sqlite_master WHERE name = 'vsl_direct_rpc_nonces'").toArray()
        .length === 0
        ? 0
        : Number(fake.sql.exec("SELECT count(*) AS n FROM vsl_direct_rpc_nonces").one()["n"]);
    const read = instance.runCall("123e4567-e89b-42d3-a456-426614174001", false, () => 1);
    expect(read).toEqual({ result: 1, persisted: null });
    expect(count()).toBe(0);
    const logBefore = fake.dolt.log().length;
    const write = instance.runCall("123e4567-e89b-42d3-a456-426614174002", true, () =>
      instance.add("x")
    );
    expect(write).toEqual({ result: 1, persisted: true });
    expect(count()).toBe(1);
    // One commit for the write, none for the nonce, and the working set is clean.
    expect(fake.dolt.log().length).toBe(logBefore + 1);
    expect(() => instance.check()).not.toThrow();
    // A second transaction in the same call does not record it again.
    const second = instance.runCall("123e4567-e89b-42d3-a456-426614174003", true, () => {
      instance.add("y");
      instance.add("z");
    });
    expect(second.persisted).toBe(true);
    expect(count()).toBe(2);
  });

  it("records no nonce for a call that changed nothing in storage", async () => {
    const { fake, instance } = await onDolt();
    const noop = instance.runCall("123e4567-e89b-42d3-a456-426614174004", true, () => {
      instance.noopTransaction();
    });
    expect(noop.persisted).toBe(false);
    expect(
      fake.sql.exec("SELECT name FROM sqlite_master WHERE name = 'vsl_direct_rpc_nonces'").toArray()
    ).toHaveLength(1); // the table exists (the mutating admission checked it) but holds nothing
    expect(fake.sql.exec("SELECT count(*) AS n FROM vsl_direct_rpc_nonces").one()["n"]).toBe(0);
  });

  it("is a plain transaction on a SQLite cell: the same class, no Dolt, the old nonce table", async () => {
    const { instance, sql } = await createTestDO(NotesDO);
    expect(instance.engine()).toBe(false);
    expect(instance.add("one")).toBe(1);
    expect(() => instance.check()).not.toThrow();
    expect(instance.consumeNonce("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    const tables = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row["name"]);
    expect(tables).toContain("_vibestudio_direct_rpc_nonces");
    expect(tables).not.toContain("vsl_direct_rpc_nonces");
  });

  it("reopens on a restarted Dolt cell without reading the re-rendered schema as drift", async () => {
    const { fake } = await onDolt();
    const restarted = await fake.restart();
    const reopened = await createTestDO(NotesDO, undefined, { storage: restarted.storage });
    expect(reopened.instance.add("after restart")).toBe(1);
    expect(
      restarted.dolt.log().filter((entry) => entry.message.startsWith("schema:"))
    ).toHaveLength(1);
  });
});
