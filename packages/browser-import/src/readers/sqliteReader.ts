import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

export interface ReaderStatement {
  all(...bindings: SQLInputValue[]): Record<string, unknown>[];
  get(...bindings: SQLInputValue[]): Record<string, unknown> | undefined;
  iterate(...bindings: SQLInputValue[]): IterableIterator<Record<string, unknown>>;
}

export interface ReaderDatabase {
  prepare(sql: string): ReaderStatement;
  close(): void;
}

function readerRow(row: Record<string, SQLOutputValue>): Record<string, unknown> {
  // Preserve 64-bit browser timestamps without changing safe integer IDs/counts.
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint" && Number.isSafeInteger(Number(value))) row[key] = Number(value);
  }
  return row;
}

export async function openReadonlySqlite(filePath: string): Promise<ReaderDatabase> {
  const db = new DatabaseSync(filePath, { readOnly: true });
  return {
    prepare(sql: string): ReaderStatement {
      return {
        all(...bindings) {
          return Array.from(this.iterate(...bindings));
        },
        get(...bindings) {
          for (const row of this.iterate(...bindings)) return row;
          return undefined;
        },
        *iterate(...bindings) {
          const statement = db.prepare(sql);
          statement.setReadBigInts(true);
          for (const row of statement.iterate(...bindings)) yield readerRow(row);
        },
      };
    },
    close() {
      db.close();
    },
  };
}

export type { ReaderDatabase as Database };
