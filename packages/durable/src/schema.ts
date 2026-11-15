import { parseDurableWorkReady, type DurableWorkQueue } from "@vibestudio/shared/durableWork";
import type { DoltStorage, DoltTransactionOptions } from "./dolt.js";

export interface SchemaSqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

export interface SchemaSqlStorage {
  exec(query: string, ...bindings: unknown[]): SchemaSqlResult;
}

export interface DurableObjectSchemaStorage {
  readonly sql: SchemaSqlStorage;
  /** Present on a Dolt cell or a Dolt facet: the install is then committed. */
  readonly dolt?: DoltStorage;
  /** On a Dolt store `options.commit` makes the writes and the commit one durable step (F2). */
  transaction<T>(callback: () => Promise<T>, options?: DoltTransactionOptions<T>): Promise<T>;
}

export interface DurableObjectSchemaDescriptor {
  readonly className: string;
  readonly version: number;
  readonly freshSchemaFingerprint: string;
}

/** Storage schema and immutable class capabilities admitted from one executable. */
export interface DurableObjectExecutableDescriptor extends DurableObjectSchemaDescriptor {
  readonly durableWorkQueues: readonly DurableWorkQueue[];
  readonly nativeOwner: boolean;
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

/**
 * SQL predicate excluding objects the runtime owns rather than the class:
 * SQLite's own (`sqlite_*`), celld's bookkeeping (`_cf_*`, `_litestream*`),
 * and Dolt's system names (`dolt_*`, `doltlite_*`), which a celld cell keeps
 * in the same database as application tables. LIKE treats `_` as a wildcard,
 * so the reserved prefixes are matched with substr.
 */
const APPLICATION_OBJECT =
  "name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 11) <> '_litestream'" +
  " AND substr(name, 1, 5) <> 'dolt_' AND substr(name, 1, 9) <> 'doltlite_'";
/** Tables the base owns, outside every class's schema. `vsl_*` is the local (Dolt) naming. */
const FRAMEWORK_OBJECTS = new Set([
  SCHEMA_TABLE,
  "_vibestudio_direct_rpc_nonces",
  "vsl_direct_rpc_nonces",
]);

function normalizedShape(sql: SchemaSqlStorage, schemaTables?: readonly string[]): string {
  const ownedTables = schemaTables === undefined ? null : new Set(["state", ...schemaTables]);
  return JSON.stringify(
    sql
      .exec(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'view', 'trigger')
           AND ${APPLICATION_OBJECT}
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

/**
 * The form of a statement that the engine's rendering leaves unchanged.
 *
 * DoltLite re-renders `sqlite_master.sql` when the creating transaction commits
 * (celld `docs/services/dolt-cells.md`, "Schema text"): whitespace runs become
 * one space, none stays before `(`, `)` and `,`, comments are gone, and a name
 * is quoted only when it has to be; string literals and quoted names that need
 * their quotes are kept. This function removes every one of those differences
 * (and, being loose, the spacing after `(` and `,` as well), so the text as
 * written and the text as rendered compare equal. Equality under it admits
 * nothing a store could forge: the declared text is code.
 */
export function looseSql(value: string): string {
  // Text the engine keeps as written is set aside while the rest is loosened.
  const kept: string[] = [];
  const keep = (text: string): string => `\u0000${kept.push(text) - 1}\u0000`;
  let out = "";
  let at = 0;
  const length = value.length;
  while (at < length) {
    const char = value[at]!;
    const next = value[at + 1];
    if (char === "-" && next === "-") {
      while (at < length && value[at] !== "\n") at++;
      out += " ";
    } else if (char === "/" && next === "*") {
      const end = value.indexOf("*/", at + 2);
      at = end === -1 ? length : end + 2;
      out += " ";
    } else if (char === "'") {
      let end = at + 1;
      while (end < length && !(value[end] === "'" && value[end + 1] !== "'")) {
        end += value[end] === "'" ? 2 : 1;
      }
      out += keep(value.slice(at, end + 1));
      at = end + 1;
    } else if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let end = at + 1;
      while (end < length && !(value[end] === close && value[end + 1] !== close)) {
        end += value[end] === close ? 2 : 1;
      }
      const quoted = value.slice(at, end + 1);
      const name = value.slice(at + 1, end);
      out += /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ? name : keep(quoted);
      at = end + 1;
    } else {
      out += char;
      at++;
    }
  }
  return out
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim()
    .replace(/\u0000(\d+)\u0000/gu, (_match, index: string) => kept[Number(index)]!);
}

/** `normalizedShape` output with each statement's punctuation spacing ignored. */
function looseShape(shape: string): string {
  try {
    const rows = JSON.parse(shape) as unknown;
    if (!Array.isArray(rows)) return shape;
    return JSON.stringify(
      rows.map((row: unknown) =>
        row && typeof row === "object" && typeof (row as { sql?: unknown }).sql === "string"
          ? { ...(row as object), sql: looseSql((row as { sql: string }).sql) }
          : row
      )
    );
  } catch {
    return shape;
  }
}

/**
 * A Dolt store drops `--` comments from the DDL it keeps, and the shape of an object is taken from
 * text whose line breaks are already gone, so a line comment swallows the rest of its statement in
 * the fingerprint the build trusts and the shape no longer matches once the engine has rendered the
 * text. Refuse it where it is written, not at a later activation.
 */
function assertNoLineComments(definition: DurableObjectSchemaDefinition): void {
  const rows = definition.storage.sql
    .exec(`SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND ${APPLICATION_OBJECT}`)
    .toArray();
  for (const row of rows) {
    const text = String(row["sql"]).replace(/'(?:[^']|'')*'/gu, "''");
    if (/--/u.test(text))
      throw new Error(
        `${definition.className}: the DDL of ${String(row["name"])} has a "--" comment. A Dolt store drops ` +
          "comments, so its shape would not match the fingerprint the build trusts: move it out of the SQL"
      );
  }
}

function normalizeIndexSql(value: string): string {
  // Index definitions are compared loosely everywhere: the declared text is
  // code, so equality under looser spacing admits nothing a store could forge,
  // and a Dolt store re-renders `ON notes (body)` as `ON notes(body)`.
  return looseSql(value.replace(/\bIF\s+NOT\s+EXISTS\b/giu, ""));
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
       WHERE type = 'index' AND ${APPLICATION_OBJECT}
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

export function durableObjectExecutableDescriptor(
  definition: DurableObjectSchemaDefinition,
  queues: readonly DurableWorkQueue[],
  nativeOwner: boolean
): DurableObjectExecutableDescriptor {
  return {
    ...durableObjectSchemaDescriptor(definition),
    durableWorkQueues: parseDurableWorkReady(queues),
    nativeOwner,
  };
}

export function validateDurableObjectExecutableCapabilities(
  descriptor: DurableObjectExecutableDescriptor,
  queues: readonly DurableWorkQueue[],
  nativeOwner: boolean
): void {
  if (
    descriptor.nativeOwner !== nativeOwner ||
    JSON.stringify(parseDurableWorkReady(descriptor.durableWorkQueues)) !==
      JSON.stringify(parseDurableWorkReady(queues))
  ) {
    throw new Error("Durable work descriptor does not match the admitted runtime image");
  }
}

function schemaObjects(sql: SchemaSqlStorage): string[] {
  return sql
    .exec(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'index', 'view', 'trigger')
         AND ${APPLICATION_OBJECT}`
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

function createMetadata(definition: DurableObjectSchemaDefinition, shape: string): void {
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
    shape
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
  const { dolt } = definition.storage;
  if (dolt) checkpointBeforeUpgrade(definition, dolt);
  // What the transaction did, so a Dolt store commits exactly that (F2): the
  // commit is in the transaction's own root record, so no crash can leave the
  // install uncommitted and nothing needs recovering at activation.
  let outcome: SchemaInstallOutcome = { kind: "current" };
  // A Dolt store renders `sqlite_master.sql` itself once the creating
  // transaction ends (`notes (id` becomes `notes(id`, `CHECK (` becomes
  // `CHECK(`), so a shape taken inside that transaction is not the shape read
  // at the next activation. Every comparison on a Dolt store ignores that
  // punctuation spacing; SQLite stores keep the exact text.
  const comparable = (shape: string): string => (dolt ? looseShape(shape) : shape);
  const shapeNow = (): string =>
    comparable(normalizedShape(definition.storage.sql, definition.schemaTables));
  const install = async (): Promise<void> => {
    const objects = schemaObjects(definition.storage.sql);
    if (objects.length === 0) {
      definition.storage.sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      await definition.createSchema();
      await definition.validateSchema();
      if (dolt) assertNoLineComments(definition);
      const shape = shapeNow();
      validateTargetFingerprint(definition, shape, comparable);
      createMetadata(definition, shape);
      outcome = { kind: "fresh" };
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
    const actualShape = shapeNow();
    // An isolated fresh probe generates the target fingerprint. Requiring it
    // while merely declaring upgrades makes that probe impossible. Persisted
    // upgrades still require the trusted target before invoking any upgrader.
    if (path.length > 0 && !definition.expectedFingerprint) {
      throw new Error(
        `${definition.className} schema upgrades require the trusted target fingerprint`
      );
    }
    const trustedSource = comparable(
      path[0]?.fromFingerprint ?? definition.expectedFingerprint ?? persisted.shape
    );
    if (actualShape !== comparable(persisted.shape) || actualShape !== trustedSource) {
      throw incompatible(
        definition,
        "shape-drift",
        persisted.version,
        "the complete current schema fingerprint has drifted"
      );
    }
    for (let index = 0; index < path.length; index++) {
      const upgrade = path[index]!;
      if (shapeNow() !== comparable(upgrade.fromFingerprint)) {
        throw incompatible(
          definition,
          "shape-drift",
          upgrade.fromVersion,
          "the supported source fingerprint differs"
        );
      }
      await upgrade.upgrade();
      const expected = path[index + 1]?.fromFingerprint ?? definition.expectedFingerprint;
      if (shapeNow() !== (expected === undefined ? expected : comparable(expected))) {
        throw incompatible(
          definition,
          "shape-drift",
          upgrade.fromVersion,
          "the upgraded schema differs from its trusted target"
        );
      }
    }
    await definition.validateSchema();
    validateTargetFingerprint(definition, undefined, comparable);
    if (path.length > 0) {
      definition.storage.sql.exec(
        `UPDATE ${SCHEMA_TABLE} SET version = ?, shape_json = ? WHERE singleton = 1`,
        definition.version,
        shapeNow()
      );
      outcome = { kind: "upgraded", fromVersion: persisted.version };
    }
  };
  if (dolt) {
    await definition.storage.transaction(install, {
      commit: () => schemaCommitMessage(definition, outcome),
    });
  } else {
    await definition.storage.transaction(install);
  }
}

type SchemaInstallOutcome =
  | { readonly kind: "current" }
  | { readonly kind: "fresh" }
  | { readonly kind: "upgraded"; readonly fromVersion: number };

/** `schema: C vN` or `schema: C vN→vM`; `null` when the install changed nothing. */
function schemaCommitMessage(
  definition: DurableObjectSchemaDefinition,
  outcome: SchemaInstallOutcome
): string | null {
  switch (outcome.kind) {
    case "current":
      return null;
    case "fresh":
      return `schema: ${definition.className} v${definition.version}`;
    case "upgraded":
      return `schema: ${definition.className} v${outcome.fromVersion}→v${definition.version}`;
  }
}

/**
 * Before an upgrade path runs, state a class left uncommitted (an agent's
 * working set) is committed as a known restore point, so the upgrade commit
 * holds exactly the migration. A plain commit taken before the transaction:
 * Dolt operations throw inside one. A crash after it leaves the checkpoint,
 * which is harmless.
 */
function checkpointBeforeUpgrade(
  definition: DurableObjectSchemaDefinition,
  dolt: DoltStorage
): void {
  const persisted = peekPersistedVersion(definition.storage.sql);
  if (persisted === null || persisted >= definition.version) return;
  const dirty = dolt
    .status()
    .some(
      (entry) =>
        !entry.table.startsWith("dolt_") &&
        !entry.table.startsWith("doltlite_") &&
        !entry.table.startsWith("_cf_")
    );
  if (!dirty) return;
  dolt.commit({
    message: `schema: checkpoint before ${definition.className} v${persisted}→v${definition.version}`,
  });
}

/** The persisted schema version, read without trusting it; `null` when absent or malformed. */
function peekPersistedVersion(sql: SchemaSqlStorage): number | null {
  const exists = sql
    .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, SCHEMA_TABLE)
    .toArray();
  if (exists.length === 0) return null;
  try {
    const row = sql.exec(`SELECT version FROM ${SCHEMA_TABLE} WHERE singleton = 1`).toArray()[0];
    const version = Number(row?.["version"]);
    return Number.isSafeInteger(version) && version >= 1 ? version : null;
  } catch {
    return null;
  }
}

function validateTargetFingerprint(
  definition: DurableObjectSchemaDefinition,
  shape?: string,
  comparable: (shape: string) => string = (value) => value
): void {
  if (
    definition.expectedFingerprint !== undefined &&
    comparable(shape ?? normalizedShape(definition.storage.sql, definition.schemaTables)) !==
      comparable(definition.expectedFingerprint)
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
