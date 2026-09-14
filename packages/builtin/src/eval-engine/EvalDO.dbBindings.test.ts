import { describe, expect, it } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { EvalDO } from "./EvalDO.js";

interface Db {
  exec(query: string, ...bindings: unknown[]): unknown[];
  run(query: string, ...bindings: unknown[]): void;
}
type Reach = { dbBinding(generation: number): Db; scopeGeneration: number };

async function db(): Promise<Db> {
  const { instance } = await createTestDO(EvalDO);
  const reach = instance as unknown as Reach;
  return reach.dbBinding(reach.scopeGeneration);
}

describe("eval db bindings", () => {
  it("names the array mistake instead of reporting a binding count", async () => {
    const store = await db();
    store.run("CREATE TABLE t (key TEXT, value TEXT)");

    // The habit every other SQLite binding teaches; underneath it surfaced as
    // "Wrong number of parameter bindings for SQL query", which names neither
    // the shape nor the convention.
    expect(() =>
      store.run("INSERT INTO t (key, value) VALUES (?, ?)", ["probe", "ok"])
    ).toThrow(/pass bindings as separate arguments, not an array.*Received a single array of 2/su);

    expect(() => store.exec("SELECT * FROM t WHERE key = ?", ["probe"])).toThrow(
      /Received a single array of 1/u
    );
  });

  it("accepts the documented variadic form and round-trips a row", async () => {
    const store = await db();
    store.run("CREATE TABLE t (key TEXT, value TEXT)");
    store.run("INSERT INTO t (key, value) VALUES (?, ?)", "probe", "ok");

    expect(store.exec("SELECT value FROM t WHERE key = ?", "probe")).toEqual([{ value: "ok" }]);
  });

  it("only claims the mistake when a lone array is the whole binding list", async () => {
    const store = await db();
    store.run("CREATE TABLE t (a TEXT, b TEXT)");
    // Two bindings, the first an array, is not the single-array mistake. The
    // guard must stay quiet and let the engine rule on the value itself.
    let raised: unknown;
    try {
      store.run("INSERT INTO t (a, b) VALUES (?, ?)", ["x"], "y");
    } catch (error) {
      raised = error;
    }
    expect(String((raised as Error | undefined)?.message ?? "")).not.toMatch(/not an array/u);
  });
});
