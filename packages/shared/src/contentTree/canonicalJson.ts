/**
 * Canonical JSON — key-sorted, undefined-dropping JSON serialization used for
 * every content-tree hash (worktree manifests, state hashes, tree objects).
 *
 * HOST-OWNED VERBATIM PORT of workspace/packages/agentic-protocol/src/
 * canonical-json.ts. The gad-store DO (workerd) keeps its own copy; the two
 * MUST agree byte-for-byte — contentTree/worktreeHash.test.ts pins golden
 * vectors generated from the workspace implementation. Do not "improve" the
 * serialization here without regenerating and cross-checking those vectors.
 */

export function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child !== undefined) sorted[key] = sortForCanonicalJson(child);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}
