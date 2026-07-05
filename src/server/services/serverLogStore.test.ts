import { describe, expect, it, vi } from "vitest";
import { createServerLogStore } from "./serverLogStore.js";

describe("serverLogStore", () => {
  it("captures records with parsed tags, levels, and monotonic seq", () => {
    const store = createServerLogStore({ now: () => 1000 });
    store.append("info", ["[Server] ready on port 1234"]);
    store.append("warn", ["no tag here"]);

    const { records, latestSeq } = store.tail();
    expect(latestSeq).toBe(2);
    expect(records[0]).toMatchObject({
      seq: 1,
      timestamp: 1000,
      level: "info",
      tag: "Server",
      message: "ready on port 1234",
      pid: process.pid,
    });
    expect(records[1]).toMatchObject({ seq: 2, level: "warn", message: "no tag here" });
    expect(records[1]!.tag).toBeUndefined();
  });

  it("joins string args into the message and keeps non-strings as JSON-safe fields", () => {
    const store = createServerLogStore();
    store.append("error", ["[Boot] failed:", "hard", new Error("boom"), { code: 7 }]);
    const record = store.tail().records[0]!;
    expect(record.message).toBe("failed: hard");
    expect(record.fields).toHaveLength(2);
    expect(record.fields![0]).toMatchObject({ name: "Error", message: "boom" });
    expect(record.fields![1]).toEqual({ code: 7 });
  });

  it("redacts registered secrets from future and already-buffered records", () => {
    const store = createServerLogStore();
    store.append("info", ["Pairing code: super-secret-code-123"]);
    store.addSecret("super-secret-code-123");
    store.append("info", ["again: super-secret-code-123 done"]);

    const messages = store.tail().records.map((r) => r.message);
    expect(messages[0]).toBe("Pairing code: [redacted]");
    expect(messages[1]).toBe("again: [redacted] done");
  });

  it("redacts secrets inside structured fields", () => {
    const store = createServerLogStore();
    store.addSecret("tok-abcdefgh");
    store.append("info", ["payload", { token: "tok-abcdefgh", ok: true }]);
    expect(store.tail().records[0]!.fields![0]).toEqual({ token: "[redacted]", ok: true });
  });

  it("evicts oldest records beyond the buffer size but keeps seq/stats totals", () => {
    const store = createServerLogStore({ bufferSize: 3 });
    for (let i = 1; i <= 5; i++) store.append("info", [`m${i}`]);
    const { records } = store.tail();
    expect(records.map((r) => r.seq)).toEqual([3, 4, 5]);
    const stats = store.stats();
    expect(stats.totalCaptured).toBe(5);
    expect(stats.oldestSeq).toBe(3);
    expect(stats.latestSeq).toBe(5);
  });

  it("query filters by sinceSeq, min level, tag, and substring; keeps most recent matches", () => {
    const store = createServerLogStore();
    store.append("verbose", ["[A] chatty"]);
    store.append("info", ["[A] hello world"]);
    store.append("warn", ["[B] hello warn"]);
    store.append("error", ["[A] boom"]);

    expect(store.query({ level: "warn" }).records.map((r) => r.seq)).toEqual([3, 4]);
    expect(store.query({ tag: "A", level: "info" }).records.map((r) => r.seq)).toEqual([2, 4]);
    expect(store.query({ contains: "HELLO" }).records.map((r) => r.seq)).toEqual([2, 3]);
    expect(store.query({ sinceSeq: 2 }).records.map((r) => r.seq)).toEqual([3, 4]);
    expect(store.query({ contains: "hello", limit: 1 }).records.map((r) => r.seq)).toEqual([3]);
  });

  it("notifies append listeners and survives a throwing listener", () => {
    const store = createServerLogStore();
    const seen: number[] = [];
    store.onAppend(() => {
      throw new Error("listener bug");
    });
    const off = store.onAppend((record) => seen.push(record.seq));
    store.append("info", ["one"]);
    off();
    store.append("info", ["two"]);
    expect(seen).toEqual([1]);
  });

  it("console capture tees into the store and does not recurse from listeners", () => {
    const store = createServerLogStore();
    const original = console.log;
    const printed = vi.fn();
    console.log = printed;
    try {
      store.installConsoleCapture();
      // A listener that logs must not re-enter capture (re-entrancy guard).
      store.onAppend(() => console.log("from listener"));
      console.log("[Capture] hi");
      expect(store.tail().records.map((r) => r.message)).toEqual(["hi"]);
      expect(printed).toHaveBeenCalled();
    } finally {
      console.log = original;
    }
  });
});
