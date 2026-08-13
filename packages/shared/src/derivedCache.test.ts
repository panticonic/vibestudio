import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DerivedCacheCoordinator,
  derivedCacheDatabasePath,
  derivedCacheUnderPressure,
  type DerivedCacheLease,
} from "./derivedCache.js";

const roots: string[] = [];

function cacheRoot(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-derived-cache-"));
  roots.push(parent);
  return path.join(parent, "cache");
}

function put(root: string, key: string, bytes: number): void {
  const directory = path.join(root, key);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "payload"), Buffer.alloc(bytes, key.charCodeAt(0)));
}

/**
 * Stamp exact recency on already-scanned entries. Wall-clock writes collide
 * inside one millisecond, which would leave the eviction order decided by the
 * key tiebreak rather than by the policy under test.
 */
function setLastAccess(root: string, ages: Record<string, number>): void {
  const database = new DatabaseSync(derivedCacheDatabasePath(root));
  try {
    for (const [key, lastAccess] of Object.entries(ages)) {
      database
        .prepare("UPDATE cache_entries SET last_access = ? WHERE root = ? AND key = ?")
        .run(lastAccess, path.resolve(root), key);
    }
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("DerivedCacheCoordinator", () => {
  it("does not prune an entry borrowed by another coordinator", async () => {
    const root = cacheRoot();
    put(root, "active", 64 * 1024);
    put(root, "idle", 64 * 1024);
    const owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const collector = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const lease = owner.acquire(root, "active");
    try {
      const result = await collector.prune(root, {
        targetBytes: 0,
        freeFloorBytes: 0,
      });
      expect(fs.existsSync(path.join(root, "active"))).toBe(true);
      expect(fs.existsSync(path.join(root, "idle"))).toBe(false);
      expect(result.removedEntries).toBe(1);
      expect(result.leasedEntries).toBe(1);
    } finally {
      lease.release();
      owner.close();
      collector.close();
    }
  });

  it("re-fences a live entry after its lease row is swept", async () => {
    vi.useFakeTimers();
    const root = cacheRoot();
    put(root, "active", 64 * 1024);
    const owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const collector = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const lease = owner.acquire(root, "active");
    const database = new DatabaseSync(derivedCacheDatabasePath(root));
    try {
      database.exec("DELETE FROM cache_leases");
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await collector.prune(root, { targetBytes: 0, freeFloorBytes: 0 });
      expect(result.removedEntries).toBe(0);
      expect(fs.existsSync(path.join(root, "active"))).toBe(true);
    } finally {
      lease.release();
      database.close();
      owner.close();
      collector.close();
      vi.useRealTimers();
    }
  });

  it("prunes the released entry on a later pass", async () => {
    const root = cacheRoot();
    put(root, "entry", 64 * 1024);
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const lease = coordinator.acquire(root, "entry");
    lease.release();
    const result = await coordinator.prune(root, { targetBytes: 0, freeFloorBytes: 0 });
    expect(result.removedEntries).toBe(1);
    expect(result.bytes).toBe(0);
    expect(fs.existsSync(path.join(root, "entry"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".storage", "derived-cache.db"))).toBe(true);
    coordinator.close();
  });

  it("reports dry-run reclamation without changing the cache", async () => {
    const root = cacheRoot();
    put(root, "old", 64 * 1024);
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const result = await coordinator.prune(root, {
      targetBytes: 0,
      freeFloorBytes: 0,
      dryRun: true,
    });
    expect(result.removedEntries).toBe(1);
    expect(result.removedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, "old"))).toBe(true);
    coordinator.close();
  });

  it.each([
    ["parent traversal", ".."],
    ["current directory", "."],
    ["a nested path", "nested/child"],
    ["an absolute path", path.join(path.sep, "etc", "passwd")],
    ["an empty key", ""],
    ["an embedded NUL", "payload\0.txt"],
  ])("refuses %s as a cache key", (_label, key) => {
    const root = cacheRoot();
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    try {
      expect(() => coordinator.acquire(root, key)).toThrow(/Invalid derived-cache key/);
    } finally {
      coordinator.close();
    }
  });

  it("evicts least-recently-used entries first and stops at the target", async () => {
    const root = cacheRoot();
    for (const key of ["aged", "middle", "recent"]) put(root, key, 256 * 1024);
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    try {
      const before = coordinator.status(root);
      setLastAccess(root, { aged: 1_000, middle: 2_000, recent: 3_000 });

      // Ask for barely more than nothing: one entry already overshoots it, so a
      // policy that keeps deleting past the target is visible as a second loss.
      const result = await coordinator.prune(root, {
        targetBytes: before.bytes - 1024,
        freeFloorBytes: 0,
      });

      expect(result.removedEntries).toBe(1);
      expect(fs.existsSync(path.join(root, "aged"))).toBe(false);
      expect(fs.existsSync(path.join(root, "middle"))).toBe(true);
      expect(fs.existsSync(path.join(root, "recent"))).toBe(true);
    } finally {
      coordinator.close();
    }
  });

  it("treats releasing a lease as the most recent access", async () => {
    const root = cacheRoot();
    put(root, "idle", 256 * 1024);
    put(root, "borrowed", 256 * 1024);
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    try {
      const before = coordinator.status(root);
      setLastAccess(root, { idle: 1_000, borrowed: 1_000 });
      coordinator.acquire(root, "borrowed").release();

      const result = await coordinator.prune(root, {
        targetBytes: before.bytes - 1024,
        freeFloorBytes: 0,
      });

      expect(result.removedEntries).toBe(1);
      expect(fs.existsSync(path.join(root, "idle"))).toBe(false);
      expect(fs.existsSync(path.join(root, "borrowed"))).toBe(true);
    } finally {
      coordinator.close();
    }
  });

  it("keeps every entry when the cache is already inside both limits", async () => {
    const root = cacheRoot();
    put(root, "kept", 64 * 1024);
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    try {
      const result = await coordinator.prune(root, {
        maxBytes: 10 * 1024 ** 3,
        freeFloorBytes: 0,
      });

      expect(result.removedEntries).toBe(0);
      expect(result.removedBytes).toBe(0);
      expect(fs.existsSync(path.join(root, "kept"))).toBe(true);
    } finally {
      coordinator.close();
    }
  });

  it("reclaims under free-space pressure but still never takes a leased entry", async () => {
    const root = cacheRoot();
    put(root, "reclaimable", 64 * 1024);
    put(root, "borrowed", 64 * 1024);
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const lease = coordinator.acquire(root, "borrowed");
    try {
      // No size ceiling is exceeded here; only the free-space floor forces the
      // pass, which is the branch the size-target tests never reach.
      const result = await coordinator.prune(root, {
        freeFloorBytes: Number.MAX_SAFE_INTEGER,
      });

      expect(result.removedEntries).toBe(1);
      expect(fs.existsSync(path.join(root, "reclaimable"))).toBe(false);
      expect(fs.existsSync(path.join(root, "borrowed"))).toBe(true);
    } finally {
      lease.release();
      coordinator.close();
    }
  });

  it("refuses an entry leased after the scan but before the eviction commits", async () => {
    const root = cacheRoot();
    put(root, "contended", 64 * 1024);
    const owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const collector = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    // The reclaimable set is chosen from a snapshot taken before any entry is
    // touched. Land the lease in that window, so the entry is still listed as
    // reclaimable and only the re-check inside the writer transaction can save
    // it — the guard that makes cross-process leasing safe at all.
    const seam = collector as unknown as { scan(root: string): unknown };
    const scanUnderTest = seam.scan.bind(collector);
    const held: DerivedCacheLease[] = [];
    const scan = vi.spyOn(seam, "scan").mockImplementation((scanned: string) => {
      const snapshot = scanUnderTest(scanned);
      if (held.length === 0) held.push(owner.acquire(root, "contended"));
      return snapshot;
    });

    try {
      const result = await collector.prune(root, { targetBytes: 0, freeFloorBytes: 0 });

      expect(result.removedEntries).toBe(0);
      expect(fs.existsSync(path.join(root, "contended"))).toBe(true);
    } finally {
      scan.mockRestore();
      for (const lease of held) lease.release();
      owner.close();
      collector.close();
    }
  });

  it("never accounts for or reclaims its own internal directories", async () => {
    const root = cacheRoot();
    put(root, "entry", 64 * 1024);
    for (const internal of [".trash", "staging.tmp.abc", "sweep.gc.abc"]) {
      put(root, internal, 64 * 1024);
    }
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    try {
      expect(coordinator.status(root).entries).toBe(1);

      await coordinator.prune(root, { targetBytes: 0, freeFloorBytes: 0 });

      expect(fs.existsSync(path.join(root, "entry"))).toBe(false);
      for (const internal of [".trash", "staging.tmp.abc", "sweep.gc.abc", ".storage"]) {
        expect(fs.existsSync(path.join(root, internal))).toBe(true);
      }
    } finally {
      coordinator.close();
    }
  });

  it("forgets an entry that disappeared outside the coordinator", () => {
    const root = cacheRoot();
    put(root, "vanishing", 64 * 1024);
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    try {
      expect(coordinator.status(root).entries).toBe(1);
      fs.rmSync(path.join(root, "vanishing"), { recursive: true, force: true });

      const after = coordinator.status(root);

      expect(after.entries).toBe(0);
      expect(after.bytes).toBe(0);
      const database = new DatabaseSync(derivedCacheDatabasePath(root));
      try {
        expect(
          database.prepare("SELECT COUNT(*) AS rows FROM cache_entries").get() as {
            rows: number;
          }
        ).toEqual({ rows: 0 });
      } finally {
        database.close();
      }
    } finally {
      coordinator.close();
    }
  });

  it("releases the maintenance claim when a tuning pass throws", async () => {
    const root = cacheRoot();
    put(root, "entry", 64 * 1024);
    const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const prune = vi.spyOn(coordinator, "prune").mockRejectedValueOnce(new Error("prune exploded"));
    try {
      await expect(
        coordinator.tune(root, { targetBytes: 0, freeFloorBytes: 0 }, 60_000)
      ).rejects.toThrow("prune exploded");

      // A failed pass must not consume the cadence, or one transient error
      // would suppress reclamation for the whole interval.
      prune.mockRestore();
      const retried = await coordinator.tune(root, { targetBytes: 0, freeFloorBytes: 0 }, 60_000);

      expect(retried?.removedEntries).toBe(1);
    } finally {
      prune.mockRestore();
      coordinator.close();
    }
  });

  it("reports free-space pressure against the requested floor", () => {
    const root = cacheRoot();
    fs.mkdirSync(root, { recursive: true });

    expect(derivedCacheUnderPressure(root, 0)).toBe(false);
    expect(derivedCacheUnderPressure(root, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("coordinates the automatic tuning cadence across processes", async () => {
    const root = cacheRoot();
    put(root, "first", 64 * 1024);
    const firstProcess = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    const secondProcess = new DerivedCacheCoordinator(derivedCacheDatabasePath(root));
    try {
      const first = await firstProcess.tune(root, { targetBytes: 0, freeFloorBytes: 0 }, 60_000);
      expect(first?.removedEntries).toBe(1);

      put(root, "second", 64 * 1024);
      const suppressed = await secondProcess.tune(
        root,
        { targetBytes: 0, freeFloorBytes: 0 },
        60_000
      );
      expect(suppressed).toBeNull();
      expect(fs.existsSync(path.join(root, "second"))).toBe(true);

      const manual = await secondProcess.prune(root, { targetBytes: 0, freeFloorBytes: 0 });
      expect(manual.removedEntries).toBe(1);
      expect(fs.existsSync(path.join(root, "second"))).toBe(false);
    } finally {
      firstProcess.close();
      secondProcess.close();
    }
  });
});
