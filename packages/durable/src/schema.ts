export interface SchemaSqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

export interface SchemaSqlStorage {
  exec(query: string, ...bindings: unknown[]): SchemaSqlResult;
}

export interface DurableObjectSchemaStorage {
  readonly sql: SchemaSqlStorage;
  transactionSync<T>(callback: () => T): T;
}

export interface DurableObjectSchemaMigration {
  /** A migration at version N transforms schema N - 1 into schema N. */
  readonly version: number;
  readonly name: string;
  validateSource(sql: SchemaSqlStorage): void;
  migrate(sql: SchemaSqlStorage): void;
}

export interface DurableObjectSchemaBaseline {
  readonly version: number;
  readonly name: string;
}

export interface DurableObjectSchemaDescriptor {
  readonly className: string;
  readonly version: number;
  readonly freshSchemaFingerprint: string;
  readonly baseline: DurableObjectSchemaBaseline;
  readonly migrations: readonly { readonly version: number; readonly name: string }[];
  /** Exact object keys whose published storage is retained as migration evidence. */
  readonly fixtureObjectKeys: readonly string[];
}

export type DurableObjectSchemaIncompatibleReason =
  | "version-mismatch"
  | "shape-drift"
  | "unversioned-database"
  | "future-version"
  | "migration-missing"
  | "ledger-drift";

export type DurableObjectSchemaSafeAction =
  | "add-migration"
  | "revert-schema-version"
  | "deploy-compatible-build"
  | "reset-storage";

export interface DurableObjectSchemaErrorData {
  readonly className: string;
  readonly persistedVersion: number | null;
  readonly targetVersion: number;
  readonly reason: DurableObjectSchemaIncompatibleReason | "migration-failed";
  readonly safeActions: readonly DurableObjectSchemaSafeAction[];
  readonly migration?: { readonly version: number; readonly name: string };
  readonly source?: string;
  readonly objectKey?: string;
}

export class DurableObjectSchemaError extends Error {
  readonly errorKind = "service" as const;
  readonly code: "DO_SCHEMA_INCOMPATIBLE" | "DO_SCHEMA_MIGRATION_FAILED";
  readonly errorData: DurableObjectSchemaErrorData;

  constructor(input: {
    code: "DO_SCHEMA_INCOMPATIBLE" | "DO_SCHEMA_MIGRATION_FAILED";
    message: string;
    data: DurableObjectSchemaErrorData;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "DurableObjectSchemaError";
    this.code = input.code;
    this.errorData = input.data;
  }

  withIdentity(identity: { source: string; objectKey: string }): DurableObjectSchemaError {
    return new DurableObjectSchemaError({
      code: this.code,
      message: this.message,
      data: { ...this.errorData, ...identity },
      cause: this.cause,
    });
  }
}

export interface DurableObjectSchemaDefinition {
  readonly className: string;
  readonly version: number;
  readonly storage: DurableObjectSchemaStorage;
  /** Names of schema objects owned by the durable-object implementation. */
  readonly schemaTables?: readonly string[];
  readonly productionBaseline: DurableObjectSchemaBaseline;
  readonly migrations?: readonly DurableObjectSchemaMigration[];
  createSchema(): void;
  validateSchema(): void;
}

const SCHEMA_TABLE = "_vibestudio_schema";
const MIGRATIONS_TABLE = "_vibestudio_schema_migrations";
const FRAMEWORK_OBJECTS = new Set([
  SCHEMA_TABLE,
  MIGRATIONS_TABLE,
  "_vibestudio_direct_rpc_nonces",
]);

function normalizedShape(sql: SchemaSqlStorage, schemaTables?: readonly string[]): string {
  const ownedTables = schemaTables === undefined ? null : new Set(["state", ...schemaTables]);
  return JSON.stringify(
    sql
      .exec(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'view', 'trigger')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
      )
      .toArray()
      .filter((row) => {
        const name = String(row["name"]);
        const table = String(row["tbl_name"] ?? "");
        // Exclude framework objects by attachment too: an index or trigger the
        // framework later adds to its own table must not enter app fingerprints.
        if (FRAMEWORK_OBJECTS.has(name) || FRAMEWORK_OBJECTS.has(table)) return false;
        if (!ownedTables) return true;
        return ownedTables.has(name) || ownedTables.has(table);
      })
      .map((row) => ({
        type: String(row["type"]),
        name: String(row["name"]),
        table: String(row["tbl_name"] ?? ""),
        sql: String(row["sql"] ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      }))
  );
}

export function durableObjectSchemaFingerprint(
  sql: SchemaSqlStorage,
  schemaTables?: readonly string[]
): string {
  return normalizedShape(sql, schemaTables);
}

function normalizeIndexSql(value: string): string {
  return value
    .replace(/\bIF\s+NOT\s+EXISTS\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function validateDurableObjectSchemaIndexes(
  sql: SchemaSqlStorage,
  schemaTables: readonly string[],
  expectedDefinitions: readonly string[]
): void {
  const expected = expectedDefinitions.map(normalizeIndexSql).sort();
  const ownedTables = new Set(schemaTables);
  for (const definition of expected) {
    const match = /\bON\s+["`[]?([^\s"`\].(]+)["`\]]?/iu.exec(definition);
    if (!match?.[1]) throw new Error(`Invalid declared index definition: ${definition}`);
    ownedTables.add(match[1]);
  }
  const actual = sql
    .exec(
      `SELECT tbl_name, sql FROM sqlite_master
       WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .toArray()
    .filter((row) => ownedTables.has(String(row["tbl_name"] ?? "")))
    .map((row) => normalizeIndexSql(String(row["sql"] ?? "")))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `schema index definitions differ: expected ${JSON.stringify(expected)}, ` +
        `received ${JSON.stringify(actual)}`
    );
  }
}

/** Describe the schema installed in a scratch object after createSchema(). */
export function durableObjectSchemaDescriptor(
  definition: DurableObjectSchemaDefinition,
  fixtureObjectKeys: readonly string[] = []
): DurableObjectSchemaDescriptor {
  const normalizedFixtureKeys = fixtureObjectKeys.map((key) => key.trim());
  for (const key of normalizedFixtureKeys) {
    if (key.length === 0 || key.length > 512 || key.startsWith("__vibestudio_schema_probe:")) {
      throw new Error(`${definition.className} declared an invalid schema fixture object key`);
    }
  }
  return {
    className: definition.className,
    version: definition.version,
    freshSchemaFingerprint: durableObjectSchemaFingerprint(
      definition.storage.sql,
      definition.schemaTables
    ),
    baseline: definition.productionBaseline,
    migrations: (definition.migrations ?? []).map(({ version, name }) => ({ version, name })),
    fixtureObjectKeys: [...new Set(normalizedFixtureKeys)].sort(),
  };
}

function schemaObjects(sql: SchemaSqlStorage): string[] {
  return sql
    .exec(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'index', 'view', 'trigger')
         AND name NOT LIKE 'sqlite_%'`
    )
    .toArray()
    .map((row) => String(row["name"]));
}

function exactColumns(sql: SchemaSqlStorage, table: string): string[] {
  return sql
    .exec(`PRAGMA table_info(${table})`)
    .toArray()
    .map((row) => String(row["name"]));
}

function incompatible(
  definition: DurableObjectSchemaDefinition,
  reason: DurableObjectSchemaIncompatibleReason,
  persistedVersion: number | null,
  detail: string
): DurableObjectSchemaError {
  const safeActions: DurableObjectSchemaSafeAction[] =
    reason === "unversioned-database"
      ? ["reset-storage"]
      : reason === "future-version"
        ? ["deploy-compatible-build", "reset-storage"]
        : reason === "shape-drift" || reason === "ledger-drift"
          ? ["add-migration", "reset-storage"]
          : ["add-migration", "revert-schema-version", "reset-storage"];
  return new DurableObjectSchemaError({
    code: "DO_SCHEMA_INCOMPATIBLE",
    message:
      `${definition.className} cannot open persisted schema ` +
      `${persistedVersion === null ? "without a version" : `v${persistedVersion}`} with build schema v${definition.version}: ` +
      `${detail}. Safe actions: ${safeActions
        .map((action) => {
          if (action === "add-migration") return "add the required schemaMigrations() step";
          if (action === "revert-schema-version")
            return `revert schemaVersion to ${persistedVersion ?? "the persisted version"}`;
          if (action === "deploy-compatible-build")
            return "deploy code compatible with this version";
          return "call workers.resetStorage() for explicitly disposable state";
        })
        .join(", or ")}.`,
    data: {
      className: definition.className,
      persistedVersion,
      targetVersion: definition.version,
      reason,
      safeActions,
    },
  });
}

function validateDefinition(definition: DurableObjectSchemaDefinition): void {
  const { className, version, productionBaseline, migrations = [] } = definition;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`${className} has invalid schema version ${version}`);
  }
  if (
    !Number.isSafeInteger(productionBaseline.version) ||
    productionBaseline.version < 1 ||
    productionBaseline.version > version ||
    productionBaseline.name.trim().length === 0
  ) {
    throw new Error(`${className} has an invalid production schema baseline`);
  }
  const seen = new Set<number>();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!;
    const expectedVersion = productionBaseline.version + index + 1;
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== expectedVersion ||
      migration.name.trim().length === 0 ||
      seen.has(migration.version)
    ) {
      throw new Error(`${className} has an invalid migration at version ${migration.version}`);
    }
    seen.add(migration.version);
  }
  if (productionBaseline.version + migrations.length !== version) {
    throw incompatible(
      definition,
      "migration-missing",
      productionBaseline.version,
      `schemaMigrations() must declare every version from ` +
        `${productionBaseline.version + 1} through ${version}`
    );
  }
}

function runSynchronousMigrationCallback(
  label: string,
  callback: (sql: SchemaSqlStorage) => unknown,
  sql: SchemaSqlStorage
): void {
  if (callback.constructor.name === "AsyncFunction") {
    throw new Error(`${label} must not be an async function`);
  }
  let active = true;
  const guardedSql: SchemaSqlStorage = {
    exec(query, ...bindings) {
      if (!active) {
        throw new Error(
          `${label} attempted to use storage after its synchronous callback returned`
        );
      }
      return sql.exec(query, ...bindings);
    },
  };
  try {
    const result = callback(guardedSql);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
      throw new Error(`${label} must be synchronous and must not return a Promise`);
    }
  } finally {
    active = false;
  }
}

function createMetadata(definition: DurableObjectSchemaDefinition): void {
  const { sql } = definition.storage;
  sql.exec(`
    CREATE TABLE ${SCHEMA_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL,
      installed_version INTEGER NOT NULL,
      shape_json TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE ${MIGRATIONS_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  const shape = normalizedShape(sql, definition.schemaTables);
  sql.exec(
    `INSERT INTO ${SCHEMA_TABLE} (singleton, version, installed_version, shape_json)
     VALUES (1, ?, ?, ?)`,
    definition.version,
    definition.version,
    shape
  );
}

interface PersistedMetadata {
  version: number;
  installedVersion: number;
  shape: string;
}

function readMetadata(
  definition: DurableObjectSchemaDefinition,
  objects: readonly string[]
): PersistedMetadata {
  const { sql } = definition.storage;
  if (!objects.includes(SCHEMA_TABLE) || !objects.includes(MIGRATIONS_TABLE)) {
    throw incompatible(
      definition,
      "unversioned-database",
      null,
      "persistent objects exist but no schema identity and migration ledger are recorded"
    );
  }
  if (
    exactColumns(sql, SCHEMA_TABLE).join(",") !== "singleton,version,installed_version,shape_json"
  ) {
    throw incompatible(definition, "ledger-drift", null, "the schema identity table is malformed");
  }
  const rows = sql
    .exec(`SELECT singleton, version, installed_version, shape_json FROM ${SCHEMA_TABLE}`)
    .toArray();
  const row = rows[0];
  const version = Number(row?.["version"]);
  const installedVersion = Number(row?.["installed_version"]);
  if (
    rows.length !== 1 ||
    Number(row?.["singleton"]) !== 1 ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(installedVersion) ||
    installedVersion < 1 ||
    installedVersion > version ||
    typeof row?.["shape_json"] !== "string"
  ) {
    throw incompatible(definition, "ledger-drift", null, "the schema identity row is malformed");
  }
  return {
    version,
    installedVersion,
    shape: String(row["shape_json"]),
  };
}

function validateLedger(
  definition: DurableObjectSchemaDefinition,
  persistedVersion: number,
  installedVersion: number,
  migrations: ReadonlyMap<number, DurableObjectSchemaMigration>
): void {
  const { sql } = definition.storage;
  if (exactColumns(sql, MIGRATIONS_TABLE).join(",") !== "version,name") {
    throw incompatible(
      definition,
      "ledger-drift",
      persistedVersion,
      "the migration ledger is malformed"
    );
  }
  const rows = sql.exec(`SELECT version, name FROM ${MIGRATIONS_TABLE} ORDER BY version`).toArray();
  if (rows.length === 0) {
    if (persistedVersion === installedVersion) return;
    throw incompatible(
      definition,
      "ledger-drift",
      persistedVersion,
      "the migration ledger is incomplete"
    );
  }
  let previous = installedVersion;
  // Ledger rows at or below the current production baseline are permanent
  // history from an older support window: a later build that raises its
  // baseline retires those migration definitions, so history is validated for
  // contiguity only. Rows above the baseline must match running definitions.
  for (let index = 0; index < rows.length; index += 1) {
    const version = Number(rows[index]!["version"]);
    if (!Number.isSafeInteger(version) || version !== previous + 1) {
      throw incompatible(
        definition,
        "ledger-drift",
        persistedVersion,
        "the migration ledger is not contiguous"
      );
    }
    if (version > definition.productionBaseline.version) {
      const expected = migrations.get(version);
      if (!expected || rows[index]!["name"] !== expected.name) {
        throw incompatible(
          definition,
          "ledger-drift",
          persistedVersion,
          "recorded migrations do not match this build"
        );
      }
    }
    previous = version;
  }
  if (previous !== persistedVersion) {
    throw incompatible(
      definition,
      "ledger-drift",
      persistedVersion,
      "the migration ledger does not reach the persisted version"
    );
  }
}

/**
 * Install, migrate, or validate a Durable Object schema. All metadata and
 * application changes are committed by one storage transaction.
 */
export function installDurableObjectSchema(definition: DurableObjectSchemaDefinition): void {
  validateDefinition(definition);
  const migrations = new Map(
    (definition.migrations ?? []).map((migration) => [migration.version, migration] as const)
  );

  definition.storage.transactionSync(() => {
    const objects = schemaObjects(definition.storage.sql);
    if (objects.length === 0) {
      definition.storage.sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      definition.createSchema();
      definition.validateSchema();
      createMetadata(definition);
      return;
    }

    const persisted = readMetadata(definition, objects);
    if (persisted.version > definition.version) {
      throw incompatible(
        definition,
        "future-version",
        persisted.version,
        "the persisted schema is newer than this build"
      );
    }
    if (persisted.version < definition.productionBaseline.version) {
      throw incompatible(
        definition,
        "version-mismatch",
        persisted.version,
        `the oldest supported production schema is v${definition.productionBaseline.version}`
      );
    }

    validateLedger(definition, persisted.version, persisted.installedVersion, migrations);
    const persistedShape = normalizedShape(definition.storage.sql, definition.schemaTables);
    if (persistedShape !== persisted.shape) {
      throw incompatible(
        definition,
        "shape-drift",
        persisted.version,
        "the complete schema fingerprint has drifted"
      );
    }

    for (let version = persisted.version + 1; version <= definition.version; version += 1) {
      const migration = migrations.get(version);
      if (!migration) {
        throw incompatible(
          definition,
          "migration-missing",
          persisted.version,
          `schemaMigrations() has no contiguous ${version - 1}→${version} step`
        );
      }
      try {
        runSynchronousMigrationCallback(
          `schema migration ${version - 1}→${version} validateSource`,
          migration.validateSource,
          definition.storage.sql
        );
        runSynchronousMigrationCallback(
          `schema migration ${version - 1}→${version} migrate`,
          migration.migrate,
          definition.storage.sql
        );
      } catch (cause) {
        throw new DurableObjectSchemaError({
          code: "DO_SCHEMA_MIGRATION_FAILED",
          message:
            `${definition.className} schema migration ${version - 1}→${version} ` +
            `(${migration.name}) failed; the transaction was rolled back. Fix the migration and retry.`,
          data: {
            className: definition.className,
            persistedVersion: persisted.version,
            targetVersion: definition.version,
            reason: "migration-failed",
            safeActions: ["add-migration"],
            migration: { version, name: migration.name },
          },
          cause,
        });
      }
      definition.storage.sql.exec(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES (?, ?)`,
        version,
        migration.name
      );
    }

    definition.validateSchema();
    const shape = normalizedShape(definition.storage.sql, definition.schemaTables);
    definition.storage.sql.exec(
      `UPDATE ${SCHEMA_TABLE} SET version = ?, shape_json = ? WHERE singleton = 1`,
      definition.version,
      shape
    );
  });
}

interface RpcLikeEnvelope {
  from?: unknown;
  target?: unknown;
  delivery?: unknown;
  provenance?: unknown;
  message?: { type?: unknown; requestId?: unknown };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Shared initialization boundary for both Durable Object bases. A schema
 * refusal on `__rpc` remains an RPC response (not an HTTP transport failure).
 */
export async function dispatchWithDurableObjectSchemaGuard(input: {
  request: Request;
  identity: { source: string; className: string; objectKey: string };
  ensureReady(): void;
  dispatch(): Promise<Response>;
}): Promise<Response> {
  const segments = new URL(input.request.url).pathname.split("/").filter(Boolean);
  const isRpcPost = segments.slice(1).join("/") === "__rpc" && input.request.method === "POST";
  // Only an `__rpc` POST needs its body again on the error path (to correlate
  // the response envelope); cloning every request would buffer WebSocket
  // upgrades and large bodies for nothing.
  const requestCopy = isRpcPost ? input.request.clone() : null;
  try {
    input.ensureReady();
    return await input.dispatch();
  } catch (cause) {
    if (!(cause instanceof DurableObjectSchemaError)) throw cause;
    const error = cause.withIdentity(input.identity);
    const data = { ...error.errorData, className: input.identity.className };
    if (requestCopy) {
      try {
        const envelope = (await requestCopy.json()) as RpcLikeEnvelope;
        if (
          envelope.message?.type === "request" &&
          typeof envelope.message.requestId === "string"
        ) {
          return json({
            from: envelope.target,
            target: envelope.from,
            delivery: envelope.delivery ?? { caller: { callerId: "", callerKind: "unknown" } },
            provenance: Array.isArray(envelope.provenance) ? envelope.provenance : [],
            message: {
              type: "response",
              requestId: envelope.message.requestId,
              error: error.message,
              errorKind: error.errorKind,
              errorCode: error.code,
              errorData: data,
            },
          });
        }
      } catch {
        // A malformed request has no usable correlation id; use the ordinary
        // structured HTTP error below.
      }
    }
    return json(
      {
        error: error.message,
        errorKind: error.errorKind,
        errorCode: error.code,
        errorData: data,
      },
      500
    );
  }
}
