import { DurableObjectBase, rpc, type DurableObjectContext } from "@vibestudio/durable";
import {
  createBuildServiceClient,
  createEvalImportLoader,
  requireBuildBundleResult,
  type BuildServiceClient,
  type EvalImportLoader,
} from "@vibestudio/service-schemas/clients/evalImportLoader";
import { eventsMethods } from "@vibestudio/service-schemas/events";
import { fsMethods } from "@vibestudio/service-schemas/fs";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import { docsMethods } from "@vibestudio/service-schemas/docs";
import { evalMethods } from "@vibestudio/service-schemas/eval";
import { externalOpenMethods } from "@vibestudio/service-schemas/externalOpen";
import { EVAL_AMBIENT_ONLY } from "@vibestudio/service-schemas/runtime/runtimeSurface.eval";
import { buildOwnerBindings } from "./evalOwnerBindings.js";
import { ConsoleStreamer } from "./consoleStreamer.js";
import { describeEvalBindingSurface, invalidHelpArgumentResponse } from "./evalSurfaceHelp.js";
import { createEvalNodeCompat } from "./evalNodeCompat.js";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * EvalDO — the blessed, per-owner unsafe-eval kernel.
 *
 * An internal Durable Object (alongside WorkspaceDO/BrowserDataDO) that runs the agent
 * `eval` capability server-side. It:
 *  - dynamically loads the manifest-declared eval engine + runtime units at runtime
 *    (meta/vibestudio.yml `providers.evalEngine` / `providers.evalRuntime`, injected as
 *    env bindings — NOTHING workspace-owned is statically bundled here: keeps the
 *    internal bundle lean, lets the volatile engine update without a kernel rebuild,
 *    and keeps host code free of hardcoded workspace unit names),
 *  - compiles via the workerd `UNSAFE_EVAL` binding (`new Function` is blocked in workerd;
 *    we install `__vibestudioCompileFunction__` so the engine's two codegen sites route
 *    through `env.UNSAFE_EVAL.newFunction`),
 *  - persists REPL scope rows in its own SQLite via `SqlScopePersistence` and spills large values
 *    to the workspace blobstore,
 *  - exposes a synchronous in-DO `db` (its SQLite) to eval'd code, with reserved-table guards.
 *
 * Trust model: only the server `eval` service dispatches to it (owner is enforced there by
 * deriving the objectKey from the verified caller), so the DO needs no in-DO authz.
 *
 * Bindings mirror the in-app eval tool's surface: injected
 * `rpc`/`services`/`fs`/`ctx` + `scope`/`scopes`/`help` + `db`, plus a `chat`
 * binding when the owner is an agent DO bound to a channel (a pure forwarding
 * proxy to the agent — the EvalDO carries ZERO channel logic). (Panel-style
 * `import { fs } from "@workspace/runtime"` does not initialize in a DO isolate.)
 */

/**
 * Eval kernel tables are declared once. Schema validation and destructive
 * scope reset both consume this list so adding durable kernel state cannot
 * silently turn it into resettable user data.
 */
const EVAL_KERNEL_TABLES = [
  "eval_runs_v3",
  "eval_run_progress_v3",
  "eval_run_events_v3",
  "eval_retained_modules_v1",
  "eval_run_owned_contexts_v1",
] as const;
const EVAL_PROTECTED_TABLES = ["state", "repl_scopes", ...EVAL_KERNEL_TABLES] as const;
const EVAL_PROTECTED_TABLE_SET = new Set<string>(EVAL_PROTECTED_TABLES);
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Reserved tables the user `db` may not mutate — kernel state, scope, lifecycle, retained modules. */
const RESERVED_TABLE = new RegExp(
  `\\b(?:${EVAL_PROTECTED_TABLES.map(escapeRegExp).join("|")}|sqlite_[A-Za-z0-9_]*)\\b`,
  "i"
);
const DESTRUCTIVE_STMT = /^\s*(DROP|DELETE|ALTER|UPDATE|INSERT|REPLACE|TRUNCATE|CREATE)\b/i;

/**
 * Idle window before an EvalDO discards its in-memory instance. `preventEviction` keeps the
 * DO warm (nothing evicts it otherwise), so it self-evicts to reclaim memory. Long, because
 * eviction forces a cold reload of the engine + a scope rehydrate on the next run.
 */
const IDLE_EVICT_MS = 30 * 60_000;
const RESULT_CONSOLE_MAX_CHARS = 80_000;
const RESULT_RETURN_PREVIEW_CHARS = 60_000;
const RESULT_ERROR_MAX_CHARS = 20_000;
const RESULT_STORAGE_MAX_CHARS = 250_000;
const MAX_RETAINED_FUNCTION_SOURCE_CHARS = 256 * 1024;
const MAX_RETAINED_MODULES = 128;
const MAX_RETAINED_MODULE_BYTES = 32 * 1024 * 1024;
const MAX_FROZEN_SOURCE_CHARS = 64 * 1024 * 1024;
const MAX_RUN_CLEANUP_HANDLERS = 128;
const MAX_RUN_OWNED_CONTEXTS = 128;
const MAX_RUN_CLEANUP_MS = 30_000;
const EXECUTABLE_SOURCE_PATH = /\.(?:[cm]js|[cm]ts|jsx|tsx)$/i;

interface UnsafeEvalBinding {
  eval(code: string, name?: string): unknown;
  newFunction(code: string, name?: string, ...argNames: string[]): (...args: unknown[]) => unknown;
}

interface SandboxResult {
  success: boolean;
  consoleOutput: string;
  returnValue?: unknown;
  exports?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
}

interface ScopeManagerLike {
  readonly current: Record<string, unknown>;
  readonly api: unknown;
  hydrate(): Promise<unknown>;
  enterEval(): void;
  exitEval(): Promise<void>;
  snapshotForProvenance(): SerializedScopeLike;
}

interface SerializedScopeExecutableLike {
  source: string;
  definitionSourceDigest: string;
  definitionRunDigest: string;
}

interface ScopeExecutableCodecLike {
  serialize(
    value: (...args: unknown[]) => unknown,
    path: string
  ): SerializedScopeExecutableLike | null;
  deserialize(value: SerializedScopeExecutableLike, path: string): (...args: unknown[]) => unknown;
}

interface SerializedScopeLike {
  serialized: Record<string, unknown>;
  spills: Array<{ key: string; valueJson: string }>;
  serializedKeys: string[];
  droppedPaths: Array<{ path: string; reason: string }>;
  partialKeys: string[];
}

function utf16leBase64(value: string): string {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit & 0xff;
    bytes[index * 2 + 1] = codeUnit >>> 8;
  }
  let binary = "";
  // Avoid passing an unbounded argument list to String.fromCharCode.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

interface ScopeBlobBackendLike {
  putText(valueJson: string): Promise<{ digest: string; size?: number }>;
  getText(digest: string): Promise<string | null>;
}

interface EvalEngine {
  analyzeRetainedFunctionSource(source: string): { freeNames: string[] };
  executeSandbox(code: string, options: Record<string, unknown>): Promise<SandboxResult>;
  loadSourceFileBundle(
    entryPath: string,
    loadSourceFile: (path: string) => Promise<string>,
    entryCode?: string
  ): Promise<{
    entryPath: string;
    files: Record<string, string>;
    resolutions: Record<string, string>;
  }>;
  findStaticSpecifiers(code: string): string[];
  inferImportsFromPackageJson(
    specifiers: string[],
    context: {
      importerPath?: string;
      loadSourceFile?: (path: string) => Promise<string>;
      explicitImports?: Record<string, string>;
    }
  ): Promise<Record<string, string>>;
  ScopeManager: new (opts: {
    channelId: string;
    panelId: string;
    persistence: unknown;
    executableCodec?: ScopeExecutableCodecLike;
  }) => ScopeManagerLike;
  SqlScopePersistence: new (sql: unknown, blobs: ScopeBlobBackendLike) => unknown;
}

/**
 * Minimal structural mirrors of the runtime provider's surface. The REAL
 * implementations live in the manifest-declared runtime unit
 * (`providers.evalRuntime` in meta/vibestudio.yml) and are loaded dynamically via
 * the build service — the host bundle carries NO static import of workspace
 * code. These types describe only what the EvalDO itself touches.
 */
interface PanelRuntimeApiLike {
  getPanelHandle(panelId: string): unknown;
}

/** Opaque hosted-runtime surface — the EvalDO only spreads/enumerates it. */
type WorkspaceRuntimeLike = Record<string, unknown>;

/**
 * Factories the declared runtime unit must expose. Contract: the unit's
 * `./hosted` subpath exports the hosted-runtime factories and `./panel-runtime`
 * exports the panel-runtime factories (see `WorkspaceProvidersDecl.evalRuntime`).
 */
interface RuntimeSupportModule {
  createHostedRuntime(host: Record<string, unknown>): WorkspaceRuntimeLike;
  createRpcFs(rpc: unknown): unknown;
  createRuntimeParentHandle(
    getPanelHandle: (panelId: string) => unknown,
    parentId: string,
    parentEntityId: string,
    parentKind?: "panel" | "worker" | "do"
  ): unknown;
  createServicesProxy(
    rt: WorkspaceRuntimeLike,
    knownServiceNames?: readonly string[]
  ): Record<string, unknown>;
  createWorkerdClient(rpc: unknown): unknown;
  createPanelRuntime(options: Record<string, unknown>): PanelRuntimeApiLike;
  createRuntimeSelfHandle(options: { id: string }): unknown;
}

/** The `./hosted` + `./panel-runtime` factory names the EvalDO requires. */
const RUNTIME_HOSTED_FACTORIES = [
  "createHostedRuntime",
  "createRpcFs",
  "createRuntimeParentHandle",
  "createServicesProxy",
  "createWorkerdClient",
] as const;
const RUNTIME_PANEL_FACTORIES = ["createPanelRuntime", "createRuntimeSelfHandle"] as const;

type GlobalBag = Record<string, unknown>;
type FsClient = TypedServiceClient<typeof fsMethods>;
type BlobstoreClient = TypedServiceClient<typeof blobstoreMethods>;
type DocsClient = TypedServiceClient<typeof docsMethods>;
type EventsClient = TypedServiceClient<typeof eventsMethods>;
type EvalClient = TypedServiceClient<typeof evalMethods>;
type ExternalOpenClient = TypedServiceClient<typeof externalOpenMethods>;

interface RunArgs {
  code?: string;
  path?: string;
  /** Virtual context-relative filename/base for inline code and relative imports. */
  sourcePath?: string;
  /** Clear durable user scope/db before this run is first inserted. */
  reset?: boolean;
  syntax?: "javascript" | "typescript" | "jsx" | "tsx";
  imports?: Record<string, string>;
  /** Owner's contextId, resolved + passed by the eval service (informational for `ctx`). */
  contextId?: string;
  /**
   * Channel the eval is bound to. Present only when the owner is an agent DO
   * (set by the eval service). Pairs with `agentRef`; when both are present a
   * `chat` binding is injected that forwards every op to the agent DO.
   */
  channelId?: string;
  /**
   * Parked agent-tool invocation correlated with this run. This is derived by
   * the eval service from the authenticated agent's idempotency key; evaluated
   * code never supplies or observes it. A durable eval run id is deliberately
   * independent from the agent-loop invocation id.
   */
  agentInvocationId?: string;
  /**
   * The owning agent DO's runtime id (its own `do:source:Class:objectKey`).
   * Set by the eval service to the verified caller; the `chat` binding proxies
   * every op to `agentRef.chatOp(channelId, op, args)`. The agent re-derives
   * THIS EvalDO's objectKey to authorize the forward.
   */
  agentRef?: string;
  /**
   * The owner's nearest panel ancestor (resolved server-side by the eval service
   * from verified entity lineage), or absent when there is none. Backs the
   * portable `parent`/`getParent`/`getParentWithContract`. Server→DO arg only.
   */
  parent?: { parentId: string; parentEntityId: string; parentKind: "panel" | "worker" | "do" };
  /** Opt-in deadline; the run is aborted after this many ms. Absent ⇒ unbounded. */
  timeoutMs?: number;
  startIntentDigest?: string;
  manifestDigest?: string;
  sourceBundleDigest?: string;
  authorityPolicy?: {
    mode: "adaptive" | "strict";
    effects: "read-only" | "mutable";
    approvals: "prompt" | "pregranted-only";
    requests: readonly unknown[];
  };
}

interface FrozenSourceBundle {
  version: 1;
  code: string;
  sourcePath?: string;
  /** Original context path when its bytes are returned as data rather than parsed as code. */
  sourceReferencePath?: string;
  sourceFiles: Record<string, string>;
  importBundles: Record<string, string>;
  retainedModules: Record<string, { ref: string; digest: string }>;
  workspaceImports: string[];
}

interface RetainedModuleRecord {
  specifier: string;
  ref: string;
  bundleDigest: string;
}

interface LiveInvocationLease {
  credential: string;
  policy: NonNullable<RunArgs["authorityPolicy"]>;
}

interface RunResult {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  errorCode?: string;
  scopeKeys?: string[];
  authority?: unknown;
  provenance?: {
    startIntentDigest: string;
    sourceDigest: string | null;
    executionProvenanceDigest: string | null;
    scopeInputRevision: string | null;
    runDigest: string | null;
    sourceBundleDigest: string | null;
    manifestDigest: string | null;
    terminalReason: string | null;
  };
}

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "interrupted",
] as const;

function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

function cancelledRunResult(): RunResult {
  return {
    success: false,
    console: "",
    error: "eval: run cancelled",
    errorCode: "EVAL_CANCELLED",
  };
}

interface DurableRunActivity {
  count: number;
  oldestStartedAt: number | null;
  activeRuns: Array<{
    runId: string;
    status: string;
    startedAt: number;
    deadlineAt: number | null;
  }>;
  latestRuns: Array<{
    runId: string;
    status: string;
    startedAt: number;
    deadlineAt: number | null;
    agentRef: string | null;
    channelId: string | null;
  }>;
}

export class EvalDO extends DurableObjectBase {
  static override schemaVersion = 3;

  private engine: EvalEngine | null = null;
  private scopeManager: ScopeManagerLike | null = null;
  /** Serializes eval runs — ScopeManager has a single in-progress flag + one current scope. */
  private runChain: Promise<unknown> = Promise.resolve();
  /** In-flight runs in THIS instance, keyed by runId → the single execution promise. A concurrent
   *  `executeRun` (e.g. a deferRedrive that races the first dispatch) SHARES this promise instead of
   *  starting a second sandbox run; also lets `reset` abort live runs and `alarm` skip mid-run. */
  private readonly inFlightRuns = new Map<string, Promise<RunResult>>();
  /** Independent in-memory activity marker for claimed rows, used as an alarm safety net. */
  private readonly activeRunIds = new Set<string>();
  /** Abort controllers per in-flight run — used by `reset` and the `timeoutMs` deadline. */
  private readonly runAborts = new Map<string, AbortController>();
  /** Run-scoped cleanup registered by evaluated orchestration code. */
  private readonly runCleanupHandlers = new Map<string, Set<() => void | Promise<void>>>();
  private readonly runCleanupTasks = new Map<string, Promise<void>>();
  private readonly runCleanupStarted = new Set<string>();
  /** Distinguishes user execution from terminal cleanup across async continuations. */
  private readonly authoredCallContext = new AsyncLocalStorage<{
    phase: "run" | "cleanup";
    signal?: AbortSignal;
  }>();
  /** Process-local by design. A cold incarnation cannot resume a run because
   * no invocation secret or JavaScript continuation is durable. */
  private readonly invocationLeases = new Map<string, LiveInvocationLease>();
  private buildClient: BuildServiceClient | null = null;
  private fsClient: FsClient | null = null;
  private preparationBlobstoreClient: BlobstoreClient | null = null;
  private kernelBlobstoreClient: BlobstoreClient | null = null;
  private docsClient: DocsClient | null = null;
  private eventsClient: EventsClient | null = null;
  private evalClient: EvalClient | null = null;
  private externalOpenClient: ExternalOpenClient | null = null;
  /**
   * The portable runtime surface (createHostedRuntime) — the SAME assembly panel
   * and worker run, so `import { … } from "@workspace/runtime"` resolves to the
   * identical surface in eval. Cached per-object (its rpc/fs are owner-scoped).
   */
  private hostedRuntime: WorkspaceRuntimeLike | null = null;
  /**
   * Factories from the manifest-declared runtime unit (providers.evalRuntime),
   * loaded dynamically via the build service (see ensureRuntimeSupport). The
   * host bundle never statically imports workspace code.
   */
  private runtimeSupport: RuntimeSupportModule | null = null;
  /** The declared runtime unit's `./portable` helpers (z, defineContract, …). */
  private portableHelpers: Record<string, unknown> | null = null;
  /** Owner identity baked into the cached hosted runtime at first init. A warm
   *  EvalDO serves exactly one owner (objectKey = sha256(ownerId\0subKey)), so a
   *  later run arriving with a different contextId is a routing or
   *  ownership bug — refuse loudly rather than silently run under stale identity
   *  (Finding 3). */
  private hostedRuntimeIdentity: { contextId: string } | null = null;
  private cdpLoaded = false;
  private warnedNoCdpProvider = false;
  /**
   * The owner's nearest panel ancestor (server-supplied via `RunArgs.parent`),
   * read by the hosted runtime's `resolveParent`. Mutable so a re-resolved parent
   * is reflected even though `hostedRuntime` is cached (the closure reads it live).
   */
  private parentMeta: RunArgs["parent"] | null = null;

  /**
   * Per-run containment for eval-authored RPC calls. Read LIVE by the cached
   * hosted-runtime rpc wrapper so cached imports of `@workspace/runtime` still
   * get the current run's abort signal/read-only flag.
   */
  private currentRunReadOnly = false;
  private currentEvalInvocation: { runId: string; credential: string } | null = null;
  private currentRunAbortSignal: AbortSignal | null = null;
  /** Current bindings are installed only for the held execution interval. A
   * durable function wrapper resolves them at CALL time, so it can never retain
   * a previous run's authority-bearing clients or ctx object. */
  private currentRunBindings: Record<string, unknown> | null = null;
  private currentDefinitionProvenance: {
    sourceDigest: string;
    runDigest: string;
  } | null = null;
  private readonly retainedExecutableMetadata = new WeakMap<
    (...args: unknown[]) => unknown,
    SerializedScopeExecutableLike
  >();
  private readonly retainedExecutableCompilation = new WeakMap<
    (...args: unknown[]) => unknown,
    { runId: string; compiled: (...args: unknown[]) => unknown }
  >();

  /**
   * Per-OBJECT module registry passed to the engine on every run. Many owners' EvalDOs share
   * one workerd isolate, so the engine's per-isolate global `__vibestudioModuleMap__` would leak
   * one owner's loaded `imports` into another (and dedup-by-specifier could hand owner B owner
   * A's *version*). A per-object map keeps each owner's modules isolated. Persists across this
   * DO's runs for import continuity (a module loaded in one run is reusable by the next).
   */
  private moduleMap: Record<string, unknown> = {};
  private readonly loadedModuleDigests = new Map<string, string>();

  /** Per-object require paired with `moduleMap` (resolves only THIS owner's loaded modules). */
  private engineRequire = (id: string): unknown => {
    const m = this.moduleMap[id];
    if (m !== undefined) return m;
    throw new Error(`Module "${id}" not available in EvalDO; use the imports parameter.`);
  };

  private readonly scopeExecutableCodec: ScopeExecutableCodecLike = {
    serialize: (value, path) => this.serializeRetainedExecutable(value, path),
    deserialize: (value, path) => this.deserializeRetainedExecutable(value, path),
  };

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
    // Runs once per boot (this instance), before any run executes — so every `running`
    // row is orphaned by a prior instance whose held connection dropped (server restart).
    this.reconcileOrphanedRuns();
    // Run-owned lifecycle contexts are durable kernel state. If a prior
    // incarnation vanished, reclaim resources for the runs just marked
    // interrupted before accepting work in this incarnation.
    void this.ctx
      .blockConcurrencyWhile(() => this.reconcileTerminalOwnedContexts())
      .catch((error) =>
        console.error("[EvalDO] failed to reconcile terminal run-owned contexts", error)
      );
  }

  protected createTables(): void {
    // The base `state` table is created by ensureReady(). The scope table (`repl_scopes`)
    // is created lazily by SqlScopePersistence on first run; user `db` tables are created
    // on demand by eval'd code.
    //
    // The `runs` table is the durable job queue: `accept` inserts, `execute` runs the
    // sandbox synchronously in a HELD handler (the eval service holds the connection open —
    // workerd does not cap held requests), `get` is the poll backstop. `agent_ref`/
    // `channel_id` are stored so the alarm-free execution reconstructs the `chat` binding.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS eval_runs_v3 (
        run_id TEXT PRIMARY KEY,
        args TEXT,
        agent_ref TEXT,
        channel_id TEXT,
        status TEXT NOT NULL,
        result TEXT,
        accepted_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        deadline_at INTEGER,
        start_intent_digest TEXT NOT NULL,
        source_digest TEXT,
        execution_provenance_digest TEXT,
        scope_input_revision TEXT,
        source_bundle_digest TEXT,
        run_digest TEXT,
        manifest_digest TEXT,
        terminal_reason TEXT
      )
    `);
    // SqlStorage executes one statement per exec() call under real workerd.
    // Keep this separate from `runs` so existing objects and fresh objects both
    // receive the progress table deterministically.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS eval_run_progress_v3 (
        run_id TEXT PRIMARY KEY,
        progress TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES eval_runs_v3(run_id) ON DELETE CASCADE
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS eval_run_events_v3 (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT,
        detail TEXT,
        FOREIGN KEY (run_id) REFERENCES eval_runs_v3(run_id) ON DELETE CASCADE
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS eval_retained_modules_v1 (
        specifier TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        bundle_digest TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS eval_run_owned_contexts_v1 (
        run_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        owner_entity_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, context_id),
        FOREIGN KEY (run_id) REFERENCES eval_runs_v3(run_id) ON DELETE CASCADE
      )
    `);
  }

  protected override requiredTables(): readonly string[] {
    return EVAL_KERNEL_TABLES;
  }

  /**
   * Crash recovery: a held `executeRun` connection drops on server restart → workerd cancels
   * the EvalDO handler → the run dies mid-flight, leaving a `running` row no in-memory executor
   * owns. Called once at construction (before any run is live), so every `running` row is stale.
   * Mark them an interrupt error; the waiting caller's `get` poll surfaces it and the model
   * re-issues (a fresh runId). We never auto-re-run — evals have side effects (spawned agents).
   */
  private reconcileOrphanedRuns(): void {
    this.sql.exec(
      `UPDATE eval_runs_v3
       SET status = 'interrupted', result = ?, ended_at = ?, terminal_reason = ?
       WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'interrupted')`,
      JSON.stringify({
        success: false,
        console: "",
        error: "eval interrupted by process or EvalDO incarnation loss",
        errorCode: "EVAL_INTERRUPTED",
      }),
      Date.now(),
      "active continuation was lost; source was not replayed"
    );
  }

  private async reconcileTerminalOwnedContexts(): Promise<void> {
    const rows = this.sql
      .exec(
        `SELECT DISTINCT owned.run_id
         FROM eval_run_owned_contexts_v1 AS owned
         INNER JOIN eval_runs_v3 AS run ON run.run_id = owned.run_id
         WHERE run.status IN ('succeeded', 'failed', 'cancelled', 'expired', 'interrupted')`
      )
      .toArray();
    for (const row of rows) {
      try {
        await this.cleanupRunOwnedContexts(String(row["run_id"]));
      } catch (error) {
        console.error(
          `[EvalDO] retained run-owned context cleanup failed for ${String(row["run_id"])}`,
          error
        );
      }
    }
  }

  private appendRunEvent(runId: string, type: string, status?: string, detail?: unknown): void {
    const count = Number(
      this.sql
        .exec(`SELECT COUNT(*) AS count FROM eval_run_events_v3 WHERE run_id = ?`, runId)
        .toArray()[0]?.["count"] ?? 0
    );
    if (count >= 1_000) {
      throw Object.assign(new Error("eval run event limit exceeded"), {
        code: "EVAL_RESOURCE_LIMIT",
      });
    }
    this.sql.exec(
      `INSERT INTO eval_run_events_v3 (run_id, at, type, status, detail)
       VALUES (?, ?, ?, ?, ?)`,
      runId,
      Date.now(),
      type,
      status ?? null,
      detail === undefined ? null : JSON.stringify(detail)
    );
  }

  private transition(runId: string, from: readonly string[], to: string, type: string): void {
    const placeholders = from.map(() => "?").join(", ");
    const startedAt = to === "running" ? Date.now() : null;
    this.sql.exec(
      `UPDATE eval_runs_v3 SET status = ?, started_at = COALESCE(started_at, ?)
       WHERE run_id = ? AND status IN (${placeholders})`,
      to,
      startedAt,
      runId,
      ...from
    );
    const row = this.sql
      .exec(`SELECT status FROM eval_runs_v3 WHERE run_id = ?`, runId)
      .toArray()[0];
    if (String(row?.["status"]) !== to) {
      throw new Error(`eval: invalid run transition ${from.join("|")} -> ${to}`);
    }
    this.appendRunEvent(runId, type, to);
  }

  private finishRun(
    runId: string,
    requestedStatus: "succeeded" | "failed" | "expired" | "interrupted",
    result: RunResult,
    reason: string | null
  ): void {
    const row = this.sql
      .exec(`SELECT status FROM eval_runs_v3 WHERE run_id = ?`, runId)
      .toArray()[0];
    const prior = String(row?.["status"] ?? "interrupted");
    const status = prior === "cancellation-requested" ? "cancelled" : requestedStatus;
    if (
      ["cancelled", "expired", "interrupted"].includes(prior) &&
      prior !== "cancellation-requested"
    ) {
      return;
    }
    const terminalResult =
      status === "cancelled"
        ? { success: false, console: result.console, error: "eval: run cancelled" }
        : result;
    this.sql.exec(
      `UPDATE eval_runs_v3
       SET status = ?, result = ?, ended_at = ?, terminal_reason = ?
       WHERE run_id = ?`,
      status,
      JSON.stringify(terminalResult),
      Date.now(),
      reason,
      runId
    );
    this.appendRunEvent(runId, "terminal", status, reason ? { reason } : undefined);
  }

  private cancelNonterminalRuns(reason: string): void {
    const rows = this.sql
      .exec(
        `SELECT run_id FROM eval_runs_v3
         WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'interrupted')`
      )
      .toArray();
    for (const row of rows) {
      const runId = String(row["run_id"]);
      const inFlight = this.inFlightRuns.has(runId);
      const status = inFlight ? "cancellation-requested" : "cancelled";
      if (inFlight) {
        this.sql.exec(
          `UPDATE eval_runs_v3 SET status = ?, ended_at = NULL, terminal_reason = ?
           WHERE run_id = ?`,
          status,
          reason,
          runId
        );
      } else {
        this.sql.exec(
          `UPDATE eval_runs_v3 SET status = ?, result = ?, ended_at = ?, terminal_reason = ?
           WHERE run_id = ?`,
          status,
          JSON.stringify(cancelledRunResult()),
          Date.now(),
          reason,
          runId
        );
      }
      this.appendRunEvent(runId, inFlight ? "cancellation-requested" : "terminal", status, {
        reason,
      });
    }
  }

  private async sha256Text(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    );
  }

  private canonicalJson(value: unknown): string {
    const canonicalize = (candidate: unknown): unknown => {
      if (Array.isArray(candidate)) return candidate.map(canonicalize);
      if (candidate && typeof candidate === "object") {
        return Object.fromEntries(
          Object.entries(candidate as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonicalize(child)])
        );
      }
      return candidate;
    };
    return JSON.stringify(canonicalize(value));
  }

  private retainedModuleRecords(): RetainedModuleRecord[] {
    const rows = this.sql
      .exec(
        `SELECT specifier, ref, bundle_digest
         FROM eval_retained_modules_v1
         ORDER BY specifier ASC
         LIMIT ?`,
        MAX_RETAINED_MODULES + 1
      )
      .toArray();
    if (rows.length > MAX_RETAINED_MODULES) {
      throw Object.assign(
        new Error(`eval retained module limit (${MAX_RETAINED_MODULES}) exceeded`),
        {
          code: "EVAL_RESOURCE_LIMIT",
        }
      );
    }
    return rows.map((row) => ({
      specifier: String(row["specifier"]),
      ref: String(row["ref"]),
      bundleDigest: String(row["bundle_digest"]),
    }));
  }

  private async materializeSource(
    runId: string,
    args: RunArgs
  ): Promise<{
    sourceDigest: string;
    executionProvenanceDigest: string;
    scopeInputRevision: string;
    sourceBundleDigest: string;
  }> {
    const engine = await this.ensureEngine();
    const readFiles: Record<string, string> = {};
    const readFrozenFile = async (path: string): Promise<string> => {
      if (Object.prototype.hasOwnProperty.call(readFiles, path)) return readFiles[path]!;
      const value = await this.readSourceFile(path);
      readFiles[path] = value;
      return value;
    };
    const requestedSourcePath = args.sourcePath ?? args.path;
    const requestedCode =
      args.code !== undefined
        ? args.code
        : requestedSourcePath
          ? await readFrozenFile(requestedSourcePath)
          : "";
    const executesContextFile =
      args.code === undefined &&
      requestedSourcePath !== undefined &&
      EXECUTABLE_SOURCE_PATH.test(requestedSourcePath);
    // Data/document paths are a first-class eval UX: freeze the exact bytes at
    // preparation and return those bytes from the immutable source bundle.
    // Never authorize one file and then re-read a mutable path during execute.
    const code =
      args.code === undefined && requestedSourcePath && !executesContextFile
        ? `return ${JSON.stringify(requestedCode)};`
        : requestedCode;
    const sourcePath =
      args.code !== undefined
        ? args.sourcePath
        : executesContextFile
          ? requestedSourcePath
          : undefined;
    const sourceGraph = sourcePath
      ? await engine.loadSourceFileBundle(sourcePath, readFrozenFile, requestedCode)
      : { entryPath: "", files: {}, resolutions: {} };
    const sourceFiles = { ...readFiles, ...sourceGraph.files };
    const explicitImports = { ...(args.imports ?? {}) };
    const resolvedImports: Record<string, string> = { ...explicitImports };
    const retainedModules = this.retainedModuleRecords();
    const retainedBySpecifier = new Map(
      retainedModules.map((record) => [record.specifier, record] as const)
    );
    for (const retained of retainedModules) {
      if (resolvedImports[retained.specifier] === undefined) {
        resolvedImports[retained.specifier] = retained.ref;
      }
    }
    const importLoader = this.makeLoadImport();
    const workspaceImports = new Set<string>();
    const sourceEntries = sourcePath
      ? Object.entries(sourceGraph.files)
      : [[args.sourcePath ?? "<inline>", code] as const];
    for (const [importerPath, source] of sourceEntries) {
      const specifiers = engine.findStaticSpecifiers(source);
      Object.assign(
        resolvedImports,
        await engine.inferImportsFromPackageJson(specifiers, {
          importerPath: sourcePath ? importerPath : undefined,
          loadSourceFile: sourcePath ? readFrozenFile : undefined,
          explicitImports,
        })
      );
      for (const specifier of specifiers) {
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("#") ||
          specifier.startsWith("node:") ||
          resolvedImports[specifier] !== undefined
        ) {
          continue;
        }
        if (await importLoader.resolveWorkspaceImport(specifier)) {
          resolvedImports[specifier] = "latest";
          workspaceImports.add(specifier);
        }
      }
    }
    const runtimeSource = this.declaredProviderSource("EVAL_RUNTIME_SOURCE");
    const retainedSpecifierCount = Object.keys(resolvedImports).filter(
      (specifier) =>
        !runtimeSource ||
        (specifier !== runtimeSource && !specifier.startsWith(`${runtimeSource}/`))
    ).length;
    if (retainedSpecifierCount > MAX_RETAINED_MODULES) {
      throw Object.assign(
        new Error(`eval retained module limit (${MAX_RETAINED_MODULES}) exceeded`),
        {
          code: "EVAL_RESOURCE_LIMIT",
        }
      );
    }
    const importBundles: Record<string, string> = {};
    const frozenRetainedModules: Record<string, { ref: string; digest: string }> = {};
    // The eval runtime root is a host-injected module. Keep it external from
    // every retained workspace bundle even during preparation, which happens
    // before the per-run hosted runtime exists. At execution the per-object
    // module map supplies the run-neutral facade backed by the active lease.
    const externals = new Set([
      ...Object.keys(this.moduleMap),
      ...(runtimeSource ? [runtimeSource] : []),
    ]);
    let retainedModuleBytes = 0;
    for (const [specifier, ref] of Object.entries(resolvedImports).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (
        runtimeSource &&
        (specifier === runtimeSource || specifier.startsWith(`${runtimeSource}/`))
      ) {
        continue;
      }
      const retained = retainedBySpecifier.get(specifier);
      const bundle =
        retained?.ref === ref
          ? await this.preparationBlobstore().getText(retained.bundleDigest)
          : await importLoader(specifier, ref, [...externals]);
      if (bundle == null) {
        throw Object.assign(new Error(`Retained eval module ${specifier}@${ref} is unavailable`), {
          code: "EVAL_INTERRUPTED",
        });
      }
      retainedModuleBytes += bundle.length;
      if (retainedModuleBytes > MAX_RETAINED_MODULE_BYTES) {
        throw Object.assign(
          new Error(
            `eval retained module source exceeds the ${MAX_RETAINED_MODULE_BYTES}-character limit`
          ),
          { code: "EVAL_RESOURCE_LIMIT" }
        );
      }
      importBundles[`${specifier}\0${ref}`] = bundle;
      const storedModule =
        retained?.ref === ref
          ? { digest: retained.bundleDigest }
          : await this.preparationBlobstore().putText(bundle);
      frozenRetainedModules[specifier] = { ref, digest: storedModule.digest };
      this.sql.exec(
        `INSERT INTO eval_retained_modules_v1 (specifier, ref, bundle_digest, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(specifier) DO UPDATE SET
           ref = excluded.ref,
           bundle_digest = excluded.bundle_digest,
           updated_at = excluded.updated_at`,
        specifier,
        ref,
        storedModule.digest,
        Date.now()
      );
      externals.add(specifier);
    }
    if (Object.keys(frozenRetainedModules).length > MAX_RETAINED_MODULES) {
      throw Object.assign(
        new Error(`eval retained module limit (${MAX_RETAINED_MODULES}) exceeded`),
        {
          code: "EVAL_RESOURCE_LIMIT",
        }
      );
    }
    const frozen: FrozenSourceBundle = {
      version: 1,
      code,
      ...(sourcePath ? { sourcePath: sourceGraph.entryPath || sourcePath } : {}),
      ...(!sourcePath && requestedSourcePath ? { sourceReferencePath: requestedSourcePath } : {}),
      sourceFiles,
      importBundles,
      retainedModules: frozenRetainedModules,
      workspaceImports: [...workspaceImports].sort(),
    };
    const encodedBundle = JSON.stringify(frozen);
    if (encodedBundle.length > MAX_FROZEN_SOURCE_CHARS) {
      throw Object.assign(
        new Error(`eval immutable source bundle exceeds ${MAX_FROZEN_SOURCE_CHARS} characters`),
        { code: "EVAL_RESOURCE_LIMIT" }
      );
    }
    const sourceDigest = await this.sha256Text(encodedBundle);
    const scopeManager = await this.ensureScopeManager(engine);
    const scopeSnapshot = scopeManager.snapshotForProvenance();
    const scopeInputRevision = await this.sha256Text(
      this.canonicalJson({
        objectKey: this.objectKey,
        serialized: scopeSnapshot.serialized,
        spills: scopeSnapshot.spills
          .map(({ key, valueJson }) => ({ key, valueJson }))
          .sort((left, right) => left.key.localeCompare(right.key)),
        droppedPaths: scopeSnapshot.droppedPaths,
      })
    );
    const executionProvenanceDigest = await this.sha256Text(
      this.canonicalJson({
        sourceDigest,
        retainedModules: frozenRetainedModules,
        scopeInputRevision,
      })
    );
    const stored = await this.preparationBlobstore().putText(encodedBundle);
    const sourceBundleDigest = stored.digest;
    this.sql.exec(
      `UPDATE eval_runs_v3
       SET source_digest = ?, execution_provenance_digest = ?, scope_input_revision = ?,
           source_bundle_digest = ?
       WHERE run_id = ? AND status = 'preparing'`,
      sourceDigest,
      executionProvenanceDigest,
      scopeInputRevision,
      sourceBundleDigest,
      runId
    );
    this.appendRunEvent(runId, "source-materialized", "preparing", {
      sourceDigest,
      executionProvenanceDigest,
      scopeInputRevision,
      sourceBundleDigest,
    });
    return { sourceDigest, executionProvenanceDigest, scopeInputRevision, sourceBundleDigest };
  }

  private serializeRetainedExecutable(
    value: (...args: unknown[]) => unknown,
    path: string
  ): SerializedScopeExecutableLike | null {
    const retained = this.retainedExecutableMetadata.get(value);
    if (retained) return retained;
    const provenance = this.currentDefinitionProvenance;
    if (!provenance) return null;
    const source = Function.prototype.toString.call(value);
    if (/\[native code\]/.test(source) || /^\s*class\b/.test(source)) return null;
    if (source.length > MAX_RETAINED_FUNCTION_SOURCE_CHARS) {
      throw Object.assign(
        new Error(
          `eval scope executable ${path} exceeds the ${MAX_RETAINED_FUNCTION_SOURCE_CHARS}-character source limit`
        ),
        { code: "EVAL_RESOURCE_LIMIT" }
      );
    }
    const bindings = this.currentRunBindings;
    if (!bindings) return null;
    let freeNames: string[];
    try {
      freeNames = this.analyzeRetainedExecutable(source, path);
    } catch {
      return null;
    }
    if (!this.retainedExecutableDependenciesAvailable(freeNames, bindings)) return null;
    const record = {
      source,
      definitionSourceDigest: provenance.sourceDigest,
      definitionRunDigest: provenance.runDigest,
    };
    this.retainedExecutableMetadata.set(value, record);
    return record;
  }

  private deserializeRetainedExecutable(
    record: SerializedScopeExecutableLike,
    path: string
  ): (...args: unknown[]) => unknown {
    if (
      !record ||
      typeof record.source !== "string" ||
      typeof record.definitionSourceDigest !== "string" ||
      typeof record.definitionRunDigest !== "string" ||
      record.source.length > MAX_RETAINED_FUNCTION_SOURCE_CHARS
    ) {
      throw Object.assign(new Error(`Invalid retained executable record at ${path || "<root>"}`), {
        code: "EVAL_INVOCATION_INVALID",
      });
    }
    this.analyzeRetainedExecutable(record.source, path);
    const invoke = this.invokeRetainedExecutable.bind(this);
    const retainedExecutable = function (this: unknown, ...args: unknown[]): unknown {
      return invoke(retainedExecutable, record, this, args);
    };
    this.retainedExecutableMetadata.set(retainedExecutable, record);
    return retainedExecutable;
  }

  private invokeRetainedExecutable(
    wrapper: (...args: unknown[]) => unknown,
    record: SerializedScopeExecutableLike,
    receiver: unknown,
    args: unknown[]
  ): unknown {
    const bindings = this.currentRunBindings;
    const runId = this.currentEvalInvocation?.runId;
    if (!bindings || !runId) {
      throw Object.assign(
        new Error("Retained eval functions can only be invoked inside an active eval run"),
        { code: "EVAL_INVOCATION_INVALID" }
      );
    }
    let compiled = this.retainedExecutableCompilation.get(wrapper);
    if (!compiled || compiled.runId !== runId) {
      const freeNames = this.analyzeRetainedExecutable(record.source, "<invocation>");
      const unavailable = freeNames.filter(
        (name) => !this.retainedExecutableDependencyAvailable(name, bindings)
      );
      if (unavailable.length > 0) {
        throw Object.assign(
          new Error(
            `Retained eval function depends on unavailable bindings: ${unavailable.join(", ")}`
          ),
          { code: "EVAL_INVOCATION_INVALID" }
        );
      }
      const g = globalThis as GlobalBag;
      const compile = g["__vibestudioCompileFunction__"] as
        | ((argNames: string[], body: string) => (...args: unknown[]) => unknown)
        | undefined;
      if (!compile) throw new Error("EvalDO: retained-function compiler is unavailable");
      const bindingNames = Object.keys(bindings);
      const factory = compile(
        ["require", "console", ...bindingNames],
        `"use strict"; return (${record.source});`
      );
      const callable = factory(
        this.engineRequire,
        console,
        ...bindingNames.map((name) => bindings[name])
      );
      if (typeof callable !== "function") {
        throw Object.assign(new Error("Retained executable source did not produce a function"), {
          code: "EVAL_INVOCATION_INVALID",
        });
      }
      compiled = { runId, compiled: callable as (...args: unknown[]) => unknown };
      this.retainedExecutableCompilation.set(wrapper, compiled);
    }
    return Reflect.apply(compiled.compiled, receiver, args);
  }

  private analyzeRetainedExecutable(source: string, path: string): string[] {
    const engine = this.engine;
    try {
      if (!engine?.analyzeRetainedFunctionSource) {
        throw new Error("eval engine has no retained-function analyzer");
      }
      return engine.analyzeRetainedFunctionSource(source).freeNames;
    } catch (error) {
      throw Object.assign(
        new Error(
          `Invalid retained executable at ${path || "<root>"}: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        { code: "EVAL_INVOCATION_INVALID" }
      );
    }
  }

  private retainedExecutableDependencyAvailable(
    name: string,
    bindings: Record<string, unknown>
  ): boolean {
    return (
      name === "require" ||
      name === "console" ||
      Object.prototype.hasOwnProperty.call(bindings, name) ||
      name in globalThis
    );
  }

  private retainedExecutableDependenciesAvailable(
    names: readonly string[],
    bindings: Record<string, unknown>
  ): boolean {
    return names.every((name) => this.retainedExecutableDependencyAvailable(name, bindings));
  }

  private rearmIdleEviction(): void {
    this.setAlarmAt(Date.now() + IDLE_EVICT_MS, { bestEffort: true });
  }

  private durableRunActivity(): DurableRunActivity {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) AS count, MIN(started_at) AS oldest_started_at
         FROM eval_runs_v3
         WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'interrupted')`
      )
      .toArray()[0];
    const activeRuns = this.sql
      .exec(
        `SELECT run_id, status, started_at, deadline_at
         FROM eval_runs_v3
         WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'expired', 'interrupted')
         ORDER BY accepted_at ASC
         LIMIT 5`
      )
      .toArray()
      .map((r) => ({
        runId: String(r["run_id"]),
        status: String(r["status"]),
        startedAt: Number(r["started_at"] ?? 0),
        deadlineAt: r["deadline_at"] == null ? null : Number(r["deadline_at"]),
      }));
    const latestRuns = this.sql
      .exec(
        `SELECT run_id, status, started_at, deadline_at, agent_ref, channel_id
         FROM eval_runs_v3
         ORDER BY accepted_at DESC
         LIMIT 5`
      )
      .toArray()
      .map((r) => ({
        runId: String(r["run_id"]),
        status: String(r["status"]),
        startedAt: Number(r["started_at"] ?? 0),
        deadlineAt: r["deadline_at"] == null ? null : Number(r["deadline_at"]),
        agentRef: r["agent_ref"] == null ? null : String(r["agent_ref"]),
        channelId: r["channel_id"] == null ? null : String(r["channel_id"]),
      }));
    return {
      count: Number(row?.["count"] ?? 0),
      oldestStartedAt: row?.["oldest_started_at"] == null ? null : Number(row["oldest_started_at"]),
      activeRuns,
      latestRuns,
    };
  }

  private readonly callMainService = (
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> =>
    this.callAuthoredRpc("main", `${service}.${method}`, args, this.currentRunCallOptions());

  /** Trusted-kernel transport for lifecycle cleanup only. Clients using this
   * path must never be reachable from evaluated bindings. */
  private readonly callKernelService = (
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> => this.rpc.call("main", `${service}.${method}`, args);

  /**
   * Observe lifecycle calls at the one transport boundary every eval-authored
   * runtime client shares. A fresh context is owned by the run that created it
   * until code explicitly detaches it or successfully destroys it. This is
   * bookkeeping, not authority: terminal destruction still passes through the
   * runtime service's server-side parent/lifecycle ownership checks.
   */
  private async callAuthoredRpc(
    target: string,
    method: string,
    args: unknown[],
    options?: Record<string, unknown>
  ): Promise<unknown> {
    const runId = this.currentEvalInvocation?.runId ?? null;
    const result = await this.rpc.call(target, method, args, options);
    if (runId && target === "main") this.observeAuthoredLifecycleCall(runId, method, args, result);
    return result;
  }

  private observeAuthoredLifecycleCall(
    runId: string,
    method: string,
    args: unknown[],
    result: unknown
  ): void {
    if (method === "runtime.destroyContext") {
      const contextId = (args[0] as { contextId?: unknown } | undefined)?.contextId;
      if (typeof contextId === "string") this.detachRunOwnedContext(runId, contextId);
      return;
    }
    if (method !== "runtime.createEntity") return;
    const requestedContextId = (args[0] as { contextId?: unknown } | undefined)?.contextId;
    // Joining an existing context is not a new lifecycle child. Only a fresh
    // context minted by this run belongs to its terminal lifecycle.
    if (
      requestedContextId !== undefined &&
      requestedContextId !== null &&
      requestedContextId !== ""
    ) {
      return;
    }
    const contextId = (result as { contextId?: unknown } | null)?.contextId;
    const ownerEntityId = (result as { id?: unknown } | null)?.id;
    if (
      typeof contextId !== "string" ||
      contextId.length === 0 ||
      typeof ownerEntityId !== "string" ||
      ownerEntityId.length === 0
    ) {
      return;
    }
    this.sql.exec(
      `INSERT INTO eval_run_owned_contexts_v1
         (run_id, context_id, owner_entity_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, context_id) DO UPDATE SET
         owner_entity_id = excluded.owner_entity_id`,
      runId,
      contextId,
      ownerEntityId,
      Date.now()
    );
    const count = Number(
      this.sql
        .exec(`SELECT COUNT(*) AS count FROM eval_run_owned_contexts_v1 WHERE run_id = ?`, runId)
        .toArray()[0]?.["count"] ?? 0
    );
    // Retain the over-limit row so terminal cleanup cannot orphan the context
    // whose successful creation exposed the resource violation.
    if (count > MAX_RUN_OWNED_CONTEXTS) {
      throw Object.assign(
        new Error(`ctx run-owned context limit (${MAX_RUN_OWNED_CONTEXTS}) exceeded`),
        { code: "EVAL_RESOURCE_LIMIT" }
      );
    }
  }

  private detachRunOwnedContext(runId: string, contextId: string): boolean {
    const existed =
      this.sql
        .exec(
          `SELECT 1 AS present FROM eval_run_owned_contexts_v1
           WHERE run_id = ? AND context_id = ?`,
          runId,
          contextId
        )
        .toArray().length > 0;
    if (existed) {
      this.sql.exec(
        `DELETE FROM eval_run_owned_contexts_v1 WHERE run_id = ? AND context_id = ?`,
        runId,
        contextId
      );
    }
    return existed;
  }

  private async cleanupRunOwnedContexts(runId: string): Promise<void> {
    const contexts = this.sql
      .exec(
        `SELECT context_id, owner_entity_id
         FROM eval_run_owned_contexts_v1
         WHERE run_id = ?
         ORDER BY created_at ASC, context_id ASC`,
        runId
      )
      .toArray()
      .map((row) => ({
        contextId: String(row["context_id"]),
        ownerEntityId: String(row["owner_entity_id"]),
      }));
    const results = await Promise.allSettled(
      contexts.map(({ contextId, ownerEntityId }) =>
        this.callKernelService("runtime", "cleanupEvalOwnedContext", [
          { contextId, ownerEntityId, recursive: true },
        ])
      )
    );
    for (let index = 0; index < results.length; index += 1) {
      if (results[index]?.status !== "fulfilled") continue;
      this.sql.exec(
        `DELETE FROM eval_run_owned_contexts_v1 WHERE run_id = ? AND context_id = ?`,
        runId,
        contexts[index]!.contextId
      );
    }
    this.throwCleanupFailures(results, `run ${runId} owned contexts`);
  }

  private ownedContextRunIds(): string[] {
    return this.sql
      .exec(`SELECT DISTINCT run_id FROM eval_run_owned_contexts_v1 ORDER BY run_id ASC`)
      .toArray()
      .map((row) => String(row["run_id"]));
  }

  private mainBuild(): BuildServiceClient {
    return (this.buildClient ??= createBuildServiceClient(this.callMainService));
  }

  private mainFs(): FsClient {
    return (this.fsClient ??= createTypedServiceClient("fs", fsMethods, this.callMainService));
  }

  /** Source/import CAS writes run through the attenuated preparation principal. */
  private preparationBlobstore(): BlobstoreClient {
    return (this.preparationBlobstoreClient ??= createTypedServiceClient(
      "blobstore",
      blobstoreMethods,
      this.callMainService
    ));
  }

  /** Trusted run/scope storage is EvalDO kernel state, never invocation authority. */
  private kernelBlobstore(): BlobstoreClient {
    return (this.kernelBlobstoreClient ??= createTypedServiceClient(
      "blobstore",
      blobstoreMethods,
      this.callKernelService
    ));
  }

  private mainDocs(): DocsClient {
    return (this.docsClient ??= createTypedServiceClient(
      "docs",
      docsMethods,
      this.callMainService
    ));
  }

  private mainEvents(): EventsClient {
    return (this.eventsClient ??= createTypedServiceClient(
      "events",
      eventsMethods,
      this.callKernelService
    ));
  }

  private mainEval(): EvalClient {
    return (this.evalClient ??= createTypedServiceClient(
      "eval",
      evalMethods,
      this.callKernelService
    ));
  }

  private mainExternalOpen(): ExternalOpenClient {
    return (this.externalOpenClient ??= createTypedServiceClient(
      "externalOpen",
      externalOpenMethods,
      this.callMainService
    ));
  }

  /**
   * Describe an injected runtime binding (fs/vcs/…) as the eval ACTUALLY sees it: the live object's
   * own methods, each enriched from the RPC-service schema where names match (or a known ergonomic
   * note). Truthful by construction — it reflects the real surface instead of the raw service, whose
   * low-level wire methods (e.g. fs.handleClose) the ergonomic client hides behind open()→FileHandle.
   * Returns null when the binding exposes no enumerable methods (e.g. a Proxy namespace) so `help()`
   * falls back to the plain service schema.
   */
  private async describeInjectedSurface(
    name: string,
    obj: Record<string, unknown>
  ): Promise<unknown | null> {
    const liveMethods = Object.keys(obj).filter((k) => typeof obj[k] === "function");
    if (liveMethods.length === 0) return null;
    let serviceMethods: Record<string, unknown> = {};
    try {
      const svc = (await this.mainDocs().describeService(name)) as {
        methods?: Record<string, unknown>;
      };
      serviceMethods = svc?.methods ?? {};
    } catch {
      // Not an RPC service (or not describable) — reflection alone still gives the truthful surface.
    }
    return describeEvalBindingSurface(name, liveMethods, serviceMethods);
  }

  /**
   * Per-object runtime id so the server resolves THIS EvalDO's registered entity (and thus
   * the owner's context) for fs/git/vcs — the shared `do-service:<source>:<class>` id can't
   * distinguish owners. Authorized by the internal-DO service bearer, which covers the
   * `do:vibestudio/internal:EvalDO:*` prefix (rpcServer.isRuntimeIdForServiceToken).
   */
  protected override get rpcSelfId(): string {
    const source = String(this.env["WORKER_SOURCE"] ?? "");
    const className = String(this.env["WORKER_CLASS_NAME"] ?? "");
    return `do:${source}:${className}:${this.objectKey}`;
  }

  /**
   * Keep the inbound `respond()` watchdog disabled explicitly: `executeRun` is a HELD handler that
   * legitimately runs for the eval's whole duration (the eval service holds the connection with a
   * no-`headersTimeout` dispatcher). An opt-in `timeoutMs` bounds a run, and a dropped connection
   * (server restart) ends it (reconciled on boot). Quick lifecycle methods resolve at once.
   */
  protected override get respondTimeoutMs(): number {
    return 0;
  }

  // ── public RPC methods (dispatched by the server `eval` service) ──────────────

  @rpc({ principals: ["host"], sensitivity: "write" })
  accept(input: { runId: string; startIntentDigest: string; deadlineAt: number | null }): {
    runId: string;
    status: string;
    acceptedAt: number;
    startIntentDigest: string;
    needsStart: boolean;
  } {
    const existing = this.sql
      .exec(
        `SELECT status, accepted_at, start_intent_digest
         FROM eval_runs_v3 WHERE run_id = ?`,
        input.runId
      )
      .toArray()[0];
    if (existing) {
      const existingDigest = String(existing["start_intent_digest"]);
      if (existingDigest !== input.startIntentDigest) {
        throw Object.assign(new Error("eval idempotency key was reused with different input"), {
          code: "EVAL_IDEMPOTENCY_CONFLICT",
        });
      }
      return {
        runId: input.runId,
        status: String(existing["status"]),
        acceptedAt: Number(existing["accepted_at"]),
        startIntentDigest: existingDigest,
        // The first accept owns launch. A concurrent lost-response retry gets
        // the same handle but never issues a second live invocation lease.
        needsStart: false,
      };
    }
    const acceptedAt = Date.now();
    this.sql.exec(
      `INSERT INTO eval_runs_v3
       (run_id, status, accepted_at, deadline_at, start_intent_digest)
       VALUES (?, 'accepted', ?, ?, ?)`,
      input.runId,
      acceptedAt,
      input.deadlineAt,
      input.startIntentDigest
    );
    this.appendRunEvent(input.runId, "accepted", "accepted");
    this.rearmIdleEviction();
    return {
      runId: input.runId,
      status: "accepted",
      acceptedAt,
      startIntentDigest: input.startIntentDigest,
      needsStart: true,
    };
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
  begin(
    input: RunArgs & {
      runId: string;
      invocationCredential: string;
      authorityPolicy: NonNullable<RunArgs["authorityPolicy"]>;
    }
  ): { runId: string; status: "queued" } {
    const row = this.sql
      .exec(`SELECT status FROM eval_runs_v3 WHERE run_id = ?`, input.runId)
      .toArray()[0];
    if (!row) throw new Error(`eval: unknown accepted run ${input.runId}`);
    if (String(row["status"]) !== "accepted") {
      throw new Error(`eval: run ${input.runId} cannot begin from ${String(row["status"])}`);
    }
    const { invocationCredential, ...durableArgs } = input;
    this.invocationLeases.set(input.runId, {
      credential: invocationCredential,
      policy: input.authorityPolicy,
    });
    this.sql.exec(
      `UPDATE eval_runs_v3
       SET args = ?, agent_ref = ?, channel_id = ?, status = 'queued', manifest_digest = ?
       WHERE run_id = ? AND status = 'accepted'`,
      JSON.stringify(durableArgs),
      input.agentRef ?? null,
      input.channelId ?? null,
      input.manifestDigest ?? null,
      input.runId
    );
    this.appendRunEvent(input.runId, "queued", "queued");
    this.rearmIdleEviction();
    return { runId: input.runId, status: "queued" };
  }

  /** Materialize source and its import closure under the short-lived
   * preparation invocation. The final run principal does not exist yet. */
  @rpc({ principals: ["host"], sensitivity: "write" })
  async prepare(runId: string): Promise<{
    sourceDigest: string;
    executionProvenanceDigest: string;
    scopeInputRevision: string;
  }> {
    this.transition(runId, ["queued"], "preparing", "preparing");
    const row = this.sql.exec(`SELECT args FROM eval_runs_v3 WHERE run_id = ?`, runId).toArray()[0];
    if (!row?.["args"]) throw new Error(`eval: unknown queued run ${runId}`);
    const args = JSON.parse(String(row["args"])) as RunArgs;
    const lease = this.invocationLeases.get(runId);
    if (!lease)
      throw Object.assign(new Error("eval preparation lease was lost"), {
        code: "EVAL_INTERRUPTED",
      });
    const heartbeat = this.startInvocationHeartbeat(runId, lease);
    this.activeRunIds.add(runId);
    const prepared = this.runChain.then(async () => {
      this.currentEvalInvocation = { runId, credential: lease.credential };
      this.currentRunReadOnly = false;
      try {
        if (args.reset === true) this.resetLocked();
        const materialized = await this.materializeSource(runId, args);
        // Runtime factories and the optional CDP facade are trusted execution
        // dependencies, not operations performed by evaluated JavaScript.
        // Resolve them while the source/import/build preparation principal is
        // live so strict/read-only run manifests never need an incidental
        // build capability and adaptive authority census stays code-shaped.
        await this.ensureRuntimeSupport();
        if (this.declaredProviderSource("EVAL_CDP_CLIENT_SOURCE")) {
          await this.ensureCdpModule();
        }
        return materialized;
      } finally {
        this.currentEvalInvocation = null;
        this.currentRunReadOnly = false;
      }
    });
    this.runChain = prepared.then(
      () => undefined,
      () => undefined
    );
    try {
      const result = await prepared;
      if (heartbeat.failure) throw heartbeat.failure;
      return {
        sourceDigest: result.sourceDigest,
        executionProvenanceDigest: result.executionProvenanceDigest,
        scopeInputRevision: result.scopeInputRevision,
      };
    } finally {
      heartbeat.stop();
      this.activeRunIds.delete(runId);
    }
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
  awaitPreauthorization(runId: string): { runId: string; status: "awaiting-preauthorization" } {
    this.transition(runId, ["preparing"], "awaiting-preauthorization", "awaiting-preauthorization");
    return { runId, status: "awaiting-preauthorization" };
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
  authorityChallenge(input: {
    runId: string;
    phase: "preparation" | "run";
    waiting: boolean;
    capability: string;
    resourceKey: string;
  }): { status: string } {
    const waitingStatus =
      input.phase === "preparation" ? "awaiting-preparation-challenge" : "awaiting-challenge";
    const resumedStatus = input.phase === "preparation" ? "preparing" : "running";
    const from = input.waiting
      ? input.phase === "preparation"
        ? ["preparing"]
        : ["running"]
      : [waitingStatus];
    this.transition(
      input.runId,
      from,
      input.waiting ? waitingStatus : resumedStatus,
      input.waiting ? "authority-challenge" : "authority-challenge-resolved"
    );
    this.appendRunEvent(
      input.runId,
      "authority-challenge-detail",
      input.waiting ? waitingStatus : resumedStatus,
      {
        capability: input.capability,
        resourceKey: input.resourceKey,
      }
    );
    return { status: input.waiting ? waitingStatus : resumedStatus };
  }

  /** Rotate from preparation to the final source-bound invocation lease. */
  @rpc({ principals: ["host"], sensitivity: "write" })
  activate(input: {
    runId: string;
    runDigest: string;
    manifestDigest: string;
    invocationCredential: string;
    authorityPolicy: NonNullable<RunArgs["authorityPolicy"]>;
  }): { runId: string; status: "preparing" } {
    const row = this.sql
      .exec(`SELECT status FROM eval_runs_v3 WHERE run_id = ?`, input.runId)
      .toArray()[0];
    if (!["preparing", "awaiting-preauthorization"].includes(String(row?.["status"]))) {
      throw new Error(`eval: run ${input.runId} cannot activate from ${String(row?.["status"])}`);
    }
    this.invocationLeases.set(input.runId, {
      credential: input.invocationCredential,
      policy: input.authorityPolicy,
    });
    this.sql.exec(
      `UPDATE eval_runs_v3 SET run_digest = ?, manifest_digest = ? WHERE run_id = ?`,
      input.runDigest,
      input.manifestDigest,
      input.runId
    );
    this.appendRunEvent(input.runId, "authority-resolved", "preparing", {
      runDigest: input.runDigest,
      manifestDigest: input.manifestDigest,
    });
    return { runId: input.runId, status: "preparing" };
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
  terminate(input: {
    runId: string;
    status: "failed" | "expired" | "interrupted";
    error: string;
    errorCode?: string;
  }): { status: "failed" | "expired" | "interrupted" | "terminal" } {
    const row = this.sql
      .exec(`SELECT status FROM eval_runs_v3 WHERE run_id = ?`, input.runId)
      .toArray()[0];
    const status = String(row?.["status"] ?? "");
    if (isTerminalRunStatus(status)) {
      return { status: "terminal" };
    }
    this.invocationLeases.delete(input.runId);
    const errorCode =
      input.errorCode ??
      (input.status === "expired"
        ? "EVAL_INVOCATION_EXPIRED"
        : input.status === "interrupted"
          ? "EVAL_INTERRUPTED"
          : undefined);
    this.finishRun(
      input.runId,
      input.status,
      {
        success: false,
        console: "",
        error: input.error,
        ...(errorCode ? { errorCode } : {}),
      },
      input.error
    );
    return { status: input.status };
  }

  /**
   * The HELD synchronous execution (one held connection per call from the eval service / panel).
   * Idempotent on `runId`: a concurrent or re-dispatched call SHARES the single in-flight promise
   * rather than starting a second sandbox run — so a deferRedrive that races the first dispatch can
   * never double-run the eval (which would double-spawn headless agents).
   */
  @rpc({ principals: ["host"], sensitivity: "write" })
  async execute(runId: string): Promise<RunResult> {
    const inFlight = this.inFlightRuns.get(runId);
    if (inFlight) return inFlight;
    const promise = this.executeAcceptedRun(runId);
    this.inFlightRuns.set(runId, promise);
    void promise.catch(() => undefined).finally(() => this.inFlightRuns.delete(runId));
    return promise;
  }

  /**
   * Run the sandbox once for `runId`: claim the row (pending → running), execute (serialized via
   * `runChain` so ScopeManager's single enter/exit is never concurrent), and persist the result with
   * a CAS so a concurrent `reset` cancel is never resurrected.
   */
  private async executeAcceptedRun(runId: string): Promise<RunResult> {
    const row = this.sql
      .exec(
        `SELECT status, args, deadline_at, result, manifest_digest, source_bundle_digest, source_digest, run_digest
         FROM eval_runs_v3 WHERE run_id = ?`,
        runId
      )
      .toArray()[0];
    if (!row) return { success: false, console: "", error: `eval: unknown run ${runId}` };
    const claimed = String(row["status"]);
    if (claimed !== "preparing" && claimed !== "awaiting-preauthorization") {
      // Already terminal (idempotent re-dispatch, or cancelled before we claimed it).
      if (isTerminalRunStatus(claimed) && row["result"] != null) {
        return JSON.parse(String(row["result"])) as RunResult;
      }
      return { success: false, console: "", error: `eval: run ${runId} is ${claimed}` };
    }

    const args = JSON.parse(String(row["args"])) as RunArgs;
    const runDigest = row["run_digest"];
    if (typeof runDigest !== "string" || runDigest.length === 0) {
      throw Object.assign(new Error(`eval: run ${runId} has no activated run digest`), {
        code: "EVAL_INVOCATION_INVALID",
      });
    }
    const invocationLease = this.invocationLeases.get(runId);
    if (!invocationLease) {
      const interrupted = {
        success: false,
        console: "",
        error: "eval interrupted before execution; live invocation lease was lost",
        errorCode: "EVAL_INTERRUPTED",
      };
      this.finishRun(runId, "interrupted", interrupted, "live invocation lease was lost");
      return interrupted;
    }
    const deadlineAt = row["deadline_at"] != null ? Number(row["deadline_at"]) : null;
    const controller = new AbortController();
    this.runAborts.set(runId, controller);
    const heartbeat = this.startInvocationHeartbeat(runId, invocationLease, () =>
      controller.abort()
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deadlineExpired = false;
    let deadlineCleanupError: unknown;

    let result: RunResult;
    this.activeRunIds.add(runId);
    try {
      if (deadlineAt != null) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          deadlineExpired = true;
          controller.abort();
          try {
            await this.executeRunCleanupHandlers(runId);
          } catch (error) {
            deadlineCleanupError = error;
          }
        } else {
          timer = setTimeout(() => {
            deadlineExpired = true;
            controller.abort();
            void this.executeRunCleanupHandlers(runId).catch((error) => {
              deadlineCleanupError = error;
              console.error(`[EvalDO] terminal cleanup failed for timed-out run ${runId}`, error);
            });
          }, remaining);
          timer.unref?.();
        }
      }
      if (deadlineExpired) {
        result = {
          success: false,
          console: "",
          error: `eval timed out after ${args.timeoutMs}ms`,
          errorCode: "EVAL_INVOCATION_EXPIRED",
        };
      } else {
        const ran = this.runChain.then(async () => {
          this.transition(runId, ["preparing", "awaiting-preauthorization"], "running", "running");
          const execution = await Promise.allSettled([
            this.authoredCallContext.run({ phase: "run", signal: controller.signal }, () =>
              this.runLocked(
                args,
                controller.signal,
                runId,
                invocationLease,
                String(row["source_bundle_digest"]),
                String(row["source_digest"]),
                runDigest
              )
            ),
          ]);
          const cleanup = await Promise.allSettled([this.executeRunCleanupHandlers(runId)]);
          const executionOutcome = execution[0]!;
          const cleanupOutcome = cleanup[0]!;
          if (executionOutcome.status === "rejected") {
            if (cleanupOutcome.status === "rejected") {
              throw new AggregateError(
                [executionOutcome.reason, cleanupOutcome.reason],
                `eval: run ${runId} execution and terminal cleanup failed`
              );
            }
            throw executionOutcome.reason;
          }
          if (cleanupOutcome.status === "rejected") {
            const cleanupMessage =
              cleanupOutcome.reason instanceof Error
                ? cleanupOutcome.reason.message
                : String(cleanupOutcome.reason);
            return {
              ...executionOutcome.value,
              success: false,
              error: `${executionOutcome.value.error ?? "eval completed"}; terminal cleanup failed: ${cleanupMessage}`,
            };
          }
          return executionOutcome.value;
        });
        this.runChain = ran.catch(() => undefined);
        result = await ran;
      }
      if (heartbeat.failure) throw heartbeat.failure;
      if (deadlineExpired) {
        result = {
          success: false,
          console: result.console,
          error: `eval timed out after ${args.timeoutMs}ms`,
          errorCode: "EVAL_INVOCATION_EXPIRED",
        };
      }
      if (deadlineCleanupError !== undefined) {
        const cleanupMessage =
          deadlineCleanupError instanceof Error
            ? deadlineCleanupError.message
            : String(deadlineCleanupError);
        result = {
          ...result,
          success: false,
          error: `${result.error ?? `eval timed out after ${args.timeoutMs}ms`}; terminal cleanup failed: ${cleanupMessage}`,
        };
      }
    } catch (err) {
      result = {
        success: false,
        console: "",
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && typeof (err as Error & { code?: unknown }).code === "string"
          ? { errorCode: (err as Error & { code: string }).code }
          : {}),
      };
    } finally {
      heartbeat.stop();
      if (timer) clearTimeout(timer);
      this.runAborts.delete(runId);
      this.activeRunIds.delete(runId);
      this.invocationLeases.delete(runId);
      this.currentRunBindings = null;
      this.currentDefinitionProvenance = null;
      this.currentRunAbortSignal = null;
      this.currentRunReadOnly = false;
      this.currentEvalInvocation = null;
      this.runCleanupHandlers.delete(runId);
      this.runCleanupTasks.delete(runId);
      this.runCleanupStarted.delete(runId);
      // Arm best-effort idle-eviction now that the run is done (never fires mid-run — see alarm()).
      this.rearmIdleEviction();
    }

    const terminalResult = this.compactRunResult(result);
    const terminalStatus = terminalResult.success
      ? "succeeded"
      : terminalResult.errorCode === "EVAL_INVOCATION_EXPIRED"
        ? "expired"
        : terminalResult.errorCode === "EVAL_INTERRUPTED"
          ? "interrupted"
          : "failed";
    this.finishRun(runId, terminalStatus, terminalResult, terminalResult.error ?? null);
    const finalStatus = this.sql
      .exec(`SELECT status FROM eval_runs_v3 WHERE run_id = ?`, runId)
      .toArray()[0]?.["status"];
    if (String(finalStatus) === "cancelled") {
      return this.compactRunResult({
        success: false,
        console: result.console,
        error: "eval: run cancelled",
      });
    }
    return terminalResult;
  }

  @rpc({ principals: ["host"], sensitivity: "read" })
  get(runId: string): Record<string, unknown> {
    const row = this.sql.exec(`SELECT * FROM eval_runs_v3 WHERE run_id = ?`, runId).toArray()[0];
    if (!row) throw new Error(`eval: unknown run ${runId}`);
    const status = String(row["status"]);
    const progressRow = this.sql
      .exec(`SELECT progress FROM eval_run_progress_v3 WHERE run_id = ?`, runId)
      .toArray()[0];
    const progress =
      progressRow?.["progress"] != null ? JSON.parse(String(progressRow["progress"])) : undefined;
    const result =
      row["result"] == null
        ? undefined
        : this.withRunProvenance(row, JSON.parse(String(row["result"])) as RunResult);
    return {
      status,
      runId,
      acceptedAt: Number(row["accepted_at"]),
      startedAt: row["started_at"] == null ? null : Number(row["started_at"]),
      endedAt: row["ended_at"] == null ? null : Number(row["ended_at"]),
      deadlineAt: row["deadline_at"] == null ? null : Number(row["deadline_at"]),
      startIntentDigest: String(row["start_intent_digest"]),
      sourceDigest: row["source_digest"] == null ? null : String(row["source_digest"]),
      executionProvenanceDigest:
        row["execution_provenance_digest"] == null
          ? null
          : String(row["execution_provenance_digest"]),
      scopeInputRevision:
        row["scope_input_revision"] == null ? null : String(row["scope_input_revision"]),
      manifestDigest: row["manifest_digest"] == null ? null : String(row["manifest_digest"]),
      runDigest: row["run_digest"] == null ? null : String(row["run_digest"]),
      sourceBundleDigest:
        row["source_bundle_digest"] == null ? null : String(row["source_bundle_digest"]),
      terminalReason: row["terminal_reason"] == null ? null : String(row["terminal_reason"]),
      ...(result ? { result } : {}),
      ...(progress !== undefined ? { progress } : {}),
    };
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
  attachAuthoritySummary(runId: string, authority: unknown): RunResult {
    const row = this.sql.exec(`SELECT * FROM eval_runs_v3 WHERE run_id = ?`, runId).toArray()[0];
    if (!row?.["result"] || !isTerminalRunStatus(String(row["status"]))) {
      throw new Error(`eval: run ${runId} has no terminal result to annotate`);
    }
    const result = this.withRunProvenance(row, {
      ...(JSON.parse(String(row["result"])) as RunResult),
      ...(authority == null ? {} : { authority }),
    });
    this.sql.exec(
      `UPDATE eval_runs_v3 SET result = ? WHERE run_id = ?`,
      JSON.stringify(result),
      runId
    );
    return result;
  }

  private withRunProvenance(row: Record<string, unknown>, result: RunResult): RunResult {
    return {
      ...result,
      provenance: {
        startIntentDigest: String(row["start_intent_digest"]),
        sourceDigest: row["source_digest"] == null ? null : String(row["source_digest"]),
        executionProvenanceDigest:
          row["execution_provenance_digest"] == null
            ? null
            : String(row["execution_provenance_digest"]),
        scopeInputRevision:
          row["scope_input_revision"] == null ? null : String(row["scope_input_revision"]),
        runDigest: row["run_digest"] == null ? null : String(row["run_digest"]),
        sourceBundleDigest:
          row["source_bundle_digest"] == null ? null : String(row["source_bundle_digest"]),
        manifestDigest: row["manifest_digest"] == null ? null : String(row["manifest_digest"]),
        terminalReason: row["terminal_reason"] == null ? null : String(row["terminal_reason"]),
      },
    };
  }

  @rpc({ principals: ["host"], sensitivity: "read" })
  events(runId: string, after = 0): { events: unknown[]; next: number } {
    const exists = this.sql
      .exec(`SELECT 1 AS present FROM eval_runs_v3 WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!exists) throw new Error(`eval: unknown run ${runId}`);
    const rows = this.sql
      .exec(
        `SELECT seq, at, type, status, detail FROM eval_run_events_v3
         WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200`,
        runId,
        after
      )
      .toArray();
    const events = rows.map((event) => ({
      seq: Number(event["seq"]),
      at: Number(event["at"]),
      type: String(event["type"]),
      ...(event["status"] == null ? {} : { status: String(event["status"]) }),
      ...(event["detail"] == null ? {} : { detail: JSON.parse(String(event["detail"])) }),
    }));
    return { events, next: events.length ? Number(events.at(-1)!.seq) : after };
  }

  /**
   * Lossless, bounded retrieval for a large string cached in the durable REPL
   * scope. Reads join `runChain`, so they observe every prior eval's persisted
   * mutations and cannot race a later eval that overwrites the same key.
   */
  @rpc({ principals: ["host"], sensitivity: "read" })
  async readScopeTextPage(
    key: string,
    offset: number,
    limit: number
  ): Promise<{ length: number; encoding: "utf16le-base64"; chunk: string }> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("eval: scope page offset must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > 128 * 1024) {
      throw new Error("eval: scope page limit must be an integer between 1 and 131072");
    }
    const read = this.runChain.then(async () => {
      const manager = await this.ensureScopeManager(await this.ensureEngine());
      const source = manager.current[key];
      if (typeof source !== "string") {
        throw new Error(`eval: scope value ${JSON.stringify(key)} is unavailable or is not text`);
      }
      const chunk = source.slice(offset, offset + limit);
      return {
        length: source.length,
        encoding: "utf16le-base64" as const,
        chunk: utf16leBase64(chunk),
      };
    });
    this.runChain = read.then(
      () => undefined,
      () => undefined
    );
    try {
      return await read;
    } finally {
      this.rearmIdleEviction();
    }
  }

  /** Persistently remove one temporary large-result cache key. */
  @rpc({ principals: ["host"], sensitivity: "destructive" })
  async deleteScopeValue(key: string): Promise<{ ok: boolean; existed: boolean }> {
    const remove = this.runChain.then(async () => {
      const manager = await this.ensureScopeManager(await this.ensureEngine());
      const existed = Object.prototype.hasOwnProperty.call(manager.current, key);
      manager.enterEval();
      try {
        Reflect.deleteProperty(manager.current, key);
      } finally {
        await manager.exitEval();
      }
      return { ok: true, existed };
    });
    this.runChain = remove.then(
      () => undefined,
      () => undefined
    );
    try {
      return await remove;
    } finally {
      this.rearmIdleEviction();
    }
  }

  /** Persist a bounded, JSON-safe heartbeat for the currently executing run. */
  private persistRunProgress(runId: string, progress: unknown): void {
    const exists = this.sql
      .exec(`SELECT 1 AS present FROM eval_runs_v3 WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!exists) throw new Error(`eval: cannot report progress for unknown run ${runId}`);
    let encoded: string;
    try {
      encoded = JSON.stringify(progress);
    } catch (error) {
      throw new Error(
        `eval progress must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (encoded === undefined) throw new Error("eval progress must be JSON-serializable");
    if (encoded.length > 256 * 1024) {
      throw new Error("eval progress exceeds the 256 KiB durable heartbeat limit");
    }
    this.sql.exec(
      `INSERT INTO eval_run_progress_v3 (run_id, progress, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET progress = excluded.progress, updated_at = excluded.updated_at`,
      runId,
      encoded,
      Date.now()
    );
  }

  /** Reset the eval context: cancel in-flight runs, then wipe user tables + scope
   *  while preserving the durable queue and its progress rows. */
  @rpc({ principals: ["host"], sensitivity: "destructive" })
  async reset(): Promise<{ status: "reset" | "waiting-for-safe-boundary" }> {
    // Cancel queued + in-flight runs FIRST so a run finishing normally can't CAS itself `done`
    // (executeRun's write requires status='running'); then abort any live run.
    this.cancelNonterminalRuns("scope reset requested");
    const runIds = new Set([
      ...this.inFlightRuns.keys(),
      ...this.runCleanupHandlers.keys(),
      ...this.runCleanupTasks.keys(),
      ...this.ownedContextRunIds(),
    ]);
    for (const id of runIds) this.runAborts.get(id)?.abort();
    const cleanupResults = await Promise.allSettled(
      [...runIds].map((id) => this.executeRunCleanupHandlers(id))
    );
    const result = this.runChain.then(() => this.resetLocked());
    this.runChain = result.catch(() => undefined);
    let value: { status: "reset" };
    try {
      value = await result;
    } catch (error) {
      const cleanupFailures = this.cleanupFailures(cleanupResults);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "eval: reset and terminal cleanup failed"
        );
      }
      throw error;
    }
    this.throwCleanupFailures(cleanupResults, "reset");
    return value;
  }

  /**
   * Cancel ONE run without touching scope or other runs. CAS the row to `cancelled` FIRST (only if
   * still pending/running) so a late finish loses — `executeAcceptedRun` persists only from a
   * live execution state
   * and its post-write status read returns the cancelled failure instead of resurrecting `done`.
   * Then abort the run's controller so a run wedged on an outbound rpc.call unwinds (the signal is
   * threaded into every outbound call in `runLocked`). A no-op for an already-terminal run.
   */
  @rpc({ principals: ["host"], sensitivity: "destructive" })
  async cancel(runId: string): Promise<{ status: "requested" | "cancelled" | "terminal" }> {
    const row = this.sql
      .exec(`SELECT status FROM eval_runs_v3 WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!row) throw new Error(`eval: unknown run ${runId}`);
    const prior = String(row["status"]);
    if (isTerminalRunStatus(prior)) {
      return { status: "terminal" };
    }
    const inFlight = this.inFlightRuns.has(runId);
    const next = inFlight ? "cancellation-requested" : "cancelled";
    if (inFlight) {
      this.sql.exec(
        `UPDATE eval_runs_v3 SET status = ?, ended_at = NULL, terminal_reason = ? WHERE run_id = ?`,
        next,
        "cooperative cancellation requested",
        runId
      );
    } else {
      this.sql.exec(
        `UPDATE eval_runs_v3 SET status = ?, result = ?, ended_at = ?, terminal_reason = ?
         WHERE run_id = ?`,
        next,
        JSON.stringify(cancelledRunResult()),
        Date.now(),
        "cooperative cancellation requested",
        runId
      );
    }
    this.appendRunEvent(runId, inFlight ? "cancellation-requested" : "terminal", next, {
      reason: "cooperative cancellation requested",
    });
    this.runAborts.get(runId)?.abort();
    await this.executeRunCleanupHandlers(runId);
    return { status: inFlight ? "requested" : "cancelled" };
  }

  private executeRunCleanupHandlers(runId: string): Promise<void> {
    const existing = this.runCleanupTasks.get(runId);
    if (existing) return existing;
    this.runCleanupStarted.add(runId);
    const handlers = [...(this.runCleanupHandlers.get(runId) ?? [])];
    this.runCleanupHandlers.delete(runId);
    const task = (async () => {
      const cleanupController = new AbortController();
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanupDeadline = new Promise<never>((_resolve, reject) => {
        cleanupTimer = setTimeout(() => {
          const error = Object.assign(
            new Error(`eval: run ${runId} cleanup exceeded ${MAX_RUN_CLEANUP_MS}ms`),
            { code: "EVAL_RESOURCE_LIMIT" }
          );
          cleanupController.abort(error);
          reject(error);
        }, MAX_RUN_CLEANUP_MS);
      });
      cleanupTimer?.unref?.();
      const invocationLease = this.invocationLeases.get(runId);
      const cleanupAuthority = await Promise.allSettled([
        handlers.length > 0 && invocationLease
          ? Promise.race([
              this.mainEval().beginCleanup({
                runId,
                credential: invocationLease.credential,
              }),
              cleanupDeadline,
            ])
          : Promise.resolve(undefined),
      ]);
      const cleanupAuthorityOutcome = cleanupAuthority[0]!;
      const handlerResults =
        cleanupAuthorityOutcome.status === "fulfilled"
          ? await Promise.allSettled(
              handlers.map((handler) =>
                Promise.race([
                  Promise.resolve().then(() =>
                    this.authoredCallContext.run(
                      { phase: "cleanup", signal: cleanupController.signal },
                      handler
                    )
                  ),
                  cleanupDeadline,
                ])
              )
            )
          : [cleanupAuthorityOutcome];
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      const contextCleanup = await Promise.allSettled([this.cleanupRunOwnedContexts(runId)]);
      this.throwCleanupFailures([...handlerResults, ...contextCleanup], `run ${runId}`);
    })();
    this.runCleanupTasks.set(runId, task);
    return task;
  }

  private throwCleanupFailures(results: PromiseSettledResult<unknown>[], operation: string): void {
    const failures = this.cleanupFailures(results);
    if (failures.length > 0) {
      const details = failures
        .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
        .join("; ");
      throw new AggregateError(
        failures,
        `eval: terminal cleanup failed during ${operation}: ${details}`
      );
    }
  }

  private cleanupFailures(results: PromiseSettledResult<unknown>[]): unknown[] {
    return results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
  }

  /**
   * Guaranteed recovery for a WEDGED DO: a run stuck on a never-returning outbound call holds
   * `runChain`, so `reset` (which `.then()`s off that chain) would hang behind it. Instead we:
   *  1. CAS every non-terminal run to `cancelled` (so any orphaned run's eventual finish loses its
   *     CAS persist — see `executeAcceptedRun` — and is neutralized; it can never resurrect itself
   *     as terminal success),
   *  2. await every registered terminal-cleanup handler, then abort EVERY in-flight controller (a run
   *     wedged on an outbound rpc.call unwinds via its threaded signal),
   *  3. REPLACE `this.runChain` with a fresh resolved promise — we ORPHAN the stuck chain rather
   *     than `.then()` off it, so we never wait on the wedged run, and
   *  4. run `resetLocked()` synchronously (NOT queued behind the old chain).
   * `resetLocked` only drops user tables + the scope table and nulls `this.scopeManager` (forcing a
   * fresh empty hydrate on the next run); it touches nothing the orphaned run still needs to finish
   * safely — and even if the orphan later runs `exitEval` against the wiped scope, its `cancelled`
   * status already discarded its result, so a fresh run is unaffected.
   */
  @rpc({ principals: ["host"], sensitivity: "destructive" })
  async forceReset(): Promise<{
    status: "requested" | "reset" | "requires-process-restart";
  }> {
    this.cancelNonterminalRuns("force reset requested");
    const runIds = new Set([
      ...this.runAborts.keys(),
      ...this.runCleanupHandlers.keys(),
      ...this.runCleanupTasks.keys(),
      ...this.ownedContextRunIds(),
    ]);
    for (const controller of this.runAborts.values()) controller.abort();
    const cleanupResults = await Promise.allSettled(
      [...runIds].map((id) => this.executeRunCleanupHandlers(id))
    );
    if (this.inFlightRuns.size > 0) {
      return { status: "requires-process-restart" };
    }
    let result: { status: "reset" };
    try {
      result = this.resetLocked();
    } catch (error) {
      const cleanupFailures = this.cleanupFailures(cleanupResults);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "eval: force reset and terminal cleanup failed"
        );
      }
      throw error;
    }
    this.throwCleanupFailures(cleanupResults, "force reset");
    return result;
  }

  private resetLocked(): { status: "reset" } {
    for (const retained of this.retainedModuleRecords()) {
      delete this.moduleMap[retained.specifier];
    }
    this.loadedModuleDigests.clear();
    this.sql.exec(`DELETE FROM eval_retained_modules_v1`);
    const tables = this.sql
      .exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .toArray()
      .map((row) => String(row["name"]))
      .filter((name) => !EVAL_PROTECTED_TABLE_SET.has(name));
    for (const name of tables) {
      this.sql.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    }
    // Drop the scope table (lazily created by SqlScopePersistence) — IF EXISTS so reset
    // works before the first run (e.g. `--fresh-scope`); the next run recreates it empty.
    this.sql.exec(`DROP TABLE IF EXISTS repl_scopes`);
    this.scopeManager = null; // force fresh hydrate (empty) on next run
    return { status: "reset" };
  }

  /**
   * Idle GC. The only alarm we arm is the best-effort idle-eviction alarm; when it fires,
   * discard the in-memory instance to reclaim RAM (`preventEviction` means workerd never
   * evicts us). Scope is already persisted after every run (exitEval), so `abort()` is safe:
   * it preserves SQLite, and the next run lazily reconstructs + rehydrates. The aborted
   * `__alarm` dispatch "fails", but the alarm is best-effort so the AlarmDriver does not
   * re-arm it — no resurrection loop.
   */
  override async alarm(): Promise<void> {
    const durableActivity = this.durableRunActivity();

    // Never evict mid-run. The in-memory map catches normal held executeRun calls, activeRunIds is
    // a second marker tied to the claimed row lifetime, and the durable queue catches async agent
    // runs that are pending before the held dispatch arrives plus reconstruction/race edges.
    if (this.inFlightRuns.size > 0 || this.activeRunIds.size > 0 || durableActivity.count > 0) {
      const inMemoryRunIds = Array.from(
        new Set([...this.inFlightRuns.keys(), ...this.activeRunIds.keys()])
      ).slice(0, 10);
      console.info("[EvalDO] idle eviction alarm", {
        objectKey: this.objectKey,
        inFlightRuns: this.inFlightRuns.size,
        activeRunIds: this.activeRunIds.size,
        inMemoryRunIds,
        durableRuns: durableActivity.count,
        oldestDurableRunStartedAt: durableActivity.oldestStartedAt,
        activeDurableRuns: durableActivity.activeRuns,
        latestRuns: durableActivity.latestRuns,
      });
      this.rearmIdleEviction();
      return;
    }
    // Drop any lingering server-side event subscriptions (e.g. an eval that
    // called vcs.subscribeHead without unsubscribing) BEFORE discarding the
    // instance. The in-memory rpc.on listeners die with the abort, so an
    // un-torn-down server subscription would otherwise re-wake this DO on every
    // matching emit — defeating the idle eviction. A later run can re-subscribe.
    await this.mainEvents()
      .unsubscribeAll()
      .catch(() => {});
    this.ctx.abort("EvalDO: idle eviction (reclaim memory; SQLite preserved)");
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private async runLocked(
    args: RunArgs,
    signal: AbortSignal | undefined,
    runId: string,
    invocationLease: LiveInvocationLease,
    sourceBundleDigest: string,
    expectedSourceDigest: string,
    expectedRunDigest: string
  ): Promise<RunResult> {
    this.currentEvalInvocation = {
      runId,
      credential: invocationLease.credential,
    };
    this.currentRunReadOnly = invocationLease.policy.effects === "read-only";
    this.currentRunAbortSignal = signal ?? null;
    const encodedBundle = await this.kernelBlobstore().getText(sourceBundleDigest);
    if (encodedBundle == null) {
      throw Object.assign(new Error(`eval source bundle ${sourceBundleDigest} is unavailable`), {
        code: "EVAL_INTERRUPTED",
      });
    }
    if ((await this.sha256Text(encodedBundle)) !== expectedSourceDigest) {
      throw Object.assign(new Error("eval source bundle digest mismatch"), {
        code: "EVAL_INVOCATION_INVALID",
      });
    }
    const frozen = JSON.parse(encodedBundle) as FrozenSourceBundle;
    if (frozen.version !== 1)
      throw new Error(`Unsupported eval source bundle version ${frozen.version}`);
    if (
      !frozen.retainedModules ||
      Object.keys(frozen.retainedModules).length > MAX_RETAINED_MODULES
    ) {
      throw Object.assign(new Error("Invalid retained module provenance in eval source bundle"), {
        code: "EVAL_INVOCATION_INVALID",
      });
    }
    for (const [specifier, retained] of Object.entries(frozen.retainedModules)) {
      if (this.loadedModuleDigests.get(specifier) !== retained.digest) {
        delete this.moduleMap[specifier];
        this.loadedModuleDigests.delete(specifier);
      }
    }
    const engine = await this.ensureEngine();
    const support = await this.ensureRuntimeSupport();
    const scopeManager = await this.ensureScopeManager(engine);
    // The hosted runtime's `resolveParent` reads `this.parentMeta` live, so set it
    // before (re)building the host. Server-supplied; defaults to no parent.
    this.parentMeta = args.parent ?? null;
    const rt = this.ensureHostedRuntime(support, args.contextId ?? "");

    // Thread THIS run's abort signal + read-only flag into EVERY outbound rpc.call the eval makes: the
    // abort signal so a `cancel(runId)`/`forceReset()` that aborts `controller` unwinds a run wedged on
    // an outbound call (the rpc client honors `options.signal`), and `readOnly` so a read-only run's
    // service calls are refused by the server dispatcher unless they declare `sensitivity:"read"`.
    const callOptions = this.currentRunCallOptions();
    // `services` is the complete convenience namespace (createServicesProxy): service names that
    // don't collide with runtime bindings are reachable as `services.<name>.<method>(...)`, while
    // rich runtime clients win on collisions (`services.workers` is the same ergonomic `workers`
    // binding). Raw service methods are always reachable with `rpc.call("main", "<svc>.<method>", [...])`.
    // It layers:
    //  1. ergonomic override — when `<name>` is a rich runtime client (vcs/fs/credentials/blobstore/
    //     …), `services.<name>` is that SAME curated object (so `services.vcs` === the bare `vcs`),
    //  2. dynamic fallback — any other service becomes `callMain("<name>.<method>", …)`.
    // It adds no access: the fallback routes through `callMain`, so the server dispatcher's
    // each method's canonical authority declaration remains the sole gate.
    const registeredServiceNames: string[] = [];
    let serviceCatalogLoaded = false;
    const loadRegisteredServiceNames = async (): Promise<readonly string[]> => {
      if (!serviceCatalogLoaded) {
        registeredServiceNames.push(
          ...(await this.mainDocs().listServices()).map((service) => service.name)
        );
        serviceCatalogLoaded = true;
      }
      return registeredServiceNames;
    };
    const services = support.createServicesProxy(rt, registeredServiceNames);

    // Layer 2 — the importable surface (gad/workspace/credentials/openPanel/…)
    // injected ambiently too (same refs as importing the declared runtime
    // module), plus Layer 3 — eval-only ambient state helpers (scope/db/help/…).
    // Help text names the DECLARED runtime module (providers.evalRuntime) —
    // resolvable here because ensureRuntimeSupport already required it.
    const runtimeModuleName = this.requireDeclaredProviderSource(
      "EVAL_RUNTIME_SOURCE",
      "evalRuntime"
    );
    const bindings: Record<string, unknown> = {
      ...rt,
      services,
      ctx: {
        contextId: args.contextId ?? null,
        objectKey: this.objectKey,
        ...(runId
          ? {
              reportProgress: (progress: unknown) => this.persistRunProgress(runId, progress),
              signal,
              onCleanup: (handler: unknown) => {
                if (typeof handler !== "function") {
                  throw new Error("ctx.onCleanup requires a cleanup function");
                }
                if (this.runCleanupStarted.has(runId)) {
                  throw new Error("ctx.onCleanup cannot register after terminal cleanup starts");
                }
                const cleanup = handler as () => void | Promise<void>;
                const handlers = this.runCleanupHandlers.get(runId) ?? new Set();
                if (!handlers.has(cleanup) && handlers.size >= MAX_RUN_CLEANUP_HANDLERS) {
                  throw Object.assign(
                    new Error(`ctx.onCleanup handler limit (${MAX_RUN_CLEANUP_HANDLERS}) exceeded`),
                    { code: "EVAL_RESOURCE_LIMIT" }
                  );
                }
                handlers.add(cleanup);
                this.runCleanupHandlers.set(runId, handlers);
                return () => {
                  const current = this.runCleanupHandlers.get(runId);
                  current?.delete(cleanup);
                  if (current?.size === 0) this.runCleanupHandlers.delete(runId);
                };
              },
              detachContext: (contextId: unknown) => {
                if (typeof contextId !== "string" || contextId.length === 0) {
                  throw new Error("ctx.detachContext requires a non-empty context id");
                }
                return this.detachRunOwnedContext(runId, contextId);
              },
            }
          : {}),
      },
      scope: scopeManager.current,
      scopes: scopeManager.api,
      db: this.dbBinding(),
      // `help()` → discovery for an agent driving eval: the importable runtime
      // surface (what `import {…} from "@workspace/runtime"` gives), the ambient
      // pre-injected globals (do NOT import these), available raw services, and where to look next.
      // `help("<service>")` → that service's methods.
      help: async (serviceName?: string) => {
        if (serviceName !== undefined && typeof serviceName !== "string") {
          return invalidHelpArgumentResponse(serviceName);
        }
        if (serviceName) {
          const dot = serviceName.indexOf(".");
          if (dot > 0) {
            const bindingName = serviceName.slice(0, dot);
            const methodName = serviceName.slice(dot + 1);
            const binding = rt[bindingName];
            if (binding && typeof binding === "object") {
              const described = await this.describeInjectedSurface(
                bindingName,
                binding as Record<string, unknown>
              );
              if (described && typeof described === "object") {
                const surface = described as { methods?: Record<string, unknown> };
                if (surface.methods?.[methodName]) {
                  return {
                    name: serviceName,
                    surface: "injected-runtime-method",
                    method: surface.methods[methodName],
                  };
                }
                return {
                  name: serviceName,
                  surface: "injected-runtime-method",
                  error: `Unknown method ${methodName} on ${bindingName}`,
                  knownMethods: Object.keys(surface.methods ?? {}).sort(),
                };
              }
            }
          }
          // Prefer the INJECTED binding's surface (what eval actually calls) over the raw RPC
          // service — they can diverge (fs's low-level handle* wire methods are hidden behind
          // open()→FileHandle).
          const injected = rt[serviceName];
          if (injected !== undefined) {
            if (injected && typeof injected === "object") {
              const described = await this.describeInjectedSurface(
                serviceName,
                injected as Record<string, unknown>
              );
              if (described) return described;
            }
            // A function/value runtime export (openPanel, getPanelHandle, listPanels, callMain, …) —
            // NOT an RPC service. Point to the docs instead of throwing "Unknown service".
            return {
              name: serviceName,
              surface: "injected-runtime",
              kind: typeof injected,
              note:
                `\`${serviceName}\` is a top-level runtime export from \`${runtimeModuleName}\` (a ` +
                `${typeof injected}) — call it directly, it is not an RPC service. See its signature ` +
                `in skills/sandbox/RUNTIME_API.md (panel APIs: skills/workspace-dev/PANEL_API.md). ` +
                `Use \`help('<name>')\` with a name from the \`services\` list for RPC services.`,
            };
          }
          // Not a rich runtime binding — a plain RPC service. It is reachable as
          // `services.${serviceName}.<method>(...)` (dynamic proxy) or, always, via
          // `rpc.call("main", "${serviceName}.<method>", [...])`.
          return this.mainDocs().describeService(serviceName);
        }
        return {
          // Names only — keeps the eval scope lean. For a service's methods +
          // typed schemas, call help('<name>') (rich bindings show the ergonomic
          // surface) or use the docs_open/docs_search tools (raw catalog).
          services: await loadRegisteredServiceNames(),
          importable: Object.keys(rt).sort(),
          ambient: [...EVAL_AMBIENT_ONLY],
          guidance:
            "Use rich runtime bindings directly (`workers`, `vcs`, `fs`, ...), or import them from " +
            `\`${runtimeModuleName}\`. For raw service catalog methods, use ` +
            '`rpc.call("main", "<svc>.<method>", [...])`; `services.<svc>.<method>(...)` is also available ' +
            "for service names that do not collide with runtime bindings. For rich runtime bindings " +
            "(fs, vcs, credentials, blobstore, gad, workers, …), `services.<name>` is the SAME " +
            "ergonomic client as the bare binding, so raw service-only methods may differ. Call " +
            "help('<name>') for a binding's methods — for the rich bindings this describes what you " +
            "actually call (e.g. fs.open()→FileHandle), not the raw RPC service; or use the " +
            "docs_search/docs_open tools for full typed schemas in the service/runtime catalog. `importable` " +
            `names come from \`import {…} from "${runtimeModuleName}"\`; \`ambient\` names are pre-injected ` +
            "globals and must be used directly. Use the `imports` parameter for npm/workspace packages. " +
            "Full reference: skills/sandbox/EVAL.md.",
        };
      },
    };

    // `chat` binding — pure forwarding to the owning agent DO. Present only when
    // the owner is an agent DO that supplied a channelId (the eval service sets
    // both). The EvalDO carries NO channel/card logic: every ChatSandboxValue
    // method is `agentRef.chatOp(channelId, "<method>", args)`, and the agent
    // performs it AS the agent (correct @agent attribution) and relays the
    // result. `rpc` reuses the already-injected rpc shape.
    // `chat` + `agent` are injected ONLY for agent-owned eval; absent otherwise
    // (CLI/panel eval) — see buildOwnerBindings.
    Object.assign(
      bindings,
      // Same signal threading as `rpcBinding`: the `chat`/`agent` ops the owning agent forwards
      // are outbound rpc.calls too, so a cancelled run unwinds them instead of wedging the chain.
      buildOwnerBindings(args, (t, m, a) => this.rpc.call(t, m, a, callOptions))
    );
    // In path mode, load the entry file. The eval service validates exactly one of
    // `code` or `path`; this fallback remains defensive for direct/internal calls.
    const entryCode = frozen.code;
    const sourcePath = frozen.sourcePath;

    // Lazily build the cdp-client bundle ONLY when this run references CDP. Most
    // evals (fs/vcs/git) never touch it, and the build is a cold-path round-trip
    // that dominated first-run latency. Direct `import "@workspace/cdp-client"`
    // self-heals via the engine's loadImport; this pre-seed is for the
    // `handle.cdp` → loadLightweightClient sync-require path. The check is
    // conservative — every route to the client (the import specifier,
    // `handle.cdp`, `CdpConnection`, `getCdpEndpoint`) contains "cdp", so a
    // no-match guarantees no CDP use; a false positive just restores prior cost.
    if (this.referencesCdp(entryCode, args.imports)) {
      await this.ensureCdpModule();
    }

    // Live console streaming — agent-owned eval only (`agentRef`+`channelId` set by the eval service).
    // Each chunk is forwarded to the owning agent's `onEvalProgress` (gated there by
    // `assertOwnEvalCaller`), which publishes it as an `invocation.output` event so the chat panel
    // renders the console live. CLI/panel eval (no `agentRef`) gets the full console in the result.
    const agentRef = args.agentRef;
    const channelId = args.channelId;
    const agentInvocationId = args.agentInvocationId;
    const streamer =
      agentRef && channelId && agentInvocationId
        ? new ConsoleStreamer((chunk) =>
            this.rpc
              .call(agentRef, "onEvalProgress", [
                { runId, invocationId: agentInvocationId, channelId, output: chunk },
              ])
              .then(() => undefined)
          )
        : null;

    let consoleOutput = "";
    this.currentRunBindings = bindings;
    this.currentDefinitionProvenance = {
      sourceDigest: expectedSourceDigest,
      runDigest: expectedRunDigest,
    };
    scopeManager.enterEval();
    try {
      const result = await engine.executeSandbox(entryCode, {
        syntax: args.syntax ?? "tsx",
        imports: Object.fromEntries(
          Object.entries(frozen.retainedModules).map(([specifier, retained]) => [
            specifier,
            retained.ref,
          ])
        ),
        sourcePath,
        loadImport: this.frozenImportLoader(frozen),
        sourceFiles: frozen.sourceFiles,
        loadSourceFile: sourcePath
          ? async (path: string) => {
              const value = frozen.sourceFiles[path];
              if (value === undefined) {
                throw Object.assign(
                  new Error(`Source file ${path} is absent from the immutable eval bundle`),
                  { code: "EVAL_INVOCATION_INVALID" }
                );
              }
              return value;
            }
          : undefined,
        bindings,
        // Per-object map/require so this owner's loaded imports never leak to other owners
        // sharing the isolate (the engine's global module map is the multi-tenant leak).
        moduleMap: this.moduleMap,
        require: this.engineRequire,
        // Opt-in deadline (timeoutMs) → AbortSignal. Best-effort: the engine may not honor it
        // mid-synchronous-CPU; it fires reliably at await points.
        signal,
        onConsole: (formatted: string) => {
          consoleOutput += (consoleOutput ? "\n" : "") + formatted;
          streamer?.push(formatted);
        },
      });
      for (const [specifier, retained] of Object.entries(frozen.retainedModules)) {
        if (this.moduleMap[specifier] !== undefined) {
          this.loadedModuleDigests.set(specifier, retained.digest);
        }
      }
      // Drain the streamed console before returning — guarantees every chunk lands before the
      // invocation terminal that `onEvalComplete` publishes once `executeRun` returns.
      if (streamer) await streamer.finalFlush();
      const consoleText = result.consoleOutput || consoleOutput;
      // Recoverable large output: the harness windows console/return for the
      // model, losing the tail. Stash a bounded copy into the persistent scope so
      // the agent can page/grep it in a follow-up eval. Overwritten each run (not
      // accumulated), and cleared when output is small, so scope can't balloon.
      this.spillLargeOutput(scopeManager.current, consoleText, result.returnValue);
      return {
        success: result.success,
        console: consoleText,
        returnValue: result.returnValue,
        error: result.error,
        errorCode: result.errorCode,
        scopeKeys: Object.keys(scopeManager.current),
      };
    } finally {
      await scopeManager.exitEval();
    }
  }

  private currentRunCallOptions<T extends Record<string, unknown> | undefined>(opts?: T): T {
    const authoredContext = this.authoredCallContext.getStore();
    const signal =
      authoredContext?.signal ??
      (authoredContext === undefined ? this.currentRunAbortSignal : null);
    const evalInvocation = this.currentEvalInvocation;
    if (!evalInvocation) {
      throw Object.assign(new Error("Eval runtime call has no active invocation authority"), {
        code: "EVAL_INVOCATION_INVALID",
      });
    }
    return {
      ...(opts ?? {}),
      ...(signal ? { signal } : {}),
      ...(this.currentRunReadOnly ? { readOnly: true } : {}),
      evalInvocation,
    } as unknown as T;
  }

  /** Keep the invocation credential short-lived even for long-running code or
   * a visible approval wait. This is a trusted kernel call and deliberately
   * does not carry the evaluated invocation metadata. */
  private startInvocationHeartbeat(
    runId: string,
    lease: LiveInvocationLease,
    onFailure?: (error: Error) => void
  ): { readonly failure: Error | null; stop(): void } {
    let stopped = false;
    let pending = false;
    let failure: Error | null = null;
    const pulse = async (): Promise<void> => {
      if (stopped || pending || failure) return;
      pending = true;
      try {
        await this.mainEval().renew({ runId, credential: lease.credential });
      } catch (cause) {
        const error = Object.assign(
          new Error(
            `Eval invocation lease renewal failed: ${cause instanceof Error ? cause.message : String(cause)}`
          ),
          {
            code:
              cause instanceof Error &&
              typeof (cause as Error & { code?: unknown }).code === "string"
                ? (cause as Error & { code: string }).code
                : "EVAL_INTERRUPTED",
          }
        );
        failure = error;
        onFailure?.(error);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void pulse(), 10_000);
    return {
      get failure() {
        return failure;
      },
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private frozenImportLoader(frozen: FrozenSourceBundle): EvalImportLoader {
    const loader = async (specifier: string, ref: string | undefined): Promise<string> => {
      const direct = frozen.importBundles[`${specifier}\0${ref ?? ""}`];
      const latest = frozen.importBundles[`${specifier}\0latest`];
      const bundle = direct ?? latest;
      if (bundle === undefined) {
        throw Object.assign(
          new Error(`Import ${specifier} was not materialized into the immutable eval bundle`),
          { code: "EVAL_INVOCATION_INVALID" }
        );
      }
      return bundle;
    };
    return Object.assign(loader, {
      resolveWorkspaceImport: async (specifier: string) =>
        frozen.workspaceImports.includes(specifier),
    });
  }

  private compactRunResult(result: RunResult): RunResult {
    const compact: RunResult = {
      success: result.success,
      console: this.windowText(result.console, RESULT_CONSOLE_MAX_CHARS, "$lastConsole"),
      ...(result.error
        ? { error: this.windowText(result.error, RESULT_ERROR_MAX_CHARS, "$lastConsole") }
        : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.scopeKeys ? { scopeKeys: result.scopeKeys.slice(0, 500) } : {}),
      ...(result.authority !== undefined ? { authority: result.authority } : {}),
      ...(result.provenance !== undefined ? { provenance: result.provenance } : {}),
    };
    if (result.returnValue !== undefined) {
      compact.returnValue = this.compactReturnValue(result.returnValue);
    }

    let encoded = JSON.stringify(compact);
    if (encoded.length <= RESULT_STORAGE_MAX_CHARS) return compact;

    const fallback: RunResult = {
      success: compact.success,
      console: this.windowText(compact.console, 20_000, "$lastConsole"),
      ...(compact.error ? { error: this.windowText(compact.error, 10_000, "$lastConsole") } : {}),
      ...(compact.errorCode ? { errorCode: compact.errorCode } : {}),
      ...(compact.returnValue !== undefined
        ? {
            returnValue: {
              truncated: true,
              reason: "eval return value exceeded result storage limit",
              scopeKey: "$lastReturn",
            },
          }
        : {}),
      ...(compact.scopeKeys ? { scopeKeys: compact.scopeKeys.slice(0, 200) } : {}),
    };
    encoded = JSON.stringify(fallback);
    if (encoded.length <= RESULT_STORAGE_MAX_CHARS) return fallback;

    return {
      success: result.success,
      console:
        "[eval] Result exceeded the EvalDO storage limit. Large console/return data may be available in scope.$lastConsole and scope.$lastReturn.",
      ...(result.error ? { error: this.windowText(result.error, 10_000, "$lastConsole") } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.scopeKeys ? { scopeKeys: result.scopeKeys.slice(0, 100) } : {}),
    };
  }

  private compactReturnValue(returnValue: unknown): unknown {
    const text = this.stringifyForResult(returnValue);
    if (text.length <= RESULT_RETURN_PREVIEW_CHARS) return returnValue;
    return {
      truncated: true,
      reason: "eval return value exceeded result transport/storage limit",
      originalChars: text.length,
      scopeKey: "$lastReturn",
      preview: this.windowText(text, RESULT_RETURN_PREVIEW_CHARS, "$lastReturn"),
    };
  }

  private stringifyForResult(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }

  private windowText(text: string, maxChars: number, scopeKey: string): string {
    if (text.length <= maxChars) return text;
    const head = Math.floor(maxChars * 0.7);
    const tail = maxChars - head;
    const elided = text.length - maxChars;
    return (
      `${text.slice(0, head)}\n` +
      `[eval output truncated: ${elided} of ${text.length} chars elided. ` +
      `Read scope.${scopeKey} in pages, e.g. return scope.${scopeKey}.slice(0, 40000).]\n` +
      `${text.slice(-tail)}`
    );
  }

  /**
   * Keep the previous return value available for REPL-style follow-up calls.
   * Small values retain their structured form (`scope.$lastReturn.methods`,
   * etc.); large values spill as a bounded JSON/text string suitable for
   * paging. Console spill remains large-output-only.
   */
  private spillLargeOutput(
    scope: Record<string, unknown>,
    console: string,
    returnValue: unknown
  ): void {
    const THRESHOLD = 50_000; // ≤ the harness window — anything windowed IS spilled
    const MAX = 1_000_000; // hard cap so the persisted scope can't balloon
    const stash = (key: string, text: string): void => {
      if (text.length <= THRESHOLD) {
        Reflect.deleteProperty(scope, key);
        return;
      }
      scope[key] =
        text.length > MAX
          ? `${text.slice(0, MAX)}\n…[${text.length - MAX} more chars dropped]`
          : text;
    };
    stash("$lastConsole", console);
    if (returnValue === undefined) {
      Reflect.deleteProperty(scope, "$lastReturn");
      return;
    }
    let returnText: string;
    try {
      returnText = JSON.stringify(returnValue, null, 2) ?? String(returnValue);
    } catch {
      returnText = String(returnValue);
    }
    if (returnText.length <= THRESHOLD) {
      scope["$lastReturn"] = returnValue;
    } else {
      scope["$lastReturn"] =
        returnText.length > MAX
          ? `${returnText.slice(0, MAX)}\n…[${returnText.length - MAX} more chars dropped]`
          : returnText;
    }
  }

  /**
   * A manifest-declared provider source from an env binding. The server derives
   * these bindings from `workspace/meta/vibestudio.yml`'s `providers.*` slots when
   * it generates the internal-DO workerd config — the EvalDO itself carries no
   * workspace unit names.
   */
  private declaredProviderSource(binding: string): string | null {
    const value = this.env[binding];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  private requireDeclaredProviderSource(binding: string, slot: string): string {
    const source = this.declaredProviderSource(binding);
    if (!source) {
      throw new Error(
        `eval: no \`providers.${slot}\` is declared in meta/vibestudio.yml for this workspace — eval is disabled`
      );
    }
    return source;
  }

  /**
   * Bootstrap the shared isolate globals: the UnsafeEval-backed compile
   * function (`new Function` is blocked in workerd), the global module map, and
   * the global require. Mirrors the worker bundle bootstrap. Returns the map.
   */
  private ensureIsolateModuleGlobals(): Record<string, unknown> {
    const g = globalThis as GlobalBag;
    const unsafeEval = this.env["UNSAFE_EVAL"] as UnsafeEvalBinding | undefined;
    if (!unsafeEval) throw new Error("EvalDO: UNSAFE_EVAL binding not configured");
    g["__vibestudioCompileFunction__"] = (argNames: string[], body: string) =>
      unsafeEval.newFunction(body, "eval", ...argNames);
    const moduleMap = (g["__vibestudioModuleMap__"] ??= {}) as Record<string, unknown>;
    g["__vibestudioRequire__"] = (id: string): unknown => {
      const mod = moduleMap[id];
      if (mod) return mod;
      throw new Error(`Module "${id}" not available in EvalDO. Use the imports parameter for npm.`);
    };
    return moduleMap;
  }

  /**
   * Build `specifier` as a worker library bundle via the build service and
   * execute it into the shared isolate module map (via the UnsafeEval compiler
   * — `new Function` is blocked even for this bootstrap step). Idempotent per
   * specifier. Only stateless library modules belong in the SHARED map.
   */
  private async loadLibraryModule(
    specifier: string,
    opts: { externals?: string[] } = {}
  ): Promise<unknown> {
    const g = globalThis as GlobalBag;
    const moduleMap = this.ensureIsolateModuleGlobals();
    if (!moduleMap[specifier]) {
      const built = await this.mainBuild().getBuild(specifier, undefined, {
        library: true,
        externals: opts.externals ?? [],
        libraryTarget: "worker",
      });
      const bundle = requireBuildBundleResult(
        built,
        `EvalDO: build.getBuild did not return a library bundle for ${specifier}`
      );
      const compile = g["__vibestudioCompileFunction__"] as (
        a: string[],
        b: string
      ) => (...args: unknown[]) => unknown;
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const fn = compile(["require", "exports", "module"], bundle);
      fn(g["__vibestudioRequire__"], exports, module);
      moduleMap[specifier] = module.exports;
    }
    return moduleMap[specifier];
  }

  /**
   * Dynamically load the manifest-declared eval engine
   * (`providers.evalEngine` in meta/vibestudio.yml — injected as the
   * `EVAL_ENGINE_SOURCE` binding). It is NOT statically bundled here — keeps
   * the internal bundle lean, lets the volatile engine update without a kernel
   * rebuild, and keeps host code free of hardcoded workspace unit names.
   */
  private async ensureEngine(): Promise<EvalEngine> {
    if (this.engine) return this.engine;
    const engineSource = this.requireDeclaredProviderSource("EVAL_ENGINE_SOURCE", "evalEngine");
    const moduleMap = this.ensureIsolateModuleGlobals();
    const loaded = await this.loadLibraryModule(engineSource, {
      externals: Object.keys(moduleMap),
    });
    this.engine = loaded as EvalEngine;
    return this.engine;
  }

  /**
   * Load the hosted-runtime/panel-runtime factories + portable helpers from
   * the manifest-declared runtime unit (`providers.evalRuntime` — injected as
   * `EVAL_RUNTIME_SOURCE`). Contract: the unit exposes `./hosted`,
   * `./panel-runtime`, and `./portable` export subpaths (the same modules
   * panels/workers build against). Loaded via the build service like the
   * engine — the host prod bundle carries ZERO static `@workspace` imports —
   * and cached in the shared isolate map (pure stateless factories, safe to
   * share across owners). `externals: []` matches the server's boot pre-warm
   * so the cold build is usually already cached.
   */
  private async ensureRuntimeSupport(): Promise<RuntimeSupportModule> {
    if (this.runtimeSupport && this.portableHelpers) return this.runtimeSupport;
    const runtimeSource = this.requireDeclaredProviderSource("EVAL_RUNTIME_SOURCE", "evalRuntime");
    const [hosted, panelRuntime, portable] = await Promise.all([
      this.loadLibraryModule(`${runtimeSource}/hosted`),
      this.loadLibraryModule(`${runtimeSource}/panel-runtime`),
      this.loadLibraryModule(`${runtimeSource}/portable`),
    ]);
    const support = {
      ...(panelRuntime as Record<string, unknown>),
      ...(hosted as Record<string, unknown>),
    };
    for (const name of [...RUNTIME_HOSTED_FACTORIES, ...RUNTIME_PANEL_FACTORIES]) {
      if (typeof support[name] !== "function") {
        throw new Error(
          `eval: the declared runtime unit ${runtimeSource} (providers.evalRuntime) does not export ` +
            `${name} from its ./hosted or ./panel-runtime subpath`
        );
      }
    }
    this.portableHelpers = { ...(portable as Record<string, unknown>) };
    this.runtimeSupport = support as unknown as RuntimeSupportModule;
    return this.runtimeSupport;
  }

  private async ensureScopeManager(engine: EvalEngine): Promise<ScopeManagerLike> {
    if (this.scopeManager) return this.scopeManager;
    const blobstore = this.kernelBlobstore();
    const persistence = new engine.SqlScopePersistence(this.sql, {
      putText: (valueJson: string) => blobstore.putText(valueJson),
      getText: (digest: string) => blobstore.getText(digest),
    });
    const mgr = new engine.ScopeManager({
      channelId: this.objectKey, // one scope per EvalDO instance
      panelId: "eval",
      persistence,
      executableCodec: this.scopeExecutableCodec,
    });
    // MUST await hydrate before the manager is used: enterEval/exitEval read &
    // re-persist `current`, so a run that proceeds before the prior scope loads
    // would execute with an empty scope and then OVERWRITE the persisted scope on
    // exit (cold-start data loss). loadCurrent is safe pre-write (ensureSchema
    // created the table in the persistence ctor) and returns empty on a fresh DO.
    await mgr.hydrate();
    this.scopeManager = mgr;
    return mgr;
  }

  /** loadImport over the build service (same on-demand build surface as the in-app eval tool). */
  private makeLoadImport(): EvalImportLoader {
    // Eval is a distinct library target: ordinary packages retain worker-safe
    // fallbacks while host-injected packages (notably @workspace/runtime) expose
    // their richer, run-neutral eval surface for static analysis.
    return createEvalImportLoader(this.mainBuild(), "eval", {
      defaultWorkspaceRef: () => {
        const contextId = this.hostedRuntimeIdentity?.contextId;
        return contextId ? `ctx:${contextId}` : undefined;
      },
    });
  }

  private async readSourceFile(path: string): Promise<string> {
    const contents = await this.mainFs().readFile(path, "utf8");
    if (typeof contents !== "string") {
      throw new Error(`fs.readFile returned non-text content for eval source file: ${path}`);
    }
    return contents;
  }

  /**
   * Build the portable runtime surface once, via the ONE shared
   * `createHostedRuntime` — identical to panel/worker. `import { … } from
   * "@workspace/runtime"` resolves to `rt` (seeded into the per-object module
   * map). `host.rpc` is the real `createRpcClient` (so `vcs.subscribeHead` /
   * `workspace.units.watch` receive server→DO pushes), and `panelRuntime` is
   * fed the real `rpc.on` (no `()=>()=>{}` no-op).
   */
  private ensureHostedRuntime(
    support: RuntimeSupportModule,
    contextId: string
  ): WorkspaceRuntimeLike {
    if (this.hostedRuntime) {
      const prev = this.hostedRuntimeIdentity;
      if (prev && prev.contextId !== contextId) {
        throw new Error(
          `eval: hosted-runtime identity drift — this EvalDO was initialized with contextId=${prev.contextId} but a run requested contextId=${contextId}. ` +
            `A warm EvalDO serves one owner; this indicates a routing/ownership bug.`
        );
      }
      return this.hostedRuntime;
    }
    // Per-run containment: wrap outbound calls so the current eval run's abort signal/read-only flag
    // is added to every authored service/runtime call. The proxy is stable and reads live fields, so
    // cached imports of @workspace/runtime remain correct across runs. DO-infrastructure calls use
    // `this.rpc` directly (unwrapped), so durable/trajectory writes are never read-only-blocked.
    const baseRpc = this.rpc;
    const rpc = new Proxy(baseRpc, {
      get: (t, prop, receiver) => {
        if (prop !== "call" && prop !== "stream" && prop !== "streamReadable") {
          return Reflect.get(t, prop, receiver);
        }
        return (...callArgs: unknown[]) => {
          const opts = callArgs[3] as Record<string, unknown> | undefined;
          const merged = this.currentRunCallOptions(opts);
          if (prop === "call") {
            return this.callAuthoredRpc(
              String(callArgs[0]),
              String(callArgs[1]),
              callArgs[2] as unknown[],
              merged
            );
          }
          return (Reflect.get(baseRpc, prop) as (...args: unknown[]) => Promise<unknown>)(
            callArgs[0],
            callArgs[1],
            callArgs[2],
            merged
          );
        };
      },
    }) as typeof baseRpc;
    const gatewayFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
        throw new Error(
          `gatewayFetch: only gateway-relative absolute paths are allowed (got ${JSON.stringify(path)})`
        );
      }
      const probe = new Request(`http://eval-gateway.invalid${path}`, init);
      const bodyBuffer = await probe.arrayBuffer();
      const body =
        bodyBuffer.byteLength === 0
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(bodyBuffer));
                controller.close();
              },
            });
      return rpc.stream(
        "main",
        "gateway.fetch",
        [
          {
            path: probe.url.slice("http://eval-gateway.invalid".length),
            method: probe.method,
            headers: Object.fromEntries(probe.headers.entries()),
          },
        ],
        { signal: init.signal ?? undefined, body }
      );
    };
    const panelRuntime = support.createPanelRuntime({
      rpc,
      selfHandle: () => support.createRuntimeSelfHandle({ id: this.rpcSelfId }),
      // A panel openPanel()'d without an explicit parentId defaults to the eval owner's nearest panel
      // ancestor (server-resolved into this.parentMeta), so an agent/eval launch nests UNDER its owning
      // panel — parity with a panel, which defaults to its own id. A function (not a value) because the
      // runtime is cached while parentMeta is set/re-resolved per run — read live, like resolveParent.
      defaultOpenParentId: () => this.parentMeta?.parentId ?? null,
    });
    const host: Record<string, unknown> = {
      id: this.rpcSelfId,
      contextId,
      rpc,
      fs: support.createRpcFs(rpc),
      gatewayConfig: null,
      gatewayFetch,
      panelRuntime,
      workers: support.createWorkerdClient(rpc),
      openExternal: (url: string, options?: unknown) =>
        this.mainExternalOpen().openExternal(
          url,
          options as Parameters<ExternalOpenClient["openExternal"]>[1]
        ),
      // The owner's nearest panel ancestor (server-supplied via RunArgs.parent →
      // this.parentMeta). Read live so the cached host reflects a re-resolved
      // parent. null when the owner has no panel ancestor.
      resolveParent: () =>
        this.parentMeta
          ? support.createRuntimeParentHandle(
              (pid) => panelRuntime.getPanelHandle(pid),
              this.parentMeta.parentId,
              this.parentMeta.parentEntityId,
              this.parentMeta.parentKind
            )
          : null,
    };
    const rt = support.createHostedRuntime(host);
    const runtimeFs = rt["fs"];
    if (!runtimeFs || typeof runtimeFs !== "object") {
      throw new Error("eval: hosted runtime did not expose its scoped filesystem");
    }
    Object.assign(this.moduleMap, createEvalNodeCompat(runtimeFs as Record<string, unknown>));
    // The declared runtime module in eval (e.g. `@workspace/runtime`) = the
    // hosted runtime instance + the pure authoring helpers
    // (z/defineContract/journal/…), matching panel/worker barrels. Keyed by the
    // manifest-declared unit name so `import { … } from "<declared runtime>"`
    // resolves to it.
    const runtimeModuleKey = this.requireDeclaredProviderSource(
      "EVAL_RUNTIME_SOURCE",
      "evalRuntime"
    );
    this.moduleMap[runtimeModuleKey] = { ...rt, ...(this.portableHelpers ?? {}) };
    this.hostedRuntime = rt;
    this.hostedRuntimeIdentity = { contextId };
    return rt;
  }

  /**
   * Conservative check: does this run reference CDP at all? Used to gate the
   * (cold-path) cdp-client build. Any route to the client contains the substring
   * "cdp" — the declared cdp-client import, `handle.cdp`, `CdpConnection`,
   * `getCdpEndpoint` — so a no-match means no CDP and a false positive only
   * restores the prior unconditional cost. Imports map values are checked too
   * (an explicit `{ "x": "<declared cdp client>" }` alias).
   */
  private referencesCdp(code: string, imports?: Record<string, string>): boolean {
    if (/cdp/i.test(code)) return true;
    if (imports && Object.values(imports).some((spec) => /cdp/i.test(spec))) return true;
    return false;
  }

  /**
   * Make the manifest-declared CDP client (`providers.cdpClient` — injected as
   * `EVAL_CDP_CLIENT_SOURCE`) importable in eval (full CDP commands+events from
   * a connectionless DO). Loaded via the build service like the engine — robust
   * to the internal-DO bundle's module resolution — and cached in the shared
   * isolate map (the client is stateless, so cross-owner sharing is safe,
   * unlike per-owner user imports). No declared provider ⇒ CDP support is
   * disabled (logged once); eval imports of an undeclared module fail with the
   * regular module-resolution diagnostic.
   */
  private async ensureCdpModule(): Promise<void> {
    if (this.cdpLoaded) return;
    const cdpSource = this.declaredProviderSource("EVAL_CDP_CLIENT_SOURCE");
    if (!cdpSource) {
      if (!this.warnedNoCdpProvider) {
        this.warnedNoCdpProvider = true;
        console.warn(
          "[eval] run references CDP but no `providers.cdpClient` is declared in meta/vibestudio.yml — CDP module not preloaded"
        );
      }
      return;
    }
    const globalMap = this.ensureIsolateModuleGlobals();
    const loaded = (await this.loadLibraryModule(cdpSource, {
      externals: Object.keys(globalMap),
    })) as { CdpConnection?: unknown } | undefined;
    if (typeof loaded?.CdpConnection !== "function") {
      // The default (".") library entry must re-export BOTH `CdpConnection`
      // (for `import {CdpConnection}`) and the browser impl (for
      // `handle.cdp.lightweightPage()` via loadLightweightClient). A missing
      // CdpConnection means the build resolved the wrong entry.
      throw new Error(
        `EvalDO: ${cdpSource} (providers.cdpClient) did not expose CdpConnection (wrong build entry?)`
      );
    }
    // Seed BOTH maps: the per-object map backs `import {…} from "<declared cdp client>"`
    // (engine resolution); the global map (seeded by loadLibraryModule) backs
    // `handle.cdp`'s `loadLightweightClient`, which resolves via the global
    // `__vibestudioRequire__`.
    this.moduleMap[cdpSource] = loaded;
    this.cdpLoaded = true;
  }

  /** Synchronous in-DO SQLite, with reserved-table guards enforced on every statement. */
  private dbBinding(): unknown {
    const sql = this.sql;
    const guard = (query: string) => {
      if (DESTRUCTIVE_STMT.test(query) && RESERVED_TABLE.test(query.replace(/["'`]/g, ""))) {
        throw new Error(
          "db: refusing to modify a reserved table (state / repl_scopes / sqlite_*). Use your own table names."
        );
      }
    };
    return {
      exec(query: string, ...bindings: unknown[]): unknown[] {
        guard(query);
        return sql.exec(query, ...bindings).toArray();
      },
      run(query: string, ...bindings: unknown[]): void {
        guard(query);
        sql.exec(query, ...bindings);
      },
    };
  }
}
