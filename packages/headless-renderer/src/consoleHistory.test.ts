import { panelConsoleHistoryResultSchema } from "@vibestudio/service-schemas/panelCdp";
import { describe, expect, it } from "vitest";
import { ConsoleHistoryStore, levelFromConsoleType } from "./consoleHistory.js";
import { panelConsoleHistoryResultSchema } from "@vibestudio/service-schemas/panelCdp";

function entry(level: "info" | "error" | "warning", message: string) {
  return { timestamp: 1, level, message, line: 0, sourceId: "", url: "" } as const;
}

describe("ConsoleHistoryStore", () => {
  it("returns the service contract even when the panel has no history", () => {
    const history = new ConsoleHistoryStore().query("empty");
    expect(panelConsoleHistoryResultSchema.parse(history).page).toEqual({
      nextBeforeSeq: null,
      hasOlder: false,
    });
  });

  it("pages filtered history by stable sequence across later appends", () => {
    const store = new ConsoleHistoryStore();
    for (const message of ["match one", "other", "match two", "match three"]) {
      store.record("p1", entry("info", message));
    }
    const newest = store.query("p1", { contains: "MATCH", limit: 2 });
    expect(panelConsoleHistoryResultSchema.parse(newest).entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(newest.page).toEqual({ nextBeforeSeq: 3, hasOlder: true });
    store.record("p1", entry("info", "match four"));
    const older = store.query("p1", {
      contains: "match",
      beforeSeq: newest.page.nextBeforeSeq!,
      limit: 2,
    });
    expect(older.entries.map((e) => e.message)).toEqual(["match one"]);
    expect(older.page).toEqual({ nextBeforeSeq: null, hasOlder: false });
  });

  it("filters lifecycle, time, and fields while retaining the independent error history", () => {
    const store = new ConsoleHistoryStore();
    store.record("p1", { ...entry("info", "outside"), timestamp: 1 });
    store.record("p1", {
      ...entry("warning", "inside"),
      timestamp: 2,
      fields: { probe: "needle" },
    });
    store.recordLifecycle("p1", "crashed", { probe: "needle" });
    const filtered = store.query("p1", {
      sources: ["console"],
      since: 2,
      until: 2,
      contains: "NEEDLE",
    });
    expect(filtered.entries.map((e) => e.message)).toEqual(["inside"]);
    expect(filtered.errors).toEqual([]);
    expect(store.query("p1", { levels: ["info"] }).errors).toHaveLength(1);
  });

  it("keeps entries and errors with capacities and dropped counters", () => {
    const store = new ConsoleHistoryStore();
    for (let index = 0; index < 1_005; index += 1) {
      store.record("p1", entry("info", `m${index}`));
    }
    const result = store.query("p1");
    expect(result.entries).toHaveLength(1_000);
    expect(result.entries[0]?.message).toBe("m5");
    expect(result.dropped.entries).toBe(5);
    expect(result.capacity).toEqual({ entries: 1_000, errors: 500 });
  });

  it("filters by level and honors limits", () => {
    const store = new ConsoleHistoryStore();
    store.record("p1", entry("info", "a"));
    store.record("p1", entry("error", "boom"));
    store.record("p1", entry("warning", "careful"));
    const errorsOnly = store.query("p1", { levels: ["error"] });
    expect(errorsOnly.entries.map((e) => e.message)).toEqual(["boom"]);
    expect(store.query("p1", { limit: 1 }).entries.map((e) => e.message)).toEqual(["careful"]);
    expect(store.query("p1").errors.map((e) => e.message)).toEqual(["boom"]);
  });

  it("records lifecycle events as error-level lifecycle entries", () => {
    const store = new ConsoleHistoryStore();
    store.recordLifecycle("p1", "render-process-gone: target crashed");
    const result = store.query("p1");
    expect(result.errors[0]?.source).toBe("lifecycle");
    expect(result.errors[0]?.message).toContain("render-process-gone");
  });

  it("returns schema-valid empty and populated pages with stable cursors across new arrivals", () => {
    const store = new ConsoleHistoryStore();
    expect(panelConsoleHistoryResultSchema.parse(store.query("absent")).page).toEqual({
      nextBeforeSeq: null,
      hasOlder: false,
    });
    for (let index = 1; index <= 5; index += 1) store.record("p1", entry("info", `m${index}`));
    const newest = panelConsoleHistoryResultSchema.parse(store.query("p1", { limit: 2 }));
    expect(newest.entries.map((item) => item.seq)).toEqual([4, 5]);
    expect(newest.page).toEqual({ nextBeforeSeq: 4, hasOlder: true });
    store.record("p1", entry("info", "new arrival"));
    const older = store.query("p1", { limit: 2, beforeSeq: newest.page.nextBeforeSeq! });
    expect(older.entries.map((item) => item.seq)).toEqual([2, 3]);
    expect(older.page).toEqual({ nextBeforeSeq: 2, hasOlder: true });
    const oldest = store.query("p1", { limit: 2, beforeSeq: older.page.nextBeforeSeq! });
    expect(oldest.entries.map((item) => item.seq)).toEqual([1]);
    expect(oldest.page).toEqual({ nextBeforeSeq: null, hasOlder: false });
  });

  it("applies source, text, time and cursor filters while retaining errors independently of levels", () => {
    const store = new ConsoleHistoryStore();
    store.record("p1", { ...entry("info", "ordinary"), timestamp: 1 });
    store.record("p1", {
      ...entry("error", "failure"),
      timestamp: 2,
      source: "lifecycle",
      fields: { reason: "BOOM" },
    });
    store.record("p1", { ...entry("warning", "other"), timestamp: 3 });
    const selected = store.query("p1", {
      sources: ["lifecycle"],
      contains: "boom",
      since: 2,
      until: 2,
      beforeSeq: 3,
      levels: ["info"],
    });
    expect(selected.entries).toEqual([]);
    expect(selected.errors.map((item) => item.seq)).toEqual([2]);
    expect(store.query("p1", { sources: ["console"] }).entries.map((item) => item.seq)).toEqual([
      1, 3,
    ]);
    expect(store.query("p1", { since: 3 }).errors).toEqual([]);
    expect(store.query("p1", { beforeSeq: 2 }).errors).toEqual([]);
    expect(store.query("p1", { errorLimit: 0 }).errors).toEqual([]);
    expect(panelConsoleHistoryResultSchema.safeParse(selected).success).toBe(true);
  });

  it("clear() drops a panel's history", () => {
    const store = new ConsoleHistoryStore();
    store.record("p1", entry("info", "a"));
    store.clear("p1");
    expect(store.query("p1").entries).toHaveLength(0);
  });

  it("maps CDP console types to levels", () => {
    expect(levelFromConsoleType("log")).toBe("info");
    expect(levelFromConsoleType("warning")).toBe("warning");
    expect(levelFromConsoleType("assert")).toBe("error");
    expect(levelFromConsoleType("weird")).toBe("unknown");
  });
});
