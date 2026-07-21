/**
 * Production SQLite schema lifecycle shared by host-owned stores.
 *
 * A schema plan has one explicit production baseline and a contiguous chain of
 * named, lossless migrations. Existing databases are validated exactly before
 * and after every migration. Unknown, malformed, pre-baseline, and future
 * databases are rejected without attempting repair.
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

export interface CanonicalSqliteMigration {
  /** Stable, human-readable identity for diagnostics and release notes. */
  name: string;
  /** Exact schema accepted as this migration's input. */
  from: CanonicalSqliteSchema;
  /** Exact schema the migration must produce. */
  to: CanonicalSqliteSchema;
  migrate(db: DatabaseSync): undefined;
}

export interface CanonicalSqliteMigrationPlan {
  /** Exact schema created for a new database and required after startup. */
  current: CanonicalSqliteSchema;
  /**
   * Ordered, contiguous migrations. With no entries, `current` is the first
   * supported production baseline; older versions are intentionally rejected.
   */
  migrations?: readonly CanonicalSqliteMigration[];
}

export interface CanonicalSqliteOpenOptions {
  description: string;
  /** Read-only owners validate current state but can never initialize/migrate. */
  readOnly?: boolean;
}

export type CanonicalSqliteOpenResult =
  | { kind: "current"; version: number }
  | { kind: "initialized"; version: number }
  | { kind: "migrated"; fromVersion: number; version: number; migrations: readonly string[] };

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

function schemaSignature(schema: CanonicalSqliteSchema): string {
  return JSON.stringify({
    version: schema.version,
    objects: schema.objects
      .map((object) => ({ ...object, sql: normalizedSql(object.sql) }))
      .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`)),
  });
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

function validatePlan(plan: CanonicalSqliteMigrationPlan): readonly CanonicalSqliteMigration[] {
  const current = plan.current;
  if (!Number.isSafeInteger(current.version) || current.version < 1) {
    throw new Error("Canonical SQLite schema version must be a positive safe integer");
  }
  const migrations = plan.migrations ?? [];
  const names = new Set<string>();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!;
    if (!migration.name.trim() || names.has(migration.name)) {
      throw new Error(`Canonical SQLite migration name is empty or duplicated: ${migration.name}`);
    }
    names.add(migration.name);
    if (migration.to.version !== migration.from.version + 1) {
      throw new Error(
        `Canonical SQLite migration ${migration.name} must advance exactly one version ` +
          `(${migration.from.version} -> ${migration.to.version})`
      );
    }
    const previous = migrations[index - 1];
    if (previous && schemaSignature(previous.to) !== schemaSignature(migration.from)) {
      throw new Error(
        `Canonical SQLite migration ${migration.name} does not continue ${previous.name}`
      );
    }
  }
  const finalSchema = migrations.at(-1)?.to ?? current;
  if (schemaSignature(finalSchema) !== schemaSignature(current)) {
    throw new Error("Canonical SQLite migration chain does not end at the current schema");
  }
  return migrations;
}

function createSchema(db: DatabaseSync, schema: CanonicalSqliteSchema): void {
  for (const object of schema.objects) db.exec(object.sql);
  db.exec(`PRAGMA user_version = ${schema.version}`);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
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
  baselineVersion: number,
  currentVersion: number
): Error {
  if (actualVersion > currentVersion) {
    return new Error(
      `Unsupported ${description}: schema version ${actualVersion} is newer than supported ` +
        `version ${currentVersion}; refusing to modify future data`
    );
  }
  return new Error(
    `Unsupported ${description}: schema version ${actualVersion} predates production baseline ` +
      `${baselineVersion}; no lossless migration is defined and the database was left unchanged`
  );
}

/**
 * Initialize, migrate, or validate one host SQLite database.
 *
 * Writers hold `BEGIN IMMEDIATE` across the locked version recheck, exact
 * source validation, every migration, version stamps, and exact final
 * validation. This makes simultaneous startup deterministic: a waiter observes
 * and validates the winner's committed schema instead of replaying work.
 */
export function openCanonicalSqliteDatabase(
  db: DatabaseSync,
  plan: CanonicalSqliteMigrationPlan,
  options: CanonicalSqliteOpenOptions
): CanonicalSqliteOpenResult {
  const migrations = validatePlan(plan);
  const baselineVersion = migrations[0]?.from.version ?? plan.current.version;
  const initiallyTrulyEmpty = isTrulyEmptySqliteDatabase(db);

  if (options.readOnly) {
    if (initiallyTrulyEmpty) {
      throw new Error(`Unsupported ${options.description}: a read-only owner cannot initialize it`);
    }
    const actualVersion = readSqliteUserVersion(db);
    if (actualVersion !== plan.current.version) {
      const pendingMigration = migrations.find(
        (candidate) => candidate.from.version === actualVersion
      );
      if (pendingMigration) {
        assertCanonicalSqliteSchema(db, pendingMigration.from, options.description);
        throw new Error(
          `Unsupported ${options.description}: schema version ${actualVersion} requires ` +
            `migration to ${plan.current.version}, but a read-only owner cannot migrate it`
        );
      }
      throw unsupportedVersionError(
        options.description,
        actualVersion,
        baselineVersion,
        plan.current.version
      );
    }
    assertCanonicalSqliteSchema(db, plan.current, options.description);
    return { kind: "current", version: plan.current.version };
  }

  db.exec("BEGIN IMMEDIATE");
  let transactionOpen = true;
  try {
    if (hasNoVersionedSchema(db)) {
      if (!initiallyTrulyEmpty) {
        throw unsupportedVersionError(
          options.description,
          0,
          baselineVersion,
          plan.current.version
        );
      }
      createSchema(db, plan.current);
      assertCanonicalSqliteSchema(db, plan.current, options.description);
      db.exec("COMMIT");
      transactionOpen = false;
      return { kind: "initialized", version: plan.current.version };
    }

    const startingVersion = readSqliteUserVersion(db);
    if (startingVersion === plan.current.version) {
      assertCanonicalSqliteSchema(db, plan.current, options.description);
      db.exec("COMMIT");
      transactionOpen = false;
      return { kind: "current", version: plan.current.version };
    }

    let version = startingVersion;
    const applied: string[] = [];
    while (version !== plan.current.version) {
      const migration = migrations.find((candidate) => candidate.from.version === version);
      if (!migration) {
        throw unsupportedVersionError(
          options.description,
          version,
          baselineVersion,
          plan.current.version
        );
      }
      assertCanonicalSqliteSchema(db, migration.from, options.description);
      // Reject native async functions before invocation: otherwise their body
      // could resume after this transaction has rolled back. The thenable
      // check also catches non-native promise-returning implementations that
      // crossed a JavaScript or type-erased boundary.
      if (migration.migrate.constructor.name === "AsyncFunction") {
        throw new Error(
          `Canonical SQLite migration ${migration.name} must be synchronous and return undefined`
        );
      }
      const migrationResult: unknown = migration.migrate(db);
      if (migrationResult !== undefined) {
        if (isThenable(migrationResult)) {
          void migrationResult.then(undefined, () => undefined);
        }
        throw new Error(
          `Canonical SQLite migration ${migration.name} must be synchronous and return undefined`
        );
      }
      db.exec(`PRAGMA user_version = ${migration.to.version}`);
      assertCanonicalSqliteSchema(db, migration.to, options.description);
      applied.push(migration.name);
      version = migration.to.version;
    }
    assertCanonicalSqliteSchema(db, plan.current, options.description);
    db.exec("COMMIT");
    transactionOpen = false;
    return {
      kind: "migrated",
      fromVersion: startingVersion,
      version: plan.current.version,
      migrations: applied,
    };
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    throw error;
  }
}
