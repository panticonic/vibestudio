import { DurableObjectBase, rpc, type DurableObjectContext } from "@vibestudio/durable";
import {
  type AuthenticatedCaller,
  type RpcCallOptions,
  type RpcCausalParent,
  type RpcClient,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import {
  createBuildServiceClient,
  createEvalImportLoader,
  requireBuildBundleResult,
  type BuildServiceClient,
  type EvalImportLoader,
} from "@vibestudio/service-schemas/clients/evalImportLoader";
import { externalOpenMethods } from "@vibestudio/service-schemas/externalOpen";
import { EVAL_RESULT_RETURN_PREVIEW_CHARS } from "@vibestudio/service-schemas/eval";
import { fsMethods } from "@vibestudio/service-schemas/fs";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import { docsMethods } from "@vibestudio/service-schemas/docs";
import { EVAL_AMBIENT_ONLY } from "@vibestudio/service-schemas/runtime/runtimeSurface.eval";
import { buildOwnerBindings } from "./evalOwnerBindings.js";
import { ConsoleStreamer } from "./consoleStreamer.js";
import { describeEvalBindingSurface, invalidHelpArgumentResponse } from "./evalSurfaceHelp.js";
import { createEvalNodeCompat } from "./evalNodeCompat.js";
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

function publishModuleNamespace<T>(value: T): T {
  // Native ESM namespace exotic objects are already immutable and their
  // [[SetIntegrityLevel]] operation rejects Object.freeze. Lockdown protects
  // the values they expose; authored facades and package exports are hardened.
  return Object.prototype.toString.call(value) === "[object Module]"
    ? value
    : hardenBoundary(value);
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
}

interface ScopeManagerLike {
  readonly current: Record<string, unknown>;
  readonly api: unknown;
  hydrate(): Promise<unknown>;
  persist(): Promise<void>;
  enterEval(): void;
  exitEval(): Promise<void>;
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
  createRpcFs(rpc: unknown): unknown;
  createRuntimeParentHandle(
    getPanelHandle: (panelId: string) => unknown,
    parentId: string,
    parentEntityId: string,
    parentKind?: "panel" | "worker" | "do"
  ): unknown;
  createServicesProxy(rt: WorkspaceRuntimeLike): Record<string, unknown>;
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
  "createServicesProxy",
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
  readonly contextId: string;
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
   * Owner-scoped gateway bearer minted by the eval service for THIS EvalDO's
   * concrete `do:...:EvalDO:<objectKey>` identity (NOT the shared internal-DO
   * service bearer). Backs `gatewayConfig`/`gatewayFetch` so a leak is scoped to
   * the owner. Server→DO arg only — never user-supplied.
   */
  gatewayToken?: string;
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
}

interface RunResult {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  failureKind?: "user-code" | "infrastructure" | "cancelled";
  failureCode?: string;
  scopeKeys?: string[];
}

export class EvalDO extends DurableObjectBase {
  static override schemaVersion = 1;

  private engine: EvalEngine | null = null;
  private scopeManager: ScopeManagerLike | null = null;
  /** Serializes eval runs — ScopeManager has a single in-progress flag + one current scope. */
  private runChain: Promise<unknown> = Promise.resolve();
  /** In-flight runs in THIS instance, keyed by runId → the single execution promise. A concurrent
   *  `executeRun` (e.g. a deferRedrive that races the first dispatch) SHARES this promise instead of
   *  starting a second sandbox run; it also lets `reset` abort live runs. */
  private readonly inFlightRuns = new Map<string, Promise<RunResult>>();
  /** Abort controllers per in-flight run — used by `reset` and the `timeoutMs` deadline. */
  private readonly runAborts = new Map<string, AbortController>();
  /**
   * Per-run phase cell captured by that run's RPC wrappers. Ordinary calls
   * always inherit the run AbortSignal. Only after the hosted execution has
   * settled may registered cancellation cleanup issue new calls without the
   * already-aborted signal; the cancelled program itself is no longer running.
   */
  private readonly runCleanupPhases = new Map<string, { active: boolean }>();
  /** Run-scoped cleanup registered by evaluated orchestration code. Cancel
   *  executes these BEFORE aborting outbound RPC so child runtimes can retire
   *  through the normal authority path instead of becoming orphans. */
  private readonly runCancelHandlers = new Map<string, Set<() => void | Promise<void>>>();
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
  private cdpLoaded = false;
  private warnedNoCdpProvider = false;
  /** Stateless provider/runtime modules shared by EvalDO instances in this isolate.
   * The map and compiler remain host-closure state and are never guest globals. */
  private readonly isolateModuleMap: Record<string, unknown> = {};

  /**
   * Per-OBJECT module registry passed to the engine on every run. Many owners' EvalDOs share
   * one workerd isolate, so the engine's per-isolate global `__vibestudioModuleMap__` would leak
   * one owner's loaded `imports` into another (and dedup-by-specifier could hand owner B owner
   * A's *version*). A per-object map keeps each owner's modules isolated. Persists across this
   * DO's runs for import continuity (a module loaded in one run is reusable by the next).
   */
  private moduleMap: Record<string, unknown> = {};

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
    // Runs once per boot (this instance), before any run executes — so every `running`
    // row is orphaned by a prior instance whose held connection dropped (server restart).
    this.reconcileOrphanedRuns();
  }

  /**
   * EvalDO executes owner-authorized code and is reachable only through the
   * server eval service. Event delivery remains open for subscriptions, but a
   * method call must retain the legacy server-only receiver boundary even when
   * the method also carries `@rpc` authority metadata.
   */
  protected override assertInboundAllowed(
    caller: AuthenticatedCaller | null,
    kind: "call" | "event"
  ): void {
    if (kind === "event") return;
    if (caller?.callerKind !== "server") {
      throw new Error(
        `eval: EvalDO is server-only (dispatched by the eval service); refusing caller kind ${caller?.callerKind ?? "unknown"}`
      );
    }
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
        failureCode: "eval_runtime_restarted",
      })
    );
  }

  private createExecutionContext(
    input: {
      contextId?: string;
      causalParent?: RpcCausalParent | null;
      readOnly?: boolean;
    },
    signal?: AbortSignal,
    cleanupPhase?: { active: boolean }
  ): EvalExecutionContext {
    const causalParent = input.causalParent ? Object.freeze({ ...input.causalParent }) : null;
    const readOnly = input.readOnly === true;
    const base = this.rpc;
    const mergeOptions = <T extends RpcCallOptions | RpcStreamOptions>(value?: T): T => {
      const options = {
        ...(value ?? {}),
        ...(signal && cleanupPhase?.active !== true ? { signal } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      };
      if (causalParent) options.causalParent = causalParent;
      else Reflect.deleteProperty(options, "causalParent");
      return options as T;
    };
    const call = <T = unknown>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ) => base.call<T>(targetId, method, args, mergeOptions(options));
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
      contextId: input.contextId ?? "",
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
    try {
      const svc = (await docs.describeService(name)) as {
        methods?: Record<string, unknown>;
      };
      serviceMethods = svc?.methods ?? {};
    } catch {
      // Not an RPC service (or not describable) — reflection alone still gives the truthful surface.
    }
    return describeEvalBindingSurface(name, liveMethods, serviceMethods);
  }

  /**
   * Keep the inbound `respond()` watchdog disabled explicitly: the synchronous panel/CLI `run`
   * method legitimately runs for the eval's whole duration. Agent `startRun` returns immediately
   * and executes under `waitUntil`. An opt-in `timeoutMs` bounds either form; restart interruption
   * is reconciled on boot.
   */
  protected override get respondTimeoutMs(): number {
    return 0;
  }

  // ── public RPC methods (dispatched by the server `eval` service) ──────────────

  /**
   * Held synchronous run for connection-holding callers (panels over their persistent WS, the CLI):
   * insert + execute in this held handler, return the result in one response. The CALLER holds its
   * own leg; the server holds the EvalDO leg. workerd does not cap a held request.
   */
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "write",
  })
  async run(args: RunArgs): Promise<RunResult> {
    const runId = args.runId ?? crypto.randomUUID();
    await this.enqueueRun({ ...args, runId }, false);
    return this.executeRun(runId);
  }

  /**
   * Quick, idempotent enqueue for an asynchronous agent run. The durable row is written before a
   * background execution is attached to the DO event with `waitUntil`, so the caller receives a
   * run id without holding an HTTP connection. Idempotent on `run_id`: a replay observes the same
   * row and may reattach only a still-pending run; it never creates a duplicate execution.
   */
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "write",
  })
  async startRun(args: RunArgs & { runId: string }): Promise<{ runId: string; status: string }> {
    return this.enqueueRun(args, true);
  }

  private async enqueueRun(
    args: RunArgs & { runId: string },
    schedule: boolean
  ): Promise<{ runId: string; status: string }> {
    const runId = args.runId;
    const existing = this.sql
      .exec(`SELECT status, args FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (existing) {
      const status = String(existing["status"]);
      const prior = JSON.parse(String(existing["args"])) as RunArgs;
      if (JSON.stringify(prior) !== JSON.stringify(args)) {
        throw new Error(`eval: runId ${runId} was reused with different input`);
      }
      if (schedule && status === "pending") this.scheduleRun(runId);
      return { runId, status };
    }
    // Reset and enqueue are one DO turn and ordered before insertion. This is
    // safe under startRun replay because an existing run returns above without
    // resetting a second time (or cancelling its own in-flight execution).
    if (args.reset === true) await this.forceReset();
    const deadlineAt = args.timeoutMs ? Date.now() + args.timeoutMs : null;
    this.sql.exec(
      `INSERT INTO runs (run_id, args, agent_ref, channel_id, status, started_at, deadline_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      runId,
      JSON.stringify(args),
      args.agentRef ?? null,
      args.channelId ?? null,
      Date.now(),
      deadlineAt
    );
    if (schedule) this.scheduleRun(runId);
    return { runId, status: "pending" };
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
    if (!args.agentRef || !args.channelId) return;
    try {
      await this.rpc.call(args.agentRef, "onEvalComplete", [
        {
          runId,
          agentInvocationId: args.agentInvocationId,
          result,
          channelId: args.channelId,
        },
      ]);
    } catch (error) {
      // The terminal row is canonical. A hibernated/restarted agent re-observes it through getRun.
      console.warn(
        `[EvalDO] completion delivery for ${runId} failed (durable getRun recovery remains available):`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * The HELD synchronous execution (one held connection per call from the eval service / panel).
   * Idempotent on `runId`: a concurrent or re-dispatched call SHARES the single in-flight promise
   * rather than starting a second sandbox run — so a deferRedrive that races the first dispatch can
   * never double-run the eval (which would double-spawn headless agents).
   */
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "write",
  })
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
    this.sql.exec(
      `UPDATE runs SET status = 'running' WHERE run_id = ? AND status = 'pending'`,
      runId
    );
    const row = this.sql
      .exec(`SELECT status, args, deadline_at, result FROM runs WHERE run_id = ?`, runId)
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
    const claimed = String(row["status"]);
    if (claimed !== "running") {
      // Already terminal (idempotent re-dispatch, or cancelled before we claimed it).
      if (claimed === "done" && row["result"] != null) {
        return JSON.parse(String(row["result"])) as RunResult;
      }
      return {
        success: false,
        console: "",
        error: `eval: run ${runId} is ${claimed}`,
        failureKind: claimed === "cancelled" ? "cancelled" : "infrastructure",
        failureCode: claimed === "cancelled" ? "eval_cancelled" : "eval_invalid_run_state",
      };
    }

    const args = JSON.parse(String(row["args"])) as RunArgs;
    const deadlineAt = row["deadline_at"] != null ? Number(row["deadline_at"]) : null;
    const controller = new AbortController();
    const cleanupPhase = { active: false };
    this.runAborts.set(runId, controller);
    this.runCleanupPhases.set(runId, cleanupPhase);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancellationCleanupError: unknown;

    let result: RunResult;
    try {
      if (deadlineAt != null) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          controller.abort();
          cleanupPhase.active = true;
          await this.executeRunCancelHandlers(runId);
        } else {
          timer = setTimeout(() => {
            controller.abort();
          }, remaining);
          timer.unref?.();
        }
      }
      const ran = this.runChain.then(() =>
        this.runLocked(args, controller.signal, runId, deadlineAt, cleanupPhase)
      );
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
    } catch (err) {
      console.error(
        `[EvalDO] run ${runId} failed`,
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      );
      result = {
        success: false,
        console: "",
        error: err instanceof Error ? err.message : String(err),
        failureKind: "infrastructure",
        failureCode: "eval_host_failed",
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.runAborts.delete(runId);
      this.runCleanupPhases.delete(runId);
      if (!controller.signal.aborted) this.runCancelHandlers.delete(runId);
    }

    const terminalResult = this.compactRunResult(result);
    // CAS persist: write `done` only if still `running`, so a concurrent `reset` → `cancelled` wins.
    this.sql.exec(
      `UPDATE runs SET status = 'done', result = ? WHERE run_id = ? AND status = 'running'`,
      JSON.stringify(terminalResult),
      runId
    );
    const finalStatus = this.sql
      .exec(`SELECT status FROM runs WHERE run_id = ?`, runId)
      .toArray()[0]?.["status"];
    if (String(finalStatus) === "cancelled") {
      return this.compactRunResult({
        success: false,
        console: result.console,
        error: "eval: run cancelled",
        failureKind: "cancelled",
        failureCode: "eval_cancelled",
      });
    }
    return terminalResult;
  }

  /** Poll backstop: a run's status + result (`status` is 'pending'|'running'|'done'|'cancelled'|'unknown'). */
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "read",
  })
  getRun(runId: string): { status: string; result?: RunResult; progress?: unknown } {
    const row = this.sql
      .exec(`SELECT status, result FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!row) return { status: "unknown" };
    const status = String(row["status"]);
    const progressRow = this.sql
      .exec(`SELECT progress FROM run_progress WHERE run_id = ?`, runId)
      .toArray()[0];
    const progress =
      progressRow?.["progress"] != null ? JSON.parse(String(progressRow["progress"])) : undefined;
    return {
      status,
      ...(row["result"] != null ? { result: JSON.parse(String(row["result"])) as RunResult } : {}),
      ...(progress !== undefined ? { progress } : {}),
    };
  }

  /**
   * Settle an execution that never crossed the method boundary.  The host uses
   * this only after the held executeRun transport failed while the durable row
   * is still pending.  A running or terminal row is untouched, so loss of a
   * response cannot overwrite work that actually began.
   */
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "write",
  })
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
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "read",
  })
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
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "destructive",
  })
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
  }

  /** Reset the eval context: cancel in-flight runs, then wipe user tables + scope
   *  while preserving the durable queue and its progress rows. */
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "destructive",
  })
  async reset(): Promise<{ ok: boolean }> {
    // Cancel queued + in-flight runs FIRST so a run finishing normally can't CAS itself `done`
    // (executeRun's write requires status='running'); then abort any live run.
    this.sql.exec(`UPDATE runs SET status = 'cancelled' WHERE status IN ('pending', 'running')`);
    const runIds = new Set([...this.inFlightRuns.keys(), ...this.runCancelHandlers.keys()]);
    for (const id of runIds) {
      const phase = this.runCleanupPhases.get(id);
      if (phase) phase.active = true;
    }
    // A cancellation handler can be the owner that tells a nested resource to
    // stop (for example, a system-test runner interrupting its agent turn), so
    // waiting for the eval body before starting handlers creates a dependency
    // cycle. Start cleanup with cancellation-safe RPC authority, abort ordinary
    // execution, and then observe both terminals.
    const cleanupPromises = [...runIds].map((id) => this.executeRunCancelHandlers(id));
    for (const id of runIds) this.runAborts.get(id)?.abort();
    const [runResults, cleanupResults] = await Promise.all([
      Promise.allSettled(
        [...runIds]
          .map((id) => this.inFlightRuns.get(id))
          .filter((run): run is Promise<RunResult> => run !== undefined)
      ),
      Promise.allSettled(cleanupPromises),
    ]);
    void runResults;
    const result = this.runChain.then(() => this.resetLocked());
    this.runChain = result.catch(() => undefined);
    let value: { ok: boolean };
    try {
      value = await result;
    } catch (error) {
      const cleanupFailures = this.cancellationCleanupFailures(cleanupResults);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "eval: reset and cancellation cleanup failed"
        );
      }
      throw error;
    }
    this.throwCancellationCleanupFailures(cleanupResults, "reset");
    return value;
  }

  /**
   * Cancel ONE run without touching scope or other runs. CAS the row to `cancelled` FIRST (only if
   * still pending/running) so a late finish loses — `runEval`'s persist requires `status='running'`
   * and its post-write status read returns the cancelled failure instead of resurrecting `done`.
   * Cleanup handlers and ordinary execution settle as one cancellation phase:
   * handlers may initiate nested teardown while the run's abort signal unwinds
   * its ordinary calls. A no-op for an already-terminal run.
   */
  @rpc({
    principals: ["host"],
    effect: { kind: "semantic", capability: "runtime.code-execution.manage" },
    tier: "gated",
    sensitivity: "destructive",
  })
  async cancel(runId: string): Promise<{ ok: boolean }> {
    this.sql.exec(
      `UPDATE runs SET status = 'cancelled' WHERE run_id = ? AND status IN ('pending', 'running')`,
      runId
    );
    const inFlight = this.inFlightRuns.get(runId);
    const cleanupPhase = this.runCleanupPhases.get(runId);
    if (cleanupPhase) cleanupPhase.active = true;
    const cleanup = this.executeRunCancelHandlers(runId);
    this.runAborts.get(runId)?.abort();
    const [runResult, cleanupResult] = await Promise.allSettled([
      inFlight ?? Promise.resolve(undefined),
      cleanup,
    ]);
    void runResult;
    if (cleanupResult.status === "rejected") throw cleanupResult.reason;
    // runLocked and cleanup race intentionally so a cleanup owner can release
    // the resource on which the sandbox is blocked. Once both are terminal,
    // persist the shared scope again: cleanup may have recorded terminal state
    // after runLocked's exitEval() snapshot.
    await this.scopeManager?.persist();
    return { ok: true };
  }

  private async executeRunCancelHandlers(runId: string): Promise<void> {
    const handlers = [...(this.runCancelHandlers.get(runId) ?? [])];
    this.runCancelHandlers.delete(runId);
    if (handlers.length === 0) return;
    const results = await Promise.allSettled(
      handlers.map((handler) => Promise.resolve().then(handler))
    );
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
   *  2. abort EVERY in-flight controller (so wedged outbound calls unwind), then
   *     await every registered cancellation handler,
   *  3. REPLACE `this.runChain` with a fresh resolved promise — we ORPHAN the stuck chain rather
   *     than `.then()` off it, so we never wait on the wedged run, and
   *  4. run `resetLocked()` synchronously (NOT queued behind the old chain).
   * `resetLocked` only drops user tables + the scope table and nulls `this.scopeManager` (forcing a
   * fresh empty hydrate on the next run); it touches nothing the orphaned run still needs to finish
   * safely — and even if the orphan later runs `exitEval` against the wiped scope, its `cancelled`
   * status already discarded its result, so a fresh run is unaffected.
   */
  private async forceReset(): Promise<{ ok: boolean }> {
    this.sql.exec(`UPDATE runs SET status = 'cancelled' WHERE status IN ('pending', 'running')`);
    const runIds = new Set([...this.runAborts.keys(), ...this.runCancelHandlers.keys()]);
    for (const controller of this.runAborts.values()) controller.abort();
    const cleanupResults = await Promise.allSettled(
      [...runIds].map((id) => this.executeRunCancelHandlers(id))
    );
    // Orphan the (possibly wedged) chain — do NOT `.then()` off it, or we'd hang behind the stuck
    // run. A subsequently-enqueued run chains off this fresh resolved promise and proceeds at once.
    this.runChain = Promise.resolve();
    let result: { ok: boolean };
    try {
      result = this.resetLocked();
    } catch (error) {
      const cleanupFailures = this.cancellationCleanupFailures(cleanupResults);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "eval: force reset and cancellation cleanup failed"
        );
      }
      throw error;
    }
    this.throwCancellationCleanupFailures(cleanupResults, "force reset");
    return result;
  }

  private resetLocked(): { ok: boolean } {
    const tables = this.sql
      .exec(
        `SELECT name FROM sqlite_master
         WHERE type='table'
           AND name NOT LIKE 'sqlite_%'
           AND name NOT GLOB '_vibestudio_*'
           AND name NOT IN ('state', 'repl_scopes', 'runs', 'run_progress')`
      )
      .toArray() as Array<{ name: string }>;
    for (const { name } of tables) {
      this.sql.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    }
    // Drop the scope table (lazily created by SqlScopePersistence) — IF EXISTS so reset
    // works before the first run (e.g. `--fresh-scope`); the next run recreates it empty.
    this.sql.exec(`DROP TABLE IF EXISTS repl_scopes`);
    this.scopeManager = null; // force fresh hydrate (empty) on next run
    return { ok: true };
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private async runLocked(
    args: RunArgs,
    signal?: AbortSignal,
    runId?: string,
    deadlineAt?: number | null,
    cleanupPhase?: { active: boolean }
  ): Promise<RunResult> {
    const execution = this.createExecutionContext(args, signal, cleanupPhase);
    const engine = await this.ensureEngine(execution);
    const support = await this.ensureRuntimeSupport(execution);
    const scopeManager = await this.ensureScopeManager(engine);

    // Every runtime/client below closes over this immutable run context. A force
    // reset may orphan this execution and start another one, but neither run can
    // replace or clear the other's causal edge, containment, or abort signal.
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
    const services = hardenBoundary(support.createServicesProxy(rt));

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
      db: hardenBoundary(this.dbBinding()),
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
                binding as Record<string, unknown>,
                execution.docs
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
                injected as Record<string, unknown>,
                execution.docs
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
          return execution.docs.describeService(serviceName);
        }
        return {
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
    if (this.referencesCdp(entryCode, args.imports)) {
      await this.ensureCdpModule(execution);
    }

    const runtimeFs = rt["fs"];
    if (!runtimeFs || typeof runtimeFs !== "object") {
      throw new Error("eval: hosted runtime did not expose its scoped filesystem");
    }
    const runLocalModules = Object.fromEntries(
      Object.entries(createEvalNodeCompat(runtimeFs as Record<string, unknown>)).map(
        ([specifier, namespace]) => [specifier, publishModuleNamespace(namespace)]
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
    // `handle.cdp` → loadLightweightClient sync-require path. The check is
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
    const streamer =
      agentRef && channelId && agentInvocationId
        ? new ConsoleStreamer((chunk, progressSignal) =>
            this.rpc
              .call(
                agentRef,
                "onEvalProgress",
                [{ runId, agentInvocationId, channelId, output: chunk }],
                { signal: progressSignal }
              )
              .then(() => undefined)
          )
        : null;

    let consoleOutput = "";
    scopeManager.enterEval();
    try {
      const result = await engine.executeSandbox(entryCode, {
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
        harden: hardenBoundary,
        publishLazyLoaderToGlobal: false,
        // Opt-in deadline (timeoutMs) → AbortSignal. Best-effort: the engine may not honor it
        // inside native code; authored loops/functions also receive cooperative
        // checkpoints so ordinary synchronous code settles inside this EvalDO.
        signal,
        ...(deadlineAt !== null && deadlineAt !== undefined && args.timeoutMs !== undefined
          ? { deadline: { atMs: deadlineAt, timeoutMs: args.timeoutMs } }
          : {}),
        onConsole: (formatted: string) => {
          consoleOutput += (consoleOutput ? "\n" : "") + formatted;
          streamer?.push(formatted);
        },
      });
      // Live progress is incidental. The terminal result below is canonical and
      // includes the complete console, so a stalled progress receiver must not
      // hold this durable run open.
      streamer?.close();
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
        scopeKeys: Object.keys(scopeManager.current),
      };
    } finally {
      streamer?.close();
      if (!signal?.aborted) {
        const localKeys = new Set([runtimeModuleName, ...Object.keys(runLocalModules)]);
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
      ...(result.scopeKeys ? { scopeKeys: result.scopeKeys.slice(0, 500) } : {}),
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
      ...(compact.returnValue !== undefined ? { returnValue: compact.returnValue } : {}),
      ...(compact.scopeKeys ? { scopeKeys: compact.scopeKeys.slice(0, 200) } : {}),
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
      ...(result.scopeKeys ? { scopeKeys: result.scopeKeys.slice(0, 100) } : {}),
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
    opts: { externals?: string[] } = {}
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
      await runConfined.call({ receiver }, createPrivateGuestGlobal());
      moduleMap[specifier] = hardenBoundary(module.exports);
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

  private async ensureScopeManager(engine: EvalEngine): Promise<ScopeManagerLike> {
    if (this.scopeManager) return this.scopeManager;
    // Scope persistence is owner infrastructure, not an eval-authored effect.
    // The cached manager must never retain the causal edge, containment, or
    // abort signal of whichever run happened to initialize it first.
    const blobstore = this.infrastructureExecution().blobstore;
    const persistence = new engine.SqlScopePersistence(this.sql, {
      putText: (valueJson: string) => blobstore.putText(valueJson),
      getText: (digest: string) => blobstore.getText(digest),
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
    await mgr.hydrate();
    this.scopeManager = mgr;
    return mgr;
  }

  /** loadImport over the build service (same on-demand build surface as the in-app eval tool). */
  private makeLoadImport(execution: EvalExecutionContext): EvalImportLoader {
    // The eval sandbox runs in this workerd DO — resolve imports as a worker,
    // from the same caller context that backs its fs/vcs/runtime surfaces.
    return createEvalImportLoader(execution.build, "worker", {
      defaultWorkspaceRef: () => (execution.contextId ? `ctx:${execution.contextId}` : undefined),
    });
  }

  private async readSourceFile(path: string, execution: EvalExecutionContext): Promise<string> {
    const contents = await execution.fs.readFile(path, "utf8");
    if (typeof contents !== "string") {
      throw new Error(`fs.readFile returned non-text content for eval source file: ${path}`);
    }
    return contents;
  }

  /**
   * Build one run-local portable runtime surface via the shared stateless
   * factories. `host.rpc`, filesystem clients, services, imported runtime
   * bindings, and parent resolution all close over one immutable execution
   * context; only the factories and owner identity are cached.
   */
  private createRunHostedRuntime(
    support: RuntimeSupportModule,
    execution: EvalExecutionContext,
    gatewayToken: string | undefined,
    parent: RunArgs["parent"] | null
  ): WorkspaceRuntimeLike {
    // Owner-scoped gateway token from the eval service (Finding 4 hardening); the
    // env `RPC_AUTH_TOKEN` (shared internal-DO service bearer) is only a fallback
    // for direct/internal calls. gatewayFetch is `relativeOnly` so the bearer
    // never reaches a non-gateway host (eval code is prompt-injectable).
    const token = gatewayToken ?? String(this.env["RPC_AUTH_TOKEN"] ?? "");
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
    const rpc = execution.rpc;
    const gatewayConfig = {
      serverUrl: String(this.env["GATEWAY_URL"] ?? ""),
      token,
    };
    const panelRuntime = support.createPanelRuntime({
      rpc,
      selfHandle: () => support.createRuntimeSelfHandle({ id: this.rpcSelfId }),
      defaultOpenParentId: () => parent?.parentId ?? null,
      loadModule: async (id: string) => {
        const existing = this.moduleMap[id] ?? this.isolateModuleMap[id];
        if (existing !== undefined) return existing;
        const cdpSource = this.declaredProviderSource("EVAL_CDP_CLIENT_SOURCE");
        if (cdpSource && id === cdpSource) {
          return this.loadLibraryModule(cdpSource, execution, {
            externals: Object.keys(this.isolateModuleMap),
          });
        }
        throw new Error(`Module "${id}" is not endowed to this eval runtime`);
      },
    });
    const host: Record<string, unknown> = {
      id: this.rpcSelfId,
      contextId: execution.contextId,
      rpc,
      fs: support.createRpcFs(rpc),
      gatewayConfig,
      gatewayFetch: support.createGatewayFetch({ ...gatewayConfig, relativeOnly: true }),
      panelRuntime,
      workers: support.createWorkerdClient(rpc),
      openExternal: (url: string, options?: unknown) =>
        execution.externalOpen.openExternal(
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
  private async ensureCdpModule(execution: EvalExecutionContext): Promise<void> {
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
    const sharedMap = this.isolateModuleMap;
    const loaded = (await this.loadLibraryModule(cdpSource, execution, {
      externals: Object.keys(sharedMap),
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
    // Seed the per-owner map as an alias of the closure-held isolate module.
    // No loader or module namespace is published on globalThis.
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
