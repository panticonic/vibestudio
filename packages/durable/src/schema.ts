export interface SchemaSqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

export interface SchemaSqlStorage {
  exec(query: string, ...bindings: unknown[]): SchemaSqlResult;
}

export interface DurableObjectSchemaMigration {
  readonly version: number;
  readonly name: string;
  /** Prove that the persisted source is the exact shape this translation understands. */
  validateSource(sql: SchemaSqlStorage): void;
  migrate(sql: SchemaSqlStorage): void;
}

export interface DurableObjectSchemaBaseline {
  readonly version: number;
  readonly name: string;
}

export interface DurableObjectSchemaStorage {
  readonly sql: SchemaSqlStorage;
  transactionSync<T>(callback: () => T): T;
}

export interface DurableObjectSchemaDefinition {
  readonly className: string;
  readonly targetVersion: number;
  readonly storage: DurableObjectSchemaStorage;
  readonly migrations: readonly DurableObjectSchemaMigration[];
  readonly productionBaseline?: DurableObjectSchemaBaseline;
  createSchema(): void;
  validateSchema(): void;
}

const SCHEMA_MIGRATIONS_TABLE = "_vibestudio_schema_migrations";

/**
 * Install or atomically migrate one Durable Object's private SQLite database.
 * This module is deliberately independent of either DurableObjectBase so host
 * and userland runtimes share one persistence contract.
 */
export function migrateDurableObjectSchema(definition: DurableObjectSchemaDefinition): void {
  const { className, targetVersion, storage } = definition;
  const sql = storage.sql;
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    throw new Error(`${className} has invalid schema version ${targetVersion}`);
  }
  const migrations = validatedMigrations(className, targetVersion, definition.migrations);
  const migrationsByVersion = new Map(
    migrations.map((migration) => [migration.version, migration])
  );
  const productionBaseline = validatedBaseline(
    className,
    targetVersion,
    migrations,
    definition.productionBaseline
  );

  // Durable Object SQLite transactions are synchronous and atomic. Schema
  // creation, ordered migrations, validation, and both version records commit
  // together or retry from the last fully committed version.
  storage.transactionSync(() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);

    const legacyVersion = readLegacyVersion(className, sql);
    const migrationRows = sql
      .exec(`SELECT version, name FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version`)
      .toArray();
    const recordedVersion = validateLedger(
      className,
      migrationRows,
      migrationsByVersion,
      productionBaseline
    );
    if (legacyVersion !== null && recordedVersion !== null && legacyVersion !== recordedVersion) {
      throw new Error(
        `${className} schema metadata disagrees: state=${legacyVersion}, migrations=${recordedVersion}`
      );
    }

    let currentVersion = recordedVersion ?? legacyVersion;
    if (currentVersion !== null && currentVersion < productionBaseline.version) {
      throw new Error(
        `${className} schema version ${currentVersion} predates production baseline ${productionBaseline.version} (${productionBaseline.name}); no lossless migration is declared and the database was left unchanged`
      );
    }
    if (currentVersion === null) {
      if (hasUnversionedPersistence(sql)) {
        throw new Error(
          `${className} has persisted data without a schema version; refusing to guess its shape`
        );
      }
      definition.createSchema();
      definition.validateSchema();
      recordVersion(sql, targetVersion, `fresh-install:${productionBaseline.name}`);
      currentVersion = targetVersion;
    } else if (recordedVersion === null) {
      sql.exec(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
        currentVersion,
        `adopted:${productionBaseline.name}`,
        Date.now()
      );
    }

    if (currentVersion === null) {
      throw new Error(`${className} failed to establish a schema baseline`);
    }
    let activeVersion: number = currentVersion;
    if (activeVersion > targetVersion) {
      throw new Error(
        `${className} schema version ${activeVersion} is newer than supported version ${targetVersion}`
      );
    }

    while (activeVersion < targetVersion) {
      const nextVersion: number = activeVersion + 1;
      const migration = migrationsByVersion.get(nextVersion);
      if (!migration) {
        throw new Error(
          `${className} has no schema migration from version ${activeVersion} to ${nextVersion}`
        );
      }
      migration.validateSource(sql);
      const result = migration.migrate(sql) as unknown;
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error(
          `${className} schema migration ${nextVersion} (${migration.name}) returned a Promise; migrations must be synchronous`
        );
      }
      recordVersion(sql, nextVersion, migration.name);
      activeVersion = nextVersion;
    }

    // Current-version drift is corruption. It is never silently repaired by
    // replaying fresh-install DDL.
    definition.validateSchema();
  });
}

function validatedBaseline(
  className: string,
  targetVersion: number,
  migrations: readonly DurableObjectSchemaMigration[],
  declared: DurableObjectSchemaBaseline | undefined
): DurableObjectSchemaBaseline {
  const baseline =
    declared ??
    ({
      version: migrations[0]?.version ? migrations[0].version - 1 : targetVersion,
      name: `${className.toLowerCase()}-production-baseline`,
    } satisfies DurableObjectSchemaBaseline);
  if (
    !Number.isSafeInteger(baseline.version) ||
    baseline.version < 1 ||
    baseline.version > targetVersion ||
    !baseline.name.trim()
  ) {
    throw new Error(`${className} has an invalid production schema baseline`);
  }
  if (targetVersion > baseline.version) {
    if (migrations[0]?.version !== baseline.version + 1) {
      throw new Error(
        `${className} production baseline ${baseline.version} (${baseline.name}) is not followed by migration ${baseline.version + 1}`
      );
    }
    if (migrations.at(-1)?.version !== targetVersion) {
      throw new Error(
        `${className} production baseline ${baseline.version} (${baseline.name}) has no complete migration chain to ${targetVersion}`
      );
    }
  } else if (migrations.length > 0) {
    throw new Error(
      `${className} declares migrations at or below its production baseline ${baseline.version} (${baseline.name})`
    );
  }
  return baseline;
}

function validatedMigrations(
  className: string,
  targetVersion: number,
  definitions: readonly DurableObjectSchemaMigration[]
): readonly DurableObjectSchemaMigration[] {
  const migrations = [...definitions];
  const versions = new Set<number>();
  const names = new Set<string>();
  let previousVersion = 0;
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version < 1 ||
      migration.version > targetVersion ||
      migration.version <= previousVersion
    ) {
      throw new Error(
        `${className} has invalid or unordered schema migration version ${migration.version}`
      );
    }
    if (!migration.name.trim() || names.has(migration.name) || versions.has(migration.version)) {
      throw new Error(
        `${className} has duplicate or empty schema migration metadata at version ${migration.version}`
      );
    }
    versions.add(migration.version);
    names.add(migration.name);
    previousVersion = migration.version;
  }
  return migrations;
}

function readLegacyVersion(className: string, sql: SchemaSqlStorage): number | null {
  const rows = sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).toArray();
  if (rows.length === 0) return null;
  return parseVersion(className, rows[0]!["value"], "state");
}

function validateLedger(
  className: string,
  rows: readonly Record<string, unknown>[],
  migrationsByVersion: ReadonlyMap<number, DurableObjectSchemaMigration>,
  productionBaseline: DurableObjectSchemaBaseline
): number | null {
  if (rows.length === 0) return null;
  let previousVersion: number | null = null;
  for (const [index, row] of rows.entries()) {
    const version = parseVersion(className, row["version"], "migration");
    const name = row["name"];
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`${className} has invalid migration name at version ${version}`);
    }
    if (index === 0) {
      const recognizedBaselineNames = new Set([
        // Accepted for databases stamped by the first migration-engine release.
        "fresh-install",
        "legacy-baseline",
        `fresh-install:${productionBaseline.name}`,
        `adopted:${productionBaseline.name}`,
      ]);
      if (!recognizedBaselineNames.has(name)) {
        throw new Error(`${className} migration ledger does not begin with a recognized baseline`);
      }
    } else {
      if (previousVersion === null || version !== previousVersion + 1) {
        throw new Error(`${className} migration ledger is not contiguous`);
      }
      const declared = migrationsByVersion.get(version);
      if (!declared || declared.name !== name) {
        throw new Error(
          `${className} migration ${version} (${name}) does not match the running code`
        );
      }
    }
    previousVersion = version;
  }
  return previousVersion;
}

function parseVersion(className: string, value: unknown, source: string): number {
  const normalized = typeof value === "number" ? String(value) : String(value ?? "");
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${className} has invalid ${source} schema version ${normalized}`);
  }
  const version = Number(normalized);
  if (!Number.isSafeInteger(version)) {
    throw new Error(`${className} has unsafe ${source} schema version ${normalized}`);
  }
  return version;
}

function hasUnversionedPersistence(sql: SchemaSqlStorage): boolean {
  const objects = sql
    .exec(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view', 'trigger')
         AND name NOT IN ('state', '${SCHEMA_MIGRATIONS_TABLE}')
         AND name NOT LIKE 'sqlite_%'`
    )
    .toArray();
  if (objects.length > 0) return true;
  return sql.exec(`SELECT 1 FROM state LIMIT 1`).toArray().length > 0;
}

function recordVersion(sql: SchemaSqlStorage, version: number, name: string): void {
  sql.exec(
    `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
    version,
    name,
    Date.now()
  );
  sql.exec(
    `INSERT OR REPLACE INTO state (key, value) VALUES ('schema_version', ?)`,
    String(version)
  );
}
