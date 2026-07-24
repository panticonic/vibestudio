import type { AuthorityRow } from "./authorityRows.js";

export interface AuthorityRowDiff {
  added: AuthorityRow[];
  removed: AuthorityRow[];
  unchanged: AuthorityRow[];
  retiered: Array<{ before: AuthorityRow; after: AuthorityRow }>;
}

export function authorityRowKey(row: Pick<AuthorityRow, "capability" | "resourceScope">): string {
  return `${row.capability}\0${JSON.stringify(row.resourceScope)}`;
}

export function diffAuthorityRows(
  base: readonly AuthorityRow[],
  next: readonly AuthorityRow[]
): AuthorityRowDiff {
  const previous = new Map(base.map((row) => [authorityRowKey(row), row]));
  const following = new Map(next.map((row) => [authorityRowKey(row), row]));
  const result: AuthorityRowDiff = { added: [], removed: [], unchanged: [], retiered: [] };
  for (const [rowKey, row] of following) {
    const before = previous.get(rowKey);
    if (!before) {
      result.added.push({ ...row, flags: { ...row.flags, newInDiff: true } });
    } else if (before.tier !== row.tier) {
      result.retiered.push({ before, after: row });
    } else {
      result.unchanged.push(row);
    }
  }
  for (const [rowKey, row] of previous) {
    if (!following.has(rowKey)) {
      result.removed.push({ ...row, flags: { ...row.flags, removedInDiff: true } });
    }
  }
  return result;
}
