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

export interface DurableObjectSchemaDescriptor {
  readonly className: string;
  readonly version: number;
  readonly freshSchemaFingerprint: string;
}

export type DurableObjectSchemaIncompatibleReason =
  | "version-mismatch"
  | "shape-drift"
  | "unversioned-database";

export type DurableObjectSchemaSafeAction = "deploy-current-build" | "reset-storage";

export interface DurableObjectSchemaErrorData {
  readonly className: string;
  readonly persistedVersion: number | null;
  readonly targetVersion: number;
  readonly reason: DurableObjectSchemaIncompatibleReason;
  readonly safeActions: readonly DurableObjectSchemaSafeAction[];
  readonly source?: string;
  readonly objectKey?: string;
}

export class DurableObjectSchemaError extends Error {
  readonly errorKind = "service" as const;
  readonly code = "DO_SCHEMA_INCOMPATIBLE" as const;
  readonly errorData: DurableObjectSchemaErrorData;

  constructor(input: {
    message: string;
    data: DurableObjectSchemaErrorData;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "DurableObjectSchemaError";
    this.errorData = input.data;
  }

  withIdentity(identity: { source: string; objectKey: string }): DurableObjectSchemaError {
    return new DurableObjectSchemaError({
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
  createSchema(): void;
  validateSchema(): void;
}

const SCHEMA_TABLE = "_vibestudio_schema";
const FRAMEWORK_OBJECTS = new Set([SCHEMA_TABLE, "_vibestudio_direct_rpc_nonces"]);

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

export function validateDurableObjectSchemaDefinition(
  definition: DurableObjectSchemaDefinition
): void {
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new Error(`${definition.className} has invalid schema version ${definition.version}`);
  }
}

/** Describe only the exact schema created by the current build. */
export function durableObjectSchemaDescriptor(
  definition: DurableObjectSchemaDefinition
): DurableObjectSchemaDescriptor {
  validateDurableObjectSchemaDefinition(definition);
  return {
    className: definition.className,
    version: definition.version,
    freshSchemaFingerprint: durableObjectSchemaFingerprint(
      definition.storage.sql,
      definition.schemaTables
    ),
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
    persistedVersion === null ? ["reset-storage"] : ["deploy-current-build", "reset-storage"];
  return new DurableObjectSchemaError({
    message:
      `${definition.className} cannot open persisted schema ` +
      `${persistedVersion === null ? "without a version" : `v${persistedVersion}`} with build schema v${definition.version}: ` +
      `${detail}. Safe actions: ${safeActions
        .map((action) =>
          action === "deploy-current-build"
            ? "deploy the exact build for that schema"
            : "call workers.resetStorage() for explicitly disposable state"
        )
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

function createMetadata(definition: DurableObjectSchemaDefinition): void {
  const { sql } = definition.storage;
  sql.exec(`
    CREATE TABLE ${SCHEMA_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL,
      shape_json TEXT NOT NULL
    )
  `);
  sql.exec(
    `INSERT INTO ${SCHEMA_TABLE} (singleton, version, shape_json) VALUES (1, ?, ?)`,
    definition.version,
    normalizedShape(sql, definition.schemaTables)
  );
}

function readMetadata(
  definition: DurableObjectSchemaDefinition,
  objects: readonly string[]
): { version: number; shape: string } {
  const { sql } = definition.storage;
  if (!objects.includes(SCHEMA_TABLE)) {
    throw incompatible(
      definition,
      "unversioned-database",
      null,
      "persistent objects exist but no current schema identity is recorded"
    );
  }
  if (exactColumns(sql, SCHEMA_TABLE).join(",") !== "singleton,version,shape_json") {
    throw incompatible(definition, "shape-drift", null, "the schema identity table is malformed");
  }
  const rows = sql.exec(`SELECT singleton, version, shape_json FROM ${SCHEMA_TABLE}`).toArray();
  const row = rows[0];
  const version = Number(row?.["version"]);
  if (
    rows.length !== 1 ||
    Number(row?.["singleton"]) !== 1 ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof row?.["shape_json"] !== "string"
  ) {
    throw incompatible(definition, "shape-drift", null, "the schema identity row is malformed");
  }
  return { version, shape: String(row["shape_json"]) };
}

/**
 * Initialize a truly empty object or validate the one exact current schema.
 * Every other shape is rejected unchanged; there is no migration path.
 */
export function installDurableObjectSchema(definition: DurableObjectSchemaDefinition): void {
  validateDurableObjectSchemaDefinition(definition);
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
    if (persisted.version !== definition.version) {
      throw incompatible(
        definition,
        "version-mismatch",
        persisted.version,
        `only exact current schema v${definition.version} is supported`
      );
    }
    const actualShape = normalizedShape(definition.storage.sql, definition.schemaTables);
    if (actualShape !== persisted.shape) {
      throw incompatible(
        definition,
        "shape-drift",
        persisted.version,
        "the complete current schema fingerprint has drifted"
      );
    }
    definition.validateSchema();
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
        // A malformed request has no usable correlation id.
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
