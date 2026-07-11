import { type DatabaseSync, type SQLOutputValue } from "node:sqlite";

export interface CanonicalSqliteObject {
  type: "table" | "index" | "trigger" | "view";
  name: string;
  sql: string;
}

export interface CanonicalSqliteSchema {
  version: number;
  objects: readonly CanonicalSqliteObject[];
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, SQLOutputValue> | undefined;
  return Number(row?.["user_version"] ?? -1);
}

function pragmaNumber(db: DatabaseSync, name: "page_count" | "freelist_count"): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, SQLOutputValue> | undefined;
  return Number(row?.[name] ?? -1);
}

/**
 * A database may initialize only when it has never contained SQLite pages.
 * Checking the schema alone is insufficient: a pre-cutover DB can have all of
 * its tables dropped while retaining freelist/data pages. That is existing
 * state, not a new database, and must never be repurposed implicitly.
 */
export function isTrulyEmptySqliteDatabase(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get() as Record<
    string,
    SQLOutputValue
  >;
  return (
    Number(row["count"]) === 0 &&
    userVersion(db) === 0 &&
    pragmaNumber(db, "page_count") === 0 &&
    pragmaNumber(db, "freelist_count") === 0
  );
}

function hasNoVersionedSchema(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get() as Record<
    string,
    SQLOutputValue
  >;
  return Number(row["count"]) === 0 && userVersion(db) === 0;
}

/** Initialize a brand-new database. This function never upgrades existing state. */
export function initializeCanonicalSqliteSchema(
  db: DatabaseSync,
  schema: CanonicalSqliteSchema
): void {
  if (!isTrulyEmptySqliteDatabase(db)) {
    throw new Error("Refusing to initialize a nonempty SQLite database");
  }
  db.exec("BEGIN IMMEDIATE");
  let transactionOpen = true;
  try {
    // Another process may have initialized the same brand-new file while this
    // connection waited for the write lock. Accept only that exact schema;
    // never run CREATE statements against state that became nonempty.
    // BEGIN IMMEDIATE reserves page 1 on a brand-new database, so the locked
    // recheck deliberately examines only durable schema/version state. The
    // stricter page-count check already ran before entering this transaction.
    if (!hasNoVersionedSchema(db)) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      assertCanonicalSqliteSchema(db, schema, "concurrently initialized SQLite database");
      return;
    }
    for (const object of schema.objects) db.exec(object.sql);
    db.exec(`PRAGMA user_version = ${schema.version}`);
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Validate the exact current schema without writing. Table SQL captures column
 * order plus PK/FK/UNIQUE/CHECK semantics; index SQL captures indexed columns,
 * order, direction, uniqueness, and predicates. Any extra object also fails.
 */
export function assertCanonicalSqliteSchema(
  db: DatabaseSync,
  schema: CanonicalSqliteSchema,
  description: string
): void {
  const actualVersion = userVersion(db);
  if (actualVersion !== schema.version) {
    throw new Error(
      `Unsupported ${description}: schema version is ${actualVersion}, expected ${schema.version}`
    );
  }

  const expected = new Map(
    schema.objects.map((object) => [`${object.type}:${object.name}`, normalizedSql(object.sql)])
  );
  const rows = db
    .prepare(
      `SELECT type, name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    )
    .all() as Array<Record<string, SQLOutputValue>>;
  const actualKeys = rows.map((row) => `${String(row["type"])}:${String(row["name"])}`);
  const expectedKeys = [...expected.keys()].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    const actualSet = new Set(actualKeys);
    const expectedSet = new Set(expectedKeys);
    const missing = expectedKeys.filter((key) => !actualSet.has(key));
    const unexpected = actualKeys.filter((key) => !expectedSet.has(key));
    throw new Error(
      `Unsupported ${description}: schema object set is not canonical` +
        (missing.length ? `; missing [${missing.join(", ")}]` : "") +
        (unexpected.length ? `; unexpected [${unexpected.join(", ")}]` : "")
    );
  }

  for (const row of rows) {
    const key = `${String(row["type"])}:${String(row["name"])}`;
    const expectedSql = expected.get(key);
    const actualSql = typeof row["sql"] === "string" ? normalizedSql(row["sql"]) : null;
    if (actualSql !== expectedSql) {
      throw new Error(`Unsupported ${description}: ${key} definition is not canonical`);
    }
  }
}
