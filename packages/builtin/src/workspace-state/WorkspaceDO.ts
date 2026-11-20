/**
 * WorkspaceDO: the workspace state store as it was, a SQLite cell.
 *
 * `WorkspaceStateDO` (a Dolt cell) is the store now. A cell's storage engine is
 * fixed when its class creates it, so existing workspaces keep their state in
 * cells of this class until it is moved. This class stays deployed for exactly
 * one release, read-only, to give that move its source: `legacyManifest` states
 * what the cell holds and `legacyReadRows` pages it. It writes nothing, installs
 * no schema, and deletes nothing: the cell is the verified fallback until a
 * later release retires it (docs/dolt-redesign.md §9.2; `legacyImport.ts`).
 */
import { DurableObjectBase, schemaRpc, type DurableObjectContext } from "@vibestudio/durable";
import { workspaceStateLegacyMethods } from "@vibestudio/service-schemas/workspaceStateLegacy";
import {
  LEGACY_COLUMNS,
  LEGACY_IMPORT_TABLES,
  digestRows,
  manifestOf,
  type LegacyImportTable,
  type LegacyManifest,
  type LegacyRow,
  type LegacyTableManifest,
} from "./legacyImport.js";

const MAX_PAGE_ROWS = 500;

export class WorkspaceDO extends DurableObjectBase {
  static override readonly durableWorkQueues = [] as const;
  static override rpcMethods = workspaceStateLegacyMethods;
  /** The last schema version this class created. It creates nothing now. */
  static override schemaVersion = 39;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected createTables(): void {
    throw new Error("WorkspaceDO is the retired SQLite store; WorkspaceStateDO holds the state");
  }

  /**
   * The cell is read as it is: no schema is installed, none is validated. The
   * one table the framework itself reads on every call (`state`) is created if
   * the cell is a fresh one that never had it, so a workspace with no retired
   * store (its cell is empty) answers "nothing to import" instead of failing.
   */
  protected override initializeSchema(): Promise<void> {
    if (!this.tableExists("state")) {
      this.sql.exec(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    }
    return Promise.resolve();
  }

  private tableExists(name: string): boolean {
    return (
      this.sql
        .exec(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`, name)
        .toArray().length > 0
    );
  }

  private readAll(table: LegacyImportTable): LegacyRow[] {
    if (!this.tableExists(table)) return [];
    const columns = LEGACY_COLUMNS[table].join(", ");
    return this.sql.exec(`SELECT ${columns} FROM ${table}`).toArray() as unknown as LegacyRow[];
  }

  /** What the cell holds: per table the row count and an order-independent digest. */
  @schemaRpc()
  async legacyManifest(): Promise<LegacyManifest> {
    if (!this.tableExists("entities")) return manifestOf(null, []);
    const tables: LegacyTableManifest[] = [];
    for (const name of LEGACY_IMPORT_TABLES) {
      const rows = this.readAll(name);
      tables.push({ name, rows: rows.length, digest: await digestRows(name, rows) });
    }
    const version = this.tableExists("_vibestudio_schema")
      ? this.sql.exec(`SELECT version FROM _vibestudio_schema`).toArray()[0]
      : undefined;
    return manifestOf(typeof version?.["version"] === "number" ? version["version"] : null, tables);
  }

  /** The next page of a table, in `rowid` order, after `afterRowid`. */
  @schemaRpc()
  legacyReadRows(input: { table: LegacyImportTable; afterRowid: number; limit: number }): {
    rows: Array<{ rowid: number; row: LegacyRow }>;
    done: boolean;
  } {
    if (!(LEGACY_IMPORT_TABLES as readonly string[]).includes(input.table)) {
      throw new Error(`Unknown legacy table: ${input.table}`);
    }
    if (!this.tableExists(input.table)) return { rows: [], done: true };
    const limit = Math.max(1, Math.min(MAX_PAGE_ROWS, Math.floor(input.limit)));
    const columns = LEGACY_COLUMNS[input.table].join(", ");
    const found = this.sql
      .exec(
        `SELECT rowid AS __rowid, ${columns} FROM ${input.table}
          WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        input.afterRowid,
        limit + 1
      )
      .toArray() as Array<LegacyRow & { __rowid: number }>;
    const page = found.slice(0, limit);
    return {
      rows: page.map(({ __rowid, ...row }) => ({ rowid: __rowid, row })),
      done: found.length <= limit,
    };
  }
}
