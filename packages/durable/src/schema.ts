export interface SchemaSqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

export interface SchemaSqlStorage {
  exec(query: string, ...bindings: unknown[]): SchemaSqlResult;
}

export interface DurableObjectSchemaStorage {
  readonly sql: SchemaSqlStorage;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
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

  constructor(input: { message: string; data: DurableObjectSchemaErrorData; cause?: unknown }) {
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
  /** Trusted fingerprint from the current build's isolated schema probe. */
  readonly expectedFingerprint?: string;
  /** Each entry admits exactly one trusted old shape and upgrades it by one version. */
  readonly upgrades?: readonly DurableObjectSchemaUpgrade[];
  createSchema(): void | Promise<void>;
  validateSchema(): void | Promise<void>;
}

export interface DurableObjectSchemaUpgrade {
  readonly fromVersion: number;
  readonly fromFingerprint: string;
  upgrade(): void | Promise<void>;
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
  const versions = new Set<number>();
  for (const upgrade of definition.upgrades ?? []) {
    if (
      !Number.isSafeInteger(upgrade.fromVersion) ||
      upgrade.fromVersion < 1 ||
      upgrade.fromVersion >= definition.version ||
      versions.has(upgrade.fromVersion) ||
      typeof upgrade.fromFingerprint !== "string" ||
      !upgrade.fromFingerprint
    ) {
      throw new Error(`${definition.className} has an invalid schema upgrade declaration`);
    }
    versions.add(upgrade.fromVersion);
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
 * One asynchronous lifecycle owns platform, dependency and domain schema work.
 * Unsupported state is refused before mutation. Every admitted upgrade and its
 * target validation share one outer native transaction.
 */
export async function installDurableObjectSchema(
  definition: DurableObjectSchemaDefinition
): Promise<void> {
  validateDurableObjectSchemaDefinition(definition);
  await definition.storage.transaction(async () => {
    const objects = schemaObjects(definition.storage.sql);
    if (objects.length === 0) {
      definition.storage.sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      await definition.createSchema();
      await definition.validateSchema();
      validateTargetFingerprint(definition);
      createMetadata(definition);
      return;
    }

    const persisted = readMetadata(definition, objects);
    const path: DurableObjectSchemaUpgrade[] = [];
    for (let version = persisted.version; version < definition.version; version++) {
      const upgrade = definition.upgrades?.find((candidate) => candidate.fromVersion === version);
      if (!upgrade) break;
      path.push(upgrade);
    }
    if (
      persisted.version > definition.version ||
      path.length !== definition.version - persisted.version
    ) {
      throw incompatible(
        definition,
        "version-mismatch",
        persisted.version,
        `no supported upgrade from v${persisted.version} to v${definition.version}`
      );
    }
    const actualShape = normalizedShape(definition.storage.sql, definition.schemaTables);
    // An isolated fresh probe generates the target fingerprint. Requiring it
    // while merely declaring upgrades makes that probe impossible. Persisted
    // upgrades still require the trusted target before invoking any upgrader.
    if (path.length > 0 && !definition.expectedFingerprint) {
      throw new Error(
        `${definition.className} schema upgrades require the trusted target fingerprint`
      );
    }
    const trustedSource =
      path[0]?.fromFingerprint ?? definition.expectedFingerprint ?? persisted.shape;
    if (actualShape !== persisted.shape || actualShape !== trustedSource) {
      throw incompatible(
        definition,
        "shape-drift",
        persisted.version,
        "the complete current schema fingerprint has drifted"
      );
    }
    for (let index = 0; index < path.length; index++) {
      const upgrade = path[index]!;
      if (
        normalizedShape(definition.storage.sql, definition.schemaTables) !== upgrade.fromFingerprint
      ) {
        throw incompatible(
          definition,
          "shape-drift",
          upgrade.fromVersion,
          "the supported source fingerprint differs"
        );
      }
      await upgrade.upgrade();
      const expected = path[index + 1]?.fromFingerprint ?? definition.expectedFingerprint;
      if (normalizedShape(definition.storage.sql, definition.schemaTables) !== expected) {
        throw incompatible(
          definition,
          "shape-drift",
          upgrade.fromVersion,
          "the upgraded schema differs from its trusted target"
        );
      }
    }
    await definition.validateSchema();
    validateTargetFingerprint(definition);
    if (path.length > 0) {
      definition.storage.sql.exec(
        `UPDATE ${SCHEMA_TABLE} SET version = ?, shape_json = ? WHERE singleton = 1`,
        definition.version,
        normalizedShape(definition.storage.sql, definition.schemaTables)
      );
    }
  });
}

function validateTargetFingerprint(definition: DurableObjectSchemaDefinition): void {
  if (
    definition.expectedFingerprint !== undefined &&
    normalizedShape(definition.storage.sql, definition.schemaTables) !==
      definition.expectedFingerprint
  ) {
    throw incompatible(
      definition,
      "shape-drift",
      definition.version,
      "the schema differs from the current build's trusted fingerprint"
    );
  }
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
  ensureReady(): void | Promise<void>;
  dispatch(): Promise<Response>;
}): Promise<Response> {
  const segments = new URL(input.request.url).pathname.split("/").filter(Boolean);
  const isRpcPost = segments.slice(1).join("/") === "__rpc" && input.request.method === "POST";
  const requestCopy = isRpcPost ? input.request.clone() : null;
  try {
    await input.ensureReady();
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
              error: {
                message: error.message,
                errorKind: error.errorKind,
                code: error.code,
                errorData: data,
              },
            },
          });
        }
      } catch {
        // A malformed request has no usable correlation id.
      }
    }
    return json(
      {
        error: {
          message: error.message,
          errorKind: error.errorKind,
          code: error.code,
          errorData: data,
        },
      },
      500
    );
  }
}
