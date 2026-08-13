import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "./derivedCache.js";

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
