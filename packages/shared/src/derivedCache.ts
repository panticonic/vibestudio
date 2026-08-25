import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_DERIVED_CACHE_MAX_BYTES = 10 * 1024 ** 3;
export const DEFAULT_DERIVED_CACHE_FREE_FLOOR_BYTES = 10 * 1024 ** 3;
const LEASE_TTL_MS = 5 * 60_000;
const HEARTBEAT_MS = 60_000;
const AUTOMATIC_PRUNE_INTERVAL_MS = 15 * 60_000;
const AUTOMATIC_PRUNE_LEASE_MS = 60 * 60_000;

export interface DerivedCacheEntry {
  key: string;
  bytes: number;
  lastAccess: number;
  leased: boolean;
}

export interface DerivedCacheStatus {
  root: string;
  bytes: number;
  entries: number;
  leasedEntries: number;
  reclaimableBytes: number;
  availableBytes: number;
}

export interface DerivedCachePruneResult extends DerivedCacheStatus {
  removedEntries: number;
  removedBytes: number;
  targetBytes: number;
}

export interface DerivedCacheLease {
  readonly root: string;
  readonly key: string;
  release(): void;
}

export function derivedCacheDatabasePath(root: string): string {
  return path.join(canonicalRoot(root), ".storage", "derived-cache.db");
}

function canonicalRoot(root: string): string {
  return path.resolve(root);
}

function assertCacheKey(key: string): void {
  if (!key || key === "." || key === ".." || key.includes("\0") || path.basename(key) !== key) {
    throw new Error(`Invalid derived-cache key: ${JSON.stringify(key)}`);
  }
}

function entryPath(root: string, key: string): string {
  assertCacheKey(key);
  return path.join(canonicalRoot(root), key);
}

async function allocatedBytes(storedPath: string): Promise<number> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(storedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (!stat.isDirectory()) {
    const allocated = (stat.blocks ?? 0) * 512 || stat.size;
    // Charge a hardlinked inode proportionally to each directory view instead
    // of pretending every pathname owns another physical copy. Summed across
    // the content owner and all materializations this is the real allocation;
    // it also keeps cheap cache topology from being evicted as though it still
    // contained duplicated payload bytes.
    return Math.ceil(allocated / Math.max(1, stat.nlink));
  }
  let bytes = (stat.blocks ?? 0) * 512;
  for (const child of await fs.promises.readdir(storedPath)) {
    bytes += await allocatedBytes(path.join(storedPath, child));
  }
  return bytes;
}

function availableBytes(root: string): number {
  let candidate = path.resolve(root);
  for (;;) {
    try {
      const stat = fs.statfsSync(candidate);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return Number.MAX_SAFE_INTEGER;
      const parent = path.dirname(candidate);
      if (parent === candidate) return Number.MAX_SAFE_INTEGER;
      candidate = parent;
    }
  }
}

export function derivedCacheUnderPressure(
  root: string,
  freeFloorBytes = DEFAULT_DERIVED_CACHE_FREE_FLOOR_BYTES
): boolean {
  return availableBytes(root) < freeFloorBytes;
}

async function cacheDirectories(root: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== ".storage" &&
          entry.name !== ".trash" &&
          !entry.name.includes(".tmp.") &&
          !entry.name.includes(".gc.")
      )
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Cross-process ownership for deletable cache entries.
 *
 * Acquiring a key and committing its rename-to-trash are serialized through
 * one SQLite writer transaction. Expiry is only crash recovery: live owners
 * renew their leases until release.
 */
export class DerivedCacheCoordinator {
  private readonly db: DatabaseSync;
  private readonly ownerId = `${process.pid}:${crypto.randomBytes(16).toString("hex")}`;
  private readonly leases = new Map<
    string,
    { root: string; key: string; timer: ReturnType<typeof setInterval> }
  >();

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        root TEXT NOT NULL,
        key TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        last_access INTEGER NOT NULL,
        PRIMARY KEY (root, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cache_leases (
        lease_id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        key TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cache_leases_entry
        ON cache_leases(root, key, expires_at);
      CREATE TABLE IF NOT EXISTS cache_maintenance (
        root TEXT PRIMARY KEY,
        owner_id TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_pruned_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
  }

  acquire(rootInput: string, key: string): DerivedCacheLease {
    const root = canonicalRoot(rootInput);
    entryPath(root, key);
    const leaseId = crypto.randomBytes(20).toString("hex");
    const now = Date.now();
    this.transaction(() => {
      this.deleteExpiredLeases(now);
      this.db
        .prepare(
          `INSERT INTO cache_entries(root, key, bytes, last_access)
           VALUES (?, ?, 0, ?)
           ON CONFLICT(root, key) DO UPDATE SET last_access = excluded.last_access`
        )
        .run(root, key, now);
      this.db
        .prepare(
          "INSERT INTO cache_leases(lease_id, root, key, owner_id, expires_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(leaseId, root, key, this.ownerId, now + LEASE_TTL_MS);
    });
    const timer = setInterval(() => this.heartbeat(leaseId), HEARTBEAT_MS);
    timer.unref?.();
    this.leases.set(leaseId, { root, key, timer });
    let released = false;
    return {
      root,
      key,
      release: () => {
        if (released) return;
        released = true;
        const owned = this.leases.get(leaseId);
        if (owned) clearInterval(owned.timer);
        this.leases.delete(leaseId);
        this.transaction(() => {
          this.db
            .prepare("DELETE FROM cache_leases WHERE lease_id = ? AND owner_id = ?")
            .run(leaseId, this.ownerId);
          this.db
            .prepare("UPDATE cache_entries SET last_access = ? WHERE root = ? AND key = ?")
            .run(Date.now(), root, key);
        });
      },
    };
  }

  async status(rootInput: string): Promise<DerivedCacheStatus> {
    const root = canonicalRoot(rootInput);
    const entries = await this.scan(root);
    return this.summarize(root, entries);
  }

  async prune(
    rootInput: string,
    options: {
      maxBytes?: number;
      freeFloorBytes?: number;
      targetBytes?: number;
      dryRun?: boolean;
    } = {}
  ): Promise<DerivedCachePruneResult> {
    const root = canonicalRoot(rootInput);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    let entries = await this.scan(root);
    const before = this.summarize(root, entries);
    const maxBytes = options.maxBytes ?? DEFAULT_DERIVED_CACHE_MAX_BYTES;
    const freeFloor = options.freeFloorBytes ?? DEFAULT_DERIVED_CACHE_FREE_FLOOR_BYTES;
    const pressureBytes = Math.max(0, freeFloor - before.availableBytes);
    const targetBytes = Math.max(
      0,
      options.targetBytes ?? Math.min(maxBytes, Math.max(0, before.bytes - pressureBytes))
    );
    let bytesToRemove = Math.max(0, before.bytes - targetBytes, pressureBytes);
    let removedBytes = 0;
    let removedEntries = 0;
    const oldest = entries
      .filter((entry) => !entry.leased)
      .sort(
        (left, right) => left.lastAccess - right.lastAccess || left.key.localeCompare(right.key)
      );

    for (const entry of oldest) {
      if (bytesToRemove <= 0) break;
      if (options.dryRun) {
        removedBytes += entry.bytes;
        removedEntries += 1;
        bytesToRemove -= entry.bytes;
        continue;
      }
      const trashRoot = path.join(root, ".trash");
      const trashPath = path.join(
        trashRoot,
        `${entry.key}.${crypto.randomBytes(8).toString("hex")}`
      );
      let committed = false;
      this.transaction(() => {
        const now = Date.now();
        this.deleteExpiredLeases(now);
        const leased = this.db
          .prepare(
            "SELECT 1 AS one FROM cache_leases WHERE root = ? AND key = ? AND expires_at > ? LIMIT 1"
          )
          .get(root, entry.key, now);
        if (leased) return;
        const source = entryPath(root, entry.key);
        try {
          fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
          fs.renameSync(source, trashPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.db
          .prepare("DELETE FROM cache_entries WHERE root = ? AND key = ?")
          .run(root, entry.key);
        committed = true;
      });
      if (!committed) continue;
      await fs.promises.rm(trashPath, { recursive: true, force: true });
      removedBytes += entry.bytes;
      removedEntries += 1;
      bytesToRemove -= entry.bytes;
    }

    entries = options.dryRun ? entries : await this.scan(root);
    const after = options.dryRun
      ? {
          ...before,
          bytes: Math.max(0, before.bytes - removedBytes),
          entries: before.entries - removedEntries,
        }
      : this.summarize(root, entries);
    return { ...after, removedEntries, removedBytes, targetBytes };
  }

  /**
   * Run an automatic pass only when no other process has recently tuned this
   * root. Manual prune intentionally bypasses this cross-process cadence.
   */
  async tune(
    rootInput: string,
    options: Parameters<DerivedCacheCoordinator["prune"]>[1] = {},
    intervalMs = AUTOMATIC_PRUNE_INTERVAL_MS
  ): Promise<DerivedCachePruneResult | null> {
    const root = canonicalRoot(rootInput);
    const now = Date.now();
    const claimed = this.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT owner_id, expires_at, last_pruned_at FROM cache_maintenance WHERE root = ?"
        )
        .get(root) as
        | { owner_id: string | null; expires_at: number; last_pruned_at: number }
        | undefined;
      if (current?.expires_at && current.expires_at > now) return false;
      if (current?.last_pruned_at && now - current.last_pruned_at < intervalMs) return false;
      this.db
        .prepare(
          `INSERT INTO cache_maintenance(root, owner_id, expires_at, last_pruned_at)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(root) DO UPDATE SET
             owner_id = excluded.owner_id,
             expires_at = excluded.expires_at`
        )
        .run(root, this.ownerId, now + Math.max(AUTOMATIC_PRUNE_LEASE_MS, intervalMs * 2));
      return true;
    });
    if (!claimed) return null;

    try {
      const result = await this.prune(root, options);
      this.finishTuning(root, true);
      return result;
    } catch (error) {
      this.finishTuning(root, false);
      throw error;
    }
  }

  close(): void {
    for (const { timer } of this.leases.values()) clearInterval(timer);
    this.leases.clear();
    this.db.close();
  }

  private async scan(root: string): Promise<DerivedCacheEntry[]> {
    const now = Date.now();
    this.transaction(() => this.deleteExpiredLeases(now));
    const stored = new Map(
      (
        this.db
          .prepare("SELECT key, last_access FROM cache_entries WHERE root = ?")
          .all(root) as Array<{ key: string; last_access: number }>
      ).map((entry) => [entry.key, entry.last_access])
    );
    const leased = new Set(
      (
        this.db
          .prepare("SELECT DISTINCT key FROM cache_leases WHERE root = ? AND expires_at > ?")
          .all(root, now) as Array<{ key: string }>
      ).map((entry) => entry.key)
    );
    const entries = await Promise.all(
      (await cacheDirectories(root)).map(async (key) => {
        const storedPath = entryPath(root, key);
        const bytes = await allocatedBytes(storedPath);
        let modified = 0;
        try {
          modified = Math.floor((await fs.promises.stat(storedPath)).mtimeMs);
        } catch {
          // A concurrent owner can remove a failed unpublished entry.
        }
        return {
          key,
          bytes,
          lastAccess: stored.get(key) ?? modified,
          leased: leased.has(key),
        };
      })
    );
    this.transaction(() => {
      const present = new Set(entries.map((entry) => entry.key));
      for (const entry of entries) {
        this.db
          .prepare(
            `INSERT INTO cache_entries(root, key, bytes, last_access)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(root, key) DO UPDATE SET bytes = excluded.bytes`
          )
          .run(root, entry.key, entry.bytes, entry.lastAccess);
      }
      for (const key of stored.keys()) {
        if (!present.has(key) && !leased.has(key)) {
          this.db.prepare("DELETE FROM cache_entries WHERE root = ? AND key = ?").run(root, key);
        }
      }
    });
    return entries;
  }

  private summarize(root: string, entries: DerivedCacheEntry[]): DerivedCacheStatus {
    return {
      root,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      entries: entries.length,
      leasedEntries: entries.filter((entry) => entry.leased).length,
      reclaimableBytes: entries
        .filter((entry) => !entry.leased)
        .reduce((total, entry) => total + entry.bytes, 0),
      availableBytes: availableBytes(root),
    };
  }

  private heartbeat(leaseId: string): void {
    const owned = this.leases.get(leaseId);
    if (!owned) return;
    try {
      this.transaction(() => {
        const renewed = this.db
          .prepare("UPDATE cache_leases SET expires_at = ? WHERE lease_id = ? AND owner_id = ?")
          .run(Date.now() + LEASE_TTL_MS, leaseId, this.ownerId);
        if (renewed.changes > 0) return;
        // A sweep can treat a live owner whose event loop stalled past the TTL
        // as crashed. Re-fence while holding the same writer lock used by prune,
        // but only if prune has not already committed the entry to trash.
        if (!fs.existsSync(entryPath(owned.root, owned.key))) return;
        this.db
          .prepare(
            "INSERT INTO cache_leases(lease_id, root, key, owner_id, expires_at) VALUES (?, ?, ?, ?, ?)"
          )
          .run(leaseId, owned.root, owned.key, this.ownerId, Date.now() + LEASE_TTL_MS);
      });
    } catch {
      // A transient busy database is retried by the next heartbeat. The lease
      // remains fenced for several heartbeat intervals.
    }
  }

  private deleteExpiredLeases(now: number): void {
    this.db.prepare("DELETE FROM cache_leases WHERE expires_at <= ?").run(now);
  }

  private finishTuning(root: string, completed: boolean): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE cache_maintenance
           SET owner_id = NULL, expires_at = 0,
               last_pruned_at = CASE WHEN ? THEN ? ELSE last_pruned_at END
           WHERE root = ? AND owner_id = ?`
        )
        .run(completed ? 1 : 0, Date.now(), root, this.ownerId);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const coordinators = new Map<string, DerivedCacheCoordinator>();

export function derivedCacheCoordinator(root: string): DerivedCacheCoordinator {
  const canonical = canonicalRoot(root);
  let coordinator = coordinators.get(canonical);
  if (!coordinator) {
    coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(canonical));
    coordinators.set(canonical, coordinator);
  }
  return coordinator;
}

const scheduledPrunes = new Map<string, Promise<DerivedCachePruneResult | null>>();
const tuningTimers = new Map<string, ReturnType<typeof setTimeout>>();
const tuningOptions = new Map<string, Parameters<DerivedCacheCoordinator["prune"]>[1]>();

function armDerivedCacheTuning(root: string): void {
  if (tuningTimers.has(root)) return;
  const timer = setTimeout(() => {
    tuningTimers.delete(root);
    void runScheduledDerivedCachePrune(root)
      .catch((error) => {
        console.warn(
          `[derivedCache] Periodic tuning failed for ${root}: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => armDerivedCacheTuning(root));
  }, AUTOMATIC_PRUNE_INTERVAL_MS);
  timer.unref?.();
  tuningTimers.set(root, timer);
}

function runScheduledDerivedCachePrune(canonical: string): Promise<DerivedCachePruneResult | null> {
  const existing = scheduledPrunes.get(canonical);
  if (existing) return existing;
  const pending = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() =>
      derivedCacheCoordinator(canonical).tune(canonical, tuningOptions.get(canonical) ?? {})
    )
    .finally(() => scheduledPrunes.delete(canonical));
  scheduledPrunes.set(canonical, pending);
  return pending;
}

export function scheduleDerivedCachePrune(
  root: string,
  options: Parameters<DerivedCacheCoordinator["prune"]>[1] = {}
): Promise<DerivedCachePruneResult | null> {
  const canonical = canonicalRoot(root);
  tuningOptions.set(canonical, options);
  armDerivedCacheTuning(canonical);
  return runScheduledDerivedCachePrune(canonical);
}
