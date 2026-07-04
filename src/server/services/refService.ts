/**
 * RefService — the host's protected MAIN-ref table, reduced to a semantics-free
 * content compare-and-swap (narrow-host-boundary-refactor Phase 5).
 *
 * The host tracks exactly one canonical `main` state per repo path:
 * `repoPath → { stateHash, updatedAt }`. There is no generic `(repo, ref)`
 * namespace. The whole write surface is a single atomic group compare-and-swap
 * — `updateMains` — plus movement-limited host-internal seeding (`seedMain`,
 * set-if-absent, implemented through `updateMains`). `next === null` removes the
 * ref.
 *
 * `updateMains` is CONTENT-only for the SWAP decision: it validates every
 * non-null `next` is fully present in the content store (`assertTreeComplete`),
 * runs the injected approval gate once (host-enforced user consent, D3), then
 * swaps. It makes no push/merge/delete/restore branching decision. But every
 * movement it commits is APPENDED to the host **main-ref log** (§2): a durable,
 * host-verified `(operation, writer, onBehalfOf, reason, old→new, seq)` audit
 * trail the RPC layer feeds it (the token-resolved principal, captured here
 * before it is discarded). The log is the design's native main-advance
 * provenance signal, read back via `listMainRefLog`.
 *
 * After a successful swap it emits a DUMB `onRefsChanged` signal — just the
 * changed `repoPath → stateHash` pairs (null = removed), no operation label, no
 * transition kind, no diff. The host subscribes to drive its own semantics-free
 * post-advance effects (build EV-baseline promotion, memory-index reaction);
 * the CAS neither knows nor cares what they are.
 *
 * DURABILITY: the whole main table AND its movement log live in ONE JSON file
 * replaced atomically via writeJsonFileAtomic (temp file + fsync + rename +
 * best-effort dir fsync). The single rename is the sole commit point, so a
 * crash at any moment leaves either the complete old {table, log} or the
 * complete new one — a ref advance and its log row commit together, never one
 * without the other. A batch writes ALL its entries + log rows in that one
 * replace: there is no partial persist and nothing to roll back.
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
import { normalizeWorkspaceRepoPath } from "@vibez1/shared/runtime/entitySpec";
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
}

/** One repo's requested main movement. `next: null` deletes the main. */
export interface MainUpdateEntry {
  repoPath: string;
  expectedOld: string | null;
  next: string | null;
}

/** The VCS operation a movement represents, recorded in the main-ref log.
 *  `seed` is the host-internal bootstrap set-if-absent (no wire operation). */
export type MainRefOperation = "push" | "import" | "delete" | "restore" | "seed";

export interface UpdateMainsInput {
  entries: MainUpdateEntry[];
  /**
   * Opaque policy-layer context forwarded VERBATIM to the gate (the resolved
   * caller an approval prompt needs). RefService never inspects or persists it
   * — advancement policy stays injected.
   */
  gateContext?: unknown;
  /**
   * Movement provenance recorded to the main-ref log (§2). The RPC layer
   * (`refsService`) resolves these before they are discarded: `operation`/
   * `reason` come from the wire request, `writer` is the single VCS writer DO,
   * `onBehalfOf` is the token-resolved originating principal. Host-internal
   * seeding passes operation `seed`.
   */
  operation: MainRefOperation;
  reason?: string;
  writer?: string;
  onBehalfOf?: unknown;
}

export interface UpdateMainsResult {
  updated: Array<{
    repoPath: string;
    stateHash: string | null;
    /** The main-ref log id assigned to this movement (equal to the current max
     *  seq for a no-op removal that recorded no row). */
    seq: number;
  }>;
}

/** One durable row of the host main-ref movement log (§2). */
export interface MainRefLogRow {
  /** Monotonic global id (this movement's `seq`). */
  id: number;
  repoPath: string;
  /** Always `main` today — one protected ref per repo. */
  ref: string;
  operation: MainRefOperation;
  /** Ref value before the movement; null when created. */
  old: string | null;
  /** Ref value after the movement; null when removed. */
  new: string | null;
  /** The single VCS writer DO identity, or null for host-internal seeding. */
  writer: string | null;
  /** The token-resolved originating principal, or null. */
  onBehalfOf: unknown;
  reason: string | null;
  /** Movement timestamp (ms since epoch). */
  createdAt: number;
}

/** Per-repo view the gate receives: the ACTUAL current value (validated equal
 *  to the entry's `expectedOld`) and the requested `next` (null = removal). The
 *  gate computes its own content diff from these; it derives a removal from
 *  `next === null` and needs no VCS-operation label. */
export interface RefGateBatchEntry {
  repoPath: string;
  old: string | null;
  next: string | null;
}

export interface RefGateBatch {
  entries: RefGateBatchEntry[];
  gateContext?: unknown;
}

/** One committed ref change delivered to an {@link OnRefsChanged} listener:
 *  which repoPath now points at which stateHash (`null` = the ref was removed).
 *  Deliberately semantics-free — no operation, no transition kind, no diff. */
export interface RefChange {
  repoPath: string;
  stateHash: string | null;
}

/**
 * Post-commit notification invoked AFTER a successful `updateMains` swap has
 * committed and the per-repoPath queues have been released (so a listener may
 * do slow work without holding the critical section). It carries ONLY the
 * changed refs; it is not part of the CAS and never writes refs. Awaited by
 * `updateMains` so callers observe a fully-reacted host on return, but
 * best-effort — a listener failure never fails the (already-committed) advance.
 */
export type OnRefsChanged = (changes: RefChange[]) => void | Promise<void>;

/**
 * Approval hook run ONCE per batch, BEFORE the swap, inside the batch's
 * critical section (all touched repoPath queues held). Throwing aborts the
 * whole batch with zero state change. This is where the wiring phase plugs in
 * the host-enforced main-advance approval; this module stays policy-free.
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
  /**
   * The main-ref movement log for one repo (§2), oldest first. `sinceId` returns
   * only movements with a greater id (omit for the full log). The render paths
   * read main-advance attribution from here; the DO's stale-intent discard
   * consults it.
   */
  listMainRefLog(repoPath: string, sinceId?: number): MainRefLogRow[];
  /**
   * Atomic group compare-and-swap. Every entry's `expectedOld` must match the
   * current value (null = must-not-exist) or the WHOLE batch fails with a
   * {@link RefBatchConflictError}. Non-null `next` values are validity-checked
   * against the content store, then the injected gate runs once, then all
   * entries persist in ONE atomic file replace (`next: null` removes the ref).
   */
  updateMains(input: UpdateMainsInput): Promise<UpdateMainsResult>;
  /**
   * One-time adoption of a repo's `main`: set it only if absent (bootstrap
   * seeding). Idempotent — an existing main is left untouched (even if `value`
   * differs) and returned. Implemented through `updateMains`, so it gets the
   * same tree validation and swap path as every other protected-main creation.
   * Movement-limited by construction: it can never MOVE an existing main.
   */
  seedMain(input: { repoPath: string; value: string }): Promise<{
    created: boolean;
    record: MainRefRecord;
  }>;
  /**
   * Subscribe to the dumb post-commit "refs changed" signal. The listener fires
   * after every successful `updateMains` swap with the changed refs only.
   * Returns an unsubscribe function. Multiple listeners are supported and fire
   * in registration order.
   */
  onRefsChanged(listener: OnRefsChanged): () => void;
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
function validateRepoPath(name: unknown): asserts name is string {
  if (typeof name !== "string") throw new RefValidationError("repoPath must be a string");
  try {
    normalizeWorkspaceRepoPath(name);
  } catch (error) {
    throw new RefValidationError(error instanceof Error ? error.message : String(error));
  }
}

function validateValue(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !REF_VALUE_RE.test(value)) {
    throw new RefValidationError(
      `Invalid ${label} (want state:<hex64> or manifest:<hex64>): ${JSON.stringify(value)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// STORE_VERSION stays 3: the movement `log`/`seq` fields are ADDITIVE and
// default-empty, so an existing v3 store (written before the log existed) loads
// intact and starts logging from its next movement. Bumping the version would
// brick startup on a running install (loadStore treats an unknown version as
// fatal), orphaning every protected main — never acceptable for this table.
const STORE_VERSION = 3;
const STORE_FILE_NAME = "refs.json";

// The main-ref movement log (§2) is an append-only audit trail written into the
// single refs.json store, so an unbounded log would grow that file — and every
// atomic rewrite of it — without limit. Cap it at the most recent
// MAIN_REF_LOG_MAX_PER_REPO movements PER repoPath (the oldest beyond the cap
// are dropped on the next write). The cap is per-repo so a chatty repo can never
// evict a quiet repo's history, and generous enough that the DO's since-id
// catch-up (which reads far fewer than this between reactions) never misses a
// movement. `seq` keeps advancing monotonically regardless of pruning.
const MAIN_REF_LOG_MAX_PER_REPO = 1000;

/** Cap the movement log to the most recent {@link MAIN_REF_LOG_MAX_PER_REPO}
 *  rows per repoPath, dropping the oldest overflow while preserving the overall
 *  append (ascending-id) order. Returns the input unchanged when nothing
 *  overflows, so the common path allocates nothing extra. */
function capMainRefLog(rows: MainRefLogRow[]): MainRefLogRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.repoPath, (counts.get(row.repoPath) ?? 0) + 1);
  const dropRemaining = new Map<string, number>();
  for (const [repo, count] of counts) {
    if (count > MAIN_REF_LOG_MAX_PER_REPO) {
      dropRemaining.set(repo, count - MAIN_REF_LOG_MAX_PER_REPO);
    }
  }
  if (dropRemaining.size === 0) return rows;
  const kept: MainRefLogRow[] = [];
  for (const row of rows) {
    const remaining = dropRemaining.get(row.repoPath) ?? 0;
    if (remaining > 0) {
      dropRemaining.set(row.repoPath, remaining - 1); // drop this (oldest) overflow row
      continue;
    }
    kept.push(row);
  }
  return kept;
}

interface StoredRefStore {
  version: number;
  mains: MainRefRecord[];
  /** The main-ref movement log (§2). Absent in pre-log v3 stores. */
  log?: MainRefLogRow[];
  /** The highest movement id assigned so far. Absent ⇒ 0. */
  seq?: number;
}

function isMainRefRecord(value: unknown): value is MainRefRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<MainRefRecord>;
  return (
    typeof record.repoPath === "string" &&
    typeof record.stateHash === "string" &&
    typeof record.updatedAt === "number"
  );
}

function isMainRefLogRow(value: unknown): value is MainRefLogRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<MainRefLogRow>;
  return (
    typeof row.id === "number" &&
    typeof row.repoPath === "string" &&
    typeof row.ref === "string" &&
    typeof row.operation === "string" &&
    (row.old === null || typeof row.old === "string") &&
    (row.new === null || typeof row.new === "string") &&
    (row.writer === null || typeof row.writer === "string") &&
    (row.reason === null || typeof row.reason === "string") &&
    typeof row.createdAt === "number"
  );
}

/** Load persisted state into the in-memory `mains`/`log` collections and return
 *  the highest movement id seen (the seq to continue from). */
function loadStore(
  filePath: string,
  mains: Map<string, MainRefRecord>,
  log: MainRefLogRow[]
): number {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  // Corruption is fatal by design: a protected-ref store that silently reset to
  // empty would let any caller re-create mains via expectedOld:null CAS,
  // erasing protection. Fail loudly instead.
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
    validateRepoPath(record.repoPath);
    mains.set(record.repoPath, { ...record });
  }
  let maxId = 0;
  for (const row of parsed.log ?? []) {
    if (!isMainRefLogRow(row)) throw new Error(`Corrupt main-ref log row in ${filePath}`);
    validateRepoPath(row.repoPath);
    log.push({ ...row });
    if (row.id > maxId) maxId = row.id;
  }
  return Math.max(parsed.seq ?? 0, maxId);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createRefService(deps: RefServiceDeps): RefService {
  const now = deps.now ?? (() => Date.now());
  const filePath = path.join(deps.statePath, STORE_FILE_NAME);
  const mains = new Map<string, MainRefRecord>();
  const log: MainRefLogRow[] = [];
  const chains = new Map<string, Promise<unknown>>();
  const refsChangedListeners = new Set<OnRefsChanged>();

  let seq = loadStore(filePath, mains, log);

  /** Write the full store (mains + movement log) atomically. The rename is the
   *  sole commit point; callers adopt into memory only after this returns. */
  const persistStore = (
    nextMains: Iterable<MainRefRecord>,
    nextLog: MainRefLogRow[],
    nextSeq: number
  ): void => {
    fs.mkdirSync(deps.statePath, { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(filePath, {
      version: STORE_VERSION,
      mains: [...nextMains],
      log: nextLog,
      seq: nextSeq,
    } satisfies StoredRefStore);
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

    listMainRefLog(repoPath, sinceId) {
      validateRepoPath(repoPath);
      const floor = sinceId ?? 0;
      // `log` is append-ordered ⇒ already ascending by id.
      return log
        .filter((row) => row.repoPath === repoPath && row.id > floor)
        .map((row) => ({ ...row }));
    },

    async updateMains(input) {
      if (input.entries.length === 0) {
        throw new RefValidationError("updateMains requires at least one entry");
      }
      if (!input.operation) {
        throw new RefValidationError("updateMains requires an operation");
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
      // Genuine ref changes captured inside the critical section, emitted to the
      // dumb refs-changed listeners AFTER the queues release (below).
      let changes: RefChange[] = [];

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

        // 3) Approval gate (once per batch), inside the critical section. The
        //    gate computes its own content diff (current → next) and classifies
        //    a removal from `next === null`; RefService supplies no semantics.
        await deps.gate({
          entries: input.entries.map((entry) => ({
            repoPath: entry.repoPath,
            old: mains.get(entry.repoPath)?.stateHash ?? null,
            next: entry.next,
          })),
          ...(input.gateContext !== undefined ? { gateContext: input.gateContext } : {}),
        });

        // 4) Swap: build the full next store (mains + appended log rows) and
        //    persist in ONE atomic replace. seq/log stay LOCAL until the rename
        //    succeeds, so a failed persist leaves memory untouched.
        const timestamp = now();
        const nextMains = new Map(mains);
        const updated: UpdateMainsResult["updated"] = [];
        const batchChanges: RefChange[] = [];
        const newRows: MainRefLogRow[] = [];
        let nextSeq = seq;
        for (const entry of input.entries) {
          const current = mains.get(entry.repoPath) ?? null;
          const old = current?.stateHash ?? null;
          if (entry.next === null) {
            // Removal. A no-op removal of an absent main moves nothing — no log
            // row; report the current max seq.
            if (!current) {
              updated.push({ repoPath: entry.repoPath, stateHash: null, seq: nextSeq });
              continue;
            }
            nextMains.delete(entry.repoPath);
          } else {
            nextMains.set(entry.repoPath, {
              repoPath: entry.repoPath,
              stateHash: entry.next,
              updatedAt: timestamp,
            });
          }
          const rowSeq = ++nextSeq;
          newRows.push({
            id: rowSeq,
            repoPath: entry.repoPath,
            ref: "main",
            operation: input.operation,
            old,
            new: entry.next,
            writer: input.writer ?? null,
            onBehalfOf: input.onBehalfOf ?? null,
            reason: input.reason ?? null,
            createdAt: timestamp,
          });
          updated.push({ repoPath: entry.repoPath, stateHash: entry.next, seq: rowSeq });
          batchChanges.push({ repoPath: entry.repoPath, stateHash: entry.next });
        }
        // Cap the log per repo BEFORE persisting so the in-memory and on-disk
        // logs stay identical (a crash leaves whichever is the pre-rename state).
        const nextLog = capMainRefLog([...log, ...newRows]);
        persistStore(nextMains.values(), nextLog, nextSeq);
        // Only reached when the rename succeeded — adopt into memory.
        mains.clear();
        for (const record of nextMains.values()) mains.set(record.repoPath, record);
        log.length = 0;
        for (const row of nextLog) log.push(row);
        seq = nextSeq;
        changes = batchChanges;
        return { updated };
      };

      const acquire = (index: number): Promise<UpdateMainsResult> =>
        index >= keys.length
          ? runBatch()
          : serializeByKey(chains, keys[index]!, () => acquire(index + 1));
      const result = await acquire(0);
      // Dumb post-commit signal — fired after the swap committed and the queues
      // released, awaited so callers observe a fully-reacted host on return.
      // Best-effort: a listener failure never fails the committed advance.
      if (changes.length > 0 && refsChangedListeners.size > 0) {
        for (const listener of refsChangedListeners) {
          try {
            await listener(changes);
          } catch (error) {
            console.error("[refService] onRefsChanged listener failed:", error);
          }
        }
      }
      return result;
    },

    onRefsChanged(listener) {
      refsChangedListeners.add(listener);
      return () => {
        refsChangedListeners.delete(listener);
      };
    },

    async seedMain(input) {
      validateRepoPath(input.repoPath);
      validateValue("value", input.value);
      const current = mains.get(input.repoPath);
      if (current) return { created: false, record: { ...current } };
      try {
        await service.updateMains({
          entries: [{ repoPath: input.repoPath, expectedOld: null, next: input.value }],
          operation: "seed",
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
