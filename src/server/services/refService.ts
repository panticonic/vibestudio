/**
 * RefService — the host's protected MAIN-ref table (narrow-host-vcs §2.1).
 *
 * The host tracks exactly one canonical `main` state per repo path:
 * `repoPath → { stateHash, seq, updatedAt }`. There is no generic `(repo, ref)`
 * namespace. The public write surface is a single atomic group compare-and-swap
 * — `updateMains` — plus movement-limited host-internal seeding
 * (`seedMain`, set-if-absent, implemented through `updateMains`). Repo retirement
 * is a `next: null` entry through `updateMains` (approval-gated). Advancement
 * policy is injected as a `gate` hook that runs once per batch, before the swap;
 * this module stays policy- and content-free (a wiring phase attaches the
 * main-advance approval + a content-store validity check as deps).
 *
 * DURABILITY: the whole store (main table + append-only log) lives in ONE JSON
 * file replaced atomically via writeJsonFileAtomic (temp file + fsync + rename
 * + best-effort dir fsync). The single rename is the sole commit point, so the
 * table and its log can never disagree on disk, and a crash at any moment
 * leaves either the complete old store or the complete new store. A batch
 * writes ALL its entries in that one replace: there is no partial persist and
 * nothing to roll back.
 *
 * CONCURRENCY: a single server process owns the store, so an in-process
 * per-repoPath queue (serializeByKey) is sufficient. A batch acquires every
 * touched repoPath's queue (sorted, so overlapping multi-acquires can never
 * deadlock) and runs its whole critical section — CAS validity check → tree
 * validity check → approval gate → swap — while holding them. Competing writes
 * to a touched repo queue behind the batch and then re-check their own CAS.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { serializeByKey } from "@vibez1/shared/keyedSerializer";
import type { MainUpdateOperation } from "@vibez1/shared/serviceSchemas/refs";
import { writeJsonFileAtomic } from "./atomicFile.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MainRefRecord {
  repoPath: string;
  /** Content-store tree reference this main points at (`state:…`/`manifest:…`). */
  stateHash: string;
  /** Clock timestamp (ms) of the last successful movement/seed. */
  updatedAt: number;
  /** Per-repoPath sequence number, strictly increasing across the repo's
   *  whole movement history (survives delete → re-create). */
  seq: number;
}

export interface MainRefLogEntry {
  repoPath: string;
  /** The seq this movement reached (strictly increasing per repoPath). */
  seq: number;
  old: string | null;
  /** NULLABLE: a delete records `new: null`; a re-creation records `old: null`. */
  new: string | null;
  /** Principal that performed the CAS (e.g. `do:workers/gad-store:…`). */
  writer: string;
  /** Host-resolved originating principal (invocation-token table, §4). */
  onBehalfOf: string | null;
  reason: string;
  operation: MainUpdateOperation;
  timestamp: number;
}

/** One repo's requested main movement. `next: null` deletes the main. */
export interface MainUpdateEntry {
  repoPath: string;
  expectedOld: string | null;
  next: string | null;
}

export interface UpdateMainsInput {
  entries: MainUpdateEntry[];
  operation: MainUpdateOperation;
  reason: string;
  /** Principal string recorded as the log `writer`. */
  writer: string;
  /** Host-resolved originating principal for the log `onBehalfOf`. */
  onBehalfOf?: string | null;
  /**
   * Opaque policy-layer context forwarded VERBATIM to the gate (the resolved
   * caller + operation an approval prompt needs). RefService never inspects or
   * persists it — advancement policy stays injected.
   */
  gateContext?: unknown;
}

export interface UpdateMainsResult {
  updated: Array<{ repoPath: string; stateHash: string | null; seq: number }>;
}

/**
 * A committed main movement, delivered to the {@link RefService.setOnMainsUpdated}
 * reaction AFTER the atomic swap lands. Carries the per-repo old/new state so the
 * reaction can project the new trees to disk and drive the build trigger without
 * re-reading. `newState: null` is a delete.
 */
export interface MainsUpdatedEvent {
  entries: Array<{ repoPath: string; oldState: string | null; newState: string | null }>;
  operation: MainUpdateOperation;
  writer: string;
  onBehalfOf: string | null;
  reason: string;
}

/**
 * Reaction invoked ONCE per successful `updateMains` batch, AFTER the swap has
 * committed and the per-repoPath queues have been released (so it may do slow
 * disk I/O without holding the critical section). This is the SINGLE host source
 * of post-advance effects (disk projection + build state trigger); it never
 * writes refs. Awaited by `updateMains` so callers observe a fully-projected
 * workspace on return. Must be internally best-effort — a reaction failure never
 * fails the (already-committed) advance.
 */
export type OnMainsUpdated = (event: MainsUpdatedEvent) => Promise<void>;

/** Per-repo view the gate receives: the ACTUAL current value (validated equal
 *  to the entry's `expectedOld`), the requested `next` (null = delete), and
 *  whether the host's own ref log shows this repo was previously deleted (its
 *  latest log entry recorded `new: null`) — the restore-classification input. */
export interface RefGateBatchEntry {
  repoPath: string;
  old: string | null;
  next: string | null;
  priorDeleted: boolean;
}

export interface RefGateBatch {
  entries: RefGateBatchEntry[];
  operation: MainUpdateOperation;
  reason: string;
  writer: string;
  onBehalfOf: string | null;
  gateContext?: unknown;
}

/**
 * Approval hook run ONCE per batch, BEFORE the swap, inside the batch's
 * critical section (all touched repoPath queues held). Throwing aborts the
 * whole batch with zero state change. This is where the wiring phase plugs in
 * the main-advance approval; this module stays policy-free.
 */
export type RefGate = (batch: RefGateBatch) => Promise<void>;

export interface RefServiceDeps {
  /** Directory the ref store persists under (wiring passes a userData subdir). */
  statePath: string;
  /** Required so a protected-ref store can never accidentally run ungated. */
  gate: RefGate;
  /**
   * Content-store validity check run BEFORE approval for every non-null `next`:
   * throws when the tree is not fully expandable from the content store
   * (userland can never claim a hash the store cannot expand). Optional so pure
   * CAS unit tests need no content store; production wiring always provides it.
   */
  assertTreeComplete?: (stateHash: string) => Promise<void>;
  /** Injected clock (repo convention) so tests are deterministic. */
  now?: () => number;
}

export interface RefService {
  readMain(repoPath: string): MainRefRecord | null;
  listMains(): MainRefRecord[];
  /** Chronological (oldest→newest) log for one repo; `limit` keeps the newest N. */
  readMainLog(query: { repoPath: string; limit?: number }): MainRefLogEntry[];
  /**
   * Atomic group compare-and-swap. Every entry's `expectedOld` must match the
   * current value (null = must-not-exist) or the WHOLE batch fails with a
   * {@link RefBatchConflictError}. Non-null `next` values are validity-checked
   * against the content store, then the injected gate runs once, then all
   * entries persist in ONE atomic file replace (`next: null` deletes).
   */
  updateMains(input: UpdateMainsInput): Promise<UpdateMainsResult>;
  /**
   * One-time adoption of a repo's `main`: set it only if absent (bootstrap
   * seeding). Idempotent — an existing main is left untouched (even if `value`
   * differs) and returned. Implemented through `updateMains`, so it gets the
   * same tree validation, store/log write path, and post-advance reaction as
   * every other protected-main creation. Movement-limited by construction: it
   * can never MOVE an existing main.
   */
  seedMain(input: { repoPath: string; value: string }): Promise<{
    created: boolean;
    record: MainRefRecord;
  }>;
  /**
   * Register (or clear with `null`) the single post-advance reaction (§ item 1
   * of the narrow-host P3 flip). Wired once — WorkspaceVcs registers its
   * projection + state-trigger reaction here in its constructor, covering BOTH
   * the in-process host push path and the DO's `refs.updateMains` RPC path, so
   * post-advance effects fire exactly once from one place.
   */
  setOnMainsUpdated(reaction: OnMainsUpdated | null): void;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export interface MainRefConflict {
  repoPath: string;
  expectedOld: string | null;
  actual: string | null;
}

/** An atomic-batch CAS failure. Carries per-entry conflict data; NO entry in
 *  the batch was persisted (there is nothing to roll back). */
export class RefBatchConflictError extends Error {
  readonly code = "REF_CONFLICT";
  constructor(readonly conflicts: MainRefConflict[]) {
    super(
      `Main-ref group compare-and-swap conflict: ` +
        conflicts
          .map(
            (c) =>
              `${c.repoPath} expected ${c.expectedOld ?? "<absent>"}, found ${c.actual ?? "<absent>"}`
          )
          .join("; ")
    );
    this.name = "RefBatchConflictError";
  }
}

export function isRefConflictError(err: unknown): err is RefBatchConflictError {
  return err instanceof RefBatchConflictError;
}

export class RefValidationError extends Error {
  readonly code = "REF_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "RefValidationError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Mirrors the shared TREE_REF_RE (`manifest:<hex64>`/`state:<hex64>`) without
 *  importing content-store modules — this service stays decoupled. */
const REF_VALUE_RE = /^(state|manifest):[0-9a-f]{64}$/;
/** One path segment: no separators, no control chars, no whitespace. */
const SAFE_NAME_SEGMENT = /^[A-Za-z0-9._@-]+$/;
const MAX_NAME_LENGTH = 256;
const MAX_WRITER_LENGTH = 500;
const MAX_REASON_LENGTH = 2000;

function validateRepoPath(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new RefValidationError("Empty repoPath");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new RefValidationError(`repoPath exceeds ${MAX_NAME_LENGTH} characters`);
  }
  for (const segment of name.split("/")) {
    if (segment === "." || segment === ".." || !SAFE_NAME_SEGMENT.test(segment)) {
      throw new RefValidationError(`Invalid repoPath: ${JSON.stringify(name)}`);
    }
  }
}

function validateValue(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !REF_VALUE_RE.test(value)) {
    throw new RefValidationError(
      `Invalid ${label} (want state:<hex64> or manifest:<hex64>): ${JSON.stringify(value)}`
    );
  }
}

function validateWriter(writer: unknown): asserts writer is string {
  if (typeof writer !== "string" || writer.length === 0 || writer.length > MAX_WRITER_LENGTH) {
    throw new RefValidationError("writer must be a non-empty string");
  }
}

function validateReason(reason: unknown): asserts reason is string {
  if (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH) {
    throw new RefValidationError("reason must be a string");
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORE_VERSION = 2;
const STORE_FILE_NAME = "refs.json";

interface StoredRefStore {
  version: number;
  mains: MainRefRecord[];
  log: MainRefLogEntry[];
}

function isMainRefRecord(value: unknown): value is MainRefRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<MainRefRecord>;
  return (
    typeof record.repoPath === "string" &&
    typeof record.stateHash === "string" &&
    typeof record.updatedAt === "number" &&
    typeof record.seq === "number"
  );
}

function isMainRefLogEntry(value: unknown): value is MainRefLogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<MainRefLogEntry>;
  return (
    typeof entry.repoPath === "string" &&
    typeof entry.seq === "number" &&
    (entry.old === null || typeof entry.old === "string") &&
    (entry.new === null || typeof entry.new === "string") &&
    typeof entry.writer === "string" &&
    (entry.onBehalfOf === null || typeof entry.onBehalfOf === "string") &&
    typeof entry.reason === "string" &&
    typeof entry.operation === "string" &&
    typeof entry.timestamp === "number"
  );
}

function loadStore(
  filePath: string,
  mains: Map<string, MainRefRecord>,
  log: MainRefLogEntry[]
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  // Corruption is fatal by design: a protected-ref store that silently reset to
  // empty would let any caller re-create mains via expectedOld:null CAS,
  // erasing protection and history. Fail loudly instead.
  let parsed: Partial<StoredRefStore>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredRefStore>;
  } catch (err) {
    throw new Error(`Corrupt ref store at ${filePath}: ${(err as Error).message}`);
  }
  if (parsed.version !== STORE_VERSION) {
    throw new Error(`Unsupported ref store version at ${filePath}: ${String(parsed.version)}`);
  }
  for (const record of parsed.mains ?? []) {
    if (!isMainRefRecord(record)) throw new Error(`Corrupt main-ref record in ${filePath}`);
    mains.set(record.repoPath, { ...record });
  }
  for (const entry of parsed.log ?? []) {
    if (!isMainRefLogEntry(entry)) throw new Error(`Corrupt main-ref log entry in ${filePath}`);
    log.push({ ...entry });
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createRefService(deps: RefServiceDeps): RefService {
  const now = deps.now ?? (() => Date.now());
  const filePath = path.join(deps.statePath, STORE_FILE_NAME);
  const mains = new Map<string, MainRefRecord>();
  const log: MainRefLogEntry[] = [];
  const chains = new Map<string, Promise<unknown>>();
  let onMainsUpdated: OnMainsUpdated | null = null;

  loadStore(filePath, mains, log);

  /** Write the full store atomically. The rename is the sole commit point;
   *  callers adopt into memory only after this returns. */
  const persistStore = (nextMains: Iterable<MainRefRecord>, nextLog: MainRefLogEntry[]): void => {
    fs.mkdirSync(deps.statePath, { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(filePath, {
      version: STORE_VERSION,
      mains: [...nextMains],
      log: nextLog,
    } satisfies StoredRefStore);
  };

  /** Highest seq ever recorded for a repoPath (across its whole log), so a
   *  repo's movement history is strictly increasing even across delete →
   *  re-create. Falls back to the live record's seq. */
  const maxSeqForRepo = (repoPath: string): number => {
    let max = mains.get(repoPath)?.seq ?? 0;
    for (const entry of log) {
      if (entry.repoPath === repoPath && entry.seq > max) max = entry.seq;
    }
    return max;
  };

  /** Whether the repo's latest log entry recorded a delete (`new: null`). */
  const priorDeleted = (repoPath: string): boolean => {
    let latest: MainRefLogEntry | null = null;
    for (const entry of log) {
      if (entry.repoPath !== repoPath) continue;
      if (!latest || entry.seq > latest.seq) latest = entry;
    }
    return latest !== null && latest.new === null;
  };

  const service: RefService = {
    readMain(repoPath) {
      validateRepoPath(repoPath);
      const record = mains.get(repoPath);
      return record ? { ...record } : null;
    },

    listMains() {
      return [...mains.values()]
        .sort((a, b) => a.repoPath.localeCompare(b.repoPath))
        .map((record) => ({ ...record }));
    },

    readMainLog(query) {
      validateRepoPath(query.repoPath);
      const limit = query.limit;
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new RefValidationError("limit must be a positive integer");
      }
      const entries = log.filter((entry) => entry.repoPath === query.repoPath);
      const tail = limit === undefined ? entries : entries.slice(-limit);
      return tail.map((entry) => ({ ...entry }));
    },

    async updateMains(input) {
      validateReason(input.reason);
      validateWriter(input.writer);
      if (input.onBehalfOf != null && typeof input.onBehalfOf !== "string") {
        throw new RefValidationError("onBehalfOf must be a string");
      }
      if (input.entries.length === 0) {
        throw new RefValidationError("updateMains requires at least one entry");
      }
      const seen = new Set<string>();
      for (const entry of input.entries) {
        validateRepoPath(entry.repoPath);
        if (seen.has(entry.repoPath)) {
          throw new RefValidationError(`updateMains: duplicate repoPath "${entry.repoPath}"`);
        }
        seen.add(entry.repoPath);
        if (entry.expectedOld !== null) validateValue("expectedOld", entry.expectedOld);
        if (entry.next !== null) validateValue("next", entry.next);
      }

      // Acquire every touched repoPath queue (sorted → deadlock-free), then run
      // the whole critical section holding all of them.
      const keys = [...input.entries.map((e) => e.repoPath)].sort();
      // Movements captured inside the critical section, replayed to the
      // post-advance reaction AFTER the queues release (below).
      let movements: MainsUpdatedEvent["entries"] = [];

      const runBatch = async (): Promise<UpdateMainsResult> => {
        // 1) CAS validity: every expectedOld must match the current value.
        const conflicts: MainRefConflict[] = [];
        for (const entry of input.entries) {
          const actual = mains.get(entry.repoPath)?.stateHash ?? null;
          if (actual !== entry.expectedOld) {
            conflicts.push({ repoPath: entry.repoPath, expectedOld: entry.expectedOld, actual });
          }
        }
        if (conflicts.length > 0) throw new RefBatchConflictError(conflicts);

        // 2) Tree validity BEFORE approval: every non-null next must be a
        //    well-formed tree fully present in the content store.
        if (deps.assertTreeComplete) {
          for (const entry of input.entries) {
            if (entry.next !== null) await deps.assertTreeComplete(entry.next);
          }
        }

        // 3) Approval gate (once per batch), inside the critical section.
        await deps.gate({
          entries: input.entries.map((entry) => ({
            repoPath: entry.repoPath,
            old: mains.get(entry.repoPath)?.stateHash ?? null,
            next: entry.next,
            priorDeleted: priorDeleted(entry.repoPath),
          })),
          operation: input.operation,
          reason: input.reason,
          writer: input.writer,
          onBehalfOf: input.onBehalfOf ?? null,
          ...(input.gateContext !== undefined ? { gateContext: input.gateContext } : {}),
        });

        // 4) Swap: build the full next store and persist in ONE atomic replace.
        const timestamp = now();
        const nextMains = new Map(mains);
        const nextLog = [...log];
        const updated: UpdateMainsResult["updated"] = [];
        const batchMovements: MainsUpdatedEvent["entries"] = [];
        for (const entry of input.entries) {
          const current = mains.get(entry.repoPath) ?? null;
          const seq = maxSeqForRepo(entry.repoPath) + 1;
          if (entry.next === null) {
            // Delete. A no-op delete of an absent main records nothing.
            if (!current) {
              updated.push({ repoPath: entry.repoPath, stateHash: null, seq: 0 });
              continue;
            }
            nextMains.delete(entry.repoPath);
          } else {
            nextMains.set(entry.repoPath, {
              repoPath: entry.repoPath,
              stateHash: entry.next,
              updatedAt: timestamp,
              seq,
            });
          }
          nextLog.push({
            repoPath: entry.repoPath,
            seq,
            old: current?.stateHash ?? null,
            new: entry.next,
            writer: input.writer,
            onBehalfOf: input.onBehalfOf ?? null,
            reason: input.reason,
            operation: input.operation,
            timestamp,
          });
          updated.push({ repoPath: entry.repoPath, stateHash: entry.next, seq });
          batchMovements.push({
            repoPath: entry.repoPath,
            oldState: current?.stateHash ?? null,
            newState: entry.next,
          });
        }
        persistStore(nextMains.values(), nextLog);
        // Only reached when the rename succeeded — adopt into memory.
        mains.clear();
        for (const record of nextMains.values()) mains.set(record.repoPath, record);
        log.length = 0;
        log.push(...nextLog);
        movements = batchMovements;
        return { updated };
      };

      const acquire = (index: number): Promise<UpdateMainsResult> =>
        index >= keys.length
          ? runBatch()
          : serializeByKey(chains, keys[index]!, () => acquire(index + 1));
      const result = await acquire(0);
      // Post-advance reaction — the SINGLE source of projection + build-trigger
      // effects — runs after the swap committed and the queues released, and is
      // awaited so callers observe a fully-projected workspace on return.
      if (onMainsUpdated && movements.length > 0) {
        await onMainsUpdated({
          entries: movements,
          operation: input.operation,
          writer: input.writer,
          onBehalfOf: input.onBehalfOf ?? null,
          reason: input.reason,
        });
      }
      return result;
    },

    setOnMainsUpdated(reaction) {
      onMainsUpdated = reaction;
    },

    async seedMain(input) {
      validateRepoPath(input.repoPath);
      validateValue("value", input.value);
      const current = mains.get(input.repoPath);
      if (current) return { created: false, record: { ...current } };
      try {
        await service.updateMains({
          entries: [{ repoPath: input.repoPath, expectedOld: null, next: input.value }],
          operation: "import",
          reason: "seedMain: adopt pre-existing head",
          writer: "system:seed",
          gateContext: { kind: "system", actor: { id: "seed", kind: "system" } },
        });
      } catch (error) {
        if (!isRefConflictError(error)) throw error;
        const afterConflict = mains.get(input.repoPath);
        if (afterConflict) return { created: false, record: { ...afterConflict } };
        throw error;
      }
      const record = mains.get(input.repoPath);
      if (!record) throw new RefValidationError(`seedMain failed to create ${input.repoPath}`);
      return { created: true, record: { ...record } };
    },
  };
  return service;
}
