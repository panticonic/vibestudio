import type { SqlStorage } from "@workspace/runtime/worker";

export type SqlTableColumn = readonly [
  name: string,
  type: string,
  notNull: boolean,
  defaultSql?: string,
];

export interface ExactSqlTableSchema {
  table: string;
  columns: readonly SqlTableColumn[];
  primaryKey: readonly string[];
}

/**
 * Assert that an existing SQLite table is exactly the table this source knows
 * how to operate. Pre-release state is intentionally not migrated in place:
 * CREATE TABLE IF NOT EXISTS creates fresh state, while this assertion makes a
 * stale same-name table fail before any component reads or mutates it.
 */
export function assertExactSqlTableSchema(sql: SqlStorage, expected: ExactSqlTableSchema): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(expected.table)) {
    throw new Error(`Invalid SQLite table name: ${JSON.stringify(expected.table)}`);
  }
  const rows = sql.exec(`PRAGMA table_info("${expected.table}")`).toArray() as Array<{
    name?: unknown;
    type?: unknown;
    notnull?: unknown;
    dflt_value?: unknown;
    pk?: unknown;
  }>;
  const columnsMatch =
    rows.length === expected.columns.length &&
    rows.every((row, index) => {
      const column = expected.columns[index];
      return (
        column !== undefined &&
        row.name === column[0] &&
        row.type === column[1] &&
        Number(row.notnull) === (column[2] ? 1 : 0) &&
        row.dflt_value === (column[3] ?? null)
      );
    });
  const primaryKey = rows
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => row.name);
  const primaryKeyMatches =
    primaryKey.length === expected.primaryKey.length &&
    primaryKey.every((name, index) => name === expected.primaryKey[index]);

  if (!columnsMatch || !primaryKeyMatches) {
    throw new Error(`Unsupported ${expected.table} schema; delete this pre-release agent state`);
  }
}
