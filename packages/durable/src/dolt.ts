/**
 * The typed surface of celld's `ctx.storage.dolt`.
 *
 * A Dolt cell is a Durable Object whose store is a versioned DoltLite database
 * (celld fork `unified-fork`, `docs/services/dolt-cells.md` and
 * `dolt-remotes.md`). This file mirrors that API exactly; it adds no adapter
 * and no second engine abstraction. A SQLite cell has no `dolt`, and
 * {@link doltStorageOf} returns `null` for it.
 *
 * Result shapes are those of the fork's `crates/celld/dolt_cell.rs` and
 * `js/harness.js` at `fcc7268`.
 *
 * Constraints a caller must know:
 * - Every Dolt operation throws inside `transaction()` and `transactionSync()`.
 *   The one exception is the commit of a transaction: `{ commit }` (F2) is an
 *   option of the outermost transaction, and see {@link committedTransactionSync}.
 * - `reset` is a soft reset unless `hard: true`.
 * - Remotes exist only for a class that declared `doltRemotes`
 *   ({@link DoltRemoteStorage}); a facet takes its root class's declaration.
 */

/** A SQL value as application SQL (`ctx.storage.sql`) returns it. */
export type DoltSqlValue = string | number | bigint | Uint8Array | null;

/** A row as `{ column: value }`. */
export type DoltRow = Record<string, DoltSqlValue>;

/** An ISO string, a `Date`, or epoch milliseconds. */
export type DoltDate = string | Date | number;

export interface DoltCommitOptions {
  /** Required and non-empty. */
  readonly message: string;
  /** `"Name <email>"`. */
  readonly author?: string;
  readonly date?: DoltDate;
  readonly allowEmpty?: boolean;
}

/** A commit message, or the full options. */
export type DoltCommitMessage = string | DoltCommitOptions;

/**
 * What a transaction's `commit` option takes: the message, the options, or a
 * function of the callback's result (a message rendered from the facts the
 * callback wrote) that may return `null` to leave the writes uncommitted.
 */
export type DoltTransactionCommit<T> =
  | DoltCommitMessage
  | ((result: T) => DoltCommitMessage | null | undefined | false);

/** The fork's F2 option of `transactionSync` and `transaction`. */
export interface DoltTransactionOptions<T> {
  readonly commit?: DoltTransactionCommit<T> | null | false;
}

export interface DoltBranchInfo {
  readonly name: string;
  readonly hash: string;
  readonly committer: string;
  readonly date: string;
  readonly message: string;
}

export interface DoltLogEntry {
  readonly hash: string;
  readonly committer: string;
  readonly email: string;
  readonly date: string;
  readonly message: string;
}

/** One uncommitted change to an application table. */
export interface DoltStatusEntry {
  readonly table: string;
  readonly staged: boolean | number;
  readonly status: string;
}

export interface DoltDiffSummaryEntry {
  readonly fromTable: string | null;
  readonly toTable: string | null;
  readonly diffType: string;
  readonly dataChange: boolean | number;
  readonly schemaChange: boolean | number;
}

export interface DoltPatchEntry {
  readonly table: string;
  readonly diffType: string;
  /** The SQL statement that turns `from` into `to` for one change. */
  readonly statement: string;
}

export interface DoltDiffResult {
  readonly summary: readonly DoltDiffSummaryEntry[];
  readonly patch: readonly DoltPatchEntry[];
}

export interface DoltDiffOptions {
  /** A branch, tag, hash or `HEAD~n`. */
  readonly from: string;
  /** Default: the working set. */
  readonly to?: string;
  readonly table?: string;
}

export interface DoltResetOptions {
  readonly hard?: boolean;
  /** Default `HEAD`. */
  readonly to?: string;
}

export interface DoltBranchApi {
  create(name: string, options?: { readonly from?: string }): void;
  /** `main` and the checked-out branch cannot be deleted. */
  delete(name: string, options?: { readonly force?: boolean }): void;
  list(): DoltBranchInfo[];
  current(): string;
}

// --- Merge -----------------------------------------------------------------

/** A plain merge result, or a conflicting one (nothing is committed then). */
export interface DoltMergeConflictTable {
  readonly table: string;
  readonly conflicts: unknown;
}

export interface DoltPlainMergeResult {
  /** The merge commit, or `null` when conflicts rolled the merge back. */
  readonly hash: string | null;
  readonly conflicts: readonly DoltMergeConflictTable[];
}

export type DoltRowChange = "added" | "modified" | "removed";

/** One conflicting row, as the F1 resolver sees it. */
export interface DoltMergeConflictRow {
  readonly table: string;
  /** The primary key, `{ id: 1 }`. */
  readonly key: DoltRow;
  /** The row on each side as `{ column: value }`, or `null` where that side has none. */
  readonly base: DoltRow | null;
  readonly ours: DoltRow | null;
  readonly theirs: DoltRow | null;
  readonly ourChange: DoltRowChange;
  readonly theirChange: DoltRowChange;
  readonly resolved: boolean;
  /** The row is as it should be: the resolver wrote it with SQL, or ours stands. */
  resolve(): void;
  keepOurs(): void;
  /** Their row replaces ours, or the row is deleted when they deleted it. */
  takeTheirs(): void;
}

export interface DoltMergeViolationRow {
  readonly table: string;
  /** `"unique index"`, `"foreign key"`, `"check constraint"`, ... */
  readonly type: string;
  readonly info: unknown;
  readonly row: DoltRow;
  readonly resolved: boolean;
  /** The violation is fixed (the resolver changed rows) or accepted. */
  resolve(): void;
}

/** What `resolve` is called with, once, synchronously, inside the merge's transaction. */
export interface DoltMergeSession {
  readonly branch: string;
  /** Commit hashes: our head, theirs, and the merge base (`null` when none). */
  readonly ours: string;
  readonly theirs: string;
  readonly base: string | null;
  readonly conflicts: readonly DoltMergeConflictRow[];
  readonly violations: readonly DoltMergeViolationRow[];
}

export interface DoltMergeOptions {
  /** Default `"Merge <branch>"` for a resolving merge. */
  readonly message?: string;
  readonly author?: string;
  readonly date?: DoltDate;
  /**
   * Resolve conflicts inside the merge's own transaction (F1). Must be
   * synchronous, must answer every conflict and violation, and may write rows
   * with `ctx.storage.sql`. A throw, a promise or an unanswered row rolls the
   * whole merge back.
   */
  readonly resolve?: (merge: DoltMergeSession) => void;
  /** `false` forces a merge commit where a fast-forward would do. */
  readonly fastForward?: boolean;
}

export interface DoltResolvingMergeResult {
  /** `HEAD` after the merge. */
  readonly hash: string;
  readonly conflicts: readonly [];
  readonly fastForward: boolean;
  readonly upToDate: boolean;
  readonly resolved: { readonly conflicts: number; readonly violations: number };
}

export type DoltMergeResult = DoltPlainMergeResult | DoltResolvingMergeResult;

// --- Deterministic execution and reads --------------------------------------

export interface DoltBinding {
  readonly index?: number;
  readonly name?: string;
  readonly value: DoltSqlValue | Float64Array | ArrayBuffer;
}

export interface DoltStatement {
  readonly sql: string;
  readonly bindings?: readonly DoltBinding[];
}

export interface DoltExecuteContext {
  readonly nowMs: number | bigint;
  readonly seed: number | bigint;
  readonly actor?: Uint8Array;
  readonly schemaAdmin?: boolean;
  readonly limits?: Record<string, number>;
}

export type DoltExecuteResult =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "rejected"; readonly code: string; readonly statementIndex: number };

export interface DoltQueryResult {
  readonly columns: readonly string[];
  /** INTEGER is a `bigint`, REAL a number, TEXT a string, BLOB a `Uint8Array`. */
  readonly rows: readonly (readonly DoltSqlValue[])[];
}

// --- Remotes (F7) -----------------------------------------------------------

export interface DoltGrantOptions {
  /** For the issuer's own bookkeeping. */
  readonly label?: string;
  /** May fetch the branches below. */
  readonly fetch?: boolean;
  /** Branch patterns a fetch shows (default `["*"]`); `*` is the only wildcard. */
  readonly branches?: readonly string[];
  /** Branch patterns a push may update (default none). */
  readonly push?: readonly string[];
  /** Epoch milliseconds. */
  readonly expiresAt?: number;
  /** Only a carrier that presents this peer to `serve`. */
  readonly peer?: string;
}

export interface DoltGrant {
  readonly id: string;
  /** Shown once. The source keeps only its SHA-256. */
  readonly token: string;
  readonly label: string | null;
  readonly fetch: boolean;
  readonly push: readonly string[];
  readonly branches: readonly string[];
  readonly peer: string | null;
  readonly expiresAt: number | null;
}

/** A grant as `grants()` lists it: never the token. */
export type DoltGrantInfo = Omit<DoltGrant, "token">;

export interface DoltRemoteTarget {
  /** A `DurableObjectId`, or its `"Class:<id>"` string. */
  readonly id?: { toString(): string } | string;
  readonly ref?: string;
  readonly token: string;
}

export interface DoltRemoteInfo {
  readonly name: string;
  readonly ref: string;
}

export interface DoltRemoteBranch {
  /** `"origin/main"`. */
  readonly name: string;
  readonly hash: string;
}

/** Any `async (bytes) => bytes` carrier; the wire knows no transport. */
export type DoltRemoteTransport = (request: Uint8Array) => Promise<Uint8Array | ArrayBuffer>;

export interface DoltFetchOptions {
  /** Patterns (`*`) of branches to fetch. Default: every branch the grant shows. */
  readonly branches?: readonly string[];
  readonly transport?: DoltRemoteTransport;
}

export interface DoltFetchResult {
  readonly remote: string;
  readonly branches: Readonly<Record<string, string>>;
  readonly bytes: number;
}

export interface DoltPullOptions extends DoltMergeOptions {
  readonly transport?: DoltRemoteTransport;
}

export type DoltPullResult = DoltMergeResult & { readonly fetched: DoltFetchResult };

export interface DoltPushOptions {
  /** The remote branch to move (default: the same name). */
  readonly to?: string;
  readonly transport?: DoltRemoteTransport;
}

export interface DoltPushResult {
  readonly branch: string;
  readonly hash: string;
  readonly created: boolean;
  readonly unchanged: boolean;
}

export interface DoltRemoteApi {
  add(name: string, remote: DoltRemoteTarget): unknown;
  remove(name: string): unknown;
  list(): DoltRemoteInfo[];
  /** The remote-tracking branches fetches brought. */
  branches(): DoltRemoteBranch[];
  /** The source's side: lets a holder fetch and push. */
  grant(options?: DoltGrantOptions): DoltGrant;
  grants(): DoltGrantInfo[];
  revoke(id: string): unknown;
  /** Answers one request with one response, for a carrier of your own. */
  serve(request: Uint8Array, options?: { readonly peer?: string }): Uint8Array;
}

/** Stable `error.code` values of a remote operation. */
export const DOLT_REMOTE_ERROR_CODES = [
  "ERR_DOLT_REMOTE_FORBIDDEN",
  "ERR_DOLT_REMOTE_NOT_FOUND",
  "ERR_DOLT_NON_FAST_FORWARD",
  "ERR_DOLT_TARGET_DIRTY",
  "ERR_DOLT_REMOTE_BAD_REQUEST",
  "ERR_DOLT_REMOTE_FAILED",
] as const;
export type DoltRemoteErrorCode = (typeof DOLT_REMOTE_ERROR_CODES)[number];

/** Whether `error` is a Dolt remote failure with this `code`. */
export function isDoltRemoteError(error: unknown, code?: DoltRemoteErrorCode): boolean {
  if (typeof error !== "object" || error === null) return false;
  const actual = (error as { code?: unknown }).code;
  return code === undefined
    ? typeof actual === "string" && (DOLT_REMOTE_ERROR_CODES as readonly string[]).includes(actual)
    : actual === code;
}

// --- The store ---------------------------------------------------------------

/** `ctx.storage.dolt` of a Dolt cell or a Dolt facet. */
export interface DoltStorage {
  /** Stages every application table (`dolt commit -Am`) and returns the new commit hash. */
  commit(options: DoltCommitMessage): string;
  readonly branch: DoltBranchApi;
  /** Switches the object to `name`, creating it first with `create`. */
  checkout(name: string, options?: { readonly create?: boolean }): string;
  /** Returns the new `HEAD` hash. A soft reset unless `hard: true`. */
  reset(options?: DoltResetOptions): string;
  merge(
    name: string,
    options: DoltMergeOptions & { readonly resolve: NonNullable<DoltMergeOptions["resolve"]> }
  ): DoltResolvingMergeResult;
  merge(name: string, options?: { readonly message?: string }): DoltPlainMergeResult;
  /** Newest first. Default limit 100, at most 10 000. */
  log(options?: { readonly limit?: number }): DoltLogEntry[];
  diff(options: DoltDiffOptions): DoltDiffResult;
  /** A branch, tag, hash or `HEAD~n`. */
  hashOf(ref?: string): string;
  /** Uncommitted changes to application tables. */
  status(): DoltStatusEntry[];
  /** Compacts the store; rewrites the whole file. */
  gc(): unknown;
  /** One deterministic program (Chronolog). Not for single-owner state (L8). */
  execute(
    program: string | readonly DoltStatement[],
    context: DoltExecuteContext,
    options?: { readonly log?: DoltStatement }
  ): DoltExecuteResult;
  /** One read-only statement under the local-read profile. A refusal throws with `code`. */
  query(
    sql: string,
    bindings?: readonly DoltBinding[],
    options?: { readonly limits?: Record<string, number>; readonly maxRows?: number }
  ): DoltQueryResult;
  engineDigest(): string;
}

/** A Dolt store whose class declared `doltRemotes` (`remote`, `fetch`, `pull`, `push`). */
export interface DoltRemoteStorage extends DoltStorage {
  readonly remote: DoltRemoteApi;
  fetch(name: string, options?: DoltFetchOptions): Promise<DoltFetchResult>;
  pull(name: string, branch: string, options?: DoltPullOptions): Promise<DoltPullResult>;
  push(name: string, branch: string, options?: DoltPushOptions): Promise<DoltPushResult>;
}

/** The shape of a `ctx.storage` that may carry Dolt. */
export interface DoltCapableStorage {
  readonly dolt?: DoltStorage;
  transactionSync<T>(callback: () => T, options?: DoltTransactionOptions<T>): T;
  transaction<T>(callback: () => Promise<T>, options?: DoltTransactionOptions<T>): Promise<T>;
}

/** The Dolt store of a storage, or `null` on a SQLite cell. */
export function doltStorageOf(
  storage: { readonly dolt?: DoltStorage } | null | undefined
): DoltStorage | null {
  return storage?.dolt ?? null;
}

/** The Dolt store of a storage when its class declared `doltRemotes`, else `null`. */
export function doltRemotesOf(
  storage: { readonly dolt?: DoltStorage } | null | undefined
): DoltRemoteStorage | null {
  const dolt = storage?.dolt as Partial<DoltRemoteStorage> | undefined;
  return dolt?.remote !== undefined && typeof dolt.fetch === "function"
    ? (dolt as DoltRemoteStorage)
    : null;
}

// --- Commit discipline -------------------------------------------------------

/**
 * Run `fn` in a transaction whose writes and Dolt commit are one durable step
 * (F2). `describe` renders the commit message from the result (L2) and may
 * return `null` to leave the writes uncommitted.
 *
 * On a SQLite cell (no `dolt`) this is a plain `transactionSync` and the
 * commit point is a no-op, so a class does not branch on the engine. It
 * throws on a nested transaction on a Dolt cell, because a savepoint cannot
 * be undone by a commit.
 */
export function committedTransactionSync<T>(
  storage: DoltCapableStorage,
  describe: DoltTransactionCommit<T>,
  fn: () => T
): T {
  return doltStorageOf(storage)
    ? storage.transactionSync(fn, { commit: describe })
    : storage.transactionSync(fn);
}

/** The asynchronous form of {@link committedTransactionSync}. */
export function committedTransaction<T>(
  storage: DoltCapableStorage,
  describe: DoltTransactionCommit<T>,
  fn: () => Promise<T>
): Promise<T> {
  return doltStorageOf(storage)
    ? storage.transaction(fn, { commit: describe })
    : storage.transaction(fn);
}

/** Dolt and celld own these names: they are never part of a class's schema. */
export function isDoltSystemTable(name: string): boolean {
  return (
    name.startsWith("dolt_") ||
    name.startsWith("doltlite_") ||
    name.startsWith("_cf_") ||
    name.startsWith("_litestream") ||
    name.startsWith("sqlite_")
  );
}

/** The uncommitted changes to tables the class owns (system tables excluded). */
export function dirtyApplicationTables(dolt: DoltStorage): DoltStatusEntry[] {
  return dolt.status().filter((entry) => !isDoltSystemTable(entry.table));
}

export class DoltDriftError extends Error {
  readonly code = "DOLT_UNCOMMITTED_DRIFT" as const;
  constructor(readonly tables: readonly string[]) {
    super(
      `versioned tables have uncommitted changes outside committedTransaction: ${tables.join(", ")}`
    );
    this.name = "DoltDriftError";
  }
}

/**
 * Throws when a transactional class left versioned rows uncommitted. A class
 * that writes versioned state only through {@link committedTransactionSync}
 * has a clean working set at every turn boundary; a plain SQL write leaves it
 * dirty and the next commit would sweep that write in. A diagnostic for tests
 * and the dev host, not a recovery. `keep` classes (the agent) hold a dirty
 * working set on purpose and do not call it.
 */
export function assertCleanWorkingSet(dolt: DoltStorage): void {
  const dirty = dirtyApplicationTables(dolt);
  if (dirty.length > 0) throw new DoltDriftError(dirty.map((entry) => entry.table));
}

// --- Compaction (docs/dolt-redesign.md §6.11.8) --------------------------------

/**
 * When a Dolt cell is compacted. A commit appends to the file and nothing frees what it superseded, so an
 * agent cell that is never collected grows by 635 KB a turn (41 KB after `gc`, R1). `gc` rewrites the whole
 * file, so its cost is the size of the file: collecting every N commits would make N small and the total
 * quadratic. The cell is collected after `minCommits` commits, and after that when the commits since its
 * last collection reach `growth` times the commits it held then: the total cost stays linear in the history
 * (a geometric schedule), and a young cell is collected early, when it is cheap.
 */
export interface DoltGcPolicy {
  readonly minCommits: number;
  readonly growth: number;
}

export const DEFAULT_DOLT_GC_POLICY: DoltGcPolicy = { minCommits: 64, growth: 0.5 };

/** Where a cell remembers its last collection: its own local state (never versioned, never forked). */
export interface DoltGcMemory {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const GC_HEAD_KEY = "__dolt_gc_head";
const GC_COMMITS_KEY = "__dolt_gc_commits";
/** `dolt.log` answers at most this many commits. */
const DOLT_LOG_MAX = 10_000;

/** The number of commits since the last collection after which the cell is due. */
export function doltGcThreshold(memory: DoltGcMemory, policy: DoltGcPolicy): number {
  const held = Number(memory.get(GC_COMMITS_KEY) ?? 0);
  const grown = Number.isFinite(held) ? Math.ceil(held * policy.growth) : 0;
  return Math.min(DOLT_LOG_MAX, Math.max(policy.minCommits, grown));
}

/** Whether enough commits have landed since the last collection (a bounded read of the log). */
export function doltGcDue(
  dolt: DoltStorage,
  memory: DoltGcMemory,
  policy: DoltGcPolicy = DEFAULT_DOLT_GC_POLICY
): boolean {
  const threshold = doltGcThreshold(memory, policy);
  const log = dolt.log({ limit: threshold });
  if (log.length < threshold) return false;
  const last = memory.get(GC_HEAD_KEY);
  // The last collection's HEAD is among the newest `threshold` commits: fewer than that have landed since.
  return last === null || !log.some((entry) => entry.hash === last);
}

export type DoltGcOutcome =
  | { readonly ran: true; readonly commits: number }
  | { readonly ran: false; readonly reason: "not-due" | "dirty" };

/**
 * Compact the cell if it is due. Call it at an idle point: outside every transaction, and not while a turn
 * holds uncommitted work. A working set with uncommitted application changes is left alone (the cell is
 * collected after its next commit instead), because the engine rewrites the file it is writing to.
 */
export function collectDoltGarbage(
  dolt: DoltStorage,
  memory: DoltGcMemory,
  policy: DoltGcPolicy = DEFAULT_DOLT_GC_POLICY
): DoltGcOutcome {
  if (!doltGcDue(dolt, memory, policy)) return { ran: false, reason: "not-due" };
  if (dirtyApplicationTables(dolt).length > 0) return { ran: false, reason: "dirty" };
  dolt.gc();
  const commits = dolt.log({ limit: DOLT_LOG_MAX }).length;
  memory.set(GC_HEAD_KEY, dolt.hashOf("HEAD"));
  memory.set(GC_COMMITS_KEY, String(commits));
  return { ran: true, commits };
}

// --- Local tables and deployment declarations --------------------------------

/**
 * Tables the base itself owns that are local on a Dolt store (L3): the direct
 * RPC nonce ledger (`vsl_direct_rpc_nonces`, a name a pattern can match; a
 * pattern cannot start with `_`) and the per-object `state` table. A Dolt class
 * declares these with its own patterns through {@link doltLocalPatterns}.
 */
export const DOLT_FRAMEWORK_LOCAL_PATTERNS: readonly string[] = ["vsl_%", "state"];

/** The reserved prefixes no `doltLocal` pattern may cover. */
const RESERVED_LOCAL_PREFIXES = ["_cf_", "dolt_", "doltlite_", "sqlite_"] as const;

/**
 * Check a `doltLocal` pattern with the rules the fork applies at deploy: up to
 * 64 ASCII letters, digits and `_`, starting with a letter, `%` standing for any
 * run of characters, case-sensitive, and nothing that could cover a table
 * celld or Dolt owns. The fork is authoritative; this catches a bad
 * declaration before the deploy does. Returns the reason, or `null`.
 */
export function doltLocalPatternProblem(pattern: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_%]{0,63}$/u.test(pattern)) {
    return "a pattern is up to 64 ASCII letters, digits, `_` and `%`, starting with a letter";
  }
  const percent = pattern.indexOf("%");
  const literal = percent === -1 ? pattern : pattern.slice(0, percent);
  for (const reserved of RESERVED_LOCAL_PREFIXES) {
    const covers =
      percent === -1
        ? pattern.startsWith(reserved)
        : reserved.startsWith(literal) || literal.startsWith(reserved);
    if (covers) return `a pattern may not cover tables named ${reserved}*`;
  }
  return null;
}

/** Validate and merge a class's patterns with the framework's. */
export function doltLocalPatterns(classPatterns: readonly string[] = []): string[] {
  const all = [...new Set([...DOLT_FRAMEWORK_LOCAL_PATTERNS, ...classPatterns])];
  for (const pattern of all) {
    const problem = doltLocalPatternProblem(pattern);
    if (problem)
      throw new Error(`invalid doltLocal pattern ${JSON.stringify(pattern)}: ${problem}`);
  }
  return all;
}

/** The per-class `celld` block of a deployment config. */
export interface CelldDoltClassConfig {
  readonly doltLocal?: readonly string[];
  readonly doltRemotes?: boolean;
  readonly residency?: boolean;
  readonly codegen?: boolean;
}

/** The `celld` startup options of a facet. */
export interface CelldFacetStorageOptions {
  readonly storage: "dolt" | "sqlite";
  readonly doltLocal?: readonly string[];
}

/** Whether a table name matches a `doltLocal` pattern (`%` is any run, case-sensitive). */
export function matchesDoltLocalPattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replaceAll("%", ".*");
  return new RegExp(`^${escaped}$`, "u").test(name);
}
