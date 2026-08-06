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

export interface ExactDurableObjectSchemaDefinition {
  readonly className: string;
  readonly version: number;
  readonly storage: DurableObjectSchemaStorage;
  /** Tables and indexes owned by the durable-object implementation. */
  readonly schemaTables?: readonly string[];
  createSchema(): void;
  validateSchema(): void;
}

const SCHEMA_TABLE = "_vibestudio_schema";

function schemaShape(sql: SchemaSqlStorage, schemaTables?: readonly string[]): string {
  const ownedTables =
    schemaTables === undefined ? null : new Set(["state", ...schemaTables]);
  return JSON.stringify(
    sql
      .exec(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE type IN ('table', 'view', 'trigger')
           AND name NOT LIKE 'sqlite_%'
           AND name <> ?
           AND name <> '_vibestudio_direct_rpc_nonces'
         ORDER BY type, name`,
        SCHEMA_TABLE
      )
      .toArray()
      .filter((row) => {
        if (!ownedTables) return true;
        const name = String(row["name"]);
        const table = String(row["tbl_name"] ?? "");
        return ownedTables.has(name) || ownedTables.has(table);
      })
      .map((row) => ({
        type: String(row["type"]),
        name: String(row["name"]),
        sql: String(row["sql"] ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      }))
  );
}

/**
 * Install or validate the one schema shape supported by this build.
 *
 * Vibestudio is pre-release: persisted layouts from another build are not
 * translated, adopted, or repaired. A non-current database fails closed and
 * must be recreated explicitly.
 */
export function installExactDurableObjectSchema(
  definition: ExactDurableObjectSchemaDefinition
): void {
  const { className, version, storage, schemaTables } = definition;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`${className} has invalid schema version ${version}`);
  }

  storage.transactionSync(() => {
    const objects = storage.sql
      .exec(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'view', 'trigger')
           AND name NOT LIKE 'sqlite_%'`
      )
      .toArray()
      .map((row) => String(row["name"]));
    const fresh = objects.length === 0;

    if (fresh) {
      storage.sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      definition.createSchema();
      definition.validateSchema();
      const shape = schemaShape(storage.sql, schemaTables);
      storage.sql.exec(`
        CREATE TABLE ${SCHEMA_TABLE} (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL,
          shape_json TEXT NOT NULL
        )
      `);
      storage.sql.exec(
        `INSERT INTO ${SCHEMA_TABLE} (singleton, version, shape_json) VALUES (1, ?, ?)`,
        version,
        shape
      );
      return;
    }

    if (!objects.includes(SCHEMA_TABLE)) {
      throw new Error(
        `${className} persisted state has no current schema identity; recreate it explicitly`
      );
    }
    const schemaColumns = storage.sql
      .exec(`PRAGMA table_info(${SCHEMA_TABLE})`)
      .toArray()
      .map((row) => String(row["name"]));
    if (
      schemaColumns.length !== 3 ||
      schemaColumns[0] !== "singleton" ||
      schemaColumns[1] !== "version" ||
      schemaColumns[2] !== "shape_json"
    ) {
      throw new Error(
        `${className} persisted schema identity does not match the current exact format`
      );
    }
    const rows = storage.sql
      .exec(`SELECT singleton, version, shape_json FROM ${SCHEMA_TABLE}`)
      .toArray();
    if (
      rows.length !== 1 ||
      Number(rows[0]!["singleton"]) !== 1 ||
      Number(rows[0]!["version"]) !== version ||
      rows[0]!["shape_json"] !== schemaShape(storage.sql, schemaTables)
    ) {
      throw new Error(
        `${className} persisted schema does not match current version ${version}; recreate it explicitly`
      );
    }
    definition.validateSchema();
  });
}
