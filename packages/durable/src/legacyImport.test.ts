import { describe, expect, it } from "vitest";
import { decodeRpcJson } from "@vibestudio/rpc";
import {
  LEGACY_PROOF_HEADER,
  isLegacyCall,
  legacyLoadRows,
  legacyRowsPage,
  legacyTables,
  serveLegacyCall,
} from "./legacyImport.js";
import { FakeDoltStorage } from "./test-dolt.js";

const SCHEMA = [
  "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), body TEXT)",
  "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE blobs (k TEXT PRIMARY KEY, v BLOB)",
  "CREATE TABLE _vibestudio_schema (version INTEGER)",
  "CREATE TABLE vsl_direct_rpc_nonces (nonce TEXT PRIMARY KEY)",
];

async function store(rows = 0): Promise<FakeDoltStorage> {
  const fake = await FakeDoltStorage.create({ doltLocal: ["vsl_%"] });
  for (const statement of SCHEMA) fake.sql.exec(statement);
  for (let index = 1; index <= rows; index++) {
    fake.sql.exec("INSERT INTO parent (id, name) VALUES (?, ?)", index, `p${index}`);
    fake.sql.exec(
      "INSERT INTO child (id, parent_id, body) VALUES (?, ?, ?)",
      index,
      index,
      "x".repeat(300)
    );
  }
  return fake;
}

const props = { codeHost: { name: "root", proof: "proof-value-1234" } };
const request = (proof: string | null) =>
  new Request("http://do/key/__legacy/x", {
    method: "POST",
    headers: proof ? { [LEGACY_PROOF_HEADER]: proof } : {},
  });

async function serve(
  fake: FakeDoltStorage,
  call: string,
  body: unknown,
  proof: string | null = props.codeHost.proof
) {
  const response = await serveLegacyCall({
    storage: fake as never,
    props,
    request: request(proof),
    method: `__legacy/${call}`,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: decodeRpcJson(await response.text()) as { result?: any; error?: any },
  };
}

describe("legacy import: the class's side of copying a SQLite facet into a Dolt facet", () => {
  it("lists application tables parents first and leaves the store's own tables out", async () => {
    const fake = await store(2);
    const tables = legacyTables(fake.sql as never);
    expect(tables.map((table) => table.name)).toEqual(["blobs", "parent", "child"]);
    expect(tables.find((table) => table.name === "child")).toMatchObject({
      columns: ["id", "parent_id", "body"],
      count: 2,
    });
  });

  it("pages a table by rowid, bounded by rows and by bytes, and ends with next: null", async () => {
    const fake = await store(7);
    const seen: number[] = [];
    let after: number | null = null;
    let pages = 0;
    for (;;) {
      const page = legacyRowsPage(fake.sql as never, "child", after, 3);
      seen.push(...page.rows.map((row) => Number(row[0])));
      pages++;
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pages).toBe(3);
    expect(() => legacyRowsPage(fake.sql as never, "_vibestudio_schema", null)).toThrow(/no table/);
    expect(() => legacyRowsPage(fake.sql as never, "child; DROP TABLE child", null)).toThrow();
  });

  it("copies a store into another with the same schema and commits it, bytes and integers kept", async () => {
    const source = await store(5);
    source.sql.exec(
      "INSERT INTO blobs (k, v) VALUES (?, ?)",
      "b",
      new Uint8Array([0, 1, 254, 255])
    );
    const target = await store();
    for (const table of legacyTables(source.sql as never)) {
      let after: number | null = null;
      for (;;) {
        const page = legacyRowsPage(source.sql as never, table.name, after, 2);
        if (page.rows.length > 0)
          legacyLoadRows(target as never, {
            table: table.name,
            columns: page.columns,
            rows: page.rows,
          });
        if (page.next === null) break;
        after = page.next;
      }
    }
    const committed = await serve(target, "commit", { message: "import: k from sqlite" });
    expect(committed.status).toBe(200);
    expect(target.dolt.log({ limit: 1 })[0]!.message).toBe("import: k from sqlite");
    expect(target.sql.exec("SELECT count(*) AS n FROM child").toArray()[0]!["n"]).toBe(5);
    expect(
      Array.from(
        target.sql.exec("SELECT v FROM blobs WHERE k = 'b'").toArray()[0]!["v"] as Uint8Array
      )
    ).toEqual([0, 1, 254, 255]);
    // Running the copy again changes nothing (INSERT OR REPLACE by key).
    const page = legacyRowsPage(source.sql as never, "parent", null);
    legacyLoadRows(target as never, { table: "parent", columns: page.columns, rows: page.rows });
    expect(target.sql.exec("SELECT count(*) AS n FROM parent").toArray()[0]!["n"]).toBe(5);
  });

  it("refuses a load into a table or column the new schema does not have", async () => {
    const target = await store();
    expect(() =>
      legacyLoadRows(target as never, { table: "nope", columns: ["a"], rows: [[1]] })
    ).toThrow(/no table nope/);
    expect(() =>
      legacyLoadRows(target as never, { table: "parent", columns: ["id", "ghost"], rows: [[1, 2]] })
    ).toThrow(/no column ghost/);
  });

  it("serves only the object's own root: a call without the proof, or with another, is refused", async () => {
    const fake = await store(1);
    expect(isLegacyCall("__legacy/tables")).toBe(true);
    expect(isLegacyCall("tables")).toBe(false);
    expect((await serve(fake, "tables", {}, null)).status).toBe(403);
    expect((await serve(fake, "tables", {}, "proof-value-9999")).status).toBe(403);
    expect((await serve(fake, "tables", {}, "short")).status).toBe(403);
    expect((await serve(fake, "tables", {})).status).toBe(200);
    expect((await serve(fake, "engine", {})).body.result).toEqual({ engine: "dolt" });
    expect((await serve(fake, "nothing", {})).status).toBe(404);
  });
});
