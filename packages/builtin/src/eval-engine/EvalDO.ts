import {
  DurableObjectBase,
  schemaRpc,
  type DurableObjectContext,
  type LifecyclePrepareInput,
  type LifecycleResumeInput,
} from "@vibestudio/durable";
import * as asyncHooks from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  type RpcCallOptions,
  type RpcCausalParent,
  type RpcClient,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import { bindExecutionSession } from "@vibestudio/rpc/internal";
import {
  createBuildServiceClient,
  createEvalImportLoader,
  requireBuildBundleResult,
  type BuildServiceClient,
  type EvalImportLoader,
} from "@vibestudio/service-schemas/clients/evalImportLoader";
import { executionArtifactRefSchema } from "@vibestudio/service-schemas/build";
import { externalOpenMethods } from "@vibestudio/service-schemas/externalOpen";
import {
  EVAL_RESULT_RETURN_PREVIEW_CHARS,
  evalLifecycleFailureCodes,
} from "@vibestudio/service-schemas/eval";
import { evalEngineMethods } from "@vibestudio/service-schemas/evalEngine";
import { evalEventIngressMethods } from "@vibestudio/service-schemas/evalEventIngress";
import { evalExecutionRootsMethods } from "@vibestudio/service-schemas/evalExecutionRoots";
import { fsMethods } from "@vibestudio/service-schemas/fs";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import { docsMethods } from "@vibestudio/service-schemas/docs";
import {
  externalWaitResource,
  progressSemanticsForRpcMethod,
} from "@vibestudio/service-schemas/progressSemantics";
import { EVAL_AMBIENT_ONLY } from "@vibestudio/service-schemas/runtime/runtimeSurface.eval";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { buildOwnerBindings } from "./evalOwnerBindings.js";
import { ConsoleStreamer } from "./consoleStreamer.js";
import {
  describeEvalBindingIndex,
  describeEvalBindingSurface,
  describeEvalMethod,
  EVAL_RUNTIME_METHOD_NOTES,
  evalRuntimeServiceName,
  invalidHelpArgumentResponse,
} from "./evalSurfaceHelp.js";
import { createEvalNodeCompat } from "./evalNodeCompat.js";
import { freezeModuleNamespace } from "./moduleNamespace.js";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { createPrivateGuestGlobal } from "@vibestudio/shared/evalConfinement";

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
 *  - compiles via the workerd `UNSAFE_EVAL` binding (`new Function` is blocked in workerd),
 *    passed explicitly into the engine and never published on the isolate global,
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

/** Reserved tables the user `db` may not DROP/DELETE/ALTER — base state, scope, sqlite internals. */
const RESERVED_TABLE = /\b(state|repl_scopes|sqlite_[A-Za-z0-9_]*)\b/i;
const DESTRUCTIVE_STMT = /^\s*(DROP|DELETE|ALTER|UPDATE|INSERT|REPLACE|TRUNCATE|CREATE)\b/i;

const RESULT_CONSOLE_MAX_CHARS = 80_000;
const RESULT_ERROR_MAX_CHARS = 20_000;
const RESULT_STORAGE_MAX_CHARS = 250_000;
const CANCELLATION_GRACE_MS = 5_000;
const MAX_KERNEL_IDLE_LEASE_MS = 60 * 60 * 1_000;
/** Bounded EvalDO-side terminal-push redelivery (receivers dedupe). */
const RESULT_REDELIVERY_MAX_ATTEMPTS = 3;
const RESULT_REDELIVERY_BASE_DELAY_MS = 5_000;

const EVAL_SCHEMA_TABLES = [
  "runs",
  "run_progress",
  "run_checkpoints",
  "run_events",
  "eval_execution_roots",
  "eval_result_redeliveries",
] as const;

interface RunCleanupPhase {
  active: boolean;
  revoked: boolean;
}

interface EvalCancelResult {
  ok: true;
  forcedReset: boolean;
}

type EvalRunStatusValue =
  | "pending"
  | "running"
  | "cancelling"
  | "done"
  | "cancelled"
  | "approval-route-lost";

type TimedSettlement<T> = { settled: true; value: T } | { settled: false };

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedSettlement<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ settled: false });
    }, timeoutMs);
    timer.unref?.();
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ settled: true, value });
    });
  });
}

type BoundaryHarden = <T>(value: T) => T;

/**
 * Source-test fallback for the production SES hardener installed by
 * workerdEntry. Keep it shallow: recursively freezing Vitest spies or Node
 * native compatibility objects would mutate the test runner rather than model
 * the already-locked-down workerd realm.
 */
const fallbackHarden: BoundaryHarden = <T>(value: T): T => {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.freeze(value);
  }
  return value;
};

function hardenBoundary<T>(value: T): T {
  const sesHarden = (globalThis as { harden?: BoundaryHarden }).harden;
  return (sesHarden ?? fallbackHarden)(value);
}

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
  failureKind?: "user-code" | "infrastructure" | "cancelled";
  failureCode?: string;
  errorData?: unknown;
}

interface ScopeManagerLike {
  readonly current: Record<string, unknown>;
  readonly api: unknown;
  hydrate(): Promise<ScopeRecovery>;
  persist(): Promise<void>;
  enterEval(): void;
  exitEval(): Promise<void>;
}

interface ScopeRecovery {
  restored: string[];
  lost: string[];
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
  executeSandbox(code: string, options: Record<string, unknown>): Promise<SandboxResult>;
  ScopeManager: new (opts: {
    channelId: string;
    panelId: string;
    persistence: unknown;
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
  createGatewayFetch(config: Record<string, unknown>): unknown;
  createRpcFs(rpc: unknown, options?: Record<string, unknown>): unknown;
  createRuntimeParentHandle(
    getPanelHandle: (panelId: string) => unknown,
    parentId: string,
    parentEntityId: string,
    parentKind?: "panel" | "worker" | "do"
  ): unknown;
  createWorkerdClient(rpc: unknown): unknown;
  createPanelRuntime(options: Record<string, unknown>): PanelRuntimeApiLike;
  createRuntimeSelfHandle(options: { id: string }): unknown;
}

/** The `./hosted` + `./panel-runtime` factory names the EvalDO requires. */
const RUNTIME_HOSTED_FACTORIES = [
  "createHostedRuntime",
  "createGatewayFetch",
  "createRpcFs",
  "createRuntimeParentHandle",
  "createWorkerdClient",
] as const;
const RUNTIME_PANEL_FACTORIES = ["createPanelRuntime", "createRuntimeSelfHandle"] as const;

type FsClient = TypedServiceClient<typeof fsMethods>;
type BlobstoreClient = TypedServiceClient<typeof blobstoreMethods>;
type DocsClient = TypedServiceClient<typeof docsMethods>;
type ExternalOpenClient = TypedServiceClient<typeof externalOpenMethods>;

/** One run's immutable outbound authority/provenance boundary. */
interface EvalExecutionContext {
  readonly rpc: RpcClient;
  readonly signal?: AbortSignal;
  readonly contextId: string;
  readonly runId?: string;
  readonly build: BuildServiceClient;
  readonly fs: FsClient;
  readonly blobstore: BlobstoreClient;
  readonly docs: DocsClient;
  readonly externalOpen: ExternalOpenClient;
}

interface RunArgs {
  code?: string;
  path?: string;
  /** Virtual context-relative filename/base for inline code and relative imports. */
  sourcePath?: string;
  /** Exact immutable source accepted by the host before this durable row. */
  sourceDigest?: string;
  sourceState?: import("@vibestudio/service-schemas/vcs").VcsStateNodeRef;
  contentStateHash?: string;
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
   * The owning agent DO's runtime id (its own `do:source:Class:objectKey`).
   * Set by the eval service to the verified caller; the `chat` binding proxies
   * every op to `agentRef.chatOp(channelId, op, args)`. The agent re-derives
   * THIS EvalDO's objectKey to authorize the forward.
   */
  agentRef?: string;
  /**
   * Host-derived terminal receiver runtime. Public input can request only the
   * authenticated caller; the host resolves that caller to this exact id.
   */
  resultReceiverRef?: string;
  /**
   * Owner-scoped gateway bearer minted by the eval service for THIS EvalDO's
   * concrete `do:...:EvalDO:<objectKey>` identity (NOT the shared internal-DO
   * service bearer). Backs `gatewayConfig`/`gatewayFetch` so a leak is scoped to
   * the owner. Server→DO arg only — never user-supplied.
   */
  gatewayToken?: string;
  /** Host-created proof binding outbound RPC to this exact admitted run. */
  executionSessionNonce?: string;
  /** Host-only producer credential for the canonical live event sink. */
  eventSinkNonce?: string;
  /** Exact non-authorizing parent tool invocation for outbound service effects. */
  causalParent?: RpcCausalParent;
  /** Exact parent tool invocation used to route the eventual tool completion. */
  agentInvocationId?: string;
  /**
   * The owner's nearest panel ancestor (resolved server-side by the eval service
   * from verified entity lineage), or absent when there is none. Backs the
   * portable `parent`/`getParent`/`getParentWithContract`. Server→DO arg only.
   */
  parent?: { parentId: string; parentEntityId: string; parentKind: "panel" | "worker" | "do" };
  /** Caller-provided idempotency key for the run (agents: a namespaced invocation-effect id). */
  runId?: string;
  /** Opt-in deadline; the run is aborted after this many ms. Absent ⇒ unbounded. */
  timeoutMs?: number;
  /** Read-only containment: outbound service calls from this run are dispatched
   *  with ctx.readOnly, so the server refuses any non-`read` method. */
  readOnly?: boolean;
  /** Digest of the host-normalized authority manifest admitted for this run. */
  authorityManifestDigest?: string;
  /** Host-normalized caller intent, before the EvalDO binds its scope input. */
  intentDigest?: string;
  /** EvalDO-owned serialized notebook input coordinate. */
  scopeInputRevision?: string;
  /** Final provenance digest over intent + serialized notebook input. */
  runDigest?: string;
}

function semanticRunArgs(
  args: RunArgs
): Omit<
  RunArgs,
  | "gatewayToken"
  | "executionSessionNonce"
  | "eventSinkNonce"
  | "resultReceiverRef"
  | "scopeInputRevision"
  | "runDigest"
> {
  const {
    gatewayToken: _gatewayToken,
    executionSessionNonce: _executionSessionNonce,
    eventSinkNonce: _eventSinkNonce,
    resultReceiverRef: _resultReceiverRef,
    scopeInputRevision: _scopeInputRevision,
    runDigest: _runDigest,
    ...semantic
  } = args;
  return semantic;
}

interface RunResult {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  failureKind?: "user-code" | "infrastructure" | "cancelled";
  failureCode?: string;
  errorData?: unknown;
  scopeKeys?: string[];
  kernel?: KernelRunStatus;
}

type EvalRunEventKind =
  | "state"
  | "console"
  | "progress"
  | "checkpoint"
  | "authority-requested"
  | "authority-decided"
  | "kernel"
  | "cleanup"
  | "diagnostic";

const MAX_DURABLE_RUN_EVENTS = 2_048;
const MAX_DURABLE_EVENT_PAYLOAD_CHARS = 64 * 1024;

interface KernelRunStatus {
  /** Identifies the exact in-memory notebook heap serving this result. */
  incarnationId: string;
  startedAt: number;
  /** The current residency lease deadline, refreshed before every eval cell. */
  idleExpiresAt?: number;
  /** Present only on the first result produced by this kernel incarnation. */
  event?: {
    kind: "started" | "restarted";
    recovery:
      | { status: "complete"; restored: string[]; lost: string[] }
      | { status: "unavailable" };
  };
}

interface KernelLeaseState {
  id: string;
  expiresAt: number;
  holderAttached: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  settled: Promise<{ reason: "expired" | "released" | "replaced" }>;
  settle: (result: { reason: "expired" | "released" | "replaced" }) => void;
}

export class EvalDO extends DurableObjectBase {
  static override rpcMethods = evalEngineMethods;
  static override schemaVersion = 2;

  protected override schemaProductionBaseline() {
    return { version: 2, name: "eval-engine-v2" } as const;
  }

  private engine: EvalEngine | null = null;
  private scopeManager: ScopeManagerLike | null = null;
  /** Invalidates persistence and db bindings captured by an execution orphaned during recovery. */
  private scopeGeneration = 0;
  /** Instance field so cancellation timing can be exercised without a real five-second test. */
  private readonly cancellationGraceMs = CANCELLATION_GRACE_MS;
  /** Instance field so the terminal drain bound can be exercised without a real one-second test. */
  /** Serializes eval runs — ScopeManager has a single in-progress flag + one current scope. */
  private runChain: Promise<unknown> = Promise.resolve();
  /** In-flight runs in THIS instance, keyed by runId → the single execution promise. A concurrent
   *  `executeRun` (e.g. a deferRedrive that races the first dispatch) SHARES this promise instead of
   *  starting a second sandbox run; it also lets `reset` abort live runs. */
  private readonly inFlightRuns = new Map<string, Promise<RunResult>>();
  /** One cancellation phase per run. Concurrent cancel RPCs join this promise
   *  so no caller can publish a terminal status while another caller's cleanup
   *  is still running. */
  private readonly inFlightCancellations = new Map<string, Promise<EvalCancelResult>>();
  /** Abort controllers per in-flight run — used by `reset` and the `timeoutMs` deadline. */
  private readonly runAborts = new Map<string, AbortController>();
  /**
   * Per-run phase cell captured by that run's RPC wrappers. Ordinary calls
   * always inherit the run AbortSignal. Only after the hosted execution has
   * settled may registered cancellation cleanup issue new calls without the
   * already-aborted signal; the cancelled program itself is no longer running.
   */
  private readonly runCleanupPhases = new Map<string, RunCleanupPhase>();
  /** Exact authority asks still awaiting a decision, grouped by invocation identity. */
  private readonly runPendingAuthorityRequests = new Map<string, Map<string, unknown>>();
  /** Last observable operation checkpoint digest; repeated polling of the same
   * operation does not flood the durable event stream. */
  private readonly runCheckpointDigests = new Map<string, string>();
  /**
   * The execution currently invoking retained runtime objects. Imported
   * workspace packages and panel handles survive across notebook cells, so
   * every retained runtime client must resolve authority from the calling cell
   * rather than the cell that initialized the module. Async-local binding also
   * keeps a force-reset overlap from borrowing a newer run's execution session.
   */
  private readonly activeEvalExecution = new asyncHooks.AsyncLocalStorage<EvalExecutionContext>();
  /** Run-scoped cleanup registered by evaluated orchestration code. Cancel
   *  executes these BEFORE aborting outbound RPC so child runtimes can retire
   *  through the normal authority path instead of becoming orphans. */
  private readonly runCancelHandlers = new Map<string, Set<() => void | Promise<void>>>();
  /**
   * Live event delivery is ordered per run. Terminal events close the host
   * event-sink route, so concurrent waitUntil publishes would otherwise let a
   * terminal event overtake earlier events and turn normal teardown into
   * authenticated-session errors.
   */
  private readonly liveEventDeliveries = new Map<string, Promise<void>>();
  /**
   * Factories from the manifest-declared runtime unit (providers.evalRuntime),
   * loaded dynamically via the build service (see ensureRuntimeSupport). The
   * host bundle never statically imports workspace code.
   */
  private runtimeSupport: RuntimeSupportModule | null = null;
  /** The declared runtime unit's `./portable` helpers (z, defineContract, …). */
  private portableHelpers: Record<string, unknown> | null = null;
  /** Owner identity established by the first hosted runtime. A warm
   *  EvalDO serves exactly one owner (objectKey = sha256(ownerId\0subKey)), so a
   *  later run arriving with a different contextId/gatewayToken is a routing or
   *  ownership bug — refuse loudly rather than silently run under stale identity
   *  (Finding 3). */
  private hostedRuntimeIdentity: { contextId: string; gatewayToken: string } | null = null;
  /** Stateless provider/runtime modules shared by EvalDO instances in this isolate.
   * The map and compiler remain host-closure state and are never guest globals. */
  private readonly isolateModuleMap: Record<string, unknown> = {
    "node:async_hooks": asyncHooks,
  };

  /**
   * Per-OBJECT module registry passed to the engine on every run. Many owners' EvalDOs share
   * one workerd isolate, so the engine's per-isolate global `__vibestudioModuleMap__` would leak
   * one owner's loaded `imports` into another (and dedup-by-specifier could hand owner B owner
   * A's *version*). A per-object map keeps each owner's modules isolated. Persists across this
   * DO's runs for import continuity (a module loaded in one run is reusable by the next).
   */
  private moduleMap: Record<string, unknown> = {};
  /** Stable only for this exact in-memory notebook heap. */
  private readonly kernelIncarnationId: string;
  private readonly kernelStartedAt: number;
  private kernelRestarted = false;
  private kernelEventPending = true;
  /** Exact durable recovery report captured when this incarnation first hydrates scope. */
  private scopeRecovery: ScopeRecovery | null = null;
  /**
   * One host-held request owns inter-cell notebook residency. Individual eval
   * requests protect only their own execution; this lease keeps the same heap
   * (scope objects, module singletons, open client handles) alive between cells.
   */
  private kernelLease: KernelLeaseState | null = null;
  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.kernelIncarnationId = crypto.randomUUID();
    this.kernelStartedAt = Date.now();
  }

  protected override afterSchemaReady(): void {
    this.kernelRestarted = this.getStateValue("eval_kernel_incarnation") !== null;
    this.setStateValue(
      "eval_kernel_incarnation",
      JSON.stringify({
        id: this.kernelIncarnationId,
        startedAt: this.kernelStartedAt,
      })
    );
    // Runs once per boot (this instance), before any run executes — so every `running`
    // row is orphaned by a prior instance whose held connection dropped (server restart).
    this.reconcileOrphanedRuns();
    // Execution roots describe live module objects in this exact in-memory
    // kernel, not merely builds used by historical runs. A new activation has
    // no module heap to retain, so carrying these rows across an incarnation
    // would reject a valid rebuild after the workspace head changes.
    if (this.kernelRestarted) this.sql.exec(`DELETE FROM eval_execution_roots`);
  }

  protected createTables(): void {
    // The base `state` table is created by ensureReady(). The scope table (`repl_scopes`)
    // is created lazily by SqlScopePersistence on first run; user `db` tables are created
    // on demand by eval'd code.
    //
    // The `runs` table is the durable job queue. `startRun` inserts and starts agent-owned work
    // under this object's `waitUntil` lifetime; no host HTTP request is held for an asynchronous
    // run. `getRun` is the durable recovery/read path. `agent_ref`/`channel_id` are stored so a
    // restarted owner can still observe the exact run and its terminal result.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        args TEXT NOT NULL,
        agent_ref TEXT,
        channel_id TEXT,
        status TEXT NOT NULL,
        result TEXT,
        started_at INTEGER NOT NULL,
        deadline_at INTEGER
      )
    `);
    // SqlStorage executes one statement per exec() call under real workerd.
    // Keep this separate from `runs` so existing objects and fresh objects both
    // receive the progress table deterministically.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_progress (
        run_id TEXT PRIMARY KEY,
        progress TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        run_id TEXT PRIMARY KEY,
        checkpoint TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS eval_execution_roots (
        module_specifier TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        retained_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS eval_result_redeliveries (
        run_id TEXT PRIMARY KEY,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      )
    `);
  }

  protected override requiredTables(): readonly string[] {
    return EVAL_SCHEMA_TABLES;
  }

  /**
   * Crash recovery: a process restart cancels the object's background execution and leaves a
   * `running` row no in-memory executor owns. Called once at construction (before any run is live),
   * so every `running` row is stale.
   * Mark them an interrupt error; the waiting caller's `getRun` poll surfaces it and the model
   * re-issues (a fresh runId). We never auto-re-run — evals have side effects (spawned agents).
   */
  private reconcileOrphanedRuns(): void {
    this.sql.exec(
      `UPDATE runs SET status = 'done', result = ? WHERE status = 'running'`,
      JSON.stringify({
        success: false,
        console: "",
        error: "eval interrupted by restart",
        failureKind: "infrastructure",
        failureCode: evalLifecycleFailureCodes.runtimeRestarted,
      })
    );
    // A cancelling row means the old activation had already prevented normal
    // completion, but its in-memory cleanup phase was lost in the restart.
    // It is terminal cancellation, never an execution to replay.
    this.sql.exec(`UPDATE runs SET status = 'cancelled' WHERE status = 'cancelling'`);
  }

  private createExecutionContext(
    input: {
      contextId?: string;
      runId?: string;
      causalParent?: RpcCausalParent | null;
      readOnly?: boolean;
      executionSessionNonce?: string;
    },
    signal?: AbortSignal,
    cleanupPhase?: RunCleanupPhase
  ): EvalExecutionContext {
    const causalParent = input.causalParent ? Object.freeze({ ...input.causalParent }) : null;
    const readOnly = input.readOnly === true;
    const base = this.rpc;
    const mergeOptions = <T extends RpcCallOptions | RpcStreamOptions>(value?: T): T => {
      const options = {
        ...(value ?? {}),
        ...(signal && (cleanupPhase?.active !== true || cleanupPhase.revoked) ? { signal } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      };
      if (causalParent) options.causalParent = causalParent;
      else Reflect.deleteProperty(options, "causalParent");
      if (input.executionSessionNonce) {
        bindExecutionSession(options, input.executionSessionNonce);
      }
      return options as T;
    };
    const call = async <T = unknown>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ): Promise<T> => {
      const progressSemantics = progressSemanticsForRpcMethod(method);
      const checkpoint =
        progressSemantics?.kind === "external-wait"
          ? {
              stage: "external-wait",
              operation: progressSemantics.operation,
              resource: externalWaitResource(progressSemantics, args),
              targetId,
              method,
            }
          : { stage: "outbound-rpc", targetId, method };
      if (input.runId) {
        this.recordRunCheckpoint(input.runId, {
          ...checkpoint,
          state: "waiting",
        });
      }
      try {
        const result = await base.call<T>(targetId, method, args, mergeOptions(options));
        if (input.runId) {
          this.completeRunCheckpoint(input.runId, {
            ...checkpoint,
            state: "completed",
          });
        }
        return result;
      } catch (error) {
        if (input.runId) {
          this.completeRunCheckpoint(input.runId, {
            ...checkpoint,
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    };
    const emit = (targetId: string, event: string, payload: unknown, options?: RpcCallOptions) =>
      base.emit(targetId, event, payload, mergeOptions(options));
    const peerFor = (targetId: string) => {
      const inbound = base.peer(targetId);
      const contextual = {
        id: targetId,
        call: new Proxy(
          {},
          {
            get:
              (_target, method) =>
              (...args: unknown[]) =>
                call(targetId, String(method), args),
          }
        ),
        on: inbound.on.bind(inbound),
        emit: (event: string, payload: unknown) => emit(targetId, event, payload),
        withContract: () => contextual,
      };
      return contextual;
    };
    const rpc: RpcClient = Object.freeze({
      selfId: base.selfId,
      expose: base.expose.bind(base),
      exposeAll: base.exposeAll.bind(base),
      exposeStreaming: base.exposeStreaming.bind(base),
      call,
      stream: (targetId: string, method: string, args: unknown[], options?: RpcStreamOptions) =>
        base.stream(targetId, method, args, mergeOptions(options)),
      streamReadable: (
        targetId: string,
        method: string,
        args: unknown[],
        options?: RpcStreamOptions
      ) => base.streamReadable(targetId, method, args, mergeOptions(options)),
      emit,
      on: base.on.bind(base),
      peer: ((targetId: string) => peerFor(targetId)) as RpcClient["peer"],
      status: base.status.bind(base),
      ready: base.ready.bind(base),
      onStatusChange: base.onStatusChange.bind(base),
    });
    const callMainService = (service: string, method: string, args: unknown[]) =>
      rpc.call("main", `${service}.${method}`, args);
    return Object.freeze({
      rpc,
      signal,
      contextId: input.contextId ?? "",
      ...(input.runId ? { runId: input.runId } : {}),
      build: createBuildServiceClient(callMainService),
      fs: createTypedServiceClient("fs", fsMethods, callMainService),
      blobstore: createTypedServiceClient("blobstore", blobstoreMethods, callMainService),
      docs: createTypedServiceClient("docs", docsMethods, callMainService),
      externalOpen: createTypedServiceClient("externalOpen", externalOpenMethods, callMainService),
    });
  }

  private infrastructureExecution(): EvalExecutionContext {
    return this.createExecutionContext({
      contextId: this.hostedRuntimeIdentity?.contextId ?? "",
      causalParent: null,
      readOnly: false,
    });
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
    obj: Record<string, unknown>,
    docs: DocsClient
  ): Promise<unknown | null> {
    const liveMethods = Object.keys(obj).filter((k) => typeof obj[k] === "function");
    if (liveMethods.length === 0) return null;
    let serviceMethods: Record<string, unknown> = {};
    const serviceName = evalRuntimeServiceName(name);
    try {
      const svc = (await docs.describeService(serviceName)) as {
        methods?: Record<string, unknown>;
      };
      serviceMethods = svc?.methods ?? {};
    } catch {
      // Not an RPC service (or not describable) — reflection alone still gives the truthful surface.
    }
    if (Object.keys(serviceMethods).length === 0) {
      for (const method of liveMethods) {
        for (const target of ["panel", "workerRuntime"] as const) {
          const entry = await docs
            .describe(`runtime:${target}.${name}.${method}`)
            .catch(() => null);
          if (entry) {
            serviceMethods[method] = entry;
            break;
          }
        }
      }
    }
    return describeEvalBindingSurface(
      name,
      liveMethods,
      serviceMethods,
      EVAL_RUNTIME_METHOD_NOTES,
      serviceName
    );
  }

  /**
   * Keep the inbound `respond()` watchdog disabled explicitly: the synchronous panel/CLI `run`
   * method legitimately runs for the eval's whole duration. Agent `startRun` returns immediately
   * and executes under `waitUntil`. Only an explicit `timeoutMs` bounds either form; otherwise the
   * run remains admitted until completion, explicit cancellation, or runtime lifecycle loss.
   */
  protected override get respondTimeoutMs(): number {
    return 0;
  }

  // ── public RPC methods (dispatched by the server `eval` service) ──────────────

  @schemaRpc()
  acquireKernelLease(input: { leaseId: string; idleMs: number }): {
    leaseId: string;
    expiresAt: number;
    holderAttached: boolean;
  } {
    if (!input || typeof input.leaseId !== "string" || input.leaseId.length === 0) {
      throw new Error("eval kernel lease requires a non-empty leaseId");
    }
    if (
      !Number.isSafeInteger(input.idleMs) ||
      input.idleMs <= 0 ||
      input.idleMs > MAX_KERNEL_IDLE_LEASE_MS
    ) {
      throw new Error(
        `eval kernel lease idleMs must be an integer between 1 and ${MAX_KERNEL_IDLE_LEASE_MS}`
      );
    }

    let lease = this.kernelLease;
    if (lease?.id !== input.leaseId) {
      if (lease) this.settleKernelLease(lease, "replaced");
      let settle!: KernelLeaseState["settle"];
      const settled = new Promise<Awaited<KernelLeaseState["settled"]>>((resolve) => {
        settle = resolve;
      });
      lease = {
        id: input.leaseId,
        expiresAt: 0,
        holderAttached: false,
        timer: null,
        settled,
        settle,
      };
      this.kernelLease = lease;
    } else if (lease.timer) {
      clearTimeout(lease.timer);
    }

    lease.expiresAt = Date.now() + input.idleMs;
    lease.timer = setTimeout(() => void this.expireKernelLease(lease), input.idleMs);
    lease.timer.unref?.();
    return {
      leaseId: lease.id,
      expiresAt: lease.expiresAt,
      holderAttached: lease.holderAttached,
    };
  }

  @schemaRpc()
  async attachKernelLeaseHolder(leaseId: string): Promise<{ attached: true }> {
    const lease = this.kernelLease;
    if (!lease || lease.id !== leaseId) {
      throw new Error(`eval kernel lease ${leaseId} is not active`);
    }
    if (lease.holderAttached) {
      throw new Error(`eval kernel lease ${leaseId} already has a holder`);
    }
    // Register the activation-owned hold before acknowledging it so planned
    // restart and shutdown can release every successful long request.
    await this.registerLifecycleRelease({ kind: "eval-kernel", leaseId });
    if (this.kernelLease !== lease) {
      throw new Error(`eval kernel lease ${leaseId} changed while its holder was attaching`);
    }
    lease.holderAttached = true;
    return { attached: true };
  }

  @schemaRpc()
  async holdKernelLease(
    leaseId: string
  ): Promise<{ leaseId: string; reason: "expired" | "released" | "replaced" }> {
    const lease = this.kernelLease;
    if (!lease || lease.id !== leaseId) {
      throw new Error(`eval kernel lease ${leaseId} is not active`);
    }
    if (!lease.holderAttached) {
      throw new Error(`eval kernel lease ${leaseId} has no attached holder`);
    }
    try {
      const terminal = await lease.settled;
      return { leaseId, ...terminal };
    } finally {
      lease.holderAttached = false;
    }
  }

  /**
   * Held synchronous run for connection-holding callers (panels over their persistent WS, the CLI):
   * insert + execute in this held handler, return the result in one response. The CALLER holds its
   * own leg; the server holds the EvalDO leg. workerd does not cap a held request.
   */
  @schemaRpc()
  async run(args: RunArgs): Promise<RunResult> {
    const runId = args.runId ?? crypto.randomUUID();
    await this.enqueueRun({ ...args, runId }, false);
    return this.executeRun(runId);
  }

  override async releaseForLifecycle(_input: LifecyclePrepareInput): Promise<{ status: "ready" }> {
    const failures: unknown[] = [];
    try {
      await this.cancelRunsForLifecycle();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.clearLifecycleRelease();
    } catch (error) {
      failures.push(error);
    }
    if (this.kernelLease) this.settleKernelLease(this.kernelLease, "released");
    if (failures.length > 0) {
      throw new AggregateError(failures, "eval lifecycle release failed");
    }
    return { status: "ready" };
  }

  /**
   * A lifecycle release is a process-boundary operation, not just a notebook
   * lease release. Any pending/running durable run owns work inside this
   * activation and must be cancelled before the activation can claim that it
   * is ready to disappear. The durable CAS in cancel() makes a late execution
   * unable to resurrect a completed result after shutdown.
   */
  private async cancelRunsForLifecycle(): Promise<void> {
    const runIds = this.sql
      .exec(
        `SELECT run_id FROM runs
         WHERE status IN ('pending', 'running', 'cancelling')
         ORDER BY started_at ASC, run_id ASC`
      )
      .toArray()
      .map((row) => String(row["run_id"]));
    if (runIds.length === 0) return;
    const results = await Promise.allSettled(
      runIds.map(async (runId) => {
        // Persist the infrastructure terminal before aborting execution. The
        // execution promise and cancellation owner race to resume after abort;
        // stamping afterward could let executeAndDeliver publish an ordinary
        // eval_cancelled terminal first.
        this.markRunGenerationLost(runId);
        await this.cancel(runId);
      })
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `eval lifecycle cancellation failed for ${runIds.length} run(s)`
      );
    }
  }

  /**
   * A planned lifecycle suspend is infrastructure, never user intent. Stamp the
   * active row with the typed `runtime_generation_lost` result before its abort
   * is issued, so the execution and cancellation continuations observe the
   * same canonical terminal. A run that raced to a real result keeps it.
   */
  private markRunGenerationLost(runId: string): void {
    this.sql.exec(
      `UPDATE runs SET result = ?
        WHERE run_id = ?
          AND status IN ('pending', 'running', 'cancelling', 'cancelled')
          AND result IS NULL`,
      JSON.stringify({
        success: false,
        console: "",
        error: "eval runtime generation was retired by a planned lifecycle transition",
        failureKind: "infrastructure",
        failureCode: evalLifecycleFailureCodes.runtimeGenerationLost,
      }),
      runId
    );
  }

  override async resumeAfterRestart(_input: LifecycleResumeInput): Promise<void> {
    // A process crash cannot preserve the JavaScript heap. Clear a stale
    // activation-resource declaration; the next eval establishes a fresh,
    // explicitly reported kernel incarnation and held lease.
    await this.clearLifecycleRelease();
  }

  /**
   * Quick, idempotent enqueue for an asynchronous agent run. The durable row is written before a
   * background execution is attached to the DO event with `waitUntil`, so the caller receives a
   * run id without holding an HTTP connection. Idempotent on `run_id`: a replay observes the same
   * row and may reattach only a still-pending run; it never creates a duplicate execution.
   */
  @schemaRpc()
  async startRun(args: RunArgs & { runId: string }): Promise<{
    runId: string;
    runDigest: string;
    scopeInputRevision: string;
    status: string;
    existing: boolean;
  }> {
    return this.enqueueRun(args, true);
  }

  private async enqueueRun(
    args: RunArgs & { runId: string },
    schedule: boolean
  ): Promise<{
    runId: string;
    runDigest: string;
    scopeInputRevision: string;
    status: string;
    existing: boolean;
  }> {
    const runId = args.runId;
    const existing = this.sql
      .exec(`SELECT status, args FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (existing) {
      const status = String(existing["status"]);
      const prior = JSON.parse(String(existing["args"])) as RunArgs;
      if (canonicalJson(semanticRunArgs(prior)) !== canonicalJson(semanticRunArgs(args))) {
        throw new Error(`eval: runId ${runId} was reused with different input`);
      }
      if (!prior.runDigest || !prior.scopeInputRevision) {
        throw new Error(`eval: run ${runId} has incompatible pre-provenance metadata`);
      }
      if (status === "pending" || status === "cancelling") {
        // Host credentials prove the current live admission; they are not part
        // of the user's idempotent program. A deferred-effect redrive after a
        // host restart may legitimately remint them before the durable pending
        // run is attached to execution. A CANCELLING run is refreshed too: its
        // terminal `cancelled` state event has not been appended yet, so
        // routing the tail of its lifecycle to the freshly prepared event sink
        // lets the new admission observe a terminal instead of leaking open
        // against a dead nonce.
        const refreshed = {
          ...prior,
          gatewayToken: args.gatewayToken,
          executionSessionNonce: args.executionSessionNonce,
          eventSinkNonce: args.eventSinkNonce,
          resultReceiverRef: args.resultReceiverRef,
        };
        if (JSON.stringify(refreshed) !== JSON.stringify(prior)) {
          this.sql.exec(
            `UPDATE runs SET args = ? WHERE run_id = ?`,
            JSON.stringify(refreshed),
            runId
          );
        }
        if (schedule && status === "pending") this.scheduleRun(runId);
      }
      return {
        runId,
        runDigest: prior.runDigest,
        scopeInputRevision: prior.scopeInputRevision,
        status,
        existing: true,
      };
    }
    // Reset and enqueue are one DO turn and ordered before insertion. This is
    // safe under startRun replay because an existing run returns above without
    // resetting a second time (or cancelling its own in-flight execution).
    if (args.reset === true) await this.forceReset();
    const predecessor = this.sql
      .exec(`SELECT run_id FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1`)
      .toArray()[0];
    const scopeInputRevision =
      args.reset === true
        ? `reset:${runId}`
        : predecessor
          ? `run:${String(predecessor["run_id"])}`
          : "scope:initial";
    const runDigest = createHash("sha256")
      .update(`${args.intentDigest ?? ""}\0${scopeInputRevision}`)
      .digest("hex");
    args = { ...args, scopeInputRevision, runDigest };
    const acceptedAt = Date.now();
    const deadlineAt = args.timeoutMs ? acceptedAt + args.timeoutMs : null;
    this.sql.exec(
      `INSERT INTO runs (run_id, args, agent_ref, channel_id, status, started_at, deadline_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      runId,
      JSON.stringify(args),
      args.agentRef ?? null,
      args.channelId ?? null,
      acceptedAt,
      deadlineAt
    );
    this.appendRunEvent(runId, "state", { status: "accepted" });
    this.appendRunEvent(runId, "state", { status: "queued" });
    if (schedule) this.scheduleRun(runId);
    return {
      runId,
      runDigest,
      scopeInputRevision,
      status: "pending",
      existing: false,
    };
  }

  /**
   * Attach an asynchronous run to the object's lifetime. Deferring one task turn is important:
   * `startRun` must be able to serialize its acknowledgement before guest code can monopolize the
   * isolate (for example, a synchronous infinite loop with an opt-in external watchdog).
   */
  private scheduleRun(runId: string): void {
    if (!this.ctx.waitUntil) {
      throw new Error("eval: Durable Object context does not support background execution");
    }
    const execution = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => this.executeAndDeliver(runId))
      .catch((error) => {
        console.error(
          `[EvalDO] background run ${runId} failed`,
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        );
      });
    this.ctx.waitUntil(execution);
  }

  /** Execute once, persist first, then let only this agent's EvalDO settle its owning agent. */
  private async executeAndDeliver(runId: string): Promise<void> {
    const row = this.sql.exec(`SELECT args FROM runs WHERE run_id = ?`, runId).toArray()[0];
    if (!row) return;
    const args = JSON.parse(String(row["args"])) as RunArgs;
    const result = await this.executeRun(runId);
    if (!args.resultReceiverRef || !args.channelId) return;
    try {
      await this.deliverTerminalResult(runId, args, result);
    } catch (error) {
      // The terminal row is canonical. A hibernated/restarted agent re-observes
      // it through getRun; the vessel keeps its own durable redrive. Between
      // those, retry the push a few bounded times from here — receivers dedupe.
      console.warn(
        `[EvalDO] completion delivery for ${runId} failed (durable getRun recovery remains available):`,
        error instanceof Error ? error.message : String(error)
      );
      this.scheduleResultRedelivery(runId, 1);
    }
  }

  private async deliverTerminalResult(
    runId: string,
    args: RunArgs,
    result: RunResult
  ): Promise<void> {
    await this.rpc.call(args.resultReceiverRef!, "onEvalComplete", [
      {
        runId,
        agentInvocationId: args.agentInvocationId,
        result,
        channelId: args.channelId,
      },
    ]);
  }

  private scheduleResultRedelivery(runId: string, attempt: number): void {
    this.sql.exec(
      `INSERT INTO eval_result_redeliveries (run_id, attempt) VALUES (?, ?)
       ON CONFLICT (run_id) DO NOTHING`,
      runId,
      attempt
    );
    this.setAlarm(RESULT_REDELIVERY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }

  override async alarm(): Promise<{ wakeAt: number } | null> {
    this.ensureReady();
    return this.redeliverTerminalResults();
  }

  /**
   * Bounded, idempotent redelivery of failed terminal pushes. The durable run
   * row stays canonical; this only shortens the window before the receiver's
   * own durable redrive. After the attempt budget the entry is dropped.
   */
  private async redeliverTerminalResults(): Promise<{ wakeAt: number } | null> {
    const pending = this.sql
      .exec(`SELECT run_id, attempt FROM eval_result_redeliveries ORDER BY run_id`)
      .toArray();
    for (const pendingRow of pending) {
      const runId = String(pendingRow["run_id"]);
      const attempt = Number(pendingRow["attempt"]);
      const row = this.sql
        .exec(`SELECT args, status, result FROM runs WHERE run_id = ?`, runId)
        .toArray()[0];
      const status = row ? String(row["status"]) : null;
      const terminal =
        status === "done" || status === "cancelled" || status === "approval-route-lost";
      if (!row || !terminal || row["result"] == null) {
        this.deleteResultRedelivery(runId, attempt);
        continue;
      }
      const args = JSON.parse(String(row["args"])) as RunArgs;
      if (!args.resultReceiverRef || !args.channelId) {
        this.deleteResultRedelivery(runId, attempt);
        continue;
      }
      try {
        await this.deliverTerminalResult(
          runId,
          args,
          JSON.parse(String(row["result"])) as RunResult
        );
        this.deleteResultRedelivery(runId, attempt);
      } catch (error) {
        if (attempt >= RESULT_REDELIVERY_MAX_ATTEMPTS) {
          console.warn(
            `[EvalDO] completion redelivery for ${runId} exhausted after ${attempt} attempts:`,
            error instanceof Error ? error.message : String(error)
          );
          this.deleteResultRedelivery(runId, attempt);
          continue;
        }
        this.sql.exec(
          `UPDATE eval_result_redeliveries SET attempt = ? WHERE run_id = ? AND attempt = ?`,
          attempt + 1,
          runId,
          attempt
        );
      }
    }
    const next = this.sql
      .exec(`SELECT attempt FROM eval_result_redeliveries ORDER BY attempt ASC LIMIT 1`)
      .toArray()[0];
    if (!next) return null;
    const delayMs = RESULT_REDELIVERY_BASE_DELAY_MS * 2 ** (Number(next["attempt"]) - 1);
    return { wakeAt: Date.now() + delayMs };
  }

  private deleteResultRedelivery(runId: string, attempt: number): void {
    this.sql.exec(
      `DELETE FROM eval_result_redeliveries WHERE run_id = ? AND attempt = ?`,
      runId,
      attempt
    );
  }

  /**
   * The HELD synchronous execution (one held connection per call from the eval service / panel).
   * Idempotent on `runId`: a concurrent or re-dispatched call SHARES the single in-flight promise
   * rather than starting a second sandbox run — so a deferRedrive that races the first dispatch can
   * never double-run the eval (which would double-spawn headless agents).
   */
  @schemaRpc()
  async executeRun(runId: string): Promise<RunResult> {
    const inFlight = this.inFlightRuns.get(runId);
    if (inFlight) return inFlight;
    const promise = this.runEval(runId);
    this.inFlightRuns.set(runId, promise);
    void promise.catch(() => undefined).finally(() => this.inFlightRuns.delete(runId));
    return promise;
  }

  /**
   * Run the sandbox once for `runId`: claim the row (pending → running), execute (serialized via
   * `runChain` so ScopeManager's single enter/exit is never concurrent), and persist the result with
   * a CAS so a concurrent `reset` cancel is never resurrected.
   */
  private async runEval(runId: string): Promise<RunResult> {
    const claimedRow = this.sql
      .exec(
        `UPDATE runs
            SET status = 'running'
          WHERE run_id = ? AND status = 'pending'
        RETURNING status`,
        runId
      )
      .toArray()[0];
    const row = this.sql
      .exec(
        `SELECT status, args, started_at, deadline_at, result FROM runs WHERE run_id = ?`,
        runId
      )
      .toArray()[0];
    if (!row) {
      return {
        success: false,
        console: "",
        error: `eval: unknown run ${runId}`,
        failureKind: "infrastructure",
        failureCode: "eval_run_missing",
      };
    }
    const status = String(row["status"]) as EvalRunStatusValue;
    if (!claimedRow) {
      // Already terminal (idempotent re-dispatch, or cancelled before we claimed it).
      if (
        (status === "done" || status === "cancelled" || status === "approval-route-lost") &&
        row["result"] != null
      ) {
        return JSON.parse(String(row["result"])) as RunResult;
      }
      return {
        success: false,
        console: "",
        error: `eval: run ${runId} is ${status}`,
        failureKind:
          status === "cancelling" || status === "cancelled" ? "cancelled" : "infrastructure",
        failureCode:
          status === "cancelling" || status === "cancelled"
            ? "eval_cancelled"
            : "eval_invalid_run_state",
      };
    }
    this.appendRunEvent(runId, "state", { status: "running" });

    const args = JSON.parse(String(row["args"])) as RunArgs;
    const deadlineAt = row["deadline_at"] != null ? Number(row["deadline_at"]) : null;
    const controller = new AbortController();
    const cleanupPhase: RunCleanupPhase = { active: false, revoked: false };
    this.runAborts.set(runId, controller);
    this.runCleanupPhases.set(runId, cleanupPhase);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancellationCleanupError: unknown;

    let result: RunResult;
    let kernel: KernelRunStatus | undefined;
    try {
      if (deadlineAt != null) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          controller.abort(evalDeadlineAbortReason(args.timeoutMs));
          cleanupPhase.active = true;
          await this.executeRunCancelHandlers(runId);
        } else {
          timer = setTimeout(() => {
            controller.abort(evalDeadlineAbortReason(args.timeoutMs));
          }, remaining);
          timer.unref?.();
        }
      }
      const ran = this.runChain.then(async () => {
        try {
          this.recordRunCheckpoint(runId, { stage: "sandbox-execution" });
          return await this.runLocked(args, controller.signal, runId, deadlineAt, cleanupPhase);
        } finally {
          // Consume the incarnation event inside the serialized run chain. A
          // second queued cell can never race the first and also claim it.
          kernel = this.kernelStatusForRun();
        }
      });
      this.runChain = ran.catch(() => undefined);
      result = await ran;
      if (controller.signal.aborted && deadlineAt !== null) {
        cleanupPhase.active = true;
        try {
          await this.executeRunCancelHandlers(runId);
          // Cancellation handlers deliberately run outside the sandbox's
          // ordinary abort signal. They can therefore mutate `scope` after
          // runLocked's exitEval() has persisted its final snapshot. Persist
          // once more after cleanup so those terminal writes are durable.
          await this.scopeManager?.persist();
        } catch (error) {
          cancellationCleanupError = error;
          console.error(`[EvalDO] cancellation cleanup failed for timed-out run ${runId}`, error);
        }
      }
      if (controller.signal.aborted && deadlineAt !== null) {
        result = {
          success: false,
          console: result.console,
          error: `eval timed out after ${args.timeoutMs}ms`,
          failureKind: "cancelled",
          failureCode: "eval_deadline_exceeded",
        };
      }
      if (cancellationCleanupError !== undefined) {
        const cleanupMessage =
          cancellationCleanupError instanceof Error
            ? cancellationCleanupError.message
            : String(cancellationCleanupError);
        result = {
          ...result,
          success: false,
          error: `${result.error ?? `eval timed out after ${args.timeoutMs}ms`}; cancellation cleanup failed: ${cleanupMessage}`,
        };
      }
      result = { ...result, kernel };
    } catch (err) {
      const currentStatus = String(
        this.sql.exec(`SELECT status FROM runs WHERE run_id = ?`, runId).toArray()[0]?.["status"] ??
          ""
      );
      const deadlineFired = deadlineAt !== null && controller.signal.aborted;
      // A fired deadline is not carte blanche: only an error DERIVED from the
      // abort (the reason itself, an AbortError, or an abort-caused transport
      // rejection in the cause chain) is the timeout. Anything else is a real
      // failure that must keep its own classification and stay visible.
      const deadlineExceeded =
        deadlineFired &&
        currentStatus !== "cancelling" &&
        currentStatus !== "cancelled" &&
        isAbortDerivedError(err, controller.signal.reason);
      const cancelled = currentStatus === "cancelling" || currentStatus === "cancelled";
      const approvalRouteLost = errorCodeInChain(err) === "EAPPROVALROUTELOST";
      if (approvalRouteLost) {
        console.warn(`[EvalDO] approval route lost for run ${runId}`);
      } else if (!deadlineExceeded && !cancelled) {
        const log = deadlineFired ? console.warn : console.error;
        log(
          `[EvalDO] run ${runId} failed`,
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        );
      }
      result = deadlineExceeded
        ? {
            success: false,
            console: "",
            error: `eval timed out after ${args.timeoutMs}ms${
              /cancellation cleanup failed/iu.test(err instanceof Error ? err.message : String(err))
                ? `; ${err instanceof Error ? err.message : String(err)}`
                : ""
            }`,
            failureKind: "cancelled",
            failureCode: "eval_deadline_exceeded",
            kernel: kernel ?? this.kernelStatusForRun(),
          }
        : {
            success: false,
            console: "",
            error: approvalRouteLost
              ? "Attached-host approval route was lost; restart this eval on a live attached run"
              : err instanceof Error
                ? err.message
                : String(err),
            failureKind: "infrastructure",
            failureCode: approvalRouteLost ? "approval-route-lost" : "eval_host_failed",
            kernel: kernel ?? this.kernelStatusForRun(),
          };
    } finally {
      if (timer) clearTimeout(timer);
      this.runPendingAuthorityRequests.delete(runId);
      this.runCheckpointDigests.delete(runId);
      this.runAborts.delete(runId);
      this.runCleanupPhases.delete(runId);
      if (!controller.signal.aborted) this.runCancelHandlers.delete(runId);
      this.releaseUnloadedExecutionRoots(runId);
    }

    const terminalResult = this.compactRunResult(result);
    // CAS persist: write `done` only if still `running`, so a concurrent `reset` → `cancelled` wins.
    const terminalStatus =
      terminalResult.failureCode === "approval-route-lost" ? "approval-route-lost" : "done";
    const terminalClaim = this.sql
      .exec(
        `UPDATE runs
            SET status = ?, result = ?
          WHERE run_id = ? AND status = 'running'
        RETURNING status`,
        terminalStatus,
        JSON.stringify(terminalResult),
        runId
      )
      .toArray()[0];
    const finalStatus = this.sql
      .exec(`SELECT status, result FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (
      String(finalStatus?.["status"]) === "cancelling" ||
      String(finalStatus?.["status"]) === "cancelled"
    ) {
      if (finalStatus?.["result"] != null) {
        return JSON.parse(String(finalStatus["result"])) as RunResult;
      }
      return this.compactRunResult({
        success: false,
        console: result.console,
        error: "eval: run cancelled",
        failureKind: "cancelled",
        failureCode: "eval_cancelled",
        kernel: result.kernel,
      });
    }
    if (!terminalClaim) {
      if (finalStatus?.["result"] != null) {
        return JSON.parse(String(finalStatus["result"])) as RunResult;
      }
      return this.compactRunResult({
        success: false,
        console: terminalResult.console,
        error: `eval: run ${runId} lost terminal ownership in state ${String(finalStatus?.["status"] ?? "unknown")}`,
        failureKind: "infrastructure",
        failureCode: "eval_invalid_run_state",
        kernel: terminalResult.kernel,
      });
    }
    const hasConsoleEvents =
      Number(
        this.sql
          .exec(
            `SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND kind = 'console'`,
            runId
          )
          .toArray()[0]?.["count"] ?? 0
      ) > 0;
    if (terminalResult.console && !hasConsoleEvents) {
      this.appendRunEvent(runId, "console", {
        text: this.windowText(terminalResult.console, 12_000, "$lastLargeConsole"),
      });
    }
    if (terminalResult.kernel) this.appendRunEvent(runId, "kernel", terminalResult.kernel);
    this.appendRunEvent(runId, "state", {
      status: terminalResult.success ? "succeeded" : "failed",
      failureKind: terminalResult.failureKind,
      failureCode: terminalResult.failureCode,
    });
    await this.settleLiveEventDelivery(runId);
    return terminalResult;
  }

  /** Poll backstop for the durable run state. `cancelling` is deliberately
   * non-terminal: execution admission remains live until cleanup settles. */
  @schemaRpc()
  getRun(runId: string): {
    status: EvalRunStatusValue | "unknown";
    result?: RunResult;
    progress?: unknown;
    checkpoint?: unknown;
    activity?:
      | { kind: "executing" }
      | { kind: "authority-pending"; request: unknown }
      | {
          kind: "external-wait";
          operation: string;
          resource: { kind: string; value: unknown };
          targetId: string;
          method: string;
        }
      | { kind: "cancelling" };
  } {
    const row = this.sql
      .exec(`SELECT status, result FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!row) return { status: "unknown" };
    const status = String(row["status"]) as EvalRunStatusValue;
    const progressRow = this.sql
      .exec(`SELECT progress FROM run_progress WHERE run_id = ?`, runId)
      .toArray()[0];
    const progress =
      progressRow?.["progress"] != null ? JSON.parse(String(progressRow["progress"])) : undefined;
    const checkpointRow = this.sql
      .exec(`SELECT checkpoint FROM run_checkpoints WHERE run_id = ?`, runId)
      .toArray()[0];
    const checkpoint = checkpointRow?.["checkpoint"]
      ? JSON.parse(String(checkpointRow["checkpoint"]))
      : undefined;
    // Activity is a LIVE-lifecycle observation; a terminal run has none.
    const pendingAuthority =
      status === "running"
        ? this.runPendingAuthorityRequests.get(runId)?.values().next().value
        : undefined;
    const activity =
      status === "cancelling"
        ? ({ kind: "cancelling" } as const)
        : status === "running"
          ? pendingAuthority
            ? ({
                kind: "authority-pending" as const,
                request: pendingAuthority,
              } as const)
            : checkpoint &&
                checkpoint.stage === "external-wait" &&
                checkpoint.state === "waiting" &&
                typeof checkpoint.operation === "string" &&
                checkpoint.resource &&
                typeof checkpoint.resource === "object" &&
                typeof checkpoint.resource.kind === "string" &&
                typeof checkpoint.targetId === "string" &&
                typeof checkpoint.method === "string"
              ? ({
                  kind: "external-wait" as const,
                  operation: checkpoint.operation,
                  resource: checkpoint.resource,
                  targetId: checkpoint.targetId,
                  method: checkpoint.method,
                } as const)
              : ({ kind: "executing" } as const)
          : undefined;
    return {
      status,
      ...(row["result"] != null ? { result: JSON.parse(String(row["result"])) as RunResult } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      ...(activity ? { activity } : {}),
    };
  }

  @schemaRpc()
  getRunEvents(
    runId: string,
    after = 0,
    limit = 100
  ): {
    events: Array<{ sequence: number; at: number; kind: EvalRunEventKind; payload: unknown }>;
    next: number;
    hasMore: boolean;
  } {
    const boundedLimit = Math.max(1, Math.min(256, Math.trunc(limit)));
    const boundedAfter = Math.max(0, Math.trunc(after));
    const range = this.sql
      .exec(
        `SELECT MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence
           FROM run_events WHERE run_id = ?`,
        runId
      )
      .toArray()[0];
    const firstSequence =
      range?.["first_sequence"] == null ? null : Number(range["first_sequence"]);
    const gap =
      firstSequence !== null && boundedAfter + 1 < firstSequence
        ? {
            sequence: firstSequence - 1,
            at: Date.now(),
            kind: "diagnostic" as const,
            payload: {
              code: "event-retention-gap",
              requestedAfter: boundedAfter,
              availableFrom: firstSequence,
              rereadAfter: firstSequence - 1,
            },
          }
        : null;
    const rowLimit = gap ? boundedLimit - 1 : boundedLimit;
    const rows = this.sql
      .exec(
        `SELECT sequence, at, kind, payload
           FROM run_events
          WHERE run_id = ? AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?`,
        runId,
        gap ? (firstSequence ?? 1) - 1 : boundedAfter,
        rowLimit + 1
      )
      .toArray();
    const hasMore = rows.length > rowLimit;
    const page = rows.slice(0, rowLimit).map((row) => ({
      sequence: Number(row["sequence"]),
      at: Number(row["at"]),
      kind: String(row["kind"]) as EvalRunEventKind,
      payload: JSON.parse(String(row["payload"])),
    }));
    if (gap) page.unshift(gap);
    return {
      events: page,
      next: page.at(-1)?.sequence ?? boundedAfter,
      hasMore,
    };
  }

  @schemaRpc()
  appendAuthorityEvent(
    runId: string,
    kind: "authority-requested" | "authority-decided",
    payload: unknown
  ): void {
    const row = this.sql.exec(`SELECT args FROM runs WHERE run_id = ?`, runId).toArray()[0];
    if (!row || !this.appendRunEvent(runId, kind, payload)) return;
    const identity = authorityEventIdentity(payload);
    if (identity) {
      const pending = this.runPendingAuthorityRequests.get(runId) ?? new Map();
      if (kind === "authority-requested") {
        pending.set(identity, payload);
        this.runPendingAuthorityRequests.set(runId, pending);
      } else {
        pending.delete(identity);
        if (pending.size === 0) this.runPendingAuthorityRequests.delete(runId);
      }
    }
    const args = JSON.parse(String(row["args"])) as RunArgs;
    const activity = this.deliverEvalProgress(runId, args, {
      activity: { kind, detail: payload },
    })
      .then(() => undefined)
      .catch((error) => {
        // The durable run event and eval.get activity are canonical. This push
        // only makes the lifecycle visible immediately in the trajectory.
        console.warn(
          `[EvalDO] activity progress delivery for ${runId} failed:`,
          error instanceof Error ? error.message : String(error)
        );
      });
    this.ctx.waitUntil?.(activity);
  }

  /**
   * Best-effort progress is still part of the admitted eval execution. Bind it
   * to that durable execution session so connectionless RPC does not inherit
   * the transient authority parent of whichever callback happened to emit it.
   * That callback may return before a waitUntil delivery reaches the server.
   */
  private async deliverEvalProgress(
    runId: string | undefined,
    args: RunArgs,
    progress: { output?: string; activity?: { kind: string; detail?: unknown } },
    signal?: AbortSignal
  ): Promise<void> {
    if (
      !runId ||
      !args.agentRef ||
      !args.channelId ||
      !args.agentInvocationId ||
      !args.executionSessionNonce
    ) {
      return;
    }
    const options: RpcCallOptions = signal ? { signal } : {};
    bindExecutionSession(options, args.executionSessionNonce);
    await this.rpc.call(
      args.agentRef,
      "onEvalProgress",
      [
        {
          runId,
          agentInvocationId: args.agentInvocationId,
          channelId: args.channelId,
          ...progress,
        },
      ],
      options
    );
  }

  /**
   * Settle an execution that never crossed the method boundary.  The host uses
   * this only after the held executeRun transport failed while the durable row
   * is still pending.  A running or terminal row is untouched, so loss of a
   * response cannot overwrite work that actually began.
   */
  @schemaRpc()
  failPendingRun(runId: string, error: string): RunResult | null {
    const result = this.compactRunResult({
      success: false,
      console: "",
      error,
      failureKind: "infrastructure",
      failureCode: "eval_dispatch_failed",
    });
    this.sql.exec(
      `UPDATE runs SET status = 'done', result = ? WHERE run_id = ? AND status = 'pending'`,
      JSON.stringify(result),
      runId
    );
    const row = this.sql
      .exec(`SELECT status, result FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    return row?.["status"] === "done" && row["result"] != null
      ? (JSON.parse(String(row["result"])) as RunResult)
      : null;
  }

  /**
   * Lossless, bounded retrieval for a large string cached in the durable REPL
   * scope. Reads join `runChain`, so they observe every prior eval's persisted
   * mutations and cannot race a later eval that overwrites the same key.
   */
  @schemaRpc()
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
      const execution = this.infrastructureExecution();
      const manager = await this.ensureScopeManager(await this.ensureEngine(execution));
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
    return read;
  }

  /** Persistently remove one temporary large-result cache key. */
  @schemaRpc()
  async deleteScopeValue(key: string): Promise<{ ok: boolean; existed: boolean }> {
    const remove = this.runChain.then(async () => {
      const execution = this.infrastructureExecution();
      const manager = await this.ensureScopeManager(await this.ensureEngine(execution));
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
    return remove;
  }

  /** Persist a bounded, JSON-safe heartbeat for the currently executing run. */
  private persistRunProgress(runId: string, progress: unknown): void {
    const exists = this.sql
      .exec(`SELECT 1 AS present FROM runs WHERE run_id = ?`, runId)
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
      `INSERT INTO run_progress (run_id, progress, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET progress = excluded.progress, updated_at = excluded.updated_at`,
      runId,
      encoded,
      Date.now()
    );
    this.appendRunEvent(runId, "progress", progress);
  }

  private recordRunCheckpoint(runId: string, checkpoint: Record<string, unknown>): void {
    const at = Date.now();
    this.persistRunCheckpoint(runId, { ...checkpoint, at }, at);
    // State is intentionally excluded: repeatedly polling the same operation
    // alternates waiting/completed but is still one unchanged semantic stage.
    const semantic = { ...checkpoint };
    Reflect.deleteProperty(semantic, "state");
    const digest = canonicalJson(semantic);
    if (this.runCheckpointDigests.get(runId) !== digest) {
      this.runCheckpointDigests.set(runId, digest);
      this.appendRunEvent(runId, "checkpoint", { ...checkpoint, at });
    }
  }

  private completeRunCheckpoint(runId: string, checkpoint: Record<string, unknown>): void {
    const at = Date.now();
    this.persistRunCheckpoint(runId, { ...checkpoint, at }, at);
  }

  private persistRunCheckpoint(
    runId: string,
    checkpoint: Record<string, unknown>,
    at: number
  ): void {
    this.sql.exec(
      `INSERT INTO run_checkpoints (run_id, checkpoint, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE
         SET checkpoint = excluded.checkpoint, updated_at = excluded.updated_at`,
      runId,
      JSON.stringify(checkpoint),
      at
    );
  }

  private appendRunEvent(runId: string, kind: EvalRunEventKind, payload: unknown): boolean {
    let encoded: string;
    try {
      encoded = JSON.stringify(payload) ?? "null";
    } catch (error) {
      encoded = JSON.stringify({
        message: "event payload was not JSON-serializable",
        error: error instanceof Error ? error.message : String(error),
      });
      kind = "diagnostic";
    }
    if (encoded.length > MAX_DURABLE_EVENT_PAYLOAD_CHARS) {
      encoded = JSON.stringify({
        message: "event payload exceeded the durable event bound",
        originalChars: encoded.length,
      });
      kind = "diagnostic";
    }
    const prior = this.sql
      .exec(
        `SELECT sequence, kind, payload
           FROM run_events
          WHERE run_id = ?
          ORDER BY sequence DESC
          LIMIT 1`,
        runId
      )
      .toArray()[0];
    // Only the LATEST state event can be terminal: this very gate absorbs any
    // state event appended after a terminal one, so "terminal state is the last
    // state event" is an invariant, not a property to re-scan every append.
    const lastStateEvent = this.sql
      .exec(
        `SELECT payload
           FROM run_events
          WHERE run_id = ? AND kind = 'state'
          ORDER BY sequence DESC
          LIMIT 1`,
        runId
      )
      .toArray()[0];
    const terminalEventExists = isTerminalRunStatus(parseJsonRecord(lastStateEvent?.["payload"]));
    // The audit tail after terminal: settlement bookkeeping (cleanup),
    // diagnostics, and late authority decisions — an `authority-decided` for a
    // request raised while the run was live is audit that must not be lost.
    const postTerminalTail =
      kind === "cleanup" || kind === "diagnostic" || kind === "authority-decided";
    if (terminalEventExists && !postTerminalTail) return false;
    const sequence = Number(prior?.["sequence"] ?? 0) + 1;
    const at = Date.now();
    this.sql.exec(
      `INSERT INTO run_events (run_id, sequence, at, kind, payload) VALUES (?, ?, ?, ?, ?)`,
      runId,
      sequence,
      at,
      kind,
      encoded
    );
    this.sql.exec(
      `DELETE FROM run_events
        WHERE run_id = ? AND sequence <= (
          SELECT MAX(sequence) - ? FROM run_events WHERE run_id = ?
        )`,
      runId,
      MAX_DURABLE_RUN_EVENTS,
      runId
    );
    const argsRow = this.sql.exec(`SELECT args FROM runs WHERE run_id = ?`, runId).toArray()[0];
    // The durable event remains canonical, but no event after a terminal state
    // may re-enter a route whose authenticated execution session has already
    // been closed. This also covers late waitUntil work from an aborted run.
    if (!argsRow || terminalEventExists) return true;
    const args = JSON.parse(String(argsRow["args"])) as RunArgs;
    if (!args.executionSessionNonce || !args.eventSinkNonce) return true;
    const event = {
      sequence,
      at,
      kind,
      payload: JSON.parse(encoded),
    };
    const options: RpcCallOptions = {};
    bindExecutionSession(options, args.executionSessionNonce);
    if (args.causalParent) options.causalParent = args.causalParent;
    const eventIngress = createTypedServiceClient(
      "evalEventIngress",
      evalEventIngressMethods,
      (service, method, callArgs) =>
        this.rpc.call("main", `${service}.${method}`, callArgs, options)
    );
    const previous = this.liveEventDeliveries.get(runId) ?? Promise.resolve();
    let publish: Promise<void>;
    publish = previous
      .catch(() => undefined)
      .then(() => eventIngress.publish(args.eventSinkNonce!, runId, event))
      .then(() => undefined)
      .catch((error) => {
        // The durable page is canonical. A dropped live observer recovers by
        // cursor without affecting execution or terminal settlement.
        console.warn(
          `[EvalDO] live event delivery failed for ${runId}@${sequence}:`,
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        if (this.liveEventDeliveries.get(runId) === publish) {
          this.liveEventDeliveries.delete(runId);
        }
      });
    this.liveEventDeliveries.set(runId, publish);
    this.ctx.waitUntil?.(publish);
    return true;
  }

  private async drainLiveEventDelivery(runId: string): Promise<void> {
    for (;;) {
      const pending = this.liveEventDeliveries.get(runId);
      if (!pending) return;
      await pending;
      if (this.liveEventDeliveries.get(runId) === pending) return;
    }
  }

  /**
   * The single place durable terminal settlement meets live delivery: hand the
   * ordered per-run delivery chain to the DO lifetime immediately. INVARIANT:
   * terminal settlement
   * (run()/executeRun/cancel) never blocks on a wedged live publisher — the
   * durable page is canonical and observers recover by cursor.
   */
  private settleLiveEventDelivery(runId: string): Promise<void> {
    const drained = this.drainLiveEventDelivery(runId);
    // Durable settlement never waits on the lossy live observer. The DO event
    // owns the ordered delivery tail; cursor recovery remains canonical if the
    // receiver or transport never answers.
    if (this.ctx.waitUntil) this.ctx.waitUntil(drained);
    else void drained.catch(() => undefined);
    return Promise.resolve();
  }

  /** Reset the eval context, including recovery from non-cooperative in-flight work. */
  @schemaRpc()
  async reset(): Promise<{ ok: boolean }> {
    return this.forceReset();
  }

  /**
   * Destructively empty an explicitly finite kernel before its runtime entity
   * retires. Unlike reset, disposal also releases every loaded provider/module
   * reference and removes terminal run records so an idle cached DO instance
   * cannot retain the former owner's execution heap.
   */
  @schemaRpc()
  async dispose(): Promise<{ ok: boolean }> {
    if (this.kernelLease) {
      await this.clearLifecycleRelease();
      this.settleKernelLease(this.kernelLease, "released");
    }
    await this.forceReset();
    this.sql.exec(`DELETE FROM run_progress`);
    this.sql.exec(`DELETE FROM eval_execution_roots`);
    this.sql.exec(`DELETE FROM runs`);
    this.engine = null;
    this.scopeManager = null;
    this.runtimeSupport = null;
    this.portableHelpers = null;
    this.hostedRuntimeIdentity = null;
    this.moduleMap = {};
    for (const key of Object.keys(this.isolateModuleMap)) {
      if (key !== "node:async_hooks") delete this.isolateModuleMap[key];
    }
    this.inFlightRuns.clear();
    this.runAborts.clear();
    this.runCleanupPhases.clear();
    this.runCancelHandlers.clear();
    return { ok: true };
  }

  /**
   * Host-journaled acceptance of an immutable workspace bundle used by this
   * notebook. The host verifies run/session ownership and wraps this durable
   * write in the global execution-publication interlock before invoking it.
   */
  @schemaRpc()
  retainExecutionRoot(
    runId: string,
    moduleSpecifier: string,
    artifactInput: ExecutionArtifactRefV1
  ): void {
    if (!runId || !moduleSpecifier) throw new Error("eval execution root identity is required");
    const run = this.sql.exec(`SELECT 1 FROM runs WHERE run_id = ?`, runId).toArray()[0];
    if (!run) throw new Error(`eval execution root references unknown run ${runId}`);
    const artifact = verifyExecutionArtifactRef(artifactInput);
    const existing = this.sql
      .exec(
        `SELECT artifact_json FROM eval_execution_roots WHERE module_specifier = ?`,
        moduleSpecifier
      )
      .toArray()[0];
    if (existing) {
      const retained = verifyExecutionArtifactRef(
        JSON.parse(String(existing["artifact_json"])) as ExecutionArtifactRefV1
      );
      if (retained.executionDigest !== artifact.executionDigest) {
        throw new Error(
          `eval module ${moduleSpecifier} is already retained at a different execution`
        );
      }
      return;
    }
    this.sql.exec(
      `INSERT INTO eval_execution_roots
         (module_specifier, run_id, artifact_json, retained_at)
       VALUES (?, ?, ?, ?)`,
      moduleSpecifier,
      runId,
      canonicalJson(artifact),
      Date.now()
    );
  }

  @schemaRpc()
  listRetainedExecutionRoots(): Array<{
    runId: string;
    moduleSpecifier: string;
    artifact: ExecutionArtifactRefV1;
  }> {
    return this.sql
      .exec(
        `SELECT run_id, module_specifier, artifact_json
         FROM eval_execution_roots
         ORDER BY module_specifier`
      )
      .toArray()
      .map((row) => ({
        runId: String(row["run_id"]),
        moduleSpecifier: String(row["module_specifier"]),
        artifact: verifyExecutionArtifactRef(
          JSON.parse(String(row["artifact_json"])) as ExecutionArtifactRefV1
        ),
      }));
  }

  /**
   * Import acquisition is rooted before bundle evaluation so execution GC
   * cannot race the load. Once a run settles, only modules that actually
   * reached one of this kernel's persistent maps still own that root. This
   * removes acquisitions discarded by package initialization failure,
   * deadline cancellation, or forced recovery.
   */
  private releaseUnloadedExecutionRoots(runId: string): void {
    const rows = this.sql
      .exec(
        `SELECT module_specifier
           FROM eval_execution_roots
          WHERE run_id = ?`,
        runId
      )
      .toArray();
    for (const row of rows) {
      const specifier = String(row["module_specifier"]);
      if (
        this.moduleMap[specifier] !== undefined ||
        this.isolateModuleMap[specifier] !== undefined
      ) {
        continue;
      }
      this.sql.exec(
        `DELETE FROM eval_execution_roots
          WHERE run_id = ? AND module_specifier = ?`,
        runId,
        specifier
      );
    }
  }

  /**
   * Cancel ONE run without touching scope or other runs. `cancelling` is a
   * durable non-terminal state: it defeats `runEval`'s `status='running'`
   * completion CAS while retaining the evaluated-execution admission needed by
   * cleanup. Only a settled cleanup phase publishes `cancelled`.
   */
  @schemaRpc()
  async cancel(runId: string): Promise<EvalCancelResult> {
    const existing = this.inFlightCancellations.get(runId);
    if (existing) return existing;
    const cancellation = this.cancelRun(runId);
    this.inFlightCancellations.set(runId, cancellation);
    try {
      return await cancellation;
    } finally {
      if (this.inFlightCancellations.get(runId) === cancellation) {
        this.inFlightCancellations.delete(runId);
      }
    }
  }

  private async cancelRun(runId: string): Promise<EvalCancelResult> {
    const claimed = this.sql
      .exec(
        `UPDATE runs SET status = 'cancelling'
         WHERE run_id = ? AND status IN ('pending', 'running')
         RETURNING status`,
        runId
      )
      .toArray()[0];
    if (!claimed) return { ok: true, forcedReset: false };
    this.appendRunEvent(runId, "state", { status: "cancellation-requested" });
    this.appendRunEvent(runId, "cleanup", { status: "started" });
    const inFlight = this.inFlightRuns.get(runId);
    const hasOwnedCleanup = (this.runCancelHandlers.get(runId)?.size ?? 0) > 0;
    const cleanupPhase = this.runCleanupPhases.get(runId);
    if (cleanupPhase) cleanupPhase.active = true;
    const cleanup = this.executeRunCancelHandlers(runId);
    this.runAborts.get(runId)?.abort();
    const terminal = Promise.allSettled([inFlight ?? Promise.resolve(undefined), cleanup]);
    // A registered cleanup handler is the run's lifecycle owner. In particular,
    // orchestration handlers may need to interrupt remote model work, retire
    // sessions, and serialize a terminal record. Revoking their execution
    // authority after an arbitrary wall-clock interval corrupts that teardown
    // and lets it continue against a reset scope. Treat the admitted eval and
    // its owned cleanup as one trust unit and await its real settlement.
    //
    // The bounded recovery path remains for genuinely unowned guest code: an
    // eval with no cleanup contract can await a non-cooperative promise forever,
    // so there is nobody whose valid teardown a force reset could interrupt.
    const settlement: TimedSettlement<
      [PromiseSettledResult<RunResult | undefined>, PromiseSettledResult<void>]
    > = hasOwnedCleanup
      ? { settled: true, value: await terminal }
      : await settleWithin(terminal, this.cancellationGraceMs);
    try {
      if (!settlement.settled) {
        console.warn(
          `[EvalDO] run ${runId} did not settle within ${this.cancellationGraceMs}ms; resetting its eval scope`
        );
        await this.forceReset();
        return { ok: true, forcedReset: true };
      }
      const [, cleanupResult] = settlement.value;
      // runLocked and cleanup race intentionally so a cleanup owner can release
      // the resource on which the sandbox is blocked. Once both are terminal,
      // persist the shared scope again: cleanup may have recorded terminal state
      // after runLocked's exitEval() snapshot. Persist even when a handler
      // rejects: partial terminal diagnostics must remain inspectable rather
      // than disappearing behind the cleanup error.
      let persistenceFailure: unknown;
      try {
        await this.scopeManager?.persist();
      } catch (error) {
        persistenceFailure = error;
      }
      if (cleanupResult.status === "rejected" && persistenceFailure !== undefined) {
        throw new AggregateError(
          [cleanupResult.reason, persistenceFailure],
          `eval: cancellation cleanup and terminal scope persistence failed for run ${runId}`
        );
      }
      if (cleanupResult.status === "rejected") throw cleanupResult.reason;
      if (persistenceFailure !== undefined) throw persistenceFailure;
      return { ok: true, forcedReset: false };
    } finally {
      // Terminalization is guaranteed even when cleanup reports a failure. The
      // cancel RPC still rejects in that case, but admission monitors can now
      // retire the failed run instead of leaking a permanent cancelling fact.
      this.sql.exec(
        `UPDATE runs SET status = 'cancelled' WHERE run_id = ? AND status = 'cancelling'`,
        runId
      );
      this.appendRunEvent(runId, "cleanup", { status: "settled" });
      this.appendRunEvent(runId, "state", { status: "cancelled" });
      await this.settleLiveEventDelivery(runId);
    }
  }

  private async executeRunCancelHandlers(runId: string): Promise<void> {
    const handlers = [...(this.runCancelHandlers.get(runId) ?? [])];
    this.runCancelHandlers.delete(runId);
    if (handlers.length === 0) return;
    // Invoke every handler before the caller aborts ordinary guest execution.
    // A handler may then await that unwind, but its synchronous prefix must be
    // able to claim child resources first. Deferring invocation to a microtask
    // lets the guest's abort/finally retire those resources before cleanup has
    // even started.
    const pending = handlers.map((handler) => {
      try {
        return Promise.resolve(handler());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    const results = await Promise.allSettled(pending);
    this.throwCancellationCleanupFailures(results, `run ${runId}`);
  }

  private throwCancellationCleanupFailures(
    results: PromiseSettledResult<unknown>[],
    operation: string
  ): void {
    const failures = this.cancellationCleanupFailures(results);
    if (failures.length > 0) {
      const details = failures
        .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
        .join("; ");
      throw new AggregateError(
        failures,
        `eval: cancellation cleanup failed during ${operation}: ${details}`
      );
    }
  }

  private cancellationCleanupFailures(results: PromiseSettledResult<unknown>[]): unknown[] {
    return results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
  }

  /**
   * Guaranteed recovery for a WEDGED DO: a run stuck on a never-returning outbound call holds
   * `runChain`, so `reset` (which `.then()`s off that chain) would hang behind it. Instead we:
   *  1. CAS every non-terminal run to `cancelled` (so any orphaned run's eventual finish loses its
   *     CAS persist — see `runEval` — and is neutralized; it can never resurrect itself `done`),
   *  2. start every cancellation handler, then abort EVERY in-flight controller. Explicit
   *     recovery does not depend forever on a non-cooperative handler,
   *  3. REPLACE `this.runChain` with a fresh resolved promise — we ORPHAN the stuck chain rather
   *     than `.then()` off it, so we never wait on the wedged run, and
   *  4. run `resetLocked()` synchronously (NOT queued behind the old chain).
   * `resetLocked` only drops user tables + the scope table and nulls `this.scopeManager` (forcing a
   * fresh empty hydrate on the next run); it touches nothing the orphaned run still needs to finish
   * safely — and even if the orphan later runs `exitEval` against the wiped scope, its `cancelled`
   * status already discarded its result, so a fresh run is unaffected.
   */
  private async forceReset(): Promise<{ ok: boolean }> {
    this.sql.exec(
      `UPDATE runs SET status = 'cancelled'
       WHERE status IN ('pending', 'running', 'cancelling')`
    );
    const runIds = new Set([...this.runAborts.keys(), ...this.runCancelHandlers.keys()]);
    for (const id of runIds) {
      const phase = this.runCleanupPhases.get(id);
      if (phase) phase.active = true;
    }
    const cleanup = Promise.allSettled([...runIds].map((id) => this.executeRunCancelHandlers(id)));
    for (const controller of this.runAborts.values()) controller.abort();
    for (const runId of runIds) this.releaseUnloadedExecutionRoots(runId);
    const cleanupSettlement = await settleWithin(cleanup, this.cancellationGraceMs);
    for (const phase of this.runCleanupPhases.values()) {
      phase.active = false;
      phase.revoked = true;
    }
    if (!cleanupSettlement.settled) {
      console.warn(
        `[EvalDO] force reset continued after cancellation cleanup exceeded ${this.cancellationGraceMs}ms`
      );
      void cleanup.then((results) => {
        const failures = this.cancellationCleanupFailures(results);
        if (failures.length > 0) {
          console.error("[EvalDO] late cancellation cleanup failed after force reset", failures);
        }
      });
    }
    // Orphan the (possibly wedged) chain — do NOT `.then()` off it, or we'd hang behind the stuck
    // run. A subsequently-enqueued run chains off this fresh resolved promise and proceeds at once.
    this.runChain = Promise.resolve();
    let result: { ok: boolean };
    try {
      result = this.resetLocked();
    } catch (error) {
      const cleanupFailures = cleanupSettlement.settled
        ? this.cancellationCleanupFailures(cleanupSettlement.value)
        : [];
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "eval: force reset and cancellation cleanup failed"
        );
      }
      throw error;
    }
    if (cleanupSettlement.settled) {
      this.throwCancellationCleanupFailures(cleanupSettlement.value, "force reset");
    }
    return result;
  }

  private resetLocked(): { ok: boolean } {
    this.scopeGeneration += 1;
    const tables = this.sql
      .exec(
        `SELECT name FROM sqlite_master
         WHERE type='table'
           AND name NOT LIKE 'sqlite_%'
           AND name NOT GLOB '_vibestudio_*'
           AND name NOT IN (
             'state',
             'repl_scopes',
             'runs',
             'run_progress',
             'run_checkpoints',
             'run_events',
             'eval_execution_roots'
           )`
      )
      .toArray() as Array<{ name: string }>;
    for (const { name } of tables) {
      this.sql.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    }
    // Drop the scope table (lazily created by SqlScopePersistence) — IF EXISTS so reset
    // works before the first run (e.g. `--fresh-scope`); the next run recreates it empty.
    this.sql.exec(`DROP TABLE IF EXISTS repl_scopes`);
    this.scopeManager = null; // force fresh hydrate (empty) on next run
    this.scopeRecovery = null;
    return { ok: true };
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private settleKernelLease(lease: KernelLeaseState, reason: "released" | "replaced"): void {
    if (lease.timer) clearTimeout(lease.timer);
    if (this.kernelLease === lease) this.kernelLease = null;
    lease.settle({ reason });
  }

  private async expireKernelLease(lease: KernelLeaseState): Promise<void> {
    if (this.kernelLease !== lease) return;
    // The held request keeps this activation resident while its durable
    // lifecycle declaration is cleared.
    await this.clearLifecycleRelease();
    if (this.kernelLease === lease) {
      if (lease.timer) clearTimeout(lease.timer);
      this.kernelLease = null;
      lease.settle({ reason: "expired" });
    }
  }

  private kernelStatusForRun(): KernelRunStatus {
    const event = this.kernelEventPending
      ? {
          kind: this.kernelRestarted ? ("restarted" as const) : ("started" as const),
          recovery: this.scopeRecovery
            ? {
                status: "complete" as const,
                restored: [...this.scopeRecovery.restored],
                lost: [...this.scopeRecovery.lost],
              }
            : { status: "unavailable" as const },
        }
      : undefined;
    this.kernelEventPending = false;
    return {
      incarnationId: this.kernelIncarnationId,
      startedAt: this.kernelStartedAt,
      ...(this.kernelLease ? { idleExpiresAt: this.kernelLease.expiresAt } : {}),
      ...(event ? { event } : {}),
    };
  }

  private async runLocked(
    args: RunArgs,
    signal?: AbortSignal,
    runId?: string,
    deadlineAt?: number | null,
    cleanupPhase?: RunCleanupPhase
  ): Promise<RunResult> {
    const scopeGeneration = this.scopeGeneration;
    const execution = this.createExecutionContext({ ...args, runId }, signal, cleanupPhase);
    const engine = await this.ensureEngine(execution);
    const support = await this.ensureRuntimeSupport(execution);
    const scopeManager = await this.ensureScopeManager(engine, scopeGeneration);

    // Runtime clients can be retained by module singletons and scope, so they
    // borrow this immutable execution through activeEvalExecution at call time.
    // A force reset may overlap another run, but async-local lookup prevents
    // either one from replacing the other's causal edge, containment, or abort
    // signal.
    const rt = hardenBoundary(
      this.createRunHostedRuntime(support, execution, args.gatewayToken, args.parent ?? null)
    );
    // `services` is the complete convenience namespace (createServicesProxy): service names that
    // don't collide with runtime bindings are reachable as `services.<name>.<method>(...)`, while
    // rich runtime clients win on collisions (`services.workers` is the same ergonomic `workers`
    // binding). Raw service methods are always reachable with `rpc.call("main", "<svc>.<method>", [...])`.
    // It layers:
    //  1. ergonomic override — when `<name>` is a rich runtime client (vcs/fs/credentials/blobstore/
    //     …), `services.<name>` is that SAME curated object (so `services.vcs` === the bare `vcs`),
    //  2. dynamic fallback — any other service becomes `callMain("<name>.<method>", …)`.
    // It adds no access: the fallback routes through `callMain`, so the server dispatcher's
    // per-method `policy.allowed` is still the sole gate (a `do`-denied method still rejects).
    // Layer 2 — the importable surface (gad/workspace/credentials/openPanel/…)
    // injected ambiently too (same refs as importing the declared runtime
    // module), plus Layer 3 — eval-only ambient state helpers (scope/db/help/…).
    // Help text names the DECLARED runtime module (providers.evalRuntime) —
    // resolvable here because ensureRuntimeSupport already required it.
    const runtimeModuleName = this.requireDeclaredProviderSource(
      "EVAL_RUNTIME_SOURCE",
      "evalRuntime"
    );
    const describeHelpOverview = async () => ({
      // Names only — keeps the eval scope lean. For a service's methods +
      // typed schemas, call help('<name>') (rich bindings show the ergonomic
      // surface) or use the docs_open/docs_search tools (raw catalog).
      services: (await execution.docs.listServices()).map((s) => s.name),
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
        "globals and may also be imported in eval as a compatibility form when present. Use the `imports` parameter for npm/workspace packages. " +
        "Full reference: skills/sandbox/EVAL.md.",
    });
    const bindings: Record<string, unknown> = {
      ...rt,
      ctx: hardenBoundary({
        contextId: args.contextId ?? null,
        objectKey: this.objectKey,
        ...(runId
          ? {
              reportProgress: (progress: unknown) => this.persistRunProgress(runId, progress),
              onCancel: (handler: unknown) => {
                if (typeof handler !== "function") {
                  throw new Error("ctx.onCancel requires a cleanup function");
                }
                const handlers = this.runCancelHandlers.get(runId) ?? new Set();
                handlers.add(handler as () => void | Promise<void>);
                this.runCancelHandlers.set(runId, handlers);
              },
            }
          : {}),
      }),
      scope: scopeManager.current,
      scopes: hardenBoundary(scopeManager.api),
      db: hardenBoundary(this.dbBinding(scopeGeneration)),
      // `help()` → discovery for an agent driving eval: the importable runtime
      // surface (what `import {…} from "@workspace/runtime"` gives), the eval-only
      // ambient globals (do NOT import these), available raw services, and where to look next.
      // `help("<service>")` → that service's methods.
      help: async (serviceName?: string) => {
        if (serviceName !== undefined && typeof serviceName !== "string") {
          return invalidHelpArgumentResponse(serviceName);
        }
        if (serviceName === "services") return describeHelpOverview();
        if (serviceName) {
          const dot = serviceName.indexOf(".");
          if (dot > 0) {
            const bindingName = serviceName.slice(0, dot);
            const methodName = serviceName.slice(dot + 1);
            const binding = rt[bindingName];
            if (binding && typeof binding === "object") {
              const described = await this.describeInjectedSurface(
                bindingName,
                binding as Record<string, unknown>,
                execution.docs
              );
              if (described && typeof described === "object") {
                const surface = described as { methods?: Record<string, unknown> };
                if (surface.methods?.[methodName]) {
                  return describeEvalMethod(serviceName, surface.methods[methodName]);
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
                injected as Record<string, unknown>,
                execution.docs
              );
              if (described && typeof described === "object") {
                return describeEvalBindingIndex(
                  described as import("./evalSurfaceHelp.js").InjectedSurfaceDescription
                );
              }
            }
            // A function/value runtime export (openPanel, getPanelHandle, callMain, …) —
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
          return execution.docs.describeService(serviceName);
        }
        return describeHelpOverview();
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
      hardenBoundary(
        buildOwnerBindings(args, (target, method, values) =>
          execution.rpc.call(target, method, values)
        )
      )
    );
    hardenBoundary(bindings["help"]);

    // In path mode, load the entry file. The eval service validates exactly one of
    // `code` or `path`; this fallback remains defensive for direct/internal calls.
    const entryCode =
      args.code !== undefined
        ? args.code
        : args.path
          ? await this.readSourceFile(args.path, execution)
          : "";
    const sourcePath = args.sourcePath ?? args.path;

    // Eval-only helpers are ambient for terse REPL use, but importing them is a
    // reasonable TypeScript habit. Mirror the same live references onto this
    // owner's runtime module so importing help/scope/db is compatibility-
    // equivalent to using the ambient binding and cannot shadow it with
    // undefined.
    const runtimeFs = rt["fs"];
    if (!runtimeFs || typeof runtimeFs !== "object") {
      throw new Error("eval: hosted runtime did not expose its scoped filesystem");
    }
    const runLocalModules = Object.fromEntries(
      Object.entries(createEvalNodeCompat(runtimeFs as Record<string, unknown>)).map(
        ([specifier, namespace]) => [specifier, freezeModuleNamespace(namespace)]
      )
    );
    const runModuleMap: Record<string, unknown> = {
      ...this.moduleMap,
      ...runLocalModules,
      [runtimeModuleName]: { ...rt, ...(this.portableHelpers ?? {}) },
    };
    const evalRuntimeModule = runModuleMap[runtimeModuleName];
    if (evalRuntimeModule && typeof evalRuntimeModule === "object") {
      const namespace = evalRuntimeModule as Record<string, unknown>;
      for (const name of EVAL_AMBIENT_ONLY) {
        if (name in bindings) namespace[name] = bindings[name];
      }
      // The namespace shape is immutable. `scope` remains deliberately mutable
      // behind its proxy and is therefore not recursively hardened here.
      Object.freeze(namespace);
    }

    // Lazily build the cdp-client bundle ONLY when this run references CDP. Most
    // evals (fs/vcs/git) never touch it, and the build is a cold-path round-trip
    // that dominated first-run latency. Direct `import "@workspace/cdp-client"`
    // self-heals via the engine's loadImport; this pre-seed is for the
    // `handle.cdp` → loadCdpClient sync-require path. The check is
    // conservative — every route to the client (the import specifier,
    // `handle.cdp`, `CdpConnection`, `getCdpEndpoint`) contains "cdp", so a
    // no-match guarantees no CDP use; a false positive just restores prior cost.
    // Live console streaming — agent-owned eval only (`agentRef`+`channelId` set by the eval service).
    // Each chunk is forwarded to the owning agent's `onEvalProgress` (gated there by
    // `assertOwnEvalCaller`), which publishes it as an `invocation.output` event so the chat panel
    // renders the console live. CLI/panel eval (no `agentRef`) gets the full console in the result.
    const agentRef = args.agentRef;
    const channelId = args.channelId;
    const agentInvocationId = args.agentInvocationId;
    const executionSessionNonce = args.executionSessionNonce;
    const streamer =
      agentRef && channelId && agentInvocationId && executionSessionNonce
        ? new ConsoleStreamer((chunk, progressSignal) =>
            this.deliverEvalProgress(
              runId,
              { ...args, executionSessionNonce },
              { output: chunk },
              progressSignal
            )
          )
        : null;

    let consoleOutput = "";
    let liveConsoleBuffer = "";
    let liveConsoleTimer: ReturnType<typeof setTimeout> | null = null;
    const flushLiveConsole = () => {
      if (liveConsoleTimer) clearTimeout(liveConsoleTimer);
      liveConsoleTimer = null;
      if (!runId || liveConsoleBuffer.length === 0) return;
      const text = liveConsoleBuffer;
      liveConsoleBuffer = "";
      this.appendRunEvent(runId, "console", {
        text: this.windowText(text, 12_000, "$lastLargeConsole"),
      });
    };
    scopeManager.enterEval();
    try {
      const result = await this.activeEvalExecution.run(execution, () =>
        engine.executeSandbox(entryCode, {
          syntax: args.syntax ?? "tsx",
          imports: args.imports,
          sourcePath,
          loadImport: this.makeLoadImport(execution),
          loadSourceFile: sourcePath
            ? (path: string) => this.readSourceFile(path, execution)
            : undefined,
          bindings,
          // Per-object map/require so this owner's loaded imports never leak to other owners
          // sharing the isolate (the engine's global module map is the multi-tenant leak).
          moduleMap: runModuleMap,
          require: (id: string): unknown => {
            const value = runModuleMap[id];
            if (value !== undefined) return value;
            throw new Error(`Module "${id}" not available in EvalDO; use the imports parameter.`);
          },
          compileFunction: this.compileInIsolate,
          confinement: "private-global",
          freezeModuleNamespace,
          publishLazyLoaderToGlobal: false,
          // Opt-in deadline (timeoutMs) → AbortSignal. Best-effort: the engine may not honor it
          // inside native code; authored loops/functions also receive cooperative
          // checkpoints so ordinary synchronous code settles inside this EvalDO.
          signal,
          ...(deadlineAt !== null && deadlineAt !== undefined && args.timeoutMs !== undefined
            ? { deadline: { atMs: deadlineAt, timeoutMs: args.timeoutMs } }
            : {}),
          onConsole: (formatted: string) => {
            const chunk = `${consoleOutput ? "\n" : ""}${formatted}`;
            consoleOutput += chunk;
            liveConsoleBuffer += chunk;
            if (liveConsoleBuffer.length >= 4_096) flushLiveConsole();
            else if (runId && !liveConsoleTimer)
              liveConsoleTimer = setTimeout(flushLiveConsole, 25);
            streamer?.push(formatted);
          },
        })
      );
      // Live progress is incidental. The terminal result below is canonical and
      // includes the complete console, so a stalled progress receiver must not
      // hold this durable run open.
      streamer?.close();
      flushLiveConsole();
      const consoleText = result.consoleOutput || consoleOutput;
      // Recoverable large output: the harness windows console/error/return for
      // the model, losing the tail. Keep one bounded spill per output kind in
      // stable slots that small follow-up inspectors do not overwrite.
      this.spillLargeOutput(scopeManager.current, consoleText, result.error, result.returnValue);
      return {
        success: result.success,
        console: consoleText,
        returnValue: result.returnValue,
        error: result.error,
        failureKind: result.failureKind,
        failureCode: result.failureCode,
        errorData: result.errorData,
        scopeKeys: Object.keys(scopeManager.current),
      };
    } finally {
      flushLiveConsole();
      streamer?.close();
      if (!signal?.aborted) {
        const localKeys = new Set([
          runtimeModuleName,
          ...Object.keys(this.isolateModuleMap),
          ...Object.keys(runLocalModules),
        ]);
        for (const [specifier, value] of Object.entries(runModuleMap)) {
          if (!localKeys.has(specifier)) this.moduleMap[specifier] = value;
        }
      }
      await scopeManager.exitEval();
    }
  }

  private compactRunResult(result: RunResult): RunResult {
    const compact: RunResult = {
      success: result.success,
      console: this.windowText(result.console, RESULT_CONSOLE_MAX_CHARS, "$lastLargeConsole"),
      ...(result.error
        ? { error: this.windowText(result.error, RESULT_ERROR_MAX_CHARS, "$lastLargeError") }
        : {}),
      ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      ...(result.errorData !== undefined
        ? { errorData: this.compactReturnValue(result.errorData) }
        : {}),
      ...(result.scopeKeys ? { scopeKeys: result.scopeKeys.slice(0, 500) } : {}),
      ...(result.kernel ? { kernel: result.kernel } : {}),
    };
    if (result.returnValue !== undefined) {
      compact.returnValue = this.compactReturnValue(result.returnValue);
    }

    let encoded = JSON.stringify(compact);
    if (encoded.length <= RESULT_STORAGE_MAX_CHARS) return compact;

    const fallback: RunResult = {
      success: compact.success,
      console: this.windowText(compact.console, 20_000, "$lastLargeConsole"),
      ...(compact.error
        ? { error: this.windowText(compact.error, 10_000, "$lastLargeError") }
        : {}),
      ...(compact.failureKind ? { failureKind: compact.failureKind } : {}),
      ...(compact.failureCode ? { failureCode: compact.failureCode } : {}),
      ...(compact.errorData !== undefined ? { errorData: compact.errorData } : {}),
      ...(compact.returnValue !== undefined ? { returnValue: compact.returnValue } : {}),
      ...(compact.scopeKeys ? { scopeKeys: compact.scopeKeys.slice(0, 200) } : {}),
      ...(compact.kernel ? { kernel: compact.kernel } : {}),
    };
    encoded = JSON.stringify(fallback);
    if (encoded.length <= RESULT_STORAGE_MAX_CHARS) return fallback;

    return {
      success: result.success,
      console:
        "[eval] Result exceeded the EvalDO storage limit. Large console/error/return data may be available in scope.$lastLargeConsole, scope.$lastLargeError, and scope.$lastLargeReturn.",
      ...(result.error ? { error: this.windowText(result.error, 10_000, "$lastLargeError") } : {}),
      ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      ...(result.errorData !== undefined
        ? { errorData: this.compactReturnValue(result.errorData) }
        : {}),
      ...(result.scopeKeys ? { scopeKeys: result.scopeKeys.slice(0, 100) } : {}),
      ...(result.kernel ? { kernel: result.kernel } : {}),
    };
  }

  private compactReturnValue(returnValue: unknown): unknown {
    const text = this.stringifyForResult(returnValue);
    if (text.length <= EVAL_RESULT_RETURN_PREVIEW_CHARS) return returnValue;
    return {
      truncated: true,
      reason: "eval return value exceeded result transport/storage limit",
      originalChars: text.length,
      scopeKey: "$lastLargeReturn",
      preview: this.windowText(text, EVAL_RESULT_RETURN_PREVIEW_CHARS, "$lastLargeReturn"),
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
      `Inspect scope.${scopeKey} compactly, e.g. return { length: scope.${scopeKey}.length, sample: scope.${scopeKey}.slice(0, 1500) }.]\n` +
      `${text.slice(-tail)}`
    );
  }

  /**
   * Keep the previous return value available for ordinary REPL-style follow-up
   * calls, and retain one stable bounded spill for each large output kind.
   * Small inspectors overwrite `$lastReturn`, but deliberately do not erase
   * `$lastLarge*`, so a large result can be inspected over multiple calls.
   */
  private spillLargeOutput(
    scope: Record<string, unknown>,
    console: string,
    error: string | undefined,
    returnValue: unknown
  ): void {
    const MAX = 1_000_000; // hard cap so the persisted scope can't balloon
    const stashLarge = (key: string, text: string | undefined, threshold: number): void => {
      if (!text || text.length <= threshold) return;
      scope[key] =
        text.length > MAX
          ? `${text.slice(0, MAX)}\n…[${text.length - MAX} more chars dropped]`
          : text;
    };
    stashLarge("$lastLargeConsole", console, RESULT_CONSOLE_MAX_CHARS);
    stashLarge("$lastLargeError", error, RESULT_ERROR_MAX_CHARS);
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
    stashLarge("$lastLargeReturn", returnText, EVAL_RESULT_RETURN_PREVIEW_CHARS);
    if (returnText.length <= EVAL_RESULT_RETURN_PREVIEW_CHARS) {
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

  private compileFunction(argNames: string[], body: string): (...args: unknown[]) => unknown {
    const unsafeEval = this.env["UNSAFE_EVAL"] as UnsafeEvalBinding | undefined;
    if (!unsafeEval) throw new Error("EvalDO: UNSAFE_EVAL binding not configured");
    return unsafeEval.newFunction(body, "eval", ...argNames);
  }

  private requireIsolateModule = (id: string): unknown => {
    const mod = this.isolateModuleMap[id];
    if (mod !== undefined) return mod;
    throw new Error(`Module "${id}" not available in EvalDO. Use the imports parameter for npm.`);
  };

  private compileInIsolate = (argNames: string[], body: string) =>
    this.compileFunction(argNames, body);

  /**
   * Build `specifier` as a worker library bundle via the build service and
   * execute it into the shared isolate module map (via the UnsafeEval compiler
   * — `new Function` is blocked even for this bootstrap step). Idempotent per
   * specifier. Only stateless library modules belong in the SHARED map.
   */
  private async loadLibraryModule(
    specifier: string,
    execution: EvalExecutionContext,
    opts: { externals?: string[]; endowments?: Readonly<Record<string, unknown>> } = {}
  ): Promise<unknown> {
    const moduleMap = this.isolateModuleMap;
    if (!moduleMap[specifier]) {
      const built = await execution.build.getBuild(specifier, undefined, {
        library: true,
        externals: opts.externals ?? [],
        libraryTarget: "worker",
      });
      const artifact = requireBuildBundleResult(
        built,
        `EvalDO: build.getBuild did not return a library bundle for ${specifier}`
      );
      await this.retainWorkspaceImport(execution, specifier, artifact.execution);
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const body =
        artifact.format === "async-cjs"
          ? `return (async () => {\n${artifact.bundle}\n})();`
          : artifact.bundle;
      const controlledImport = async (dependency: string): Promise<unknown> =>
        this.requireIsolateModule(dependency);
      const receiver = [this.requireIsolateModule, exports, module, controlledImport];
      const runConfined = this.compileInIsolate(
        ["scope"],
        `with (scope) {\n` +
          `  return (function(require, exports, module, __vibestudioImport) {\n` +
          `    "use strict";\n${body}\n` +
          `  }).apply(undefined, this.receiver);\n` +
          `}`
      );
      await runConfined.call(
        { receiver },
        createPrivateGuestGlobal(globalThis as unknown as Record<string, unknown>, opts.endowments)
      );
      moduleMap[specifier] = freezeModuleNamespace(module.exports);
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
  private async ensureEngine(execution: EvalExecutionContext): Promise<EvalEngine> {
    if (this.engine) return this.engine;
    const engineSource = this.requireDeclaredProviderSource("EVAL_ENGINE_SOURCE", "evalEngine");
    const moduleMap = this.isolateModuleMap;
    const loaded = await this.loadLibraryModule(engineSource, execution, {
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
  private async ensureRuntimeSupport(
    execution: EvalExecutionContext
  ): Promise<RuntimeSupportModule> {
    if (this.runtimeSupport && this.portableHelpers) return this.runtimeSupport;
    const runtimeSource = this.requireDeclaredProviderSource("EVAL_RUNTIME_SOURCE", "evalRuntime");
    const [hosted, panelRuntime, portable] = await Promise.all([
      this.loadLibraryModule(`${runtimeSource}/hosted`, execution),
      this.loadLibraryModule(`${runtimeSource}/panel-runtime`, execution),
      this.loadLibraryModule(`${runtimeSource}/portable`, execution),
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

  private async ensureScopeManager(
    engine: EvalEngine,
    generation = this.scopeGeneration
  ): Promise<ScopeManagerLike> {
    if (generation !== this.scopeGeneration) {
      throw new Error("eval execution was invalidated by a scope reset");
    }
    if (this.scopeManager) return this.scopeManager;
    // Scope persistence is owner infrastructure, not an eval-authored effect.
    // The cached manager must never retain the causal edge, containment, or
    // abort signal of whichever run happened to initialize it first.
    const blobstore = this.infrastructureExecution().blobstore;
    const rawPersistence = new engine.SqlScopePersistence(this.sql, {
      putText: (valueJson: string) => blobstore.putText(valueJson),
      getText: (digest: string) => blobstore.getText(digest),
    });
    const persistence = new Proxy(rawPersistence as object, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        if (property === "upsert" && typeof value === "function") {
          return (...args: unknown[]) => {
            if (generation !== this.scopeGeneration) {
              return Promise.reject(new Error("eval execution was invalidated by a scope reset"));
            }
            return Reflect.apply(value, target, args) as unknown;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const mgr = new engine.ScopeManager({
      channelId: this.objectKey, // one scope per EvalDO instance
      panelId: "eval",
      persistence,
    });
    // MUST await hydrate before the manager is used: enterEval/exitEval read &
    // re-persist `current`, so a run that proceeds before the prior scope loads
    // would execute with an empty scope and then OVERWRITE the persisted scope on
    // exit (cold-start data loss). loadCurrent is safe pre-write (ensureSchema
    // created the table in the persistence ctor) and returns empty on a fresh DO.
    const recovery = await mgr.hydrate();
    if (generation !== this.scopeGeneration) {
      throw new Error("eval execution was invalidated by a scope reset");
    }
    this.scopeRecovery = recovery;
    this.scopeManager = mgr;
    return mgr;
  }

  /** loadImport over the build service (same on-demand build surface as the in-app eval tool). */
  private makeLoadImport(execution: EvalExecutionContext): EvalImportLoader {
    // The eval sandbox runs in this workerd DO — resolve imports as a worker,
    // from the same caller context that backs its fs/vcs/runtime surfaces.
    const load = createEvalImportLoader(execution.build, "worker", {
      defaultWorkspaceRef: () => (execution.contextId ? `ctx:${execution.contextId}` : undefined),
    });
    const tracked = async (specifier: string, ref: string | undefined, externals: string[]) => {
      const artifact = await load(specifier, ref, externals);
      await this.retainWorkspaceImport(execution, specifier, artifact.execution);
      return artifact;
    };
    return Object.assign(tracked, {
      resolveWorkspaceImport: load.resolveWorkspaceImport,
    });
  }

  private async retainWorkspaceImport(
    execution: EvalExecutionContext,
    moduleSpecifier: string,
    artifact: ExecutionArtifactRefV1 | undefined
  ): Promise<void> {
    if (!artifact) return;
    if (!execution.runId) {
      throw new Error(`eval workspace import ${moduleSpecifier} has no owning run identity`);
    }
    const verified = verifyExecutionArtifactRef(artifact);
    const roots = createTypedServiceClient(
      "evalExecutionRoots",
      evalExecutionRootsMethods,
      (service, method, args) => execution.rpc.call("main", `${service}.${method}`, args)
    );
    await roots.retain(
      execution.runId,
      moduleSpecifier,
      executionArtifactRefSchema.parse(verified)
    );
  }

  private async readSourceFile(path: string, execution: EvalExecutionContext): Promise<string> {
    const contents = await execution.fs.readFile(path, "utf8");
    if (typeof contents !== "string") {
      throw new Error(`fs.readFile returned non-text content for eval source file: ${path}`);
    }
    return contents;
  }

  private requireActiveEvalExecution(): EvalExecutionContext {
    const active = this.activeEvalExecution.getStore();
    if (!active) {
      throw new Error("eval: retained runtime clients require an actively executing eval cell");
    }
    return active;
  }

  /**
   * Stable RPC facade for runtime objects retained by imported modules or
   * notebook scope. Each operation borrows the invoking cell's immutable RPC
   * context at call time; no retained object can keep an earlier cell's abort
   * signal, execution-session nonce, causal parent, or authority attenuation.
   */
  private createActiveRuntimeRpc(): RpcClient {
    const call = <T = unknown>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ) => this.requireActiveEvalExecution().rpc.call<T>(targetId, method, args, options);
    const emit = (targetId: string, event: string, payload: unknown, options?: RpcCallOptions) =>
      this.requireActiveEvalExecution().rpc.emit(targetId, event, payload, options);
    const peerFor = (targetId: string) => {
      const inbound = this.rpc.peer(targetId);
      const contextual = {
        id: targetId,
        call: new Proxy(
          {},
          {
            get:
              (_target, method) =>
              (...args: unknown[]) =>
                call(targetId, String(method), args),
          }
        ),
        on: inbound.on.bind(inbound),
        emit: (event: string, payload: unknown) => emit(targetId, event, payload),
        withContract: () => contextual,
      };
      return contextual;
    };
    return Object.freeze({
      selfId: this.rpc.selfId,
      expose: this.rpc.expose.bind(this.rpc),
      exposeAll: this.rpc.exposeAll.bind(this.rpc),
      exposeStreaming: this.rpc.exposeStreaming.bind(this.rpc),
      call,
      stream: (targetId: string, method: string, args: unknown[], options?: RpcStreamOptions) =>
        this.requireActiveEvalExecution().rpc.stream(targetId, method, args, options),
      streamReadable: (
        targetId: string,
        method: string,
        args: unknown[],
        options?: RpcStreamOptions
      ) => this.requireActiveEvalExecution().rpc.streamReadable(targetId, method, args, options),
      emit,
      on: this.rpc.on.bind(this.rpc),
      peer: ((targetId: string) => peerFor(targetId)) as RpcClient["peer"],
      status: this.rpc.status.bind(this.rpc),
      ready: this.rpc.ready.bind(this.rpc),
      onStatusChange: this.rpc.onStatusChange.bind(this.rpc),
    });
  }

  /**
   * Build one run-local portable runtime surface via the shared stateless
   * factories. The resulting objects may be retained by imported module
   * singletons or notebook scope, so every outbound operation resolves the
   * active execution at invocation time. Only factories and owner identity are
   * cached across cells.
   */
  private createRunHostedRuntime(
    support: RuntimeSupportModule,
    execution: EvalExecutionContext,
    gatewayToken: string | undefined,
    parent: RunArgs["parent"] | null
  ): WorkspaceRuntimeLike {
    // Eval host calls must use the owner-scoped token minted for this exact
    // kernel. Falling back to the internal-DO service bearer would create a
    // second, broader authority path for runs that bypassed normal admission.
    if (!gatewayToken) {
      throw new Error("eval: owner-scoped gateway token is required");
    }
    const token = gatewayToken;
    const previous = this.hostedRuntimeIdentity;
    if (
      previous &&
      (previous.contextId !== execution.contextId || previous.gatewayToken !== token)
    ) {
      throw new Error(
        `eval: hosted-runtime identity drift — this EvalDO was initialized with contextId=${previous.contextId} but a run requested contextId=${execution.contextId}` +
          (previous.gatewayToken === token ? "" : " (and a different gateway token)") +
          `. A warm EvalDO serves one owner; this indicates a routing/ownership bug.`
      );
    }
    this.hostedRuntimeIdentity ??= {
      contextId: execution.contextId,
      gatewayToken: token,
    };
    const activeRpc = this.createActiveRuntimeRpc();
    const gatewayConfig = {
      serverUrl: String(this.env["GATEWAY_URL"] ?? ""),
      token,
    };
    const panelRuntime = support.createPanelRuntime({
      rpc: activeRpc,
      selfHandle: () => support.createRuntimeSelfHandle({ id: this.rpcSelfId }),
      defaultOpenParentId: () => parent?.parentId ?? null,
      loadModule: async (id: string) => {
        const existing = this.moduleMap[id] ?? this.isolateModuleMap[id];
        if (existing !== undefined) return existing;
        const cdpSource = this.declaredProviderSource("EVAL_CDP_CLIENT_SOURCE");
        if (cdpSource && id === cdpSource) {
          const activeExecution = this.requireActiveEvalExecution();
          return this.loadLibraryModule(cdpSource, activeExecution, {
            externals: Object.keys(this.isolateModuleMap),
            endowments: { fetch: globalThis.fetch.bind(globalThis) },
          });
        }
        throw new Error(`Module "${id}" is not endowed to this eval runtime`);
      },
    });
    const host: Record<string, unknown> = {
      id: this.rpcSelfId,
      contextId: execution.contextId,
      rpc: activeRpc,
      fs: support.createRpcFs(activeRpc),
      gatewayConfig,
      gatewayFetch: support.createGatewayFetch({ ...gatewayConfig, relativeOnly: true }),
      panelRuntime,
      workers: support.createWorkerdClient(activeRpc),
      openExternal: (url: string, options?: unknown) =>
        this.requireActiveEvalExecution().externalOpen.openExternal(
          url,
          options as Parameters<ExternalOpenClient["openExternal"]>[1]
        ),
      // The owner's nearest panel ancestor is captured for this run.
      resolveParent: () =>
        parent
          ? support.createRuntimeParentHandle(
              (pid) => panelRuntime.getPanelHandle(pid),
              parent.parentId,
              parent.parentEntityId,
              parent.parentKind
            )
          : null,
    };
    const rt = support.createHostedRuntime(host);
    return rt;
  }

  /** Synchronous in-DO SQLite, with reserved-table guards enforced on every statement. */
  private dbBinding(generation: number): unknown {
    const sql = this.sql;
    const guard = (query: string) => {
      if (generation !== this.scopeGeneration) {
        throw new Error("db: eval execution was invalidated by a scope reset");
      }
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

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isTerminalRunStatus(value: Record<string, unknown> | null): boolean {
  const status = value?.["status"];
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** Tagged reason for the deadline abort so downstream errors stay attributable. */
function evalDeadlineAbortReason(timeoutMs: number | undefined): Error {
  const reason = new Error(`eval deadline of ${timeoutMs}ms elapsed`);
  reason.name = "AbortError";
  return Object.assign(reason, { code: "EEVALDEADLINE" });
}

function authorityEventIdentity(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (typeof value["snapshotDigest"] === "string") {
    return `snapshot:${value["snapshotDigest"]}`;
  }
  if (typeof value["acquisitionId"] === "string") {
    return `acquisition:${value["acquisitionId"]}`;
  }
  if (
    typeof value["capability"] === "string" &&
    typeof value["resourceKey"] === "string" &&
    typeof value["tier"] === "string"
  ) {
    return `request:${value["capability"]}:${value["resourceKey"]}:${value["tier"]}`;
  }
  return null;
}

/**
 * Is `error` derived from the run's abort — the abort reason itself, an
 * AbortError, or an abort-caused transport rejection (the rpc client rejects
 * pending calls with an "aborted" message)? Walks the cause chain, mirroring
 * errorCodeInChain.
 */
function isAbortDerivedError(error: unknown, abortReason: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current === abortReason) return true;
    if (typeof current !== "object") return false;
    const candidate = current as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.name === "AbortError") return true;
    if (candidate.code === "ABORT_ERR" || candidate.code === "EEVALDEADLINE") return true;
    if (typeof candidate.message === "string" && /\babort/iu.test(candidate.message)) return true;
    current = candidate.cause;
  }
  return false;
}

function errorCodeInChain(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (
      typeof current === "object" &&
      !Array.isArray(current) &&
      "code" in current &&
      typeof (current as { code?: unknown }).code === "string"
    ) {
      return (current as { code: string }).code;
    }
    current =
      typeof current === "object" && !Array.isArray(current) && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return null;
}
