import { describe, expect, it } from "vitest";
import { createInMemorySql } from "./test-utils.js";
import { WakePublicationStore } from "./wake-publication.js";

async function fixture() {
  const sql = await createInMemorySql();
  sql.exec("CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  sql.exec(
    "CREATE TABLE do_alarms(source TEXT, class_name TEXT, object_key TEXT, wake_at INTEGER NOT NULL, dispatch_generation INTEGER NOT NULL, dispatch_owner TEXT, PRIMARY KEY(source,class_name,object_key))"
  );
  sql.exec("CREATE TABLE do_alarm_test_policies(source TEXT, class_name TEXT, object_key TEXT)");
  const store = new WakePublicationStore(
    { sql, transactionSync: (callback) => sql.transactionSync(callback) },
    () => {}
  );
  const key = { source: "workers/agent", className: "Agent", objectKey: "a" };
  return {
    sql,
    store,
    key,
    incarnation: store.register(key, { incarnation: crypto.randomUUID(), generation: 1 }),
  };
}

describe("source-versioned host alarm publication", () => {
  it("retains a host request through null publications without changing the source watermark", async () => {
    const { sql, store, key, incarnation } = await fixture();
    store.publish(key, { incarnation, revision: 1, wakeAt: null });
    expect(store.request(key, incarnation)).toBe("accepted");
    store.publish(key, { incarnation, revision: 2, wakeAt: null });
    expect(store.publish(key, { incarnation, revision: 2, wakeAt: null })).toBe("duplicate");
    expect(sql.exec("SELECT wake_at FROM do_alarms").one()["wake_at"]).toBe(0);
    const dispatchGeneration = store.nextClaimGeneration(key);
    sql.exec(
      "UPDATE do_alarms SET dispatch_owner = 'host-1', dispatch_generation = ?",
      dispatchGeneration
    );
    const token = store.claimRequest(key, dispatchGeneration)!;
    store.publish(key, { incarnation, revision: 3, wakeAt: null });
    expect(sql.exec("SELECT dispatch_owner FROM do_alarms").one()["dispatch_owner"]).toBe("host-1");
    store.acknowledgeRequest(key, token, dispatchGeneration);
    expect(store.hasPendingRequest(key)).toBe(false);
    store.publish(key, { incarnation, revision: 3, wakeAt: null });
    expect(sql.exec("SELECT * FROM do_alarms").toArray()).toEqual([]);
  });

  it("a later request survives acknowledgement of a running pass and replacement of the store", async () => {
    const { sql, store, key, incarnation } = await fixture();
    store.request(key, incarnation);
    const generation = store.nextClaimGeneration(key);
    const token = store.claimRequest(key, generation)!;
    store.request(key, incarnation);
    store.acknowledgeRequest(key, token, generation);
    const replacement = new WakePublicationStore(
      { sql, transactionSync: (callback) => sql.transactionSync(callback) },
      () => {}
    );
    expect(replacement.hasPendingRequest(key)).toBe(true);
    const next = replacement.claimRequest(key, generation + 1)!;
    expect(next.generation).toBeGreaterThan(token.generation);
    expect(() => replacement.acknowledgeRequest(key, token, generation)).toThrow(/dispatch claim/);
    replacement.acknowledgeRequest(key, next, generation + 1);
    expect(replacement.hasPendingRequest(key)).toBe(false);
  });

  it("request persistence and derived scheduling roll back together on an original SQL failure", async () => {
    const { sql, store, key, incarnation } = await fixture();
    sql.exec(
      "CREATE TRIGGER refuse_request BEFORE INSERT ON do_alarms BEGIN SELECT RAISE(ABORT, 'request failure'); END"
    );
    expect(() => store.request(key, incarnation)).toThrow(/request failure/);
    expect(store.hasPendingRequest(key)).toBe(false);
    sql.exec("DROP TRIGGER refuse_request");
    store.request(key, incarnation);
    expect(store.claimRequest(key, 1)).toEqual({ incarnation, generation: 1 });
  });

  it("incarnation replacement retires only the old request and refuses its late event", async () => {
    const { store, key, incarnation } = await fixture();
    store.request(key, incarnation);
    const old = store.claimRequest(key, 1)!;
    const next = crypto.randomUUID();
    store.register(key, { incarnation: next, generation: 2 });
    expect(store.request(key, incarnation)).toBe("stale");
    expect(store.hasPendingRequest(key)).toBe(false);
    store.request(key, next);
    const current = store.claimRequest(key, 2)!;
    expect(() => store.acknowledgeRequest(key, old, 1)).toThrow(/dispatch claim/);
    store.acknowledgeRequest(key, current, 2);
    expect(store.hasPendingRequest(key)).toBe(false);
  });
  it("retains the clear watermark and rejects reordering and same-revision conflicts", async () => {
    const { sql, store, key, incarnation } = await fixture();
    expect(store.publish(key, { incarnation, revision: 1, wakeAt: 100 })).toBe("accepted");
    expect(store.publish(key, { incarnation, revision: 2, wakeAt: null })).toBe("accepted");
    expect(store.publish(key, { incarnation, revision: 1, wakeAt: 100 })).toBe("stale");
    expect(store.publish(key, { incarnation, revision: 2, wakeAt: null })).toBe("duplicate");
    expect(() => store.publish(key, { incarnation, revision: 2, wakeAt: 10 })).toThrow(/conflicts/);
    expect(sql.exec("SELECT * FROM do_alarms").toArray()).toEqual([]);
    expect(store.owners()).toEqual([key]);
  });
  it("recovers a lost first publication from registration and preserves live claims on duplicate publication", async () => {
    const { sql, store, key, incarnation } = await fixture();
    expect(store.owners()).toEqual([key]);
    store.publish(key, { incarnation, revision: 3, wakeAt: 100 });
    sql.exec("UPDATE do_alarms SET dispatch_owner = 'host-1', dispatch_generation = 1");
    expect(store.publish(key, { incarnation, revision: 3, wakeAt: 100 })).toBe("duplicate");
    expect(sql.exec("SELECT dispatch_owner FROM do_alarms").one()["dispatch_owner"]).toBe("host-1");
    sql.exec("DELETE FROM do_alarms");
    store.publish(key, { incarnation, revision: 3, wakeAt: 100 });
    expect(sql.exec("SELECT wake_at FROM do_alarms").one()["wake_at"]).toBe(100);
  });
  it("fences an old storage incarnation and keeps claim generations monotonic across clear and reinsert", async () => {
    const { sql, store, key, incarnation } = await fixture();
    store.publish(key, { incarnation, revision: 10, wakeAt: 100 });
    const first = store.nextClaimGeneration(key);
    store.publish(key, { incarnation, revision: 11, wakeAt: null });
    store.publish(key, { incarnation, revision: 12, wakeAt: 100 });
    expect(store.nextClaimGeneration(key)).toBeGreaterThan(first);
    const identity = { incarnation: crypto.randomUUID(), generation: 2 };
    const replacement = store.register(key, identity);
    expect(replacement).not.toBe(incarnation);
    expect(store.publish(key, { incarnation, revision: 999, wakeAt: 0 })).toBe("stale");
    expect(store.publish(key, { incarnation: replacement, revision: 0, wakeAt: 100 })).toBe(
      "accepted"
    );
    expect(store.nextClaimGeneration(key)).toBeGreaterThan(first + 1);
    expect(store.register(key, identity)).toBe(replacement);
    expect(sql.exec("SELECT wake_at FROM do_alarms").one()["wake_at"]).toBe(100);
    expect(() => store.register(key, { incarnation, generation: 1 })).toThrow(/Retired/);
    expect(() => store.register(key, { incarnation, generation: 2 })).toThrow(/conflicts/);
  });
  it("revalidates a restored registry against the host identity and refuses a late old registration", async () => {
    const { sql, store, key, incarnation } = await fixture();
    store.publish(key, { incarnation, revision: 1, wakeAt: 10 });
    const backup = sql.exec("SELECT key, value FROM state").toArray();
    const current = { incarnation: crypto.randomUUID(), generation: 2 };
    store.register(key, current);
    store.publish(key, { incarnation: current.incarnation, revision: 0, wakeAt: 20 });
    sql.exec("DELETE FROM state");
    for (const row of backup)
      sql.exec("INSERT INTO state(key,value) VALUES (?,?)", row["key"], row["value"]);
    expect(store.register(key, current)).toBe(current.incarnation);
    expect(sql.exec("SELECT * FROM do_alarms").toArray()).toEqual([]);
    expect(store.publish(key, { incarnation, revision: 999, wakeAt: 0 })).toBe("stale");
    expect(() => store.register(key, { incarnation, generation: 1 })).toThrow(/Retired/);
  });
  it("rolls back source metadata and derived alarm together when queue mutation fails", async () => {
    const { sql, store, key, incarnation } = await fixture();
    sql.exec(
      "CREATE TRIGGER refuse_alarm BEFORE INSERT ON do_alarms BEGIN SELECT RAISE(ABORT, 'injected'); END"
    );
    expect(() => store.publish(key, { incarnation, revision: 1, wakeAt: 100 })).toThrow(/injected/);
    sql.exec("DROP TRIGGER refuse_alarm");
    expect(store.publish(key, { incarnation, revision: 1, wakeAt: null })).toBe("accepted");
  });
});
