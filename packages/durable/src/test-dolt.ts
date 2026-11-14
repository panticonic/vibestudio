/**
 * `FakeDoltStorage`: an in-memory test double for celld's `ctx.storage` on a
 * Dolt cell, built on `sql.js`. It is faithful enough for unit tests of
 * classes that commit, branch, merge, keep local tables, and move commits
 * between cells. It is not the engine. Read "Where it diverges" before relying
 * on a behavior the fork's tests have not shown.
 *
 * Model. Every commit holds a full snapshot of the versioned tables (schema,
 * indexes, rows). The checked-out branch's working set is the live `sql.js`
 * database; other branches keep a saved working snapshot, as Dolt keeps one
 * working set per branch. Local tables (`doltLocal` patterns), celld's `_cf_*`
 * tables and the Dolt system tables are never snapshotted: they survive
 * `reset` and `merge`, move with `checkout` untouched, and are emptied in a
 * fork (F4). Merge is a real three-way merge by primary key, cell by cell,
 * with the F1 resolver (conflicts, `UNIQUE` index violations, one 2-parent
 * commit, everything rolled back on a throw). `transactionSync(fn, { commit })`
 * commits at the end of the outermost transaction (F2). Remotes (F7) speak a
 * byte wire (JSON), so a custom `transport` and `remote.serve` work as they do
 * on celld; grants, fast-forward-only pushes and the error codes follow
 * `docs/services/dolt-remotes.md`.
 *
 * What it reproduces from the real fork (found by probe on `fcc7268`):
 * - Every Dolt operation throws inside `transaction()` and `transactionSync()`.
 * - `{ commit }` is only for the outermost transaction.
 * - `reset` is soft unless `hard: true`.
 * - `sqlite_master` lists `dolt_ignore` and `_cf_*` tables, and **re-renders a
 *   table's `sql` text once the creating transaction ends** (`notes (id` becomes
 *   `notes(id`, `CHECK (` becomes `CHECK(`). Code that fingerprints
 *   `sqlite_master.sql` must ignore that spacing (`renderSchemaText: false`
 *   turns the re-rendering off).
 * - A table named `dolt_*` or `doltlite_*` cannot be created.
 *
 * Also by design: `log()` lists newest first with children before parents (git's
 * `--date-order`), so a commit with a pinned old `date` still follows its children.
 *
 * Where it diverges from the engine (each is a gap a test cannot see):
 * - **No durability, replication or output gate.** `restart()` keeps committed
 *   and autocommitted state, and loses only an open transaction. It cannot show
 *   the fork gap that an acknowledged `reset({ hard: true })` is lost by a
 *   SIGKILL (see `doltDurableCelld.test.ts`).
 * - **Only these system reads exist:** `dolt_at_<t>('<literal ref>')` (a string
 *   literal, no binding), `dolt_log`, `dolt_branches`, `dolt_status`,
 *   `dolt_hashof(ref)`, `dolt_merge_base(a, b)`, `active_branch()`,
 *   `dolt_version()`. `dolt_history_*`, `dolt_diff_*`, `dolt_blame_*`,
 *   `dolt_conflicts_*`, `dolt_diff_summary` and the rest throw
 *   `FakeDoltUnsupportedError` instead of returning nothing. A resolver
 *   receives conflicts as objects (`merge.conflicts`), as on celld.
 * - **Violations:** only `CREATE UNIQUE INDEX` violations are detected. An
 *   inline `UNIQUE` or a foreign key or `CHECK` violated by a merge makes the
 *   merge throw a plain error. Triggers and views are carried with the
 *   snapshot; their behavior during a merge is not modeled.
 * - **Merge:** a table with no primary key is matched by all its columns
 *   (set semantics). Schema changes: one side's change is taken, both sides'
 *   different changes make the merge fail (as celld's row resolver cannot
 *   resolve a schema conflict). Plain `merge` reports `conflicts` as a count
 *   per table; celld's exact value is not documented.
 * - **Hashes** are 32 characters of Dolt's base32 alphabet derived from the
 *   commit's content, not Dolt's. Commit dates come from `now()` and are
 *   bumped to stay strictly increasing. The committer defaults to
 *   `Fake <fake@example.com>`.
 * - **Values:** `query()` returns every integral number as a `bigint` (sql.js
 *   does not keep INTEGER versus REAL), where celld keeps the storage class.
 *   `execute()` is not implemented and throws.
 * - **`status()`** reports `staged: 0` and statuses `new table`, `modified`,
 *   `deleted`, for application tables only. A fork or a restore never copies
 *   `_cf_KV`; there is no key-value API, alarm or `deleteAll()`.
 * - **Remotes:** the built-in carrier reaches any `FakeDoltStorage` registered
 *   on the same `FakeDoltNetwork` (celld's reaches root cells only; pass a
 *   `transport` to test the facet relay). There is no pack size limit and a
 *   pack carries whole snapshots. There is no `p2p`.
 * - **A resolver that returns a promise** is detected only by a `then` method.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "sql.js";
import {
  doltLocalPatternProblem,
  isDoltSystemTable,
  matchesDoltLocalPattern,
  type DoltBranchInfo,
  type DoltCommitMessage,
  type DoltCommitOptions,
  type DoltDiffOptions,
  type DoltDiffResult,
  type DoltDiffSummaryEntry,
  type DoltFetchOptions,
  type DoltFetchResult,
  type DoltGrant,
  type DoltGrantInfo,
  type DoltGrantOptions,
  type DoltLogEntry,
  type DoltMergeConflictRow,
  type DoltMergeOptions,
  type DoltMergeSession,
  type DoltMergeViolationRow,
  type DoltPatchEntry,
  type DoltPlainMergeResult,
  type DoltPullOptions,
  type DoltPullResult,
  type DoltPushOptions,
  type DoltPushResult,
  type DoltQueryResult,
  type DoltRemoteApi,
  type DoltRemoteBranch,
  type DoltRemoteInfo,
  type DoltRemoteStorage,
  type DoltRemoteTarget,
  type DoltResetOptions,
  type DoltResolvingMergeResult,
  type DoltRow,
  type DoltRowChange,
  type DoltSqlValue,
  type DoltStatusEntry,
  type DoltStorage,
  type DoltTransactionCommit,
  type DoltTransactionOptions,
} from "./dolt.js";
import { createSqlProxy, getSqlJs } from "./test-utils.js";

// --- Errors ---------------------------------------------------------------------

/** A feature the double does not model. Thrown rather than answered wrongly. */
export class FakeDoltUnsupportedError extends Error {
  constructor(what: string) {
    super(`FakeDoltStorage does not model ${what}`);
    this.name = "FakeDoltUnsupportedError";
  }
}

/** An error carrying one of celld's stable `code` values. */
export class FakeDoltError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "FakeDoltError";
  }
}

// --- Snapshots ------------------------------------------------------------------

type Cell = string | number | Uint8Array | null;
type PlainRow = Record<string, Cell>;

interface TableSnapshot {
  readonly name: string;
  readonly createSql: string;
  readonly columns: readonly string[];
  readonly pk: readonly string[];
  readonly rows: readonly PlainRow[];
  readonly indexes: readonly string[];
}

interface Snapshot {
  readonly tables: ReadonlyMap<string, TableSnapshot>;
  /** Triggers and views, in creation order. */
  readonly objects: readonly string[];
}

const EMPTY_SNAPSHOT: Snapshot = { tables: new Map(), objects: [] };

interface CommitRecord {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly committer: string;
  readonly email: string;
  readonly dateMs: number;
  readonly seq: number;
  readonly snapshot: Snapshot;
}

interface BranchRecord {
  head: string;
  /** The saved working set of a branch that is not checked out. */
  working: Snapshot | null;
}

interface GrantRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly label: string | null;
  readonly fetch: boolean;
  readonly push: readonly string[];
  readonly branches: readonly string[];
  readonly peer: string | null;
  readonly expiresAt: number | null;
  revoked: boolean;
}

function cellEquals(left: Cell | undefined, right: Cell | undefined): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
  }
  return left === right;
}

function rowEquals(
  columns: readonly string[],
  left: PlainRow | undefined,
  right: PlainRow | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return columns.every((column) => cellEquals(left[column] ?? null, right[column] ?? null));
}

function cellJson(value: Cell): unknown {
  return value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("hex") } : value;
}

function tableDigest(table: TableSnapshot): string {
  return JSON.stringify([
    table.createSql,
    table.indexes,
    table.rows.map((row) => table.columns.map((column) => cellJson(row[column] ?? null))),
  ]);
}

function snapshotDigest(snapshot: Snapshot): string {
  return JSON.stringify([
    [...snapshot.tables.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, t]) => tableDigest(t)),
    snapshot.objects,
  ]);
}

const DOLT_BASE32 = "0123456789abcdefghijklmnopqrstuv";

function doltHash(...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest().subarray(0, 20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += DOLT_BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 32);
}

function sqlLiteral(value: Cell | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  return `'${value.replaceAll("'", "''")}'`;
}

const quote = (name: string): string => `\`${name.replaceAll("`", "``")}\``;
const dq = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function patternMatches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(name);
}

// --- Wire (F7) ---------------------------------------------------------------------

interface WireSnapshot {
  tables: TableSnapshot[];
  objects: string[];
}

interface WireCommit {
  hash: string;
  parents: string[];
  message: string;
  committer: string;
  email: string;
  dateMs: number;
  seq: number;
  snapshot: WireSnapshot;
}

interface WireRequest {
  op: "refs" | "fetch" | "push";
  token: string;
  peer?: string | null;
  branches?: string[];
  have?: string[];
  branch?: string;
  to?: string;
  tip?: string;
  commits?: WireCommit[];
}

interface WireResponse {
  ok: boolean;
  code?: string;
  message?: string;
  branches?: Record<string, string>;
  known?: string[];
  commits?: WireCommit[];
  result?: DoltPushResult;
}

function encodeWire(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(value, (_key, item: unknown) =>
      item instanceof Uint8Array ? { $bytes: Buffer.from(item).toString("hex") } : item
    )
  );
}

function decodeWire<T>(bytes: Uint8Array | ArrayBuffer): T {
  const text = new TextDecoder().decode(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  );
  return JSON.parse(text, (_key, item: unknown) => {
    if (item && typeof item === "object" && "$bytes" in item) {
      return new Uint8Array(Buffer.from(String((item as { $bytes: string }).$bytes), "hex"));
    }
    return item;
  }) as T;
}

function toWireCommit(commit: CommitRecord): WireCommit {
  return {
    hash: commit.hash,
    parents: [...commit.parents],
    message: commit.message,
    committer: commit.committer,
    email: commit.email,
    dateMs: commit.dateMs,
    seq: commit.seq,
    snapshot: {
      tables: [...commit.snapshot.tables.values()],
      objects: [...commit.snapshot.objects],
    },
  };
}

function fromWireCommit(wire: WireCommit): CommitRecord {
  return {
    hash: wire.hash,
    parents: wire.parents,
    message: wire.message,
    committer: wire.committer,
    email: wire.email,
    dateMs: wire.dateMs,
    seq: wire.seq,
    snapshot: {
      tables: new Map(wire.snapshot.tables.map((table) => [table.name, table])),
      objects: wire.snapshot.objects,
    },
  };
}

/** Cells that reach each other by `"Class:<id>"`; the built-in carrier of the double. */
export class FakeDoltNetwork {
  readonly #cells = new Map<string, FakeDoltStorage>();

  register(storage: FakeDoltStorage): void {
    this.#cells.set(storage.id, storage);
  }

  resolve(ref: string): FakeDoltStorage | undefined {
    return this.#cells.get(ref);
  }
}

// --- Options ---------------------------------------------------------------------

export interface FakeDoltOptions {
  /** `"Class:<id>"` of this cell on the network. Default: a random id. */
  readonly id?: string;
  /** `doltLocal` patterns, validated as celld does at deploy. */
  readonly doltLocal?: readonly string[];
  /** Whether the class declared `doltRemotes` (default `true`). */
  readonly remotes?: boolean;
  readonly network?: FakeDoltNetwork;
  /** The clock for commit dates and grant expiry. */
  readonly now?: () => number;
  /** Re-render `sqlite_master.sql` after a transaction, as the engine does (default `true`). */
  readonly renderSchemaText?: boolean;
}

/** The durable state of a double: what `restart()` keeps. Opaque. */
export interface FakeDoltState {
  readonly id: string;
  readonly options: FakeDoltOptions;
  readonly db: Uint8Array;
  readonly commits: ReadonlyMap<string, CommitRecord>;
  readonly branches: ReadonlyMap<string, BranchRecord>;
  readonly current: string;
  readonly remotes: ReadonlyMap<string, { ref: string; token: string }>;
  readonly remoteBranches: ReadonlyMap<string, string>;
  readonly grants: ReadonlyMap<string, GrantRecord>;
  readonly lastMs: number;
  readonly seq: number;
}

interface ConflictRecord {
  readonly table: string;
  readonly key: PlainRow;
  readonly base: PlainRow | null;
  readonly ours: PlainRow | null;
  readonly theirs: PlainRow | null;
  readonly ourChange: DoltRowChange;
  readonly theirChange: DoltRowChange;
}

interface DeferredIndex {
  readonly table: string;
  readonly name: string;
  readonly sql: string;
}

const DDL = /^\s*(CREATE|ALTER|DROP)\b/iu;
const RESERVED_CREATE =
  /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(dolt_|doltlite_)/iu;
const UNSUPPORTED_READ =
  /\b(dolt_(?:history|diff|blame|conflicts|constraint_violations)_\w+|dolt_diff_summary|dolt_diff\b|dolt_patch|dolt_commit_ancestors|dolt_schema_conflicts|dolt_conflicts\b)/iu;

/** `ctx.storage` of a Dolt cell, in memory. See the file header for what it models. */
export class FakeDoltStorage {
  readonly id: string;
  readonly sql: {
    exec(
      query: string,
      ...bindings: unknown[]
    ): ReturnType<ReturnType<typeof createSqlProxy>["exec"]>;
  };
  /** `ctx.storage.dolt`; a {@link DoltRemoteStorage} unless `remotes: false`. */
  readonly dolt: DoltStorage | DoltRemoteStorage;

  #db: Database;
  #proxy: ReturnType<typeof createSqlProxy>;
  readonly #options: FakeDoltOptions;
  readonly #localPatterns: readonly string[];
  readonly #network: FakeDoltNetwork;
  readonly #now: () => number;
  #commits: Map<string, CommitRecord>;
  #branches: Map<string, BranchRecord>;
  #current: string;
  #remotes = new Map<string, { ref: string; token: string }>();
  #remoteBranches = new Map<string, string>();
  #grants = new Map<string, GrantRecord>();
  #txDepth = 0;
  #serial = 0;
  #lastMs = 0;
  #seq = 0;
  #atSerial = 0;
  #alarm: number | null = null;
  readonly #settled = new Set<string>();

  /** Create an empty Dolt cell: one `main` branch with the initial commit. */
  static async create(options: FakeDoltOptions = {}): Promise<FakeDoltStorage> {
    const SQL = await getSqlJs();
    return new FakeDoltStorage(new SQL.Database(), options, null);
  }

  /** A new process over the durable state of an earlier one (see `restart()`). */
  static async fromState(state: FakeDoltState): Promise<FakeDoltStorage> {
    const SQL = await getSqlJs();
    return new FakeDoltStorage(new SQL.Database(state.db), state.options, state);
  }

  private constructor(db: Database, options: FakeDoltOptions, state: FakeDoltState | null) {
    this.#db = db;
    this.#options = options;
    this.id = state?.id ?? options.id ?? `FakeDolt:${randomBytes(6).toString("hex")}`;
    this.#network = options.network ?? new FakeDoltNetwork();
    this.#now = options.now ?? Date.now;
    for (const pattern of options.doltLocal ?? []) {
      const problem = doltLocalPatternProblem(pattern);
      if (problem)
        throw new Error(`invalid doltLocal pattern ${JSON.stringify(pattern)}: ${problem}`);
    }
    this.#localPatterns = options.doltLocal ?? [];
    this.#proxy = createSqlProxy(db);
    this.sql = { exec: (query, ...bindings) => this.#execSql(query, bindings) };
    this.#registerFunctions();

    if (state) {
      this.#commits = new Map(state.commits);
      this.#branches = new Map([...state.branches].map(([n, b]) => [n, { ...b }]));
      this.#current = state.current;
      this.#remotes = new Map(state.remotes);
      this.#remoteBranches = new Map(state.remoteBranches);
      this.#grants = new Map([...state.grants].map(([i, g]) => [i, { ...g }]));
      this.#lastMs = state.lastMs;
      this.#seq = state.seq;
    } else {
      // celld's own tables and Dolt's ignore rules share the database.
      db.run("CREATE TABLE _cf_KV(scope TEXT, k TEXT, v TEXT, PRIMARY KEY(scope,k))");
      db.run("CREATE TABLE _cf_DOLT(k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      db.run(
        "CREATE TABLE dolt_ignore(pattern TEXT NOT NULL, ignored TINYINT NOT NULL, PRIMARY KEY(pattern))"
      );
      for (const pattern of ["_cf_%", ...this.#localPatterns]) {
        db.run("INSERT INTO dolt_ignore(pattern, ignored) VALUES (?, 1)", [pattern]);
      }
      const genesis: CommitRecord = {
        hash: doltHash("genesis", this.id),
        parents: [],
        message: `Initialize data repository (${doltHash("repo", this.id)})`,
        committer: "Fake",
        email: "fake@example.com",
        dateMs: this.#tick(),
        seq: this.#seq++,
        snapshot: EMPTY_SNAPSHOT,
      };
      this.#commits = new Map([[genesis.hash, genesis]]);
      this.#branches = new Map([["main", { head: genesis.hash, working: null }]]);
      this.#current = "main";
    }
    // What a process restart reopens has been through the engine already.
    if (state) this.#renderSchema();
    this.#network.register(this);
    this.dolt = this.#buildDolt();
  }

  // --- The storage a DurableObjectContext carries -----------------------------------

  /** `ctx.storage`: `sql`, `dolt`, both transaction forms and a minimal alarm. */
  get storage(): {
    sql: FakeDoltStorage["sql"];
    dolt: DoltStorage | DoltRemoteStorage;
    transactionSync<T>(callback: () => T, options?: DoltTransactionOptions<T>): T;
    transaction<T>(callback: () => Promise<T>, options?: DoltTransactionOptions<T>): Promise<T>;
    beginTransactionSync(): { commit(): void; rollback(): void };
    setAlarm(time: number | Date): void;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): void;
  } {
    return {
      sql: this.sql,
      dolt: this.dolt,
      transactionSync: (callback, options) => this.transactionSync(callback, options),
      transaction: (callback, options) => this.transaction(callback, options),
      beginTransactionSync: () => this.beginTransactionSync(),
      setAlarm: (time) => {
        this.#alarm = typeof time === "number" ? time : time.getTime();
      },
      getAlarm: async () => this.#alarm,
      deleteAlarm: () => {
        this.#alarm = null;
      },
    };
  }

  // --- Transactions (F2) --------------------------------------------------------------

  transactionSync<T>(callback: () => T, options?: DoltTransactionOptions<T>): T {
    const commit = this.#commitOption(options, "transactionSync");
    const savepoint = this.#begin();
    try {
      const value = callback();
      if (commit !== null) this.#commitInTransaction(commit, value);
      this.#end(savepoint, true);
      return value;
    } catch (error) {
      this.#end(savepoint, false);
      throw error;
    }
  }

  async transaction<T>(
    callback: () => Promise<T>,
    options?: DoltTransactionOptions<T>
  ): Promise<T> {
    const commit = this.#commitOption(options, "transaction");
    const savepoint = this.#begin();
    try {
      const value = await callback();
      if (commit !== null) this.#commitInTransaction(commit, value);
      this.#end(savepoint, true);
      return value;
    } catch (error) {
      this.#end(savepoint, false);
      throw error;
    }
  }

  /** `transactionSync()` without the callback, for adapters that receive BEGIN and COMMIT apart. */
  beginTransactionSync(): { commit(): void; rollback(): void } {
    const savepoint = this.#begin();
    let closed = false;
    return {
      commit: () => {
        if (closed) throw new Error("the transaction handle is closed");
        closed = true;
        this.#end(savepoint, true);
      },
      rollback: () => {
        if (closed) throw new Error("the transaction handle is closed");
        closed = true;
        this.#end(savepoint, false);
      },
    };
  }

  #begin(): string {
    const savepoint = `fake_tx_${++this.#serial}`;
    this.#db.run(`SAVEPOINT ${savepoint}`);
    this.#txDepth++;
    return savepoint;
  }

  #end(savepoint: string, commit: boolean): void {
    try {
      if (!commit) this.#db.run(`ROLLBACK TO ${savepoint}`);
      this.#db.run(`RELEASE ${savepoint}`);
    } finally {
      this.#txDepth--;
    }
    if (this.#txDepth === 0) this.#renderSchema();
  }

  #commitOption<T>(
    options: DoltTransactionOptions<T> | undefined,
    what: string
  ): DoltTransactionCommit<T> | null {
    if (options === undefined || options === null) return null;
    for (const key of Object.keys(options)) {
      if (key !== "commit")
        throw new TypeError(`${what} options has no \`${key}\`; the option is \`commit\`.`);
    }
    const spec = options.commit;
    if (spec === undefined || spec === null || spec === false) return null;
    if (this.#txDepth > 0) {
      throw new Error(
        `${what}: { commit } is only for the outermost transaction; a nested transaction is a savepoint and a Dolt commit cannot be undone by one.`
      );
    }
    return spec;
  }

  #commitInTransaction<T>(spec: DoltTransactionCommit<T>, value: T): void {
    const resolved = typeof spec === "function" ? spec(value) : spec;
    if (resolved === null || resolved === undefined || resolved === false) return;
    const options: DoltCommitOptions =
      typeof resolved === "string" ? { message: resolved } : resolved;
    if (!options.message) throw new TypeError("transaction commit needs a non-empty message.");
    this.#makeCommit(options);
  }

  #assertNoTransaction(operation: string): void {
    if (this.#txDepth > 0) {
      throw new Error(
        `ctx.storage.dolt cannot run inside a storage transaction (dolt.${operation})`
      );
    }
  }

  // --- Durable state, forks ---------------------------------------------------------------

  /** What a process restart keeps: everything committed or autocommitted. */
  exportState(): FakeDoltState {
    this.#assertNoTransaction("exportState");
    return {
      id: this.id,
      options: { ...this.#options, network: this.#network },
      db: this.#db.export(),
      commits: new Map(this.#commits),
      branches: new Map([...this.#branches].map(([n, b]) => [n, { ...b }])),
      current: this.#current,
      remotes: new Map(this.#remotes),
      remoteBranches: new Map(this.#remoteBranches),
      grants: new Map([...this.#grants].map(([i, g]) => [i, { ...g }])),
      lastMs: this.#lastMs,
      seq: this.#seq,
    };
  }

  /** A new instance over this one's durable state, as after a process restart. */
  async restart(): Promise<FakeDoltStorage> {
    return FakeDoltStorage.fromState(this.exportState());
  }

  /**
   * `env.NS.fork(id, { at })`: a new object with every branch and its history,
   * the checked-out branch reset to `at`. Local tables keep their schema and
   * start empty; remotes, grants and remote-tracking branches are cleared (a
   * fork does not inherit authority); `_cf_*` bookkeeping starts fresh.
   */
  async fork(
    options: { readonly at?: string; readonly id?: string } = {}
  ): Promise<FakeDoltStorage> {
    this.#assertNoTransaction("fork");
    const state = this.exportState();
    const fork = await FakeDoltStorage.fromState({
      ...state,
      id: options.id ?? `${this.id.split(":")[0]}:${randomBytes(6).toString("hex")}`,
      remotes: new Map(),
      remoteBranches: new Map(),
      grants: new Map(),
    });
    for (const table of fork.#tableNames()) {
      if (fork.#isLocal(table)) fork.#db.run(`DELETE FROM ${dq(table)}`);
    }
    fork.#db.run("DELETE FROM _cf_KV");
    if (options.at !== undefined) {
      const hash = fork.#resolve(options.at);
      const branch = fork.#branches.get(fork.#current);
      if (branch) {
        branch.head = hash;
        branch.working = null;
      }
      fork.#loadSnapshot(fork.#snapshotOf(hash));
    }
    return fork;
  }

  // --- SQL ---------------------------------------------------------------------------------

  #execSql(
    query: string,
    bindings: unknown[]
  ): ReturnType<ReturnType<typeof createSqlProxy>["exec"]> {
    if (RESERVED_CREATE.test(query)) {
      throw new Error("table names beginning dolt_ or doltlite_ cannot be created");
    }
    if (UNSUPPORTED_READ.test(query)) {
      const match = UNSUPPORTED_READ.exec(query);
      throw new FakeDoltUnsupportedError(
        `${match?.[0] ?? "that Dolt system table"} (see the file header)`
      );
    }
    const rewritten = this.#rewriteSystemReads(query);
    const result = this.#proxy.exec(rewritten, ...bindings);
    if (DDL.test(query)) {
      const present = new Set(
        this.#all("SELECT name FROM main.sqlite_master").map((row) => String(row["name"]))
      );
      for (const name of this.#settled) if (!present.has(name)) this.#settled.delete(name);
      if (this.#txDepth === 0) this.#renderSchema();
    }
    return result;
  }

  #registerFunctions(): void {
    this.#db.create_function("dolt_hashof", (ref: unknown) => this.#resolve(String(ref)));
    this.#db.create_function("dolt_merge_base", (left: unknown, right: unknown) =>
      this.#mergeBase(this.#resolve(String(left)), this.#resolve(String(right)))
    );
    this.#db.create_function("active_branch", () => this.#current);
    this.#db.create_function("dolt_version", () => "fake-doltlite");
    this.#db.create_function("fake_dolt_render", (name: unknown, sql: unknown) =>
      typeof sql === "string" && this.#settled.has(String(name)) ? this.#renderText(sql) : sql
    );
    this.#db.run(
      "CREATE TEMP VIEW fake_dolt_master AS SELECT type, name, tbl_name, rootpage, " +
        "fake_dolt_render(name, sql) AS sql FROM main.sqlite_master"
    );
  }

  #rewriteSystemReads(query: string): string {
    let rewritten = query;
    if (/\bdolt_log\b/iu.test(rewritten)) {
      this.#db.run("DROP TABLE IF EXISTS temp.dolt_log");
      this.#db.run("CREATE TEMP TABLE dolt_log(commit_hash, committer, email, date, message)");
      for (const entry of this.#logEntries(10_000)) {
        this.#db.run("INSERT INTO temp.dolt_log VALUES (?, ?, ?, ?, ?)", [
          entry.hash,
          entry.committer,
          entry.email,
          entry.date,
          entry.message,
        ]);
      }
    }
    if (/\bdolt_branches\b/iu.test(rewritten)) {
      this.#db.run("DROP TABLE IF EXISTS temp.dolt_branches");
      this.#db.run(
        "CREATE TEMP TABLE dolt_branches(name, hash, latest_committer, latest_commit_date, latest_commit_message)"
      );
      for (const branch of this.#branchInfos()) {
        this.#db.run("INSERT INTO temp.dolt_branches VALUES (?, ?, ?, ?, ?)", [
          branch.name,
          branch.hash,
          branch.committer,
          branch.date,
          branch.message,
        ]);
      }
    }
    if (/\bdolt_status\b/iu.test(rewritten)) {
      this.#db.run("DROP TABLE IF EXISTS temp.dolt_status");
      this.#db.run("CREATE TEMP TABLE dolt_status(table_name, staged, status)");
      for (const entry of this.#workingChanges()) {
        this.#db.run("INSERT INTO temp.dolt_status VALUES (?, ?, ?)", [
          entry.table,
          0,
          entry.status,
        ]);
      }
    }
    rewritten = rewritten.replace(/\bsqlite_(?:master|schema)\b/giu, "temp.fake_dolt_master");
    rewritten = rewritten.replace(
      /\bdolt_at_([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*'([^']*)'\s*\)/giu,
      (_match, table: string, ref: string) => this.#materializeAt(table, ref)
    );
    return rewritten;
  }

  #materializeAt(table: string, ref: string): string {
    const snapshot = this.#snapshotOf(this.#resolve(ref));
    const found = snapshot.tables.get(table);
    if (!found) throw new Error(`table not found: ${table} as of ${ref}`);
    const name = `__dolt_at_${table}_${++this.#atSerial}`;
    this.#db.run(`CREATE TEMP TABLE ${dq(name)}(${found.columns.map(dq).join(", ")})`);
    for (const row of found.rows) {
      this.#db.run(
        `INSERT INTO temp.${dq(name)} VALUES (${found.columns.map(() => "?").join(", ")})`,
        found.columns.map((column) => row[column] ?? null) as never
      );
    }
    return `temp.${dq(name)}`;
  }

  /**
   * The engine re-renders a schema object's text once the transaction that
   * created it ends. The double keeps the text as typed in the database and
   * serves the rendered form on reads of `sqlite_master` for every object that
   * has been through the end of a transaction ("settled"); snapshots always
   * hold the rendered form.
   */
  #renderSchema(): void {
    if (this.#options.renderSchemaText === false) return;
    for (const row of this.#all("SELECT name FROM main.sqlite_master WHERE sql IS NOT NULL")) {
      this.#settled.add(String(row["name"]));
    }
  }

  #renderText(sql: string): string {
    return this.#options.renderSchemaText === false ? sql : sql.replace(/\s+\(/gu, "(");
  }

  #all(query: string, params: unknown[] = []): Record<string, unknown>[] {
    const statement = this.#db.prepare(query);
    try {
      if (params.length > 0) statement.bind(params as never);
      const rows: Record<string, unknown>[] = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  // --- Snapshots of the live database ------------------------------------------------------------

  #isLocal(name: string): boolean {
    return this.#localPatterns.some((pattern) => matchesDoltLocalPattern(name, pattern));
  }

  #tableNames(): string[] {
    return this.#all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
      (row) => String(row["name"])
    );
  }

  #isVersioned(name: string): boolean {
    return !isDoltSystemTable(name) && !this.#isLocal(name);
  }

  #capture(): Snapshot {
    const master = this.#all(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid"
    );
    const tables = new Map<string, TableSnapshot>();
    for (const row of master) {
      if (row["type"] !== "table") continue;
      const name = String(row["name"]);
      if (!this.#isVersioned(name)) continue;
      const info = this.#all(`PRAGMA table_info(${dq(name)})`);
      const columns = info.map((column) => String(column["name"]));
      const pk = info
        .filter((column) => Number(column["pk"]) > 0)
        .sort((left, right) => Number(left["pk"]) - Number(right["pk"]))
        .map((column) => String(column["name"]));
      const rows = this.#all(`SELECT * FROM ${dq(name)}`) as PlainRow[];
      const indexes = master
        .filter((entry) => entry["type"] === "index" && entry["tbl_name"] === name)
        .map((entry) => this.#renderText(String(entry["sql"])));
      tables.set(name, {
        name,
        createSql: this.#renderText(String(row["sql"])),
        columns,
        pk,
        rows,
        indexes,
      });
    }
    const objects = master
      .filter(
        (entry) =>
          (entry["type"] === "trigger" || entry["type"] === "view") &&
          !isDoltSystemTable(String(entry["name"])) &&
          !isDoltSystemTable(String(entry["tbl_name"]))
      )
      .map((entry) => this.#renderText(String(entry["sql"])));
    return { tables, objects };
  }

  /** Replace the versioned tables of the live database with `snapshot`. Local tables are untouched. */
  #loadSnapshot(snapshot: Snapshot, deferUnique = false): DeferredIndex[] {
    for (const row of this.#all(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE sql IS NOT NULL"
    )) {
      const name = String(row["name"]);
      if (isDoltSystemTable(name)) continue;
      if (row["type"] === "view") this.#db.run(`DROP VIEW IF EXISTS ${dq(name)}`);
      else if (row["type"] === "trigger") this.#db.run(`DROP TRIGGER IF EXISTS ${dq(name)}`);
    }
    for (const name of this.#tableNames()) {
      if (this.#isVersioned(name)) this.#db.run(`DROP TABLE ${dq(name)}`);
    }
    const deferred: DeferredIndex[] = [];
    for (const table of snapshot.tables.values()) {
      this.#db.run(table.createSql);
      const columns = table.columns.map(dq).join(", ");
      const marks = table.columns.map(() => "?").join(", ");
      for (const row of table.rows) {
        this.#db.run(
          `INSERT INTO ${dq(table.name)} (${columns}) VALUES (${marks})`,
          table.columns.map((column) => row[column] ?? null) as never
        );
      }
      for (const index of table.indexes) {
        if (deferUnique && /^\s*CREATE\s+UNIQUE/iu.test(index)) {
          try {
            this.#db.run(index);
          } catch {
            const name =
              /INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([^\s"`\]()]+)/iu.exec(index)?.[1] ?? index;
            deferred.push({ table: table.name, name, sql: index });
          }
        } else {
          this.#db.run(index);
        }
      }
    }
    for (const object of snapshot.objects) this.#db.run(object);
    this.#renderSchema();
    return deferred;
  }

  #snapshotOf(hash: string): Snapshot {
    const commit = this.#commits.get(hash);
    if (!commit) throw new Error(`unknown commit ${hash}`);
    return commit.snapshot;
  }

  #head(): CommitRecord {
    const branch = this.#branches.get(this.#current);
    const commit = branch && this.#commits.get(branch.head);
    if (!commit) throw new Error("the checked-out branch has no head");
    return commit;
  }

  #workingChanges(): DoltStatusEntry[] {
    const head = this.#head().snapshot;
    const work = this.#capture();
    const entries: DoltStatusEntry[] = [];
    for (const name of new Set([...head.tables.keys(), ...work.tables.keys()])) {
      const before = head.tables.get(name);
      const after = work.tables.get(name);
      if (!before && after) entries.push({ table: name, staged: 0, status: "new table" });
      else if (before && !after) entries.push({ table: name, staged: 0, status: "deleted" });
      else if (before && after && tableDigest(before) !== tableDigest(after)) {
        entries.push({ table: name, staged: 0, status: "modified" });
      }
    }
    if (
      snapshotDigest({ tables: new Map(), objects: head.objects }) !==
      snapshotDigest({ tables: new Map(), objects: work.objects })
    ) {
      entries.push({ table: "(triggers and views)", staged: 0, status: "modified" });
    }
    return entries.sort((a, b) => a.table.localeCompare(b.table));
  }

  // --- Refs and history ------------------------------------------------------------------------------

  #tick(): number {
    const now = this.#now();
    this.#lastMs = Math.max(now, this.#lastMs + 1);
    return this.#lastMs;
  }

  #parents(hash: string): readonly string[] {
    return this.#commits.get(hash)?.parents ?? [];
  }

  #ancestors(hash: string): Set<string> {
    const seen = new Set<string>();
    const queue = [hash];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...this.#parents(next));
    }
    return seen;
  }

  #mergeBase(left: string, right: string): string | null {
    const leftSide = this.#ancestors(left);
    const common = [...this.#ancestors(right)].filter((hash) => leftSide.has(hash));
    const maximal = common.filter(
      (hash) => !common.some((other) => other !== hash && this.#ancestors(other).has(hash))
    );
    maximal.sort((a, b) => (this.#commits.get(b)?.seq ?? 0) - (this.#commits.get(a)?.seq ?? 0));
    return maximal[0] ?? null;
  }

  #resolve(ref: string): string {
    const tilde = /^(.*?)((?:~\d+)*)$/u.exec(ref);
    const base = tilde?.[1] ?? ref;
    const steps = [...(tilde?.[2] ?? "").matchAll(/~(\d+)/gu)].reduce(
      (sum, m) => sum + Number(m[1]),
      0
    );
    let hash: string | undefined;
    if (base === "HEAD") hash = this.#branches.get(this.#current)?.head;
    else if (this.#branches.has(base)) hash = this.#branches.get(base)?.head;
    else if (this.#remoteBranches.has(base)) hash = this.#remoteBranches.get(base);
    else if (this.#commits.has(base)) hash = base;
    else if (base.length >= 6) {
      const matches = [...this.#commits.keys()].filter((candidate) => candidate.startsWith(base));
      if (matches.length === 1) hash = matches[0];
    }
    if (!hash) throw new Error(`unknown ref ${JSON.stringify(ref)}`);
    let resolved: string = hash;
    for (let step = 0; step < steps; step++) {
      const parent: string | undefined = this.#parents(resolved)[0];
      if (!parent) throw new Error(`ref ${JSON.stringify(ref)} goes past the first commit`);
      resolved = parent;
    }
    return resolved;
  }

  /**
   * Newest first, children before parents (git's `--date-order`): a commit is
   * listed only after every commit of the history that descends from it, so a
   * commit with a pinned old `date` still follows its children.
   */
  #logEntries(limit: number): DoltLogEntry[] {
    const head = this.#branches.get(this.#current)?.head;
    if (!head) return [];
    const history = this.#ancestors(head);
    const waiting = new Map<string, number>();
    for (const hash of history) {
      for (const parent of new Set(this.#parents(hash)))
        waiting.set(parent, (waiting.get(parent) ?? 0) + 1);
    }
    const ready = [head];
    const ordered: CommitRecord[] = [];
    while (ready.length > 0 && ordered.length < limit) {
      ready.sort((a, b) => {
        const left = this.#commits.get(a)!;
        const right = this.#commits.get(b)!;
        return right.dateMs - left.dateMs || right.seq - left.seq;
      });
      const next = this.#commits.get(ready.shift()!)!;
      ordered.push(next);
      for (const parent of new Set(next.parents)) {
        const remaining = (waiting.get(parent) ?? 1) - 1;
        waiting.set(parent, remaining);
        if (remaining === 0) ready.push(parent);
      }
    }
    return ordered.map((commit) => ({
      hash: commit.hash,
      committer: commit.committer,
      email: commit.email,
      date: new Date(commit.dateMs).toISOString(),
      message: commit.message,
    }));
  }

  #branchInfos(): DoltBranchInfo[] {
    return [...this.#branches]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, branch]) => {
        const commit = this.#commits.get(branch.head)!;
        return {
          name,
          hash: branch.head,
          committer: commit.committer,
          date: new Date(commit.dateMs).toISOString(),
          message: commit.message,
        };
      });
  }

  // --- Commit ----------------------------------------------------------------------------------------

  #makeCommit(options: DoltCommitOptions, mergeParent?: string): string {
    if (!options.message) throw new Error("commit needs a non-empty message");
    let committer = "Fake";
    let email = "fake@example.com";
    if (options.author !== undefined) {
      const match = /^(.*)<(.+)>$/u.exec(options.author.trim());
      if (!match) throw new Error('author must look like "Name <email>"');
      committer = (match[1] ?? "").trim();
      email = match[2] ?? "";
    }
    const branch = this.#branches.get(this.#current)!;
    const head = this.#head();
    const snapshot = this.#capture();
    if (
      !options.allowEmpty &&
      mergeParent === undefined &&
      snapshotDigest(snapshot) === snapshotDigest(head.snapshot)
    ) {
      throw new Error("nothing to commit");
    }
    let dateMs: number;
    if (options.date !== undefined) {
      const date =
        options.date instanceof Date ? options.date.getTime() : new Date(options.date).getTime();
      if (!Number.isFinite(date)) throw new Error("date must be a string or epoch milliseconds");
      dateMs = date;
      this.#lastMs = Math.max(this.#lastMs, date);
    } else {
      dateMs = this.#tick();
    }
    const parents = mergeParent === undefined ? [head.hash] : [head.hash, mergeParent];
    const hash = doltHash(
      parents.join(","),
      options.message,
      String(dateMs),
      email,
      snapshotDigest(snapshot)
    );
    const commit: CommitRecord = {
      hash,
      parents,
      message: options.message,
      committer,
      email,
      dateMs,
      seq: this.#seq++,
      snapshot,
    };
    this.#commits.set(hash, commit);
    branch.head = hash;
    branch.working = null;
    return hash;
  }

  // --- The dolt object -------------------------------------------------------------------------------------

  #buildDolt(): DoltStorage | DoltRemoteStorage {
    const self = this;
    const branch = {
      create(name: string, options: { readonly from?: string } = {}): void {
        self.#assertNoTransaction("branchCreate");
        if (!name) throw new Error("branch name must not be empty");
        if (self.#branches.has(name))
          throw new Error(`branch ${JSON.stringify(name)} already exists`);
        const from = options.from === undefined ? self.#head().hash : self.#resolve(options.from);
        self.#branches.set(name, { head: from, working: null });
      },
      delete(name: string, options: { readonly force?: boolean } = {}): void {
        self.#assertNoTransaction("branchDelete");
        if (name === "main") throw new Error("the main branch cannot be deleted");
        if (name === self.#current)
          throw new Error(`cannot delete the checked-out branch ${JSON.stringify(name)}`);
        const target = self.#branches.get(name);
        if (!target) throw new Error(`branch not found: ${name}`);
        if (!options.force && !self.#ancestors(self.#head().hash).has(target.head)) {
          throw new Error(`branch ${JSON.stringify(name)} is not fully merged`);
        }
        self.#branches.delete(name);
      },
      list: (): DoltBranchInfo[] => self.#branchInfos(),
      current: (): string => self.#current,
    };

    const merge = (
      nameOrOptions: string | (DoltMergeOptions & { branch?: string }),
      maybe: DoltMergeOptions = {}
    ) => {
      const name = typeof nameOrOptions === "string" ? nameOrOptions : String(nameOrOptions.branch);
      const options = typeof nameOrOptions === "string" ? maybe : nameOrOptions;
      return self.#merge(name, options);
    };

    const base: DoltStorage = {
      commit: (options: DoltCommitMessage): string => {
        self.#assertNoTransaction("commit");
        return self.#makeCommit(typeof options === "string" ? { message: options } : options);
      },
      branch,
      checkout: (name: string, options: { readonly create?: boolean } = {}): string => {
        self.#assertNoTransaction("checkout");
        if (options.create) branch.create(name);
        const target = self.#branches.get(name);
        if (!target) throw new Error(`branch not found: ${name}`);
        if (name === self.#current) return name;
        const leaving = self.#branches.get(self.#current)!;
        leaving.working = self.#capture();
        self.#current = name;
        const snapshot = target.working ?? self.#snapshotOf(target.head);
        target.working = null;
        self.#loadSnapshot(snapshot);
        return name;
      },
      reset: (options: DoltResetOptions = {}): string => {
        self.#assertNoTransaction("reset");
        const hash = self.#resolve(options.to ?? "HEAD");
        const current = self.#branches.get(self.#current)!;
        current.head = hash;
        if (options.hard) {
          current.working = null;
          self.#loadSnapshot(self.#snapshotOf(hash));
        }
        return hash;
      },
      merge: merge as DoltStorage["merge"],
      log: (options: { readonly limit?: number } = {}): DoltLogEntry[] => {
        self.#assertNoTransaction("log");
        return self.#logEntries(Math.min(options.limit ?? 100, 10_000));
      },
      diff: (options: DoltDiffOptions): DoltDiffResult => {
        self.#assertNoTransaction("diff");
        return self.#diff(options);
      },
      hashOf: (ref = "HEAD"): string => {
        self.#assertNoTransaction("hashOf");
        return self.#resolve(ref);
      },
      status: (): DoltStatusEntry[] => {
        self.#assertNoTransaction("status");
        return self.#workingChanges();
      },
      gc: (): unknown => {
        self.#assertNoTransaction("gc");
        return null;
      },
      execute: (): never => {
        throw new FakeDoltUnsupportedError("dolt.execute (deterministic programs, Chronolog only)");
      },
      query: (
        sql: string,
        bindings: readonly { index?: number; name?: string; value: unknown }[] = []
      ): DoltQueryResult => {
        self.#assertNoTransaction("query");
        if (!/^\s*(SELECT|WITH)\b/iu.test(sql)) {
          throw Object.assign(new Error("dolt.query: SQL_PROFILE_VIOLATION"), {
            code: "SQL_PROFILE_VIOLATION",
          });
        }
        const statement = self.#db.prepare(self.#rewriteSystemReads(sql));
        try {
          if (bindings.length > 0) {
            statement.bind(
              bindings.map((binding) =>
                typeof binding.value === "bigint" ? Number(binding.value) : binding.value
              ) as never
            );
          }
          const columns = statement.getColumnNames();
          const rows: DoltSqlValue[][] = [];
          while (statement.step()) {
            rows.push(
              statement
                .get()
                .map((value) =>
                  typeof value === "number" && Number.isInteger(value)
                    ? BigInt(value)
                    : (value as DoltSqlValue)
                )
            );
          }
          return { columns, rows };
        } finally {
          statement.free();
        }
      },
      engineDigest: (): string => "fake-doltlite-engine",
    };

    if (this.#options.remotes === false) return base;
    return this.#withRemotes(base);
  }

  // --- Diff ---------------------------------------------------------------------------------------------------

  #diff(options: DoltDiffOptions): DoltDiffResult {
    const from = this.#snapshotOf(this.#resolve(options.from));
    const to =
      options.to === undefined ? this.#capture() : this.#snapshotOf(this.#resolve(options.to));
    const summary: DoltDiffSummaryEntry[] = [];
    const patch: DoltPatchEntry[] = [];
    const names = [...new Set([...from.tables.keys(), ...to.tables.keys()])].sort();
    for (const name of names) {
      if (options.table !== undefined && options.table !== name) continue;
      const before = from.tables.get(name);
      const after = to.tables.get(name);
      if (before && after && tableDigest(before) === tableDigest(after)) continue;
      const diffType = !before ? "added" : !after ? "removed" : "modified";
      summary.push({
        fromTable: before ? name : null,
        toTable: after ? name : null,
        diffType,
        dataChange: !before || !after || JSON.stringify(before.rows) !== JSON.stringify(after.rows),
        schemaChange: !before || !after || before.createSql !== after.createSql,
      });
      if (!after) {
        patch.push({ table: name, diffType, statement: `DROP TABLE ${quote(name)};` });
        continue;
      }
      if (!before) patch.push({ table: name, diffType, statement: `${after.createSql};` });
      const keyOf = (row: PlainRow) =>
        JSON.stringify(
          (after.pk.length > 0 ? after.pk : after.columns).map((c) => cellJson(row[c] ?? null))
        );
      const beforeRows = new Map((before?.rows ?? []).map((row) => [keyOf(row), row]));
      const afterRows = new Map(after.rows.map((row) => [keyOf(row), row]));
      const where = (row: PlainRow) =>
        (after.pk.length > 0 ? after.pk : after.columns)
          .map(
            (c) =>
              `${quote(c)}${row[c] === null || row[c] === undefined ? " IS NULL" : ` = ${sqlLiteral(row[c])}`}`
          )
          .join(" AND ");
      for (const [key, row] of beforeRows) {
        if (!afterRows.has(key)) {
          patch.push({
            table: name,
            diffType: "removed",
            statement: `DELETE FROM ${quote(name)} WHERE ${where(row)};`,
          });
        }
      }
      for (const [key, row] of afterRows) {
        const old = beforeRows.get(key);
        if (!old) {
          patch.push({
            table: name,
            diffType: "added",
            statement: `INSERT INTO ${quote(name)} (${after.columns.map(quote).join(", ")}) VALUES (${after.columns.map((c) => sqlLiteral(row[c])).join(", ")});`,
          });
        } else if (!rowEquals(after.columns, old, row)) {
          patch.push({
            table: name,
            diffType: "modified",
            statement: `UPDATE ${quote(name)} SET ${after.columns.map((c) => `${quote(c)} = ${sqlLiteral(row[c])}`).join(", ")} WHERE ${where(old)};`,
          });
        }
      }
    }
    return { summary, patch };
  }

  // --- Merge (F1) ----------------------------------------------------------------------------------------------

  #merge(name: string, options: DoltMergeOptions): DoltPlainMergeResult | DoltResolvingMergeResult {
    const resolving = options.resolve !== undefined;
    if (options.resolve !== undefined && typeof options.resolve !== "function") {
      throw new TypeError("dolt.merge: `resolve` must be a function.");
    }
    this.#assertNoTransaction("merge");
    const oursHash = this.#head().hash;
    const theirsHash = this.#resolve(name);
    const dirty = this.#workingChanges();
    if (dirty.length > 0) {
      throw new Error(
        `cannot merge with uncommitted changes (${dirty.map((entry) => entry.table).join(", ")}); commit first`
      );
    }
    const upToDate = this.#ancestors(oursHash).has(theirsHash);
    const fastForward = !upToDate && this.#ancestors(theirsHash).has(oursHash);
    if (upToDate) {
      return resolving
        ? {
            hash: oursHash,
            conflicts: [],
            fastForward: false,
            upToDate: true,
            resolved: { conflicts: 0, violations: 0 },
          }
        : { hash: oursHash, conflicts: [] };
    }
    if (fastForward && options.fastForward !== false) {
      const current = this.#branches.get(this.#current)!;
      current.head = theirsHash;
      this.#loadSnapshot(this.#snapshotOf(theirsHash));
      return resolving
        ? {
            hash: theirsHash,
            conflicts: [],
            fastForward: true,
            upToDate: false,
            resolved: { conflicts: 0, violations: 0 },
          }
        : { hash: theirsHash, conflicts: [] };
    }
    const baseHash = this.#mergeBase(oursHash, theirsHash);
    if (baseHash === null) throw new Error("no common ancestor: the histories are unrelated");

    const savepoint = `fake_merge_${++this.#serial}`;
    this.#db.run(`SAVEPOINT ${savepoint}`);
    this.#txDepth++;
    let open = true;
    const close = (keep: boolean) => {
      if (!open) return;
      open = false;
      try {
        if (!keep) this.#db.run(`ROLLBACK TO ${savepoint}`);
        this.#db.run(`RELEASE ${savepoint}`);
      } finally {
        this.#txDepth--;
      }
      this.#renderSchema();
    };
    try {
      const outcome = this.#threeWay(
        this.#snapshotOf(baseHash),
        this.#snapshotOf(oursHash),
        this.#snapshotOf(theirsHash)
      );
      if (outcome.schemaConflicts.length > 0) {
        throw new Error(
          resolving
            ? `dolt.merge: schema conflicts in ${outcome.schemaConflicts.join(", ")} cannot be resolved by a row resolver`
            : `schema conflicts in ${outcome.schemaConflicts.join(", ")}`
        );
      }
      const deferred = this.#loadSnapshot(outcome.merged, true);
      const violations = this.#violations(deferred);
      if (!resolving && (outcome.conflicts.length > 0 || violations.length > 0)) {
        const tables = new Map<string, number>();
        for (const item of [...outcome.conflicts, ...violations]) {
          tables.set(item.table, (tables.get(item.table) ?? 0) + 1);
        }
        close(false);
        return {
          hash: null,
          conflicts: [...tables].map(([table, conflicts]) => ({ table, conflicts })),
        };
      }
      let counts = { conflicts: 0, violations: 0 };
      if (options.resolve) {
        const session = this.#session(
          name,
          oursHash,
          theirsHash,
          baseHash,
          outcome.conflicts,
          violations
        );
        let returned: unknown;
        try {
          returned = options.resolve(session.view);
        } finally {
          session.close();
        }
        if (
          returned !== undefined &&
          returned !== null &&
          typeof (returned as { then?: unknown }).then === "function"
        ) {
          throw new TypeError(
            "dolt.merge: `resolve` must be synchronous; it runs inside the merge's transaction"
          );
        }
        session.assertAnswered();
        counts = {
          conflicts: session.view.conflicts.length,
          violations: session.view.violations.length,
        };
      }
      for (const index of deferred) {
        try {
          this.#db.run(index.sql);
        } catch (error) {
          throw new Error(
            `dolt.merge: the unique index ${index.name} on ${index.table} still has duplicates: ${String(error)}`
          );
        }
      }
      // The merge commit is made inside the merge's transaction, so a refused
      // message, author or date rolls the whole merge back.
      const hash = this.#makeCommit(
        {
          message: options.message || `Merge ${name}`,
          author: options.author,
          date: options.date,
          allowEmpty: true,
        },
        theirsHash
      );
      close(true);
      return resolving
        ? { hash, conflicts: [], fastForward: false, upToDate: false, resolved: counts }
        : { hash, conflicts: [] };
    } catch (error) {
      close(false);
      throw error;
    }
  }

  #session(
    branch: string,
    ours: string,
    theirs: string,
    base: string,
    conflicts: readonly ConflictRecord[],
    violations: readonly { table: string; type: string; info: unknown; row: PlainRow }[]
  ): { view: DoltMergeSession; close(): void; assertAnswered(): void } {
    let closed = false;
    const open = () => {
      if (closed)
        throw new Error("the merge's resolver has returned; its rows can no longer be answered");
    };
    const mutableConflicts = conflicts.map((conflict) => {
      const state = { resolved: false };
      const table = this.#capture().tables.get(conflict.table);
      const row: DoltMergeConflictRow = {
        table: conflict.table,
        key: conflict.key as DoltRow,
        base: conflict.base as DoltRow | null,
        ours: conflict.ours as DoltRow | null,
        theirs: conflict.theirs as DoltRow | null,
        ourChange: conflict.ourChange,
        theirChange: conflict.theirChange,
        get resolved() {
          return state.resolved;
        },
        resolve: () => {
          open();
          state.resolved = true;
        },
        keepOurs: () => {
          open();
          state.resolved = true;
        },
        takeTheirs: () => {
          open();
          const columns = table?.columns ?? Object.keys(conflict.theirs ?? conflict.ours ?? {});
          const pk = table?.pk.length ? table.pk : columns;
          if (conflict.theirs === null) {
            this.#db.run(
              `DELETE FROM ${dq(conflict.table)} WHERE ${pk.map((c) => `${dq(c)} IS ?`).join(" AND ")}`,
              pk.map((c) => conflict.key[c] ?? null) as never
            );
          } else {
            const theirs = conflict.theirs;
            this.#db.run(
              `INSERT OR REPLACE INTO ${dq(conflict.table)} (${columns.map(dq).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
              columns.map((c) => theirs[c] ?? null) as never
            );
          }
          state.resolved = true;
        },
      };
      return row;
    });
    const mutableViolations = violations.map((violation) => {
      const state = { resolved: false };
      const row: DoltMergeViolationRow = {
        table: violation.table,
        type: violation.type,
        info: violation.info,
        row: violation.row as DoltRow,
        get resolved() {
          return state.resolved;
        },
        resolve: () => {
          open();
          state.resolved = true;
        },
      };
      return row;
    });
    return {
      view: {
        branch,
        ours,
        theirs,
        base,
        conflicts: mutableConflicts,
        violations: mutableViolations,
      },
      close: () => {
        closed = true;
      },
      assertAnswered: () => {
        const unanswered =
          mutableConflicts.filter((c) => !c.resolved).length +
          mutableViolations.filter((v) => !v.resolved).length;
        if (unanswered !== 0) {
          throw new Error(
            `dolt.merge: the resolver left ${unanswered} conflicts or violations unanswered; the merge is rolled back`
          );
        }
      },
    };
  }

  /** Duplicates of the unique indexes that could not be created over the merged rows. */
  #violations(
    deferred: readonly DeferredIndex[]
  ): { table: string; type: string; info: unknown; row: PlainRow }[] {
    const found: { table: string; type: string; info: unknown; row: PlainRow }[] = [];
    for (const index of deferred) {
      const match = /ON\s+["`[]?([^\s"`\]()]+)["`\]]?\s*\(([^)]*)\)/iu.exec(index.sql);
      const columns = (match?.[2] ?? "")
        .split(",")
        .map((column) => column.replace(/\b(ASC|DESC)\b/giu, "").replace(/["`[\]\s]/gu, ""))
        .filter(Boolean);
      if (columns.length === 0) continue;
      const list = columns.map(dq).join(", ");
      const duplicates = this.#all(
        `SELECT ${list} FROM ${dq(index.table)} GROUP BY ${list} HAVING count(*) > 1`
      );
      for (const duplicate of duplicates) {
        if (columns.some((column) => duplicate[column] === null)) continue;
        const rows = this.#all(
          `SELECT * FROM ${dq(index.table)} WHERE ${columns.map((c) => `${dq(c)} = ?`).join(" AND ")}`,
          columns.map((column) => duplicate[column])
        ) as PlainRow[];
        for (const row of rows) {
          found.push({
            table: index.table,
            type: "unique index",
            info: { index: index.name, columns },
            row,
          });
        }
      }
    }
    return found;
  }

  #threeWay(
    base: Snapshot,
    ours: Snapshot,
    theirs: Snapshot
  ): { merged: Snapshot; conflicts: ConflictRecord[]; schemaConflicts: string[] } {
    const merged = new Map<string, TableSnapshot>();
    const conflicts: ConflictRecord[] = [];
    const schemaConflicts: string[] = [];
    const sameTable = (a: TableSnapshot | undefined, b: TableSnapshot | undefined): boolean =>
      a === undefined || b === undefined ? a === b : tableDigest(a) === tableDigest(b);
    const names = new Set([...base.tables.keys(), ...ours.tables.keys(), ...theirs.tables.keys()]);
    for (const name of [...names].sort()) {
      const b = base.tables.get(name);
      const o = ours.tables.get(name);
      const t = theirs.tables.get(name);
      if (sameTable(o, t)) {
        if (o) merged.set(name, o);
        continue;
      }
      if (!b) {
        if (o && !t) merged.set(name, o);
        else if (t && !o) merged.set(name, t);
        else schemaConflicts.push(name);
        continue;
      }
      if (!o || !t) {
        const survivor = o ?? t;
        if (survivor && sameTable(b, survivor)) continue; // deleted on one side, untouched on the other
        schemaConflicts.push(name);
        continue;
      }
      const oursChangedSchema = o.createSql !== b.createSql;
      const theirsChangedSchema = t.createSql !== b.createSql;
      if (oursChangedSchema && theirsChangedSchema && o.createSql !== t.createSql) {
        schemaConflicts.push(name);
        continue;
      }
      const schemaSource = theirsChangedSchema && !oursChangedSchema ? t : o;
      const columns = schemaSource.columns;
      const pk = schemaSource.pk.length > 0 ? schemaSource.pk : columns;
      const keyOf = (row: PlainRow) => JSON.stringify(pk.map((c) => cellJson(row[c] ?? null)));
      const index = (table: TableSnapshot) => new Map(table.rows.map((row) => [keyOf(row), row]));
      const bRows = index(b);
      const oRows = index(o);
      const tRows = index(t);
      const mergedRows: PlainRow[] = [];
      const keys = [...new Set([...oRows.keys(), ...tRows.keys(), ...bRows.keys()])];
      const kept = (row: PlainRow | undefined) =>
        row === undefined
          ? undefined
          : (Object.fromEntries(columns.map((c) => [c, row[c] ?? null])) as PlainRow);
      for (const key of keys) {
        const br = bRows.get(key);
        const or = oRows.get(key);
        const tr = tRows.get(key);
        let result: PlainRow | undefined;
        if (rowEquals(columns, or, tr)) result = or;
        else if (rowEquals(columns, or, br)) result = tr;
        else if (rowEquals(columns, tr, br)) result = or;
        else if (or && tr) {
          const cells: PlainRow = {};
          let clash = false;
          for (const column of columns) {
            const ov = or[column] ?? null;
            const tv = tr[column] ?? null;
            const bv = br === undefined ? undefined : (br[column] ?? null);
            if (cellEquals(ov, tv)) cells[column] = ov;
            else if (bv !== undefined && cellEquals(ov, bv)) cells[column] = tv;
            else if (bv !== undefined && cellEquals(tv, bv)) cells[column] = ov;
            else clash = true;
          }
          if (clash) {
            conflicts.push(this.#conflict(name, pk, br, or, tr));
            result = or;
          } else {
            result = cells;
          }
        } else {
          conflicts.push(this.#conflict(name, pk, br, or, tr));
          result = or;
        }
        const row = kept(result);
        if (row) mergedRows.push(row);
      }
      const indexSet = new Set<string>([...o.indexes, ...t.indexes]);
      for (const side of [o, t]) {
        for (const removed of b.indexes) {
          if (!side.indexes.includes(removed)) indexSet.delete(removed);
        }
      }
      merged.set(name, { ...schemaSource, rows: mergedRows, indexes: [...indexSet] });
    }
    const objects = [...new Set([...ours.objects, ...theirs.objects])];
    return { merged: { tables: merged, objects }, conflicts, schemaConflicts };
  }

  #conflict(
    table: string,
    pk: readonly string[],
    base: PlainRow | undefined,
    ours: PlainRow | undefined,
    theirs: PlainRow | undefined
  ): ConflictRecord {
    const source = ours ?? theirs ?? base ?? {};
    const change = (side: PlainRow | undefined): DoltRowChange =>
      base === undefined ? "added" : side === undefined ? "removed" : "modified";
    return {
      table,
      key: Object.fromEntries(pk.map((column) => [column, source[column] ?? null])),
      base: base ?? null,
      ours: ours ?? null,
      theirs: theirs ?? null,
      ourChange: change(ours),
      theirChange: change(theirs),
    };
  }

  // --- Remotes (F7) -------------------------------------------------------------------------------------------------

  #withRemotes(base: DoltStorage): DoltRemoteStorage {
    const self = this;
    const remote: DoltRemoteApi = {
      add: (name, target: DoltRemoteTarget) => {
        self.#assertNoTransaction("remoteAdd");
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name))
          throw new Error(`invalid remote name ${JSON.stringify(name)}`);
        const ref = target.ref ?? (target.id === undefined ? undefined : String(target.id));
        if (!ref) throw new TypeError("dolt.remote.add: expected { id, token }");
        self.#remotes.set(name, { ref, token: target.token });
      },
      remove: (name) => {
        self.#remotes.delete(name);
        for (const key of [...self.#remoteBranches.keys()]) {
          if (key.startsWith(`${name}/`)) self.#remoteBranches.delete(key);
        }
      },
      list: (): DoltRemoteInfo[] =>
        [...self.#remotes].map(([name, entry]) => ({ name, ref: entry.ref })),
      branches: (): DoltRemoteBranch[] =>
        [...self.#remoteBranches]
          .map(([name, hash]) => ({ name, hash }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      grant: (options: DoltGrantOptions = {}): DoltGrant => {
        const token = randomBytes(32).toString("base64url");
        const record: GrantRecord = {
          id: `grant_${randomBytes(4).toString("hex")}`,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          label: options.label ?? null,
          fetch: !!options.fetch,
          push: [...(options.push ?? [])],
          branches: [...(options.branches ?? ["*"])],
          peer: options.peer ?? null,
          expiresAt: options.expiresAt ?? null,
          revoked: false,
        };
        self.#grants.set(record.id, record);
        const { tokenHash: _hash, revoked: _revoked, ...shown } = record;
        return { ...shown, token };
      },
      grants: (): DoltGrantInfo[] =>
        [...self.#grants.values()]
          .filter((grant) => !grant.revoked)
          .map(({ tokenHash: _hash, revoked: _revoked, ...shown }) => shown),
      revoke: (id) => {
        const grant = self.#grants.get(id);
        if (grant) grant.revoked = true;
        for (const key of [...self.#remoteBranches.keys()]) {
          if (key.startsWith(`pushed-${id}/`)) self.#remoteBranches.delete(key);
        }
      },
      serve: (request, options = {}) => self.#serve(request, options.peer ?? null),
    };

    const carrier = (name: string, options: { transport?: DoltFetchOptions["transport"] }) => {
      if (options.transport) {
        const transport = options.transport;
        return async (bytes: Uint8Array): Promise<Uint8Array> => {
          const response = await transport(bytes);
          return response instanceof Uint8Array ? response : new Uint8Array(response);
        };
      }
      const entry = self.#remotes.get(name);
      if (!entry) throw new Error(`no remote named ${JSON.stringify(name)}`);
      return async (bytes: Uint8Array): Promise<Uint8Array> => {
        const target = self.#network.resolve(entry.ref);
        if (!target)
          throw new FakeDoltError(
            `remote ${entry.ref} is not a Dolt cell`,
            "ERR_DOLT_REMOTE_NOT_FOUND"
          );
        if (target.#options.remotes === false) {
          return encodeWire({
            ok: false,
            code: "ERR_DOLT_REMOTE_FORBIDDEN",
            message: "the class did not declare doltRemotes",
          } satisfies WireResponse);
        }
        return target.#serve(bytes, null);
      };
    };
    const entryOf = (name: string) => {
      const entry = self.#remotes.get(name);
      if (!entry) throw new Error(`no remote named ${JSON.stringify(name)}`);
      return entry;
    };
    const call = async <T extends WireResponse>(
      send: (bytes: Uint8Array) => Promise<Uint8Array>,
      request: WireRequest
    ): Promise<T> => {
      const response = decodeWire<T>(await send(encodeWire(request)));
      if (!response.ok)
        throw new FakeDoltError(
          response.message ?? "remote request failed",
          response.code ?? "ERR_DOLT_REMOTE_FAILED"
        );
      return response;
    };

    const fetchRemote = async (
      name: string,
      options: DoltFetchOptions = {}
    ): Promise<DoltFetchResult> => {
      const entry = entryOf(name);
      const send = carrier(name, options);
      const response = await call(send, {
        op: "fetch",
        token: entry.token,
        branches: [...(options.branches ?? [])],
        have: [...self.#commits.keys()],
      });
      for (const wire of response.commits ?? []) {
        if (!self.#commits.has(wire.hash)) self.#commits.set(wire.hash, fromWireCommit(wire));
      }
      for (const [branch, hash] of Object.entries(response.branches ?? {})) {
        self.#remoteBranches.set(`${name}/${branch}`, hash);
      }
      return {
        remote: name,
        branches: response.branches ?? {},
        bytes: JSON.stringify(response.commits ?? []).length,
      };
    };

    return {
      ...base,
      remote,
      fetch: fetchRemote,
      pull: async (
        name: string,
        branchName: string,
        options: DoltPullOptions = {}
      ): Promise<DoltPullResult> => {
        const { transport, ...mergeOptions } = options;
        const fetched = await fetchRemote(name, { branches: [branchName], transport });
        const merged = self.#merge(`${name}/${branchName}`, mergeOptions);
        return { ...merged, fetched } as DoltPullResult;
      },
      push: async (
        name: string,
        branchName: string,
        options: DoltPushOptions = {}
      ): Promise<DoltPushResult> => {
        const entry = entryOf(name);
        const send = carrier(name, options);
        const tip = self.#branches.get(branchName)?.head;
        if (!tip) throw new Error(`branch not found: ${branchName}`);
        const refs = await call(send, { op: "refs", token: entry.token });
        const known = new Set(refs.known ?? []);
        const commits = [...self.#ancestors(tip)]
          .filter((hash) => !known.has(hash))
          .map((hash) => self.#commits.get(hash)!)
          .sort((a, b) => a.seq - b.seq)
          .map(toWireCommit);
        const response = await call(send, {
          op: "push",
          token: entry.token,
          branch: branchName,
          to: options.to ?? branchName,
          tip,
          commits,
        });
        return response.result as DoltPushResult;
      },
    } as DoltRemoteStorage;
  }

  /** The source's side: one request in, one response out. A refusal is a response. */
  #serve(bytes: Uint8Array | ArrayBuffer, peer: string | null): Uint8Array {
    const fail = (code: string, message: string): Uint8Array =>
      encodeWire({ ok: false, code, message } satisfies WireResponse);
    let request: WireRequest;
    try {
      request = decodeWire<WireRequest>(bytes);
    } catch {
      return fail("ERR_DOLT_REMOTE_BAD_REQUEST", "malformed request");
    }
    const hash = createHash("sha256")
      .update(String(request.token ?? ""))
      .digest("hex");
    const grant = [...this.#grants.values()].find((candidate) => candidate.tokenHash === hash);
    if (
      !grant ||
      grant.revoked ||
      (grant.expiresAt !== null && grant.expiresAt <= this.#now()) ||
      (grant.peer !== null && grant.peer !== (request.peer ?? peer))
    ) {
      return fail("ERR_DOLT_REMOTE_FORBIDDEN", "no valid grant");
    }
    const visible = [...this.#branches.keys()].filter((name) =>
      grant.branches.some((pattern) => patternMatches(pattern, name))
    );

    if (request.op === "refs") {
      if (!grant.fetch && grant.push.length === 0)
        return fail("ERR_DOLT_REMOTE_FORBIDDEN", "the grant allows nothing");
      const branches = Object.fromEntries(
        visible.map((name) => [name, this.#branches.get(name)!.head])
      );
      return encodeWire({
        ok: true,
        branches,
        known: [...this.#commits.keys()],
      } satisfies WireResponse);
    }

    if (request.op === "fetch") {
      if (!grant.fetch) return fail("ERR_DOLT_REMOTE_FORBIDDEN", "the grant does not allow fetch");
      const patterns = request.branches ?? [];
      for (const pattern of patterns) {
        if (!pattern.includes("*") && !visible.includes(pattern)) {
          return fail("ERR_DOLT_REMOTE_NOT_FOUND", `branch ${pattern} is not shown by the grant`);
        }
      }
      const wanted = visible.filter(
        (name) => patterns.length === 0 || patterns.some((p) => patternMatches(p, name))
      );
      const have = new Set(request.have ?? []);
      const needed = new Set<string>();
      for (const name of wanted)
        for (const hash of this.#ancestors(this.#branches.get(name)!.head)) needed.add(hash);
      const commits = [...needed]
        .filter((hash) => !have.has(hash))
        .map((hash) => this.#commits.get(hash)!)
        .sort((a, b) => a.seq - b.seq)
        .map(toWireCommit);
      return encodeWire({
        ok: true,
        branches: Object.fromEntries(wanted.map((name) => [name, this.#branches.get(name)!.head])),
        commits,
      } satisfies WireResponse);
    }

    if (request.op === "push") {
      const to = request.to ?? request.branch ?? "";
      if (!to || !grant.push.some((pattern) => patternMatches(pattern, to))) {
        return fail("ERR_DOLT_REMOTE_FORBIDDEN", `the grant does not allow pushing ${to}`);
      }
      const tip = request.tip ?? "";
      const incoming = new Map((request.commits ?? []).map((wire) => [wire.hash, wire]));
      if (!incoming.has(tip) && !this.#commits.has(tip)) {
        return fail("ERR_DOLT_REMOTE_BAD_REQUEST", "the pack does not carry the claimed tip");
      }
      const installed = new Map(this.#commits);
      for (const wire of incoming.values()) installed.set(wire.hash, fromWireCommit(wire));
      const ancestorsIn = (start: string): Set<string> => {
        const seen = new Set<string>();
        const queue = [start];
        while (queue.length > 0) {
          const next = queue.pop()!;
          if (seen.has(next)) continue;
          seen.add(next);
          const commit = installed.get(next);
          if (!commit) return new Set(["\u0000incomplete"]);
          queue.push(...commit.parents);
        }
        return seen;
      };
      const closure = ancestorsIn(tip);
      if (closure.has("\u0000incomplete"))
        return fail("ERR_DOLT_REMOTE_BAD_REQUEST", "the pack's commit graph is incomplete");
      const existing = this.#branches.get(to);
      if (existing && existing.head === tip) {
        return encodeWire({
          ok: true,
          result: { branch: to, hash: tip, created: false, unchanged: true },
        } satisfies WireResponse);
      }
      if (existing && !closure.has(existing.head)) {
        return fail(
          "ERR_DOLT_NON_FAST_FORWARD",
          `the push is not a fast-forward; ${to} is at ${existing.head}`
        );
      }
      if (existing && to === this.#current && this.#workingChanges().length > 0) {
        return fail("ERR_DOLT_TARGET_DIRTY", `${to} is checked out with uncommitted changes`);
      }
      for (const wire of incoming.values())
        if (!this.#commits.has(wire.hash)) this.#commits.set(wire.hash, fromWireCommit(wire));
      this.#remoteBranches.set(`pushed-${grant.id}/${to}`, tip);
      if (existing) {
        existing.head = tip;
        if (to === this.#current) this.#loadSnapshot(this.#snapshotOf(tip));
        else existing.working = null;
      } else {
        this.#branches.set(to, { head: tip, working: null });
      }
      return encodeWire({
        ok: true,
        result: { branch: to, hash: tip, created: existing === undefined, unchanged: false },
      } satisfies WireResponse);
    }
    return fail(
      "ERR_DOLT_REMOTE_BAD_REQUEST",
      `unknown operation ${String((request as { op?: unknown }).op)}`
    );
  }
}
