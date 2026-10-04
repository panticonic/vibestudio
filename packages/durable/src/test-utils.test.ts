import { expect, it } from "vitest";
import { createInMemorySql } from "./test-utils.js";

it("accepts native ArrayBuffer SQL bindings for stored blobs and queries", async () => {
  const sql = await createInMemorySql();
  const bytes = new Uint8Array([0, 255, 42]);
  sql.exec("CREATE TABLE bytes (value BLOB NOT NULL)");
  sql.exec("INSERT INTO bytes VALUES (?)", bytes.buffer);
  bytes.fill(1);
  expect(sql.exec("SELECT hex(value) AS value FROM bytes").one()).toEqual({ value: "00FF2A" });
  expect(sql.exec("SELECT hex(?) AS value", bytes.buffer).one()).toEqual({ value: "010101" });
});
