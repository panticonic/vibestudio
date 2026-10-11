import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
export const DEFAULT_DERIVED_CACHE_MAX_BYTES = 2 * GIB;
export const DEFAULT_DERIVED_CACHE_FREE_FLOOR_BYTES = 10 * GIB;
const DERIVED_CACHE_MAX_BYTES_BY_ROOT: Readonly<Record<string, number>> = {
  "external-deps": 2 * GIB,
  "extension-runtime-deps": 1 * GIB,
  "build-results": 1 * GIB,
  "root-templates": 512 * MIB,
};
const AUTOMATIC_PRUNE_INTERVAL_MS = 15 * 60_000;

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

/** Per-root quotas sum to a bounded profile-wide shared cache footprint. */
export function derivedCacheMaxBytes(root: string): number {
  return (
    DERIVED_CACHE_MAX_BYTES_BY_ROOT[path.basename(canonicalRoot(root))] ??
    DEFAULT_DERIVED_CACHE_MAX_BYTES
  );
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
          !entry.name.startsWith(".") &&
          !entry.name.includes(".tmp.") &&
          !entry.name.includes(".gc.")
      )
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function processIdentity(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${boot}/${started}`;
  } catch {
    return undefined;
  }
}

function ownerIsAlive(owner: string): boolean {
  const [pidText, , identity] = owner.split(":");
  const pid = Number(pidText);
  // Unknown identities remain protected: inability to inspect is not death.
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
  const current = identity ? processIdentity(pid) : undefined;
  return !current || !identity || current === identity;
}

/**
 * Cross-process ownership for deletable cache entries.
 *
 * Acquiring a key and committing its rename-to-trash are serialized through
 * one SQLite writer transaction. Leases end on explicit release or confirmed
 * owner-process death. A paused or overloaded live process retains ownership.
 */
export class DerivedCacheCoordinator {
  private readonly db: DatabaseSync;
  private readonly ownerId = `${process.pid}:${crypto.randomBytes(16).toString("hex")}:${processIdentity(process.pid) ?? ""}`;
  private readonly leases = new Set<string>();

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.enableWriteAheadLogging();
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
          owner_id TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS cache_leases_entry
          ON cache_leases(root, key);
        CREATE TABLE IF NOT EXISTS cache_maintenance (
          root TEXT PRIMARY KEY,
          owner_id TEXT,
          last_pruned_at INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `);
      const tables = ["cache_leases", "cache_maintenance"];
      if (
        tables.some((table) =>
          this.db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .some((column) => column["name"] === "expires_at")
        )
      )
        this.transaction(() => {
          for (const table of tables) {
            const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
            if (columns.some((column) => column["name"] === "expires_at")) {
              if (table === "cache_leases") this.db.exec("DROP INDEX cache_leases_entry");
              this.db.exec(`ALTER TABLE ${table} DROP COLUMN expires_at`);
            }
          }
          this.db.exec("CREATE INDEX IF NOT EXISTS cache_leases_entry ON cache_leases(root, key)");
        });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  acquire(rootInput: string, key: string): DerivedCacheLease {
    const root = canonicalRoot(rootInput);
    entryPath(root, key);
    const leaseId = crypto.randomBytes(20).toString("hex");
    const now = Date.now();
    this.transaction(() => {
      this.releaseDeadOwners();
      this.db
        .prepare(
          `INSERT INTO cache_entries(root, key, bytes, last_access)
           VALUES (?, ?, 0, ?)
           ON CONFLICT(root, key) DO UPDATE SET last_access = excluded.last_access`
        )
        .run(root, key, now);
      this.db
        .prepare("INSERT INTO cache_leases(lease_id, root, key, owner_id) VALUES (?, ?, ?, ?)")
        .run(leaseId, root, key, this.ownerId);
    });
    this.leases.add(leaseId);
    let released = false;
    return {
      root,
      key,
      release: () => {
        if (released) return;
        released = true;
        if (!this.leases.delete(leaseId)) return;
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

  /**
   * Serialize a short synchronous mutation with every other process using this
   * coordinator database. The callback must not yield; it is intended for
   * filesystem decisions whose final check and mutation need one cross-process
   * boundary.
   */
  withMutation<T>(
    operation: () => T & ([Extract<T, PromiseLike<unknown>>] extends [never] ? unknown : never)
  ): T {
    return this.transaction(operation);
  }

  /** Read lease ownership while inside `withMutation` for an atomic decision. */
  hasLease(rootInput: string, key: string): boolean {
    const root = canonicalRoot(rootInput);
    this.releaseDeadOwners();
    return Boolean(
      this.db
        .prepare("SELECT 1 AS one FROM cache_leases WHERE root = ? AND key = ? LIMIT 1")
        .get(root, key)
    );
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
    const maxBytes = options.maxBytes ?? derivedCacheMaxBytes(root);
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
        this.releaseDeadOwners();
        const leased = this.db
          .prepare("SELECT 1 AS one FROM cache_leases WHERE root = ? AND key = ? LIMIT 1")
          .get(root, entry.key);
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
    return this.maintain(rootInput, () => this.prune(rootInput, options), intervalMs);
  }

  /** Serialize an owned maintenance operation without expiring a live owner. */
  async maintain<T>(
    rootInput: string,
    operation: () => Promise<T>,
    intervalMs = 0
  ): Promise<T | null> {
    const root = canonicalRoot(rootInput);
    const now = Date.now();
    const claimed = this.transaction(() => {
      const current = this.db
        .prepare("SELECT owner_id, last_pruned_at FROM cache_maintenance WHERE root = ?")
        .get(root) as { owner_id: string | null; last_pruned_at: number } | undefined;
      if (current?.owner_id && ownerIsAlive(current.owner_id)) return false;
      if (current?.last_pruned_at && now - current.last_pruned_at < intervalMs) return false;
      this.db
        .prepare(
          `INSERT INTO cache_maintenance(root, owner_id, last_pruned_at)
           VALUES (?, ?, 0)
           ON CONFLICT(root) DO UPDATE SET
             owner_id = excluded.owner_id`
        )
        .run(root, this.ownerId);
      return true;
    });
    if (!claimed) return null;

    try {
      const result = await operation();
      this.finishTuning(root, true);
      return result;
    } catch (error) {
      this.finishTuning(root, false);
      throw error;
    }
  }

  close(): void {
    if (this.db.prepare("SELECT 1 FROM cache_maintenance WHERE owner_id = ?").get(this.ownerId)) {
      throw new Error("Cannot close derived cache coordinator during an owned pruning operation");
    }
    if (this.leases.size > 0)
      this.transaction(() => {
        this.db.prepare("DELETE FROM cache_leases WHERE owner_id = ?").run(this.ownerId);
      });
    this.leases.clear();
    this.db.close();
  }

  private async scan(root: string): Promise<DerivedCacheEntry[]> {
    this.transaction(() => this.releaseDeadOwners());
    const stored = new Map(
      (
        this.db
          .prepare("SELECT key, last_access FROM cache_entries WHERE root = ?")
          .all(root) as Array<{ key: string; last_access: number }>
      ).map((entry) => [entry.key, entry.last_access])
    );
    const leased = new Set(
      (
        this.db.prepare("SELECT DISTINCT key FROM cache_leases WHERE root = ?").all(root) as Array<{
          key: string;
        }>
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

  private enableWriteAheadLogging(): void {
    const current = this.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    if (current?.journal_mode?.toLowerCase() === "wal") return;

    // journal_mode changes do not honor SQLite's busy handler consistently.
    // During a cold parallel start, one opener owns the persistent transition
    // and its siblings can otherwise block for the full timeout or fail startup.
    // WAL is an optimization, not a correctness requirement: attempt the
    // transition without waiting and retain the normal timeout for real cache
    // reads and writes. The winning opener establishes WAL for future opens.
    this.db.exec("PRAGMA busy_timeout = 0");
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
    } finally {
      this.db.exec("PRAGMA busy_timeout = 5000");
    }
  }

  private releaseDeadOwners(): void {
    const owners = this.db.prepare("SELECT DISTINCT owner_id FROM cache_leases").all();
    for (const row of owners) {
      const owner = row["owner_id"] as string;
      if (!ownerIsAlive(owner)) {
        this.db.prepare("DELETE FROM cache_leases WHERE owner_id = ?").run(owner);
      }
    }
  }

  private finishTuning(root: string, completed: boolean): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE cache_maintenance
           SET owner_id = NULL,
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

function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    (error as { errcode?: unknown }).errcode === 5
  );
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
  if (tuningTimers.has(root) || !tuningOptions.has(root)) return;
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

/** Called after application admission and producers have stopped. */
export async function closeDerivedCacheCoordinators(): Promise<void> {
  for (const timer of tuningTimers.values()) clearTimeout(timer);
  tuningTimers.clear();
  tuningOptions.clear();
  const results = await Promise.allSettled(scheduledPrunes.values());
  for (const coordinator of coordinators.values()) coordinator.close();
  coordinators.clear();
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}
