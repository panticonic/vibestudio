import { describe, expect, it, vi } from "vitest";
import type { SqlStorage } from "@workspace/runtime/worker/durable-base";

import {
  DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS,
  execBatchedInsert,
  execBatchedInsertReturning,
} from "./sqlBatch.js";

function recordingSql(returned: Record<string, unknown>[] = []) {
  const exec = vi.fn((_query: string, ..._bindings: unknown[]) => ({
    toArray: () => returned,
    one: () => returned[0] ?? {},
  }));
  return { exec, sql: { exec } as SqlStorage };
}

describe("execBatchedInsert", () => {
  it("keeps every statement within the Durable Objects binding limit", () => {
    const { exec, sql } = recordingSql();
    const rows = Array.from({ length: 101 }, (_, index) => [index, `value:${index}`, null]);

    execBatchedInsert(sql, "INSERT INTO values_table (id, value, optional)", 3, rows);

    expect(exec).toHaveBeenCalledTimes(4);
    for (const [, ...bindings] of exec.mock.calls) {
      expect(bindings.length).toBeLessThanOrEqual(DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS);
    }
    expect(exec.mock.calls.flatMap(([, ...bindings]) => bindings)).toEqual(rows.flat());
  });

  it("collects RETURNING rows from every statement", () => {
    const returned = [{ id: "one" }];
    const { exec, sql } = recordingSql(returned);
    const rows = Array.from({ length: 51 }, (_, index) => [index, `value:${index}`]);

    expect(
      execBatchedInsertReturning(
        sql,
        "INSERT INTO values_table (id, value)",
        2,
        rows,
        " RETURNING id"
      )
    ).toEqual([...returned, ...returned]);
    expect(exec.mock.calls.map(([query]) => query)).toEqual([
      expect.stringContaining(" RETURNING id"),
      expect.stringContaining(" RETURNING id"),
    ]);
  });

  it("rejects malformed rows before executing their statement", () => {
    const { exec, sql } = recordingSql();

    expect(() => execBatchedInsert(sql, "INSERT INTO values_table (id, value)", 2, [[1]])).toThrow(
      "expected 2 values"
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
