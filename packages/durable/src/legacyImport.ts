/**
 * The class's side of a one-time import of SQLite state into a Dolt facet
 * (docs/dolt-redesign.md §9.2).
 *
 * A class's engine is fixed when its object is created. When a manifest turns a
 * class that already has objects into a Dolt class, the object's root starts the
 * new Dolt facet beside the legacy SQLite facet, copies every table across with
 * these calls and deletes the legacy facet. The class code is the same on both
 * sides, so the legacy facet's schema is already at the current version (the
 * schema guard ran before this dispatch) and the rows go into tables the Dolt
 * facet created itself.
 *
 * Only the object's own root may call these: each carries the proof the root put
 * in the class's props (`codeHost.proof`), which no other caller has.
 */
import { decodeRpcJson, encodeRpcJson, serializeRpcFailure } from "@vibestudio/rpc";
import type { DoltStorage } from "./dolt.js";

export const LEGACY_ROUTE = "__legacy";
export const LEGACY_PROOF_HEADER = "x-legacy-import-proof";
/** A page stops at this many rows or bytes of encoded values, whichever comes first. */
export const LEGACY_PAGE_ROWS = 500;
export const LEGACY_PAGE_BYTES = 1_000_000;

export interface LegacyTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly count: number;
}

export interface LegacyRowsPage {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  /** Pass back as `after`; `null` when the table is exhausted. */
  readonly next: number | null;
}

/** The part of the class's props the proof lives in (`CodeHostProps`). */
export interface LegacyImportProps {
  readonly codeHost?: { readonly name: string; readonly proof: string } | null;
}

interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

interface StorageLike {
  sql: SqlLike;
  dolt?: DoltStorage;
  transactionSync<T>(fn: () => T): T;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Tables a store owns for itself, never copied. */
const NOT_COPIED = [
  /^_cf_/i,
  /^sqlite_/i,
  /^_litestream/i,
  /^dolt_/i,
  /^doltlite_/i,
  // Written by the new facet's own schema install and nonce ledger.
  /^_vibestudio_schema/,
  /^_vibestudio_direct_rpc_nonces$/,
  /^vsl_direct_rpc_nonces$/,
];

export function isLegacyCall(method: string): boolean {
  return method.startsWith(`${LEGACY_ROUTE}/`);
}

function quote(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`legacy import: bad identifier ${name}`);
  return `"${name}"`;
}

function applicationTableNames(sql: SqlLike): string[] {
  return sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => String(row["name"]))
    .filter((name) => IDENTIFIER.test(name) && !NOT_COPIED.some((pattern) => pattern.test(name)));
}

function columnsOf(sql: SqlLike, table: string): string[] {
  return sql
    .exec(`PRAGMA table_info(${quote(table)})`)
    .toArray()
    .map((row) => String(row["name"]));
}

/** Application tables parents first (a table is listed after every table its foreign keys name). */
export function legacyTables(sql: SqlLike): LegacyTable[] {
  const names = applicationTableNames(sql);
  const parents = new Map<string, Set<string>>();
  for (const name of names) {
    const referenced = new Set<string>();
    for (const row of sql.exec(`PRAGMA foreign_key_list(${quote(name)})`).toArray()) {
      const table = String(row["table"]);
      if (table !== name && names.includes(table)) referenced.add(table);
    }
    parents.set(name, referenced);
  }
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < names.length) {
    const ready = names.filter(
      (name) => !placed.has(name) && [...parents.get(name)!].every((parent) => placed.has(parent))
    );
    // A cycle between tables has no parents-first order; the rest follow by name.
    const next = ready.length > 0 ? ready : names.filter((name) => !placed.has(name));
    for (const name of next) {
      ordered.push(name);
      placed.add(name);
      if (ready.length === 0) break;
    }
  }
  return ordered.map((name) => ({
    name,
    columns: columnsOf(sql, name),
    count: Number(sql.exec(`SELECT count(*) AS n FROM ${quote(name)}`).toArray()[0]?.["n"] ?? 0),
  }));
}

function hasRowid(sql: SqlLike, table: string): boolean {
  try {
    sql.exec(`SELECT rowid FROM ${quote(table)} LIMIT 0`).toArray();
    return true;
  } catch {
    return false;
  }
}

/** One page of a table, in rowid order (or by primary key for a table without one). */
export function legacyRowsPage(
  sql: SqlLike,
  table: string,
  after: number | null,
  limit = LEGACY_PAGE_ROWS
): LegacyRowsPage {
  if (!applicationTableNames(sql).includes(table))
    throw new Error(`legacy import: no table ${table}`);
  const columns = columnsOf(sql, table);
  const cols = columns.map(quote).join(", ");
  const rowid = hasRowid(sql, table);
  const bounded = Math.max(1, Math.min(limit, LEGACY_PAGE_ROWS));
  const raw = rowid
    ? sql
        .exec(
          `SELECT rowid AS __rowid, ${cols} FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
          after ?? -9007199254740991,
          bounded
        )
        .toArray()
    : sql
        .exec(
          `SELECT ${cols} FROM ${quote(table)} ORDER BY ${cols} LIMIT ? OFFSET ?`,
          bounded,
          after ?? 0
        )
        .toArray();
  const rows: unknown[][] = [];
  let bytes = 0;
  let last: number | null = null;
  let taken = 0;
  for (const row of raw) {
    const values = columns.map((column) => row[column]);
    bytes += encodeRpcJson(values).length;
    if (rows.length > 0 && bytes > LEGACY_PAGE_BYTES) break;
    rows.push(values);
    taken++;
    last = rowid ? Number(row["__rowid"]) : (after ?? 0) + taken;
  }
  const exhausted = rows.length === raw.length && raw.length < bounded;
  return { columns, rows, next: exhausted ? null : last };
}

/** Insert rows the legacy facet paged out, into a table the new facet's schema created. */
export function legacyLoadRows(
  storage: StorageLike,
  input: { table: string; columns: readonly string[]; rows: readonly (readonly unknown[])[] }
): number {
  const exists = storage.sql
    .exec("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", input.table)
    .toArray();
  if (exists.length === 0)
    throw new Error(`legacy import: the new schema has no table ${input.table}`);
  const have = new Set(columnsOf(storage.sql, input.table));
  for (const column of input.columns)
    if (!have.has(column))
      throw new Error(`legacy import: table ${input.table} has no column ${column}`);
  const statement = `INSERT OR REPLACE INTO ${quote(input.table)} (${input.columns
    .map(quote)
    .join(", ")}) VALUES (${input.columns.map(() => "?").join(", ")})`;
  storage.transactionSync(() => {
    for (const row of input.rows) storage.sql.exec(statement, ...row);
  });
  return input.rows.length;
}

export async function serveLegacyCall(input: {
  storage: StorageLike;
  props: LegacyImportProps;
  request: Request;
  method: string;
  body: string;
}): Promise<Response> {
  const respond = (value: unknown, status = 200): Response =>
    new Response(encodeRpcJson(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const proof = input.props.codeHost?.proof;
  const offered = input.request.headers.get(LEGACY_PROOF_HEADER);
  if (!proof || !offered || offered.length !== proof.length)
    return respond({ error: { message: "Forbidden" } }, 403);
  let difference = 0;
  for (let index = 0; index < proof.length; index++)
    difference |= proof.charCodeAt(index) ^ offered.charCodeAt(index);
  if (difference !== 0) return respond({ error: { message: "Forbidden" } }, 403);
  const name = input.method.slice(LEGACY_ROUTE.length + 1);
  const parsed = (input.body ? decodeRpcJson(input.body) : {}) as Record<string, unknown>;
  try {
    const { storage } = input;
    if (name === "engine") return respond({ result: { engine: storage.dolt ? "dolt" : "sqlite" } });
    if (name === "tables") return respond({ result: legacyTables(storage.sql) });
    if (name === "rows")
      return respond({
        result: legacyRowsPage(
          storage.sql,
          String(parsed["table"]),
          typeof parsed["after"] === "number" ? parsed["after"] : null,
          typeof parsed["limit"] === "number" ? parsed["limit"] : undefined
        ),
      });
    if (name === "load")
      return respond({
        result: legacyLoadRows(storage, {
          table: String(parsed["table"]),
          columns: parsed["columns"] as string[],
          rows: parsed["rows"] as unknown[][],
        }),
      });
    if (name === "commit") {
      if (!storage.dolt)
        return respond({ error: { message: "This store is not a Dolt store" } }, 409);
      return respond({
        result: storage.dolt.commit({
          message: String(parsed["message"] ?? "import from sqlite"),
          allowEmpty: true,
        }),
      });
    }
    return respond({ error: { message: `Unknown legacy call ${name}` } }, 404);
  } catch (error) {
    return respond({ error: serializeRpcFailure(error) }, 500);
  }
}
