import { describe, expect, it } from "vitest";
import { createInMemorySql } from "./test-utils.js";
import { installExactDurableObjectSchema } from "./schema.js";

function storage(sql: Awaited<ReturnType<typeof createInMemorySql>>) {
  return {
    sql,
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
  };
}

describe("exact durable-object schema identity", () => {
  it("ignores lazy and user-owned tables while retaining implementation drift checks", async () => {
    const sql = await createInMemorySql();
    const definition = {
      className: "EvalProbeDO",
      version: 1,
      storage: storage(sql),
      schemaTables: ["runs"],
      createSchema: () => {
        sql.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY)");
      },
      validateSchema: () => undefined,
    };

    installExactDurableObjectSchema(definition);
    sql.exec("CREATE TABLE repl_scopes (id TEXT PRIMARY KEY)");
    sql.exec("CREATE TABLE user_data (value TEXT)");

    expect(() => installExactDurableObjectSchema(definition)).not.toThrow();
  });

  it("still rejects a changed implementation-owned table", async () => {
    const sql = await createInMemorySql();
    const definition = {
      className: "DriftProbeDO",
      version: 1,
      storage: storage(sql),
      schemaTables: ["runs"],
      createSchema: () => {
        sql.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY)");
      },
      validateSchema: () => undefined,
    };

    installExactDurableObjectSchema(definition);
    sql.exec("DROP TABLE runs");
    sql.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY, changed INTEGER)");

    expect(() => installExactDurableObjectSchema(definition)).toThrow(
      "DriftProbeDO persisted schema does not match current version 1; recreate it explicitly"
    );
  });
});
