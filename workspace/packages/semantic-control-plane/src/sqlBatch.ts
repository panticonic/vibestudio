import type { SqlResult, SqlStorage } from "@workspace/runtime/worker/durable-base";

// Durable Objects SQLite accepts at most 100 bound parameters per statement.
// Keep the batching primitive at that deployment boundary so every caller gets
// the same behavior in workerd and in-memory tests.
export const DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS = 100;

export function execBatchedInsert(
  sql: SqlStorage,
  insertPrefix: string,
  columnsPerRow: number,
  rows: readonly (readonly unknown[])[]
): void {
  execBatchedInsertReturning(sql, insertPrefix, columnsPerRow, rows);
}

export function execBatchedInsertReturning(
  sql: SqlStorage,
  insertPrefix: string,
  columnsPerRow: number,
  rows: readonly (readonly unknown[])[],
  returning = ""
): Record<string, unknown>[] {
  if (!Number.isSafeInteger(columnsPerRow) || columnsPerRow <= 0) {
    throw new Error("Batched SQL insert requires a positive column count");
  }
  if (columnsPerRow > DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS) {
    throw new Error(
      `Batched SQL insert row has ${columnsPerRow} columns; Durable Objects allows ${DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS} parameters`
    );
  }
  if (rows.length === 0) return [];

  const rowsPerStatement = Math.floor(DURABLE_OBJECT_SQL_MAX_BOUND_PARAMETERS / columnsPerRow);
  const placeholderRow = `(${Array.from({ length: columnsPerRow }, () => "?").join(", ")})`;
  const returned: Record<string, unknown>[] = [];
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const batch = rows.slice(offset, offset + rowsPerStatement);
    for (const row of batch) {
      if (row.length !== columnsPerRow) {
        throw new Error(
          `Batched SQL insert expected ${columnsPerRow} values, received ${row.length}`
        );
      }
    }
    const result: SqlResult = sql.exec(
      `${insertPrefix} VALUES ${batch.map(() => placeholderRow).join(", ")}${returning}`,
      ...batch.flat()
    );
    if (returning) returned.push(...result.toArray());
  }
  return returned;
}
