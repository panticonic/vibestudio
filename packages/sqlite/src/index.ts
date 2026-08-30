/**
 * Exact SQLite schema lifecycle shared by host-owned stores.
 *
 * A store either initializes an empty database at its one current schema or
 * validates that exact schema. Every other shape is rejected unchanged.
 */
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

export interface CanonicalSqliteOpenOptions {
  description: string;
  /** Read-only owners validate current state but can never initialize it. */
  readOnly?: boolean;
  /** Explicit, transactional migrations for schemas that actually shipped. */
  migrations?: readonly CanonicalSqliteMigration[];
}

export interface CanonicalSqliteMigration {
  fromVersion: number;
  toVersion: number;
  migrate(db: DatabaseSync): void;
}

export type CanonicalSqliteOpenResult =
  | { kind: "current"; version: number }
  | { kind: "initialized"; version: number };

function normalizedSql(sql: string): string {
  let result = "";
  let pendingSpace = false;
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      result += character;
      if (quote === "]" ? character === "]" : character === quote) {
        // SQL escapes quoted strings/identifiers by doubling their delimiter.
        if (sql[index + 1] === character && quote !== "]") {
          result += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (pendingSpace && result && !result.endsWith("(") && !result.endsWith(",")) result += " ";
      pendingSpace = false;
      quote = character;
      result += character;
      continue;
    }
    if (character === "[") {
      if (pendingSpace && result && !result.endsWith("(") && !result.endsWith(",")) result += " ";
      pendingSpace = false;
      quote = "]";
      result += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (character === "," || character === ")" || character === ";") {
      result = result.trimEnd();
      if (character !== ";" || sql.slice(index + 1).trim() !== "") result += character;
      pendingSpace = false;
      continue;
    }
    if (character === "(") {
      result = result.trimEnd() + character;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && result && !result.endsWith("(") && !result.endsWith(",")) result += " ";
    pendingSpace = false;
    result += character;
  }
  return result.trim();
}

function readSqliteUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, SQLOutputValue> | undefined;
  return Number(row?.["user_version"] ?? -1);
}

function pragmaNumber(db: DatabaseSync, name: "page_count" | "freelist_count"): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, SQLOutputValue> | undefined;
  return Number(row?.[name] ?? -1);
}

function schemaObjectCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get() as Record<
    string,
    SQLOutputValue
  >;
  return Number(row["count"]);
}

/**
 * A database may initialize only when it has never contained SQLite pages.
 * A dropped historical database can have an empty catalog while retaining
 * freelist/data pages; that is existing state and is never silently repurposed.
 */
function isTrulyEmptySqliteDatabase(db: DatabaseSync): boolean {
  return (
    schemaObjectCount(db) === 0 &&
    readSqliteUserVersion(db) === 0 &&
    pragmaNumber(db, "page_count") === 0 &&
    pragmaNumber(db, "freelist_count") === 0
  );
}

function hasNoVersionedSchema(db: DatabaseSync): boolean {
  return schemaObjectCount(db) === 0 && readSqliteUserVersion(db) === 0;
}

function validateSchema(schema: CanonicalSqliteSchema): void {
  if (!Number.isSafeInteger(schema.version) || schema.version < 1) {
    throw new Error("Canonical SQLite schema version must be a positive safe integer");
  }
}

function createSchema(db: DatabaseSync, schema: CanonicalSqliteSchema): void {
  for (const object of schema.objects) db.exec(object.sql);
  db.exec(`PRAGMA user_version = ${schema.version}`);
}

/**
 * Validate the exact current schema without writing. Table SQL captures column
 * order plus PK/FK/UNIQUE/CHECK semantics; index SQL captures indexed columns,
 * order, direction, uniqueness, and predicates. Any extra object also fails.
 */
function assertCanonicalSqliteSchema(
  db: DatabaseSync,
  schema: CanonicalSqliteSchema,
  description: string
): void {
  const actualVersion = readSqliteUserVersion(db);
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

function unsupportedVersionError(
  description: string,
  actualVersion: number,
  version: number
): Error {
  return new Error(
    `Unsupported ${description}: schema version is ${actualVersion}, expected ${version}; ` +
      "the database was left unchanged"
  );
}

/**
 * Initialize or validate one host SQLite database.
 *
 * Writers hold `BEGIN IMMEDIATE` across initialization and exact validation.
 * This makes simultaneous startup deterministic: a waiter observes and
 * validates the winner's committed schema.
 */
export function openCanonicalSqliteDatabase(
  db: DatabaseSync,
  schema: CanonicalSqliteSchema,
  options: CanonicalSqliteOpenOptions
): CanonicalSqliteOpenResult {
  validateSchema(schema);
  const initiallyTrulyEmpty = isTrulyEmptySqliteDatabase(db);

  if (options.readOnly) {
    if (initiallyTrulyEmpty) {
      throw new Error(`Unsupported ${options.description}: a read-only owner cannot initialize it`);
    }
    const actualVersion = readSqliteUserVersion(db);
    if (actualVersion !== schema.version) {
      throw unsupportedVersionError(options.description, actualVersion, schema.version);
    }
    assertCanonicalSqliteSchema(db, schema, options.description);
    return { kind: "current", version: schema.version };
  }

  db.exec("BEGIN IMMEDIATE");
  let transactionOpen = true;
  try {
    if (hasNoVersionedSchema(db)) {
      if (!initiallyTrulyEmpty) {
        throw unsupportedVersionError(options.description, 0, schema.version);
      }
      createSchema(db, schema);
      assertCanonicalSqliteSchema(db, schema, options.description);
      db.exec("COMMIT");
      transactionOpen = false;
      return { kind: "initialized", version: schema.version };
    }

    let actualVersion = readSqliteUserVersion(db);
    if (actualVersion !== schema.version) {
      const visited = new Set<number>();
      while (actualVersion !== schema.version) {
        if (visited.has(actualVersion)) {
          throw new Error(`Migration cycle in ${options.description} at version ${actualVersion}`);
        }
        visited.add(actualVersion);
        const migration = options.migrations?.find(
          (candidate) => candidate.fromVersion === actualVersion
        );
        if (
          !migration ||
          !Number.isSafeInteger(migration.toVersion) ||
          migration.toVersion <= actualVersion ||
          migration.toVersion > schema.version
        ) {
          throw unsupportedVersionError(options.description, actualVersion, schema.version);
        }
        migration.migrate(db);
        actualVersion = migration.toVersion;
        db.exec(`PRAGMA user_version = ${actualVersion}`);
      }
    }
    assertCanonicalSqliteSchema(db, schema, options.description);
    db.exec("COMMIT");
    transactionOpen = false;
    return { kind: "current", version: schema.version };
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  }
}
