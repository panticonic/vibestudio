import { describe, expect, it } from "vitest";
import { SqlScopePersistence } from "./sqlScopePersistence.js";

/** Minimal in-memory `SqlLike` covering the blob-store + sweep queries (content matched, not parsed). */
class FakeSql {
  blobs: Array<{ digest: string; seq: number; chunk: string }> = [];
  scopeBlobRefs: string[][] = [];

  exec(query: string, ...b: unknown[]) {
    const q = query.replace(/\s+/g, " ").trim();
    const rows = (arr: unknown[]) => ({ toArray: () => arr });
    if (q.startsWith("PRAGMA table_info(repl_scopes)"))
      return rows([{ name: "data" }, { name: "blob_refs" }, { name: "created_at" }]); // column present
    if (q.startsWith("CREATE") || q.startsWith("ALTER") || q.startsWith("INSERT OR REPLACE INTO repl_scopes"))
      return rows([]);
    if (q.startsWith("SELECT 1 FROM scope_blobs WHERE digest"))
      return rows(this.blobs.some((r) => r.digest === b[0]) ? [{ "1": 1 }] : []);
    if (q.startsWith("INSERT OR IGNORE INTO scope_blobs")) {
      const [digest, seq, chunk] = b as [string, number, string];
      if (!this.blobs.some((r) => r.digest === digest && r.seq === seq))
        this.blobs.push({ digest, seq, chunk });
      return rows([]);
    }
    if (q.startsWith("SELECT chunk FROM scope_blobs WHERE digest"))
      return rows(
        this.blobs
          .filter((r) => r.digest === b[0])
          .sort((x, y) => x.seq - y.seq)
          .map((r) => ({ chunk: r.chunk }))
      );
    if (q.startsWith("SELECT DISTINCT digest FROM scope_blobs"))
      return rows([...new Set(this.blobs.map((r) => r.digest))].map((digest) => ({ digest })));
    if (q.startsWith("DELETE FROM scope_blobs WHERE digest")) {
      this.blobs = this.blobs.filter((r) => r.digest !== b[0]);
      return rows([]);
    }
    if (q.startsWith("SELECT blob_refs FROM repl_scopes"))
      return rows(this.scopeBlobRefs.map((refs) => ({ blob_refs: JSON.stringify(refs) })));
    return rows([]);
  }
}

describe("SqlScopePersistence blob store", () => {
  it("chunks a large value, reassembles it on read, and dedupes by content", async () => {
    const sql = new FakeSql();
    const p = new SqlScopePersistence(sql as never);
    const big = "z".repeat(300 * 1024); // > one 128KB chunk → 3 chunks

    const d1 = await p.putBlob(big);
    expect(sql.blobs.filter((r) => r.digest === d1).length).toBe(3);
    expect(await p.getBlob(d1)).toBe(big); // reassembled losslessly

    const d2 = await p.putBlob(big);
    expect(d2).toBe(d1); // content-addressed
    expect(sql.blobs.filter((r) => r.digest === d1).length).toBe(3); // not re-chunked
  });

  it("returns null for an absent digest", async () => {
    const p = new SqlScopePersistence(new FakeSql() as never);
    expect(await p.getBlob("nope")).toBeNull();
  });

  it("sweeps blobs not referenced by any scope row", async () => {
    const sql = new FakeSql();
    const p = new SqlScopePersistence(sql as never);
    const dA = await p.putBlob("a".repeat(200 * 1024));
    const dB = await p.putBlob("b".repeat(200 * 1024));

    sql.scopeBlobRefs = [[dA]]; // only A is live
    await p.sweepBlobs();

    expect(sql.blobs.some((r) => r.digest === dA)).toBe(true);
    expect(sql.blobs.some((r) => r.digest === dB)).toBe(false); // orphan removed
  });
});
