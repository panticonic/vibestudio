/**
 * WorkerdManager — Process lifecycle for workerd (Cloudflare V8 isolate runtime).
 *
 * Manages:
 * - Locating the workerd binary
 * - Worker instance lifecycle (create, update, destroy)
 * - Context/token provisioning per instance
 * - Cap'n Proto text config generation for build-compiled workerd programs
 * - workerd child process management (start, restart, stop)
 */

import { spawn, type ChildProcess } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";
import * as os from "os";
import { backup, DatabaseSync } from "node:sqlite";
import { stateLayout } from "./stateLayout.js";
import { pathToFileURL } from "url";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import { createVerifiedCaller, type VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { FsService } from "@vibestudio/shared/fsService";
import type { ExecutionPublicationPort } from "@vibestudio/shared/execution/retention";
import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { BuildResult } from "./buildV2/buildStore.js";
import { executionArtifactRefFromBuild } from "./executionRootProviders.js";
import type { WorkspaceRpcMethodDoc } from "./buildV2/workspaceRpcCatalog.js";
import type { ProtectedPublicationEvent, RuntimeImageBinding } from "./buildV2/index.js";
import { validateBuildRef } from "./buildV2/refs.js";
import type { RouteRegistry, ManifestRouteDecl } from "./routeRegistry.js";
import type { SingletonRegistry } from "@vibestudio/workspace/singletonRegistry";
import { createDevLogger } from "@vibestudio/dev-log";
import { productBuiltinByIdentity } from "@vibestudio/shared/productBuiltinCatalog.generated";
import {
  getPhysicalPathForAsarPath,
  getPlatformPackageBinaryPath,
} from "@vibestudio/shared/runtimePaths";
import {
  getInternalDOBundle,
  internalDOExecutionIdentity,
  isInternalDOSource,
  type InternalDOBundle,
} from "./internalDOs/internalDoLoader.js";
import { encodeUniversalKey } from "./doDispatch.js";
import { assertPresent } from "../lintHelpers";
import { RuntimeImageStore, type RuntimeImageRecord } from "./runtimeImageStore.js";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import type { WorkerdProgramSources } from "./workerdProgramLoader.js";
import { resolveRequiredAppRoot } from "./appRoot.js";
import { SqliteIntegrityWorkerClient } from "./storage/sqliteIntegrityWorkerClient.js";
import {
  destroyWorkerdConnections,
  getWorkerdConnectionDispatcher,
  releaseDurableObjectRelaySeal,
  sealAndDrainDurableObjectRelays,
} from "./workerdRpcRelay.js";
import {
  RUNTIME_IMAGE_UNAVAILABLE_ERROR_CODE,
  RUNTIME_IMAGE_WARMING_ERROR_CODE,
} from "./runtimeReadinessError.js";
import type { WorkerdPerformanceSnapshot } from "@vibestudio/service-schemas/hostPerformance";

const log = createDevLogger("WorkerdManager");
/** uniqueKey of the single static namespace that hosts all userland DO facets.
 *  workerd stores its facet SQLite under `<disk>/<this>/<hostHash>.*`. */
const UNIVERSAL_DO_UNIQUE_KEY = "vibestudio:universal-do";
const DEFAULT_WORKERD_STARTUP_READY_TIMEOUT_MS = 15_000;
const WORKERD_STARTUP_OUTPUT_LINES = 40;
declare const __filename: string | undefined;
declare const __dirname: string | undefined;

/**
 * Materialize the immutable JavaScript portion of a worker build as the exact
 * module map consumed by workerd's workerLoader. The primary artifact keeps
 * the historical `worker.js` loader identity; relative imports from it resolve
 * against chunk artifact paths at the module-map root.
 */
function workerJavaScriptModules(build: BuildResult): Record<string, string> {
  const primary = build.artifacts.find(
    (artifact) => artifact.role === "primary" && artifact.encoding === "utf8"
  );
  if (!primary) throw new Error(`Build ${build.metadata.buildKey} has no primary text artifact`);
  const modules: Record<string, string> = { "worker.js": primary.content };
  for (const artifact of build.artifacts) {
    if (
      artifact.role === "asset" &&
      artifact.encoding === "utf8" &&
      artifact.path.endsWith(".js")
    ) {
      modules[artifact.path] = artifact.content;
    }
  }
  return modules;
}

export class RuntimeImageWarmingError extends Error {
  readonly code = RUNTIME_IMAGE_WARMING_ERROR_CODE;
}

export class RuntimeImageUnavailableError extends Error {
  readonly code = RUNTIME_IMAGE_UNAVAILABLE_ERROR_CODE;
}

export interface DurableObjectPublishedSchemaDescriptor {
  className: string;
  version: number;
  freshSchemaFingerprint: string;
}

type DurableObjectRuntimeSchemaDescriptor = DurableObjectPublishedSchemaDescriptor;

interface SchemaProbeBuild {
  source: string;
  className: string;
  build: BuildResult;
}

/** Diagnostic env vars forwarded from the host process into every worker's
 *  env bindings, so runtime-side tracing (e.g. the model-call stage trace)
 *  can be enabled by launching the server with the flag set. */
const FORWARDED_DIAGNOSTIC_ENV_VARS = ["VIBESTUDIO_MODEL_CALL_TRACE", "VIBESTUDIO_LOG_LEVEL"];

function forwardDiagnosticEnv(env: Record<string, unknown>): void {
  for (const key of FORWARDED_DIAGNOSTIC_ENV_VARS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
}

function explicitScopeRef(explicitRef?: string): string | undefined {
  return explicitRef && explicitRef.length > 0
    ? assertPresent(validateBuildRef(explicitRef))
    : undefined;
}

/**
 * Runtime entities follow the semantic context that owns them unless their
 * creator deliberately pins another immutable selector. This is the execution
 * half of context-local work: code changes remain local until publication.
 */
function entityScopeRef(explicitRef: string | undefined, contextId: string): string {
  return explicitScopeRef(explicitRef) ?? `ctx:${contextId}`;
}

function scopeTracksProtectedMain(scopeRef: string | undefined): boolean {
  const normalized = scopeRef && scopeRef.length > 0 ? scopeRef : "main";
  return normalized === "main";
}

// This file is bundled as both ESM (standalone server) and CJS (Electron
// utility process). build.mjs injects __filename into the ESM bundle, while
// CJS provides it natively. Avoid spelling import.meta here: esbuild warns
// whenever import.meta appears in CJS output, even behind typeof guards.
const requireFromUrl = pathToFileURL(path.join(resolveRequiredAppRoot(), "package.json")).href;

const require = createRequire(requireFromUrl);

/**
 * Replicate workerd's idFromName() → SQLite filename derivation.
 *
 * workerd derives DO storage filenames as:
 *   1. key = SHA-256(uniqueKey)         — 32 bytes
 *   2. base = HMAC-SHA256(key, name)    — truncate to first 16 bytes
 *   3. mac = HMAC-SHA256(key, base)     — truncate to first 16 bytes
 *   4. filename = hex(base || mac)      — 64 hex chars
 *
 * Verified against workerd source (actor-id-impl.c++) and empirically
 * tested against actual workerd DO storage files.
 */
function computeWorkerdObjectIdHash(uniqueKey: string, objectName: string): string {
  const key = crypto.createHash("sha256").update(uniqueKey).digest();
  const base = crypto.createHmac("sha256", key).update(objectName).digest().subarray(0, 16);
  const mac = crypto.createHmac("sha256", key).update(base).digest().subarray(0, 16);
  return Buffer.concat([base, mac]).toString("hex");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** DO reference — matches DORef from @workspace/runtime/worker. */
interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

export interface DurableObjectStorageBackup {
  operationId: string;
  target: DORef;
  intent: string;
  createdAt: number;
}

interface DurableObjectMaintenanceRow {
  operationId: string;
  kind: "reset" | "restore" | "destroy";
  targetId: string;
  source: string;
  className: string;
  objectKey: string;
  intent: string;
  backupOperationId: string | null;
  step: string;
  createdAt: number;
}

interface DOService {
  buildKey: string;
  className: string;
  imageId?: string;
  serviceName: string;
  source: string;
  /** Class-level/default follower scope. Object-specific scopes live in doObjectBuilds. */
  scopeRef?: string;
}

interface DOObjectBuild {
  buildKey: string;
  imageId: string;
  scopeRef?: string;
  stateArgs?: Record<string, unknown>;
}

function recordStateArgs(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function runtimeIncarnationVersion(
  image: RuntimeImageRecord,
  stateArgs?: Record<string, unknown>
): string {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        executionDigest: image.artifact.executionDigest,
        authority: image.authority,
        stateArgs: stateArgs ?? null,
      })
    )
    .digest("hex");
}

function doServiceKey(source: string, className: string): string {
  return `${source}:${className}`;
}

function doObjectBuildKey(source: string, className: string, objectKey: string): string {
  return `${source}:${className}/${objectKey}`;
}

export interface RestartBeginEvent {
  correlationId: string;
  generation: number;
  reason: string;
  /**
   * Aborted when crash recovery preempts this graceful preparation. Prep is
   * advisory — the process is being replaced either way — so hooks should
   * stop dispatching into the old generation as soon as this fires.
   */
  signal?: AbortSignal;
}

export interface RestartReadyEvent {
  correlationId: string;
  generation: number;
  reason: string;
  previousGeneration: number | null;
}

/**
 * In-process notification that the current workerd generation is closing.
 * Runs for BOTH planned and crash transitions (and idle stops). Hooks must be
 * purely in-process (drop relay URLs, close inspector bridges, …) and must
 * NEVER dispatch into workerd — the process may already be gone.
 */
export interface GenerationClosingEvent {
  correlationId: string;
  generation: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Worker→worker calls go through the RPC relay, not a live workerd capability,
// so there is no `service` binding — only serializable data bindings.
export type WorkerBinding = { type: "text"; value: string } | { type: "json"; value: unknown };

export interface WorkerCreateOptions {
  source: string;
  contextId: string;
  name?: string;
  /** Parent panel/worker id injected into the runtime for getParent(). */
  parentId?: string;
  /** Parent runtime entity id, when the display/control id differs from the RPC id. */
  parentEntityId?: string;
  /** Parent runtime kind for constructing the correct unified handle shape. */
  parentKind?: "panel" | "worker" | "do";
  env?: Record<string, string>;
  bindings?: Record<string, WorkerBinding>;
  stateArgs?: Record<string, unknown>;
  /** Explicit build ref. Omit to track main; use "ctx:<id>" only when selecting a real VCS head. */
  ref?: string;
}

export interface WorkerInstance {
  /** Public lifecycle handle. Use this for status/update/destroy calls. */
  id: string;
  name: string;
  source: string;
  contextId: string;
  callerId: string;
  parentId?: string;
  parentEntityId?: string;
  parentKind?: "panel" | "worker" | "do";
  token: string;
  env: Record<string, string>;
  bindings: Record<string, WorkerBinding>;
  stateArgs?: Record<string, unknown>;
  buildKey?: string;
  /** Immutable artifact identity used for code principals. */
  executionDigest?: string;
  /** Signed effective version of the bound image — the identity egress/approval
   *  scoping must use (buildKey is the artifact key, not the signed EV). */
  effectiveVersion?: string;
  runtimeImageId: string;
  /** Head/state this instance follows. The loader never resolves it. */
  scopeRef?: string;
  /** Monotonic version bumped on every create/update. The dynamic worker host
   *  keys its loader cache on `${name}@${codeVersion}`, so any change to code,
   *  env, bindings, ref, or stateArgs forces a fresh isolate (old ones idle out).
   *  This is what lets worker update/rebuild take effect with no workerd restart. */
  codeVersion: number;
  status: "building" | "starting" | "running" | "stopped" | "error";
}

export interface WorkerdManagerDeps {
  tokenManager: TokenManager;
  fsService: FsService;
  /**
   * Opaque workspace identity issued by the hub. The manager hosts exactly one
   * workspace, and binds this process-owned identity into host-sealed
   * authority attestations; a Durable Object id is a storage coordinate, not a workspace
   * identity.
   */
  workspaceId: string;
  /**
   * URL workers use to reach the server's RPC endpoint via HTTP POST.
   * Always points at an in-process loopback HTTP listener — workers are
   * spawned on the same host as the server, so the back-channel never
   * leaves the box. External panel/mobile traffic uses the TLS gateway;
   * this URL is deliberately distinct from it.
   */
  getServerUrl: () => string;
  /** Additional externally advertised gateway URLs that map to this server. */
  getServerAliasUrls?: () => readonly string[];
  /** Immutable, build-compiled programs used by the workerd host services. */
  readonly workerdPrograms: WorkerdProgramSources;
  /**
   * Immutable internal-DO program paired with this manager. Production loads
   * the build artifact; tests inject an in-memory build so they cannot replace
   * a concurrently running source server's authority program on disk.
   */
  readonly internalDOBundle?: InternalDOBundle;
  /** Workspace source root — used for WORKER_SOURCE binding. */
  workspacePath: string;
  /** State directory — used for DO storage (localDisk). */
  statePath: string;
  executionPublicationPort?: ExecutionPublicationPort;
  /** Route registry for `/_r/` dispatch — optional; when absent, route
   *  registration is a no-op and routes in package manifests have no effect. */
  routeRegistry?: RouteRegistry;
  getProxyPort: (caller: VerifiedCaller) => Promise<number | null> | number | null;
  /** Shared attributed-by-header egress listener port for the dynamic worker
   *  host. Identity travels in the `X-Vibestudio-Egress-Caller` header (stamped
   *  by the host's EgressGateway from non-forgeable props), gated by
   *  `egressSecret`. Distinct from `getProxyPort` (per-caller ports, still used
   *  by static DO services). */
  getSharedEgressPort: () => Promise<number>;
  /** Register/unregister a live worker's VerifiedCaller so the shared egress
   *  listener can resolve the header id → full caller for attribution. */
  registerEgressCaller: (callerId: string, caller: VerifiedCaller) => void;
  unregisterEgressCaller: (callerId: string) => void;
  /** Process-owned secret bound into worker hosts and checked by shared egress. */
  egressSecret: string;
  getWorkerdGatewayToken: () => string;
  /** Override for tests; production uses the default router readiness window. */
  workerdStartupReadyTimeoutMs?: number;
  /** Overrides for tests; production uses the default SIGTERM/SIGKILL windows. */
  workerdStopTimeoutsMs?: { sigtermMs?: number; sigkillMs?: number };
  cleanupWebhookSubscriptions?: (callerId: string) => Promise<void>;
  resourceHandleLifecycle?: {
    reconcileProviderDefinitions(
      provider: string,
      activeDefinitionDigests: readonly string[]
    ): void;
    reconcileReceiverClasses(receiverSource: string, activeClassNames: readonly string[]): void;
  };
  /**
   * Structured lifecycle sink (start/stop/update/failure per worker). The
   * server feeds this into the runtime-diagnostics store so worker startup
   * failures are queryable through runtime supervision instead of
   * living only in the server console.
   */
  recordLifecycleEvent?: (event: {
    source: string;
    callerId: string;
    entityId?: string;
    kind?: "worker" | "do";
    level: "info" | "error";
    message: string;
    fields?: Record<string, unknown>;
  }) => void;
}

/**
 * Workspace-authored runtime capabilities become available only after the
 * semantic authority has activated exact protected main. Until this provider
 * is bound, WorkerdManager is a sealed control-plane host, not a general
 * worker/build host.
 */
export interface WorkerdWorkspaceProvider {
  bindRuntimeImage(unitPath: string, ref?: string): Promise<RuntimeImageBinding>;
  getBuildByKey(key: string): BuildResult | null;
  /** Resolve the exact retained execution named by a sealed durable entity. */
  getBuildByExecution(key: string, executionDigest: string): BuildResult | null;
  getManifestRoutes(source: string): ReadonlyArray<ManifestRouteDecl>;
  getManifestDoClasses(source: string): ReadonlyArray<{ className: string }>;
  readonly singletonRegistry: SingletonRegistry;
  getInternalDoEnv(className: string): Record<string, string>;
}

export type WorkerdStage = "control-plane" | "workspace";

type ResolvedWorkerdManagerDeps = WorkerdManagerDeps;

type WorkerdRestartRequest =
  | { kind: "planned" }
  | { kind: "crash"; reason: string; alreadyExited: boolean }
  /** Graceful prepare + stop with NO restart; workerd returns lazily on the
   *  next ensureWorkerdRunning. Used by internal-DO storage maintenance, whose
   *  only guaranteed file-handle-release boundary is the process itself. */
  | { kind: "stop"; reason: string }
  | { kind: "stop-if-idle" };

type GenerationTransitionState = "preparing" | "stopping" | "reaping" | "starting";

/**
 * One run of the generation-transition owner. Exactly one exists at a time
 * (`activeTransition`); every process stop or start happens inside it. The
 * run's lifecycle is: idle → preparing → stopping → reaping → starting →
 * ready | failed, with the preemption rule that a crash request aborts a
 * planned run's "preparing" phase and escalates the run to crash kind.
 */
interface GenerationTransition {
  correlationId: string;
  kind: "planned" | "crash" | "stop" | "stop-if-idle";
  state: GenerationTransitionState;
  reason: string;
  alreadyExited: boolean;
  /** Fired when a crash request preempts this run's graceful preparation. */
  prepAbort: AbortController;
  /** Highest requested epoch this run has consumed (it may grow at re-drain). */
  covered: number;
  failed: boolean;
  error: unknown;
  promise: Promise<void>;
}

/** The canonical regular-worker instance name for a source. Matches the
 *  sanitization that startWorker applies to the entity key. */
function canonicalInstanceNameForSource(source: string): string {
  const raw = source.split("/").pop() ?? "worker";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function workerdInspectorEnabled(): boolean {
  // Always on by default: Vibestudio is a continuous-development system, and
  // userland profiling (workerdInspector service) depends on the inspector.
  // The socket binds 127.0.0.1 and is only reachable from userland through
  // the token-authenticated, approval-gated inspector bridge.
  return process.env["VIBESTUDIO_DISABLE_WORKERD_INSPECTOR"] !== "1";
}

// WorkerLoader does not expose per-isolate disposal. Keep ordinary retirement
// restart-free, but compact a generation once unreachable isolates contribute
// to material sandbox pressure or reach a bounded cross-platform count.
const WORKERD_DYNAMIC_ISOLATE_COMPACTION_RSS_BYTES = 768 * 1024 * 1024;
const WORKERD_DYNAMIC_ISOLATE_COMPACTION_COUNT = 16;

// ---------------------------------------------------------------------------
// WorkerdManager
// ---------------------------------------------------------------------------

export class WorkerdManager {
  private internalDOBundle(): InternalDOBundle {
    return this.deps.internalDOBundle ?? getInternalDOBundle();
  }

  private instances = new Map<string, WorkerInstance>();
  // Most recent startup/update failure per worker source. Survives the
  // instance row (which is deleted on failed start) so `units.list` can
  // report lastError for workers that never came up.
  private lastWorkerErrors = new Map<string, { message: string; timestamp: number }>();
  private process: ChildProcess | null = null;
  // Restart coalescing: callers mutate doServices/instances then call
  // restartWorkerd(). `requestedEpoch` increments per call; `appliedEpoch` is the
  // highest config epoch a completed restart has applied. Concurrent callers
  // within one restart window share it; a config change made during a restart
  // triggers at most one follow-up restart. Prevents the un-coalesced restart
  // storm (N failed relays ⇒ N racing restarts) that fed the server OOM.
  private requestedEpoch = 0;
  private appliedEpoch = 0;
  /** The single generation-transition owner run currently in flight, if any. */
  private activeTransition: GenerationTransition | null = null;
  private readonly restartRequests = new Map<number, WorkerdRestartRequest>();
  /** Permanently closes process-start admission once shutdown begins. */
  private shuttingDown = false;
  /** Coalesces host watchdogs that observe the same unresponsive workerd. */
  private unresponsiveRecovery: Promise<void> | null = null;
  private configDir: string;
  private port: number | null = null;
  private inspectorPort: number | null = null;
  private deps: ResolvedWorkerdManagerDeps;
  /** Derived exact DO attachments. WorkspaceDO entity rows are their durable owner. */
  private readonly sealedDoImages = new Map<string, RuntimeImageRecord>();
  private readonly runtimeImages: RuntimeImageStore;
  private readonly runtimeImageRebinds = new Map<string, Promise<void>>();
  /** Derived lookup index keyed by immutable build objects; entries disappear with the build. */
  private readonly workspaceRpcCatalogIndexes = new WeakMap<
    BuildResult,
    ReadonlyMap<string, WorkspaceRpcMethodDoc>
  >();
  private workerdBinary: string | null = null;
  private lastWorkerdStartupOutput: string[] = [];
  private workerdStartedAtMs: number | null = null;
  private workerdMemorySampleTimer: ReturnType<typeof setInterval> | null = null;
  private workerdMemorySamplePid: number | null = null;
  private lastWorkerdRssBytes: number | null = null;
  private workerdRssSamples: Array<{ at: number; rssBytes: number }> = [];
  private retiredDynamicIsolateGeneration: number | null = null;
  private readonly retiredDynamicIsolateIds = new Set<string>();
  private dynamicIsolateCompactionFlight: Promise<void> | null = null;

  // DO support: shared services (one per source)
  /** Shared DO services — keyed by `${source}:${className}`. Source-scoped: two workers CAN have same className if different source. */
  private doServices = new Map<string, DOService>();
  /** Userland DO object-specific code refs — keyed by `${source}:${className}/${objectKey}`. */
  private doObjectBuilds = new Map<string, DOObjectBuild>();
  /** Session ID — generated once per WorkerdManager lifetime, used for restart detection in bootstrap. */
  private sessionId = crypto.randomUUID();
  private bootGeneration: number;
  private pendingBootGeneration: number | null = null;
  private readonly bootGenerationFile: string;
  private restartBeginHooks = new Set<(event: RestartBeginEvent) => Promise<void> | void>();
  private restartReadyHooks = new Set<(event: RestartReadyEvent) => Promise<void> | void>();
  private generationClosingHooks = new Set<
    (event: GenerationClosingEvent) => Promise<void> | void
  >();
  /** Per-manager secret required by the generated router for direct DO dispatch. */
  private readonly dispatchSecret = crypto.randomBytes(32).toString("hex");
  /** Per-process secret gating the loopback `/_workercode` + `/_workerversion`
   *  endpoints. Bound only into the static worker-host service, so worker code +
   *  per-instance env (RPC tokens, STATE_ARGS) are unreachable with ordinary
   *  panel/worker credentials. */
  private readonly loaderSecret = crypto.randomBytes(32).toString("hex");
  /** Per-process secret the host's EgressGateway stamps on forwarded egress so
   *  the shared egress listener trusts the `X-Vibestudio-Egress-Caller` header. */
  private readonly egressSecret: string;
  private workspaceProvider: WorkerdWorkspaceProvider | null = null;
  private readonly doMaintenanceDb: DatabaseSync;
  private readonly doSchemaDescriptorDb: DatabaseSync;
  private readonly sqliteIntegrityWorker: SqliteIntegrityWorkerClient;
  private readonly schemaProbeBuilds = new Map<string, SchemaProbeBuild>();
  private readonly doMaintenanceChains = new Map<string, Promise<unknown>>();
  private readonly doMaintenanceRecovery: Promise<void>;
  /** A graceful `stop` ran with live services: the next start owes a
   *  crash-style restart-ready so released lifecycle leases resume. */
  private resumeLifecycleAfterStop = false;

  constructor(deps: WorkerdManagerDeps) {
    this.deps = deps;
    this.egressSecret = deps.egressSecret;
    this.runtimeImages = new RuntimeImageStore(deps.statePath, deps.executionPublicationPort);
    this.sqliteIntegrityWorker = new SqliteIntegrityWorkerClient(resolveRequiredAppRoot());
    this.configDir = path.join(os.tmpdir(), `vibestudio-workerd-${process.pid}`);
    fs.mkdirSync(this.configDir, { recursive: true });
    this.bootGenerationFile = stateLayout(this.deps.statePath).bootGenerationFile;
    this.bootGeneration = this.readBootGeneration();
    const layout = stateLayout(this.deps.statePath).databases;
    fs.mkdirSync(layout.root, { recursive: true });
    fs.mkdirSync(layout.durableObjectBackupsDir, { recursive: true });
    this.doMaintenanceDb = new DatabaseSync(layout.durableObjectMaintenanceDb);
    this.doMaintenanceDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS do_maintenance (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('reset', 'restore', 'destroy')),
        target_id TEXT NOT NULL,
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        intent TEXT NOT NULL,
        backup_operation_id TEXT,
        step TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'complete')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS do_maintenance_one_open_target
        ON do_maintenance(target_id) WHERE status = 'open';
    `);
    const maintenanceSchema = this.doMaintenanceDb
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'do_maintenance'`)
      .get() as { sql?: string } | undefined;
    if (!maintenanceSchema?.sql?.includes("'destroy'")) {
      throw new Error(
        "Durable Object maintenance state is not from the current system epoch; recreate this pre-release instance"
      );
    }
    this.doSchemaDescriptorDb = new DatabaseSync(layout.durableObjectSchemaDescriptorsDb);
    this.doSchemaDescriptorDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS do_schema_descriptors (
        source TEXT NOT NULL,
        effective_version TEXT NOT NULL,
        class_name TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        PRIMARY KEY (source, effective_version, class_name)
      );
      CREATE TABLE IF NOT EXISTS do_schema_installed (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        effective_version TEXT NOT NULL,
        PRIMARY KEY (source, class_name)
      );
      CREATE TABLE IF NOT EXISTS do_schema_candidates (
        state_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        effective_version TEXT NOT NULL,
        PRIMARY KEY (state_hash, source, class_name)
      );
    `);
    const open = this.readOpenDurableObjectMaintenance();
    // Establish admission synchronously before any asynchronous recovery work.
    for (const row of open) void this.fenceDurableObjectMaintenance(row);
    this.doMaintenanceRecovery = Promise.all(
      open.map((row) => this.resumeDurableObjectMaintenance(row))
    )
      .then(() => undefined)
      .catch((error) => {
        log.error("Durable Object maintenance recovery failed", error);
      });
  }

  getStage(): WorkerdStage {
    return this.workspaceProvider ? "workspace" : "control-plane";
  }

  /** Persisted mutable selectors whose immutable artifacts must remain resolvable. */
  listRuntimeImages(): RuntimeImageRecord[] {
    return this.runtimeImages.list();
  }

  /** Bind the one semantic-main-backed workspace provider exactly once. */
  bindWorkspaceProvider(provider: WorkerdWorkspaceProvider): void {
    if (this.workspaceProvider) {
      throw new Error("Workerd workspace provider is already bound");
    }
    this.workspaceProvider = provider;
  }

  /** Replace the bootstrap snapshot view with the semantic source provider. */
  replaceWorkspaceProvider(provider: WorkerdWorkspaceProvider): void {
    if (!this.workspaceProvider) {
      throw new Error("Cannot replace a workspace provider before bootstrap binding");
    }
    this.workspaceProvider = provider;
  }

  private requireWorkspaceProvider(operation: string): WorkerdWorkspaceProvider {
    if (!this.workspaceProvider) {
      throw new Error(
        `${operation} is unavailable while workerd is in the sealed control-plane stage`
      );
    }
    return this.workspaceProvider;
  }

  private ensureWorkerBearer(callerId: string): string {
    const manager = this.deps.tokenManager as TokenManager & {
      ensureWorkerBearer?: (callerId: string) => string;
    };
    return manager.ensureWorkerBearer?.(callerId) ?? manager.ensureToken(callerId, "worker");
  }

  private revokeWorkerBearer(callerId: string): boolean {
    const manager = this.deps.tokenManager as TokenManager & {
      revokeWorkerBearer?: (callerId: string) => boolean;
    };
    return manager.revokeWorkerBearer?.(callerId) ?? manager.revokeToken(callerId);
  }

  private async bindRuntimeImage(
    imageId: string,
    source: string,
    scopeRef?: string
  ): Promise<RuntimeImageRecord> {
    const binding = await this.requireWorkspaceProvider("runtime image binding").bindRuntimeImage(
      source,
      scopeRef
    );
    return this.persistRuntimeImage(imageId, binding, scopeRef);
  }

  private persistRuntimeImage(
    imageId: string,
    binding: RuntimeImageBinding,
    scopeRef?: string
  ): RuntimeImageRecord {
    return this.runtimeImages.upsert({
      id: imageId,
      source: binding.source,
      unitName: binding.unitName,
      artifact: binding.artifact,
      authority: binding.authority,
      ...(scopeRef ? { scopeRef } : {}),
    });
  }

  private persistInternalRuntimeImage(imageId: string, className: string): RuntimeImageRecord {
    const identity = internalDOExecutionIdentity(this.internalDOBundle(), className);
    return this.runtimeImages.upsert({
      id: imageId,
      source: identity.source,
      unitName: identity.unitName,
      artifact: identity.artifact,
      authority: identity.authority,
    });
  }

  private advanceWorkerCodeVersion(instance: WorkerInstance, generation?: number): void {
    instance.codeVersion = Math.max(instance.codeVersion + 1, generation ?? 0);
  }

  /** Resolve a mutable selector. Missing CAS content schedules a rebuild from its tracked scope. */
  private getMutableRuntimeImageBuild(
    imageId: string,
    onRebound?: (record: RuntimeImageRecord) => void
  ): { image: RuntimeImageRecord; build: BuildResult } {
    const image = this.runtimeImages.get(imageId);
    if (!image) {
      throw new RuntimeImageWarmingError(`Runtime image is not bound yet: ${imageId}`);
    }
    const build = this.requireWorkspaceProvider("runtime image loading").getBuildByKey(
      image.artifact.buildKey
    );
    if (build) return { image, build };
    if (image.error) {
      throw new RuntimeImageUnavailableError(
        `Runtime image ${imageId} is unavailable: ${image.error.message}`
      );
    }

    this.scheduleRuntimeImageRebind(image, onRebound);
    throw new RuntimeImageWarmingError(
      `Runtime image ${imageId} points at missing artifact ${image.artifact.buildKey}; warming`
    );
  }

  /** Resolve an exact durable incarnation. It can never be rebuilt from a mutable selector. */
  private getSealedRuntimeImageBuild(imageId: string): {
    image: RuntimeImageRecord;
    build: BuildResult;
  } {
    const image = this.sealedDoImages.get(imageId);
    if (!image) {
      throw new RuntimeImageUnavailableError(`Sealed runtime image is not attached: ${imageId}`);
    }
    const provider = this.requireWorkspaceProvider("sealed runtime image loading");
    const build = provider.getBuildByExecution(
      image.artifact.buildKey,
      image.artifact.executionDigest
    );
    if (!build) {
      throw new RuntimeImageUnavailableError(
        `Sealed runtime image ${imageId} is missing artifact ${image.artifact.buildKey}`
      );
    }
    return { image, build };
  }

  private scheduleRuntimeImageRebind(
    image: RuntimeImageRecord,
    onRebound?: (record: RuntimeImageRecord) => void
  ): void {
    if (this.runtimeImageRebinds.has(image.id)) return;
    const flight = this.bindRuntimeImage(image.id, image.source, image.scopeRef)
      .then(
        (record) => {
          onRebound?.(record);
        },
        (error) => {
          const message = errorMessage(error);
          this.runtimeImages.markError(image.id, {
            code: "rebind_failed",
            message,
          });
          log.warn(`Runtime image rebind failed for ${image.id}:`, error);
        }
      )
      .finally(() => {
        this.runtimeImageRebinds.delete(image.id);
      });
    this.runtimeImageRebinds.set(image.id, flight);
  }

  // =========================================================================
  // Binary resolution
  // =========================================================================

  private findWorkerdBinary(): string {
    if (this.workerdBinary) return this.workerdBinary;

    const maybeExeExtension = process.platform === "win32" ? ".exe" : "";
    const platformPackages: Record<string, string> = {
      "darwin arm64 LE": "@cloudflare/workerd-darwin-arm64",
      "darwin x64 LE": "@cloudflare/workerd-darwin-64",
      "linux arm64 LE": "@cloudflare/workerd-linux-arm64",
      "linux x64 LE": "@cloudflare/workerd-linux-64",
      "win32 x64 LE": "@cloudflare/workerd-windows-64",
    };
    const platformKey = `${process.platform} ${os.arch()} ${os.endianness()}`;
    const platformPackage = platformPackages[platformKey];
    const appRoot = process.env["VIBESTUDIO_APP_ROOT"];

    if (platformPackage && appRoot) {
      const packagedCandidate = getPlatformPackageBinaryPath(
        appRoot,
        platformPackage,
        `workerd${maybeExeExtension}`
      );
      if (fs.existsSync(packagedCandidate)) {
        this.workerdBinary = packagedCandidate;
        return packagedCandidate;
      }
    }

    if (platformPackage) {
      try {
        const resolved = require.resolve(`${platformPackage}/bin/workerd${maybeExeExtension}`);
        const physicalResolved = getPhysicalPathForAsarPath(resolved);
        this.workerdBinary = fs.existsSync(physicalResolved) ? physicalResolved : resolved;
        return this.workerdBinary;
      } catch {
        // Fall through to local candidate paths and PATH lookup below.
      }
    }

    // Avoid the `node_modules/.bin/workerd` shim: it shells out to the real
    // binary with execFileSync(), which leaves the actual child process outside
    // our process tree and breaks restart/shutdown determinism.
    throw new Error(
      `The exact host dependency graph has no workerd binary for ${platformKey}; refusing PATH or cwd fallback resolution`
    );
  }

  // =========================================================================
  // Instance management
  // =========================================================================

  /**
   * Ensure a DO class is registered with workerd and return the targetId +
   * effectiveVersion that the runtime service will record on the entity row.
   *
   * Does NOT write an entity row — that's runtimeService.createEntity's job.
   */
  async ensureDurableObjectEntity(args: {
    source: string;
    ref?: string;
    className: string;
    key: string;
    contextId: string;
    stateArgs?: unknown;
  }): Promise<{
    targetId: string;
    effectiveVersion: string;
    buildKey: string;
    executionDigest: string;
    authority: RuntimeImageRecord["authority"];
  }> {
    const startedAt = performance.now();
    this.requireWorkspaceProvider("Durable Object entity activation");
    const targetId = canonicalEntityId({
      kind: "do",
      source: args.source,
      className: args.className,
      key: args.key,
    });
    const scopeRef = entityScopeRef(args.ref, args.contextId);
    await this.ensureDOClass(args.source, args.className, {
      scopeRef,
      objectKey: args.key,
      imageId: targetId,
      stateArgs: args.stateArgs,
    });
    log.info(
      `Durable Object runtime binding ready for ${args.source}:${args.className} in ` +
        `${Math.round(performance.now() - startedAt)}ms`
    );
    const serviceKey = doServiceKey(args.source, args.className);
    const svc = this.doServices.get(serviceKey);
    if (!svc) {
      throw new Error(
        `ensureDurableObjectEntity: DO class ${serviceKey} missing from doServices after ensureDOClass`
      );
    }
    const image =
      this.runtimeImages.get(targetId) ??
      (svc.imageId ? this.runtimeImages.get(svc.imageId) : null);
    if (!image) {
      throw new Error(
        `ensureDurableObjectEntity: no sealed runtime image for concrete object ${targetId}`
      );
    }
    return {
      targetId,
      effectiveVersion: image.artifact.sourceState.effectiveVersion,
      buildKey: image.artifact.buildKey,
      executionDigest: image.artifact.executionDigest,
      authority: image.authority,
    };
  }

  /**
   * Re-materialize one durable incarnation from its persisted runtime-image
   * binding before alarms or lifecycle callbacks are admitted after restart.
   * The content-addressed artifact must match the exact sealed identity
   * recorded by WorkspaceDO; a missing artifact or unknown class is a startup
   * integrity failure, never an implicit rebuild or upgrade.
   */
  async restoreDurableObjectEntity(record: EntityRecord): Promise<void> {
    if (record.kind !== "do" || !record.className) {
      throw new Error(`Cannot restore non-DO runtime entity ${record.id}`);
    }
    if (!record.activeBuildKey || !record.activeExecutionDigest || !record.activeAuthority) {
      throw new Error(`Durable Object ${record.id} has no sealed active execution identity`);
    }
    if (isInternalDOSource(record.source.repoPath)) {
      // Internal classes execute in their host-bundle service. The entity
      // ledger seals that service identity directly; it does not need a second
      // object-shaped runtime-image record that can drift from the service.
      const identity = internalDOExecutionIdentity(this.internalDOBundle(), record.className);
      if (
        identity.artifact.buildKey !== record.activeBuildKey ||
        identity.artifact.executionDigest !== record.activeExecutionDigest ||
        identity.artifact.sourceState.effectiveVersion !== record.source.effectiveVersion ||
        canonicalJson(identity.authority) !== canonicalJson(record.activeAuthority)
      ) {
        throw new RuntimeImageUnavailableError(
          `Internal Durable Object ${record.id} does not match its sealed host service identity`
        );
      }
      await this.ensureDOClass(record.source.repoPath, record.className, {
        objectKey: record.key,
        stateArgs: record.stateArgs,
      });
      return;
    }

    const provider = this.requireWorkspaceProvider("sealed runtime image restoration");
    const build = provider.getBuildByExecution(record.activeBuildKey, record.activeExecutionDigest);
    if (
      !build ||
      build.metadata.kind !== "worker" ||
      build.metadata.sourcePath !== record.source.repoPath
    ) {
      this.recordDurableObjectImageEvent(
        record,
        "error",
        "runtime-image-unavailable",
        "Sealed Durable Object image is unavailable",
        "missing"
      );
      throw new RuntimeImageUnavailableError(
        `Durable Object ${record.id} is missing its sealed build artifact ${record.activeBuildKey}`
      );
    }
    const artifact = executionArtifactRefFromBuild(this.deps.workspaceId, build);
    if (
      artifact.executionDigest !== record.activeExecutionDigest ||
      artifact.sourceState.effectiveVersion !== record.source.effectiveVersion ||
      canonicalJson(build.metadata.authority) !== canonicalJson(record.activeAuthority)
    ) {
      this.recordDurableObjectImageEvent(
        record,
        "error",
        "runtime-image-unavailable",
        "Sealed Durable Object image failed identity verification",
        "identity-mismatch"
      );
      throw new RuntimeImageUnavailableError(
        `Durable Object ${record.id} build ${record.activeBuildKey} does not reproduce its sealed execution identity`
      );
    }
    const previous = this.sealedDoImages.get(record.id) ?? this.runtimeImages.get(record.id);
    const sameIncarnation =
      previous?.artifact.executionDigest === artifact.executionDigest &&
      canonicalJson(previous.authority) === canonicalJson(record.activeAuthority);
    const sealedImage: RuntimeImageRecord = {
      id: record.id,
      source: record.source.repoPath,
      unitName: build.metadata.name,
      artifact,
      authority: record.activeAuthority,
      generation: sameIncarnation ? previous!.generation : (previous?.generation ?? 0) + 1,
      updatedAt: Date.now(),
      ...(previous?.scopeRef ? { scopeRef: previous.scopeRef } : {}),
    };
    this.sealedDoImages.set(record.id, sealedImage);
    // Preparation may have persisted a selector for this id. Once the entity
    // commit succeeds it is derived state and must not remain a second owner.
    this.runtimeImages.delete(record.id);
    this.restoreSealedUserlandDOClass(record, sealedImage);
    await this.ensureWorkerdRunning();

    const restored = this.sealedDoImages.get(record.id);
    if (!restored) throw new Error(`Durable Object ${record.id} did not attach a runtime image`);
    if (
      restored.artifact.buildKey !== record.activeBuildKey ||
      restored.artifact.executionDigest !== record.activeExecutionDigest ||
      restored.artifact.sourceState.effectiveVersion !== record.source.effectiveVersion ||
      canonicalJson(restored.authority) !== canonicalJson(record.activeAuthority)
    ) {
      throw new Error(
        `Durable Object ${record.id} could not restore its sealed active execution identity`
      );
    }
    this.recordDurableObjectImageEvent(
      record,
      "info",
      "runtime-image-attached",
      "Sealed Durable Object image attached",
      "retained",
      { generation: restored.generation }
    );
  }

  private recordDurableObjectImageEvent(
    record: EntityRecord,
    level: "info" | "error",
    event: string,
    message: string,
    retentionState: string,
    fields: Record<string, unknown> = {}
  ): void {
    this.deps.recordLifecycleEvent?.({
      source: record.source.repoPath,
      callerId: record.id,
      entityId: record.id,
      kind: "do",
      level,
      message,
      fields: {
        event,
        retentionState,
        buildKey: record.activeBuildKey,
        executionDigest: record.activeExecutionDigest,
        ...fields,
      },
    });
  }

  /**
   * Restore the routing metadata for an active userland Durable Object from
   * the content-addressed runtime image recorded at activation time.
   *
   * This deliberately never calls bindRuntimeImage(). The workspace ref may
   * have advanced, been reverted, or disappeared since the object started;
   * rebuilding from that mutable ref would silently upgrade the object (or
   * make cleanup impossible). The exact build artifact is therefore a durable
   * part of the active entity identity and must still be available by key.
   */
  private restoreSealedUserlandDOClass(record: EntityRecord, image: RuntimeImageRecord): void {
    const source = record.source.repoPath;
    const className = assertPresent(record.className);
    const sourceSegments = source.split("/").filter(Boolean);
    if (sourceSegments.length !== 2) {
      throw new Error(`DO source path must be exactly 2 segments, got: "${source}"`);
    }
    const provider = this.requireWorkspaceProvider("sealed runtime image restoration");
    if (!provider.getBuildByExecution(image.artifact.buildKey, image.artifact.executionDigest)) {
      throw new RuntimeImageUnavailableError(
        `Durable Object ${record.id} is missing its sealed build artifact ${image.artifact.buildKey}`
      );
    }

    const serviceKey = doServiceKey(source, className);
    let service = this.doServices.get(serviceKey);
    if (!service) {
      const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
      service = {
        buildKey: image.artifact.buildKey,
        className,
        serviceName: `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        source,
      };
      this.doServices.set(serviceKey, service);
      this.registerRoutesForDoClass(source, className);
    }

    const stateArgs = recordStateArgs(record.stateArgs);
    this.doObjectBuilds.set(doObjectBuildKey(source, className, record.key), {
      imageId: image.id,
      buildKey: image.artifact.buildKey,
      ...(image.scopeRef ? { scopeRef: image.scopeRef } : {}),
      ...(stateArgs ? { stateArgs } : {}),
    });
    this.registerDoEgressCaller(source, className, image, record.key);
  }

  /**
   * Bring up a worker process for an entity managed by the runtime service.
   *
   * Wraps the regular worker creation path but uses an entity-scoped callerId
   * for token minting and bearer binding. Does not write an entity row.
   */
  async startWorker(args: {
    source: string;
    ref?: string;
    key: string;
    contextId: string;
    stateArgs?: unknown;
    env?: Record<string, string>;
    parent?: { parentId: string; parentEntityId: string; parentKind?: "panel" | "worker" | "do" };
  }): Promise<{
    targetId: string;
    effectiveVersion: string;
    buildKey: string;
    executionDigest: string;
    authority: RuntimeImageRecord["authority"];
  }> {
    this.requireWorkspaceProvider("worker start");
    const targetId = canonicalEntityId({ kind: "worker", source: args.source, key: args.key });
    const name = args.key.replace(/[^a-zA-Z0-9_-]/g, "_");

    // Idempotent re-attach: `canonicalEntityId` is context-free, so the same
    // (source, key) maps to the same targetId/name in any context. If a live
    // instance already matches this identity (same source AND contextId), return
    // it as a no-op — this covers spawn retries/races where the entity create is
    // replayed. A different identity colliding on the sanitized name (a different
    // source, or the same source in another context — workers are NOT
    // context-isolated until their canonical id includes contextId) is a genuine
    // collision and throws rather than silently reusing the wrong worker.
    const existingInstance = this.instances.get(name);
    if (existingInstance) {
      // Reattach ONLY on a FULL-identity match: the canonical targetId
      // (`runtimeImageId` = worker:source:key) AND the contextId. targetId is
      // context-free, so both checks are needed — the targetId guards distinct
      // raw keys that sanitize to the same `name` (e.g. `a:b`/`a_b`), and the
      // contextId prevents silently handing a launch a worker running in a
      // DIFFERENT context (same source+key in another context maps to the same
      // targetId). Workers are not context-isolated until their canonical id
      // includes contextId — callers must use context-unique keys; anything
      // short of a full match is a genuine collision and throws.
      if (
        existingInstance.runtimeImageId === targetId &&
        existingInstance.contextId === args.contextId
      ) {
        const image = this.runtimeImages.get(existingInstance.runtimeImageId);
        if (!image) {
          throw new Error(
            `Worker ${targetId} is running without its sealed runtime image; restart it to rebind`
          );
        }
        return {
          targetId,
          effectiveVersion: image.artifact.sourceState.effectiveVersion,
          buildKey: image.artifact.buildKey,
          executionDigest: image.artifact.executionDigest,
          authority: image.authority,
        };
      }
      throw new Error(
        `Worker instance "${name}" already exists with a different identity ` +
          `(existing targetId=${existingInstance.runtimeImageId} source=${existingInstance.source} ` +
          `context=${existingInstance.contextId}; requested targetId=${targetId} ` +
          `source=${args.source} context=${args.contextId})`
      );
    }

    const callerId = targetId;
    const token = this.ensureWorkerBearer(callerId);
    const scopeRef = entityScopeRef(args.ref, args.contextId);

    const stateArgs =
      args.stateArgs && typeof args.stateArgs === "object" && !Array.isArray(args.stateArgs)
        ? (args.stateArgs as Record<string, unknown>)
        : undefined;

    const instance: WorkerInstance = {
      id: callerId,
      name,
      source: args.source,
      contextId: args.contextId,
      callerId,
      token,
      env: args.env ?? {},
      bindings: {},
      stateArgs,
      runtimeImageId: targetId,
      scopeRef,
      codeVersion: 1,
      status: "building",
      // Launch parent (from the verified caller) → PARENT_* env (built later from
      // these fields), so an entity-created worker's `parent` resolves like a
      // `workers.create` one.
      parentId: args.parent?.parentId,
      parentEntityId: args.parent?.parentEntityId,
      parentKind: args.parent?.parentKind,
    };

    this.instances.set(name, instance);

    try {
      instance.status = "starting";
      const [image] = await Promise.all([
        this.bindRuntimeImage(targetId, args.source, scopeRef),
        this.ensureWorkerdRunning(),
      ]);
      instance.scopeRef = image.scopeRef;
      instance.buildKey = image.artifact.buildKey;
      instance.executionDigest = image.artifact.executionDigest;
      instance.effectiveVersion = image.artifact.sourceState.effectiveVersion;
      this.advanceWorkerCodeVersion(instance, image.generation);
      // Register egress AFTER bind so the caller carries the signed effective
      // version (not "unknown"/an artifact key) for version-scoped approvals/audit.
      this.registerEgressCaller(instance);

      instance.status = "running";
      this.lastWorkerErrors.delete(args.source);
      this.deps.recordLifecycleEvent?.({
        source: args.source,
        callerId,
        level: "info",
        message: `Worker started (build ${image.artifact.buildKey})`,
        fields: {
          event: "worker-started",
          buildKey: image.artifact.buildKey,
          executionDigest: image.artifact.executionDigest,
          generation: image.generation,
          effectiveVersion: image.artifact.sourceState.effectiveVersion,
        },
      });
      log.info(`Worker entity "${targetId}" started (source: ${args.source})`);

      if (this.deps.routeRegistry) {
        const canonical = canonicalInstanceNameForSource(args.source);
        if (name === canonical) {
          const routes = this.requireWorkspaceProvider(
            "worker route registration"
          ).getManifestRoutes(args.source);
          if (routes.length > 0) {
            this.deps.routeRegistry.registerWorkerRoutes(args.source, name, Array.from(routes));
          }
        }
      }

      return {
        targetId,
        effectiveVersion: image.artifact.sourceState.effectiveVersion,
        buildKey: image.artifact.buildKey,
        executionDigest: image.artifact.executionDigest,
        authority: image.authority,
      };
    } catch (error) {
      instance.status = "error";
      this.instances.delete(name);
      this.runtimeImages.delete(targetId);
      this.deps.unregisterEgressCaller(callerId);
      this.revokeWorkerBearer(callerId);
      const message = error instanceof Error ? error.message : String(error);
      this.lastWorkerErrors.set(args.source, { message, timestamp: Date.now() });
      this.deps.recordLifecycleEvent?.({
        source: args.source,
        callerId,
        level: "error",
        message: `Worker failed to start: ${message}`,
        fields: { event: "worker-start-failed" },
      });
      log.error(`Failed to start worker entity "${targetId}":`, error);
      throw error;
    }
  }

  /** Resolve a canonical runtime worker id to the loader's opaque instance name. */
  resolveWorkerInstanceName(targetId: string): string | null {
    for (const instance of this.instances.values()) {
      if (instance.runtimeImageId === targetId) return instance.name;
    }
    return null;
  }

  /**
   * Idempotent worker teardown invoked by the runtime-service retire hook.
   * Revokes the bearer token, drops the worker instance, runs handle/webhook
   * cleanup, and restarts (or stops) workerd as appropriate.
   */
  async stopWorker(callerId: string): Promise<void> {
    let foundInstance: WorkerInstance | null = null;
    let foundName: string | null = null;
    for (const [name, instance] of this.instances) {
      if (instance.callerId === callerId) {
        foundInstance = instance;
        foundName = name;
        break;
      }
    }

    this.deps.unregisterEgressCaller(callerId);
    this.revokeWorkerBearer(callerId);
    this.deps.fsService.closeHandlesForCaller(callerId);
    await this.deps.cleanupWebhookSubscriptions?.(callerId);

    if (!foundInstance || !foundName) return;

    if (this.deps.routeRegistry) {
      const canonical = canonicalInstanceNameForSource(foundInstance.source);
      if (foundInstance.name === canonical) {
        this.deps.routeRegistry.unregisterWorkerRoutes(foundInstance.source);
      }
    }

    foundInstance.status = "stopped";
    this.instances.delete(foundName);
    this.runtimeImages.delete(foundInstance.runtimeImageId);

    // No restart: the worker host is static and loads code on demand, so a
    // destroyed worker simply stops being addressable (its `/_workerversion`
    // 404s and its cached isolate idles out). Only stop workerd when nothing
    // is left to serve.
    await this.stopWorkerdIfIdle();

    log.info(`Worker entity "${callerId}" stopped`);
  }

  private async abortUserlandDOFacet(
    ref: DORef,
    operation: "__vibestudio_retire" | "__vibestudio_restart" | "__vibestudio_fault_abort"
  ): Promise<void> {
    if (!this.process || this.process.exitCode !== null || !this.port) return;
    const key = encodeUniversalKey(ref);
    const response = await fetch(
      `http://127.0.0.1:${this.port}/_u/${encodeURIComponent(key)}/${operation}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.deps.getWorkerdGatewayToken()}`,
          "X-Vibestudio-Dispatch-Secret": this.dispatchSecret,
          "X-Vibestudio-Lifecycle-Secret": this.loaderSecret,
        },
        dispatcher: getWorkerdConnectionDispatcher(),
      } as RequestInit
    );
    if (!response.ok) {
      throw new Error(
        `Failed to ${
          operation === "__vibestudio_retire"
            ? "retire"
            : operation === "__vibestudio_restart"
              ? "restart"
              : "fault-abort"
        } ` +
          `userland DO facet ${ref.source}:${ref.className}/${ref.objectKey} ` +
          `(${response.status}): ${await response.text()}`
      );
    }
  }

  /**
   * Test-only host seam: evict one userland DO facet without deleting its
   * durable state or changing its runtime image. Admission is owned by the
   * hidden runtime service method; this low-level owner accepts only the
   * already-resolved canonical DO reference.
   */
  async faultAbortUserlandDOFacet(ref: DORef): Promise<void> {
    if (!this.process || this.process.exitCode !== null || !this.port) {
      throw new Error(
        `Cannot fault-abort userland DO facet ${ref.source}:${ref.className}/${ref.objectKey}: ` +
          "workerd is not running"
      );
    }
    await this.abortUserlandDOFacet(ref, "__vibestudio_fault_abort");
  }

  async restartUserlandDOFacet(ref: DORef): Promise<void> {
    if (!this.process || this.process.exitCode !== null || !this.port) {
      throw new Error(
        `Cannot restart userland DO facet ${ref.source}:${ref.className}/${ref.objectKey}: ` +
          "workerd is not running"
      );
    }
    await this.abortUserlandDOFacet(ref, "__vibestudio_restart");
  }

  /**
   * Idempotent DO runtime teardown invoked by the runtime-service retire hook.
   * Aborting the live facet releases its object-owned state while deliberately
   * preserving durable storage for a later reattach. WorkerLoader has no
   * per-worker unload operation: its dynamically loaded isolate remains resident
   * until the workerd process generation ends. Mark the generation reclaimable;
   * the memory sampler compacts it under material RSS pressure, with a bounded
   * retired-isolate count for platforms without process RSS sampling. This
   * keeps ordinary create/delete UX restart-free while bounding accumulation
   * during long-running build and system-test campaigns.
   */
  async retireDOEntity(ref: DORef): Promise<void> {
    const targetId = canonicalEntityId({
      kind: "do",
      source: ref.source,
      className: ref.className,
      key: ref.objectKey,
    });
    let abortError: unknown;
    if (!isInternalDOSource(ref.source)) {
      try {
        await this.abortUserlandDOFacet(ref, "__vibestudio_retire");
      } catch (error) {
        abortError = error;
      }
    }
    this.revokeWorkerBearer(targetId);
    this.deps.fsService.closeHandlesForCaller(targetId);
    await this.deps.cleanupWebhookSubscriptions?.(targetId);
    const removedImage = this.sealedDoImages.get(targetId) ?? this.runtimeImages.get(targetId);
    this.runtimeImages.delete(targetId);
    this.sealedDoImages.delete(targetId);
    for (const [key, objectBuild] of Array.from(this.doObjectBuilds.entries())) {
      if (objectBuild.imageId === targetId) this.doObjectBuilds.delete(key);
    }
    if (removedImage) {
      this.deps.recordLifecycleEvent?.({
        source: ref.source,
        callerId: targetId,
        entityId: targetId,
        kind: "do",
        level: "info",
        message: "Durable Object runtime image evicted",
        fields: {
          event: "runtime-image-evicted",
          retentionState: "released",
          buildKey: removedImage.artifact.buildKey,
          executionDigest: removedImage.artifact.executionDigest,
        },
      });
    }
    if (!isInternalDOSource(ref.source)) {
      this.retiredDynamicIsolateGeneration ??= this.bootGeneration;
      this.retiredDynamicIsolateIds.add(targetId);
      const rssBytes = this.process?.pid ? this.readProcessRssBytes(this.process.pid) : null;
      this.maybeCompactRetiredDynamicIsolates(rssBytes);
    }
    if (abortError) throw abortError;
  }

  /**
   * Build a VerifiedCaller for a live worker instance and register it for
   * attributed egress through the shared listener. Called on create; matched by
   * `unregisterEgressCaller(callerId)` on destroy.
   */
  private registerEgressCaller(instance: WorkerInstance): void {
    const image = this.runtimeImages.get(instance.runtimeImageId);
    if (!image || image.artifact.executionDigest !== instance.executionDigest) {
      throw new Error(
        `Cannot register egress for ${instance.callerId} without its exact sealed runtime image`
      );
    }
    const caller = createVerifiedCaller(instance.callerId, "worker", {
      callerId: instance.callerId,
      callerKind: "worker",
      repoPath: instance.source,
      effectiveVersion: image.artifact.sourceState.effectiveVersion,
      executionDigest: image.artifact.executionDigest,
      requested: image.authority.requests,
    });
    this.deps.registerEgressCaller(instance.callerId, caller);
  }

  /**
   * Start workerd if it isn't already running. Idempotent. Unlike
   * `restartWorkerd`, this never tears down a live process — the worker host and
   * router are static, so worker lifecycle never needs a restart.
   */
  private async ensureWorkerdRunning(): Promise<void> {
    for (;;) {
      if (this.process && this.process.exitCode === null) return;
      // A generation transition is already in flight (or queued): joining it is
      // mandatory. Minting a fresh restart epoch here would race the stop→spawn
      // window and force a needless second full restart cycle.
      const running = this.activeTransition;
      if (running) {
        await running.promise.catch(() => {});
        if (running.failed) throw running.error;
        continue;
      }
      if (this.appliedEpoch < this.requestedEpoch) {
        await this.ensureRestartAtLeast(this.requestedEpoch);
        continue;
      }
      await this.restartWorkerd();
      return;
    }
  }

  /**
   * Stop workerd only when no workers and no DO services remain to serve.
   * Routed through the generation-transition owner — NO process stop happens
   * outside it — so an idle stop serializes with (and is subsumed by) any
   * concurrent planned or crash transition.
   */
  private async stopWorkerdIfIdle(): Promise<void> {
    if (this.instances.size > 0 || this.doServices.size > 0 || this.schemaProbeBuilds.size > 0)
      return;
    await this.restartWorkerd({ kind: "stop-if-idle" });
  }

  async updateInstance(
    name: string,
    updates: Partial<WorkerCreateOptions>
  ): Promise<WorkerInstance> {
    const resolvedName = this.resolveInstanceName(name);
    const instance = resolvedName ? this.instances.get(resolvedName) : undefined;
    if (!instance) {
      throw new Error(`Worker instance "${name}" not found`);
    }

    if (updates.env) instance.env = updates.env;
    if (updates.bindings) instance.bindings = updates.bindings;
    if (updates.stateArgs !== undefined) instance.stateArgs = updates.stateArgs;
    if (updates.ref !== undefined) {
      instance.scopeRef = entityScopeRef(updates.ref, instance.contextId);
      const image = await this.bindRuntimeImage(
        instance.runtimeImageId,
        instance.source,
        instance.scopeRef
      );
      instance.buildKey = image.artifact.buildKey;
      instance.executionDigest = image.artifact.executionDigest;
      instance.effectiveVersion = image.artifact.sourceState.effectiveVersion;
      this.advanceWorkerCodeVersion(instance, image.generation);
      this.registerEgressCaller(instance); // refresh egress EV after a rebind
    }

    // Bump the loader-cache version so the host reloads fresh code+env on the
    // next request. No workerd restart — the host is static.
    if (updates.ref === undefined) this.advanceWorkerCodeVersion(instance);

    this.deps.recordLifecycleEvent?.({
      source: instance.source,
      callerId: instance.callerId,
      level: "info",
      message: `Worker updated (codeVersion ${instance.codeVersion})`,
      fields: { event: "worker-updated", codeVersion: instance.codeVersion },
    });
    log.info(`Worker instance "${resolvedName}" updated (codeVersion ${instance.codeVersion})`);
    return instance;
  }

  /** Most recent startup/update failure for a worker source, if any. */
  getLastWorkerError(source: string): { message: string; timestamp: number } | null {
    return this.lastWorkerErrors.get(source) ?? null;
  }

  listInstances(): Omit<WorkerInstance, "token">[] {
    return Array.from(this.instances.values()).map(({ token: _token, ...rest }) => rest);
  }

  private resolveInstanceName(idOrName: string): string | null {
    if (this.instances.has(idOrName)) return idOrName;
    for (const [name, instance] of this.instances) {
      if (
        instance.id === idOrName ||
        instance.callerId === idOrName ||
        instance.runtimeImageId === idOrName
      ) {
        return name;
      }
    }
    return null;
  }

  getPort(): number | null {
    return this.port;
  }

  getInspectorUrl(): string | null {
    if (!this.process || !this.inspectorPort) return null;
    return `http://127.0.0.1:${this.inspectorPort}`;
  }

  getWorkerInspectorUrl(nameOrSource: string): string | null {
    const hasInstance = [...this.instances.values()].some(
      (instance) =>
        instance.name === nameOrSource ||
        instance.source === nameOrSource ||
        instance.callerId === nameOrSource
    );
    return hasInstance ? this.getInspectorUrl() : null;
  }

  getWorkerdGatewayToken(): string {
    return this.deps.getWorkerdGatewayToken();
  }

  getBootGeneration(): number {
    return this.bootGeneration;
  }

  onRestartBegin(fn: (event: RestartBeginEvent) => Promise<void> | void): () => void {
    this.restartBeginHooks.add(fn);
    return () => this.restartBeginHooks.delete(fn);
  }

  onRestartReady(fn: (event: RestartReadyEvent) => Promise<void> | void): () => void {
    this.restartReadyHooks.add(fn);
    return () => this.restartReadyHooks.delete(fn);
  }

  /**
   * In-process generation-closing hooks: run for planned AND crash transitions
   * (and idle stops), right before the old process is stopped. Hooks must not
   * dispatch into workerd. Failures are logged, never propagated — closing the
   * old generation cannot be vetoed.
   */
  onGenerationClosing(fn: (event: GenerationClosingEvent) => Promise<void> | void): () => void {
    this.generationClosingHooks.add(fn);
    return () => this.generationClosingHooks.delete(fn);
  }

  /**
   * True while the generation-transition owner is replacing workerd AND the
   * old generation is no longer dispatchable (stopping/reaping/starting).
   * Deliberately false during graceful "preparing": prep hooks must still be
   * able to dispatch into the live old generation.
   */
  isGenerationTransitionInFlight(): boolean {
    return (
      this.activeTransition !== null && !(this.process !== null && this.process.exitCode === null)
    );
  }

  /**
   * Recover an unresponsive sandbox without first asking workerd-hosted
   * lifecycle targets to prepare. A synchronous unsafe-eval loop prevents
   * those RPCs from running, so graceful restart would deadlock before it
   * reached the process boundary. Durable objects reconcile from SQLite after
   * the replacement process starts, and listeners receive a crash-style ready
   * event so runtime leases are resumed from durable state.
   */
  async recoverUnresponsiveSandbox(reason: string): Promise<void> {
    return this.recoverSandbox(reason, false);
  }

  /**
   * Recover a runtime generation that has already exited. The exit observer
   * cannot await this work, so failures are logged at that boundary; callers
   * reaching the new generation still receive ordinary transport terminals
   * from the destroyed connection pool.
   */
  private recoverExitedSandbox(reason: string): Promise<void> {
    return this.recoverSandbox(reason, true);
  }

  private async recoverSandbox(reason: string, alreadyExited: boolean): Promise<void> {
    if (this.unresponsiveRecovery) return this.unresponsiveRecovery;
    log.error(`recovering unresponsive workerd sandbox: ${reason}`);
    const recovery = this.restartWorkerd({ kind: "crash", reason, alreadyExited });
    this.unresponsiveRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.unresponsiveRecovery === recovery) this.unresponsiveRecovery = null;
    }
  }

  getDispatchSecret(): string {
    return this.dispatchSecret;
  }

  /** Secret gating `/_workercode` + `/_workerversion`. The gateway validates
   *  the inbound `X-Vibestudio-Loader-Secret` header against this. */
  getLoaderSecret(): string {
    return this.loaderSecret;
  }

  /** Secret the shared egress listener requires on attributed requests. */
  getEgressSecret(): string {
    return this.egressSecret;
  }

  /**
   * Current loader-cache version for a worker instance, or null if no such
   * instance exists. Served by `GET /_workerversion/{name}`; the host keys its
   * loader id on `${name}@${version}` so update/rebuild forces a fresh isolate.
   */
  getWorkerVersion(name: string): number | null {
    return this.instances.get(name)?.codeVersion ?? null;
  }

  /**
   * Serializable code + env for a worker instance, for the dynamic worker host.
   * Carries only data — capability bindings (globalOutbound) are attached by the
   * host at load time. Returns null if no such instance exists.
   */
  async getWorkerCode(name: string): Promise<{
    compatibilityDate: string;
    compatibilityFlags: string[];
    mainModule: string;
    modules: Record<string, string>;
    env: Record<string, unknown>;
    callerId: string;
  } | null> {
    const instance = this.instances.get(name);
    if (!instance) return null;

    const { image, build: buildResult } = this.getMutableRuntimeImageBuild(
      instance.runtimeImageId,
      (record) => {
        instance.buildKey = record.artifact.buildKey;
        instance.executionDigest = record.artifact.executionDigest;
        instance.effectiveVersion = record.artifact.sourceState.effectiveVersion;
        this.advanceWorkerCodeVersion(instance, record.generation);
        this.registerEgressCaller(instance);
      }
    );
    instance.buildKey = image.artifact.buildKey;
    instance.executionDigest = image.artifact.executionDigest;
    instance.effectiveVersion = image.artifact.sourceState.effectiveVersion;
    const modules = workerJavaScriptModules(buildResult);

    // WorkerCode `env` (unlike the old capnp config) supports non-string values
    // natively — so `json` bindings / STATE_ARGS / aliases keep their PARSED
    // (object/array) shape, exactly as the old workerd `json` bindings exposed
    // them. The /_workercode JSON round-trips them losslessly.
    const env: Record<string, unknown> = {
      RPC_AUTH_TOKEN: instance.token,
      WORKER_ID: instance.name,
      WORKER_SOURCE: instance.source,
      WORKER_EFFECTIVE_VERSION: instance.effectiveVersion,
      CONTEXT_ID: instance.contextId,
      GATEWAY_URL: this.deps.getServerUrl(),
      WORKERD_BOOT_GENERATION: String(this.configBootGeneration()),
    };
    if (process.env["VIBESTUDIO_TEST_MODE"]) {
      env["VIBESTUDIO_TEST_MODE"] = process.env["VIBESTUDIO_TEST_MODE"];
    }
    forwardDiagnosticEnv(env);
    if (instance.parentId) env["PARENT_ID"] = instance.parentId;
    if (instance.parentEntityId) env["PARENT_ENTITY_ID"] = instance.parentEntityId;
    if (instance.parentKind) env["PARENT_KIND"] = instance.parentKind;
    const gatewayAliases = this.deps.getServerAliasUrls?.() ?? [];
    if (gatewayAliases.length > 0) {
      env["GATEWAY_URL_ALIASES"] = [...gatewayAliases];
    }
    if (instance.stateArgs && Object.keys(instance.stateArgs).length > 0) {
      env["STATE_ARGS"] = instance.stateArgs;
    }
    // User-defined env (text only).
    for (const [key, value] of Object.entries(instance.env)) {
      env[key] = value;
    }
    // Typed bindings are serializable data only — `text` is a string, `json`
    // keeps its parsed object value; both pass through as-is.
    for (const [key, binding] of Object.entries(instance.bindings)) {
      env[key] = binding.value;
    }

    return {
      compatibilityDate: "2025-12-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules,
      env,
      callerId: instance.callerId,
    };
  }

  getDoCodeIdentity(
    source: string,
    className: string
  ): { repoPath: string; effectiveVersion: string } | null {
    const service = this.doServices.get(doServiceKey(source, className));
    if (!service) {
      return null;
    }
    const image = service.imageId ? this.runtimeImages.get(service.imageId) : null;
    return {
      repoPath: service.source,
      effectiveVersion: image?.artifact.sourceState.effectiveVersion ?? service.buildKey,
    };
  }

  /**
   * Current loader-cache version for a userland DO class (its build's effective
   * version), or null if the class isn't registered. Served by
   * `GET /_doversion/{source}/{className}?objectKey=...`; the UniversalDO host
   * keys its loader id on `source:className/objectKey@version` so a rebuild
   * forces a fresh isolate for that object/ref binding.
   */
  getDoVersion(source: string, className: string, objectKey?: string): string | null {
    const probe = objectKey ? this.schemaProbeBuilds.get(objectKey) : undefined;
    if (probe && probe.source === source && probe.className === className) {
      return `${probe.build.metadata.ev}:schema-probe:${probe.build.buildKey}`;
    }
    if (objectKey) {
      const objectBuild = this.doObjectBuilds.get(doObjectBuildKey(source, className, objectKey));
      if (objectBuild) {
        const image = this.sealedDoImages.get(objectBuild.imageId);
        return image
          ? runtimeIncarnationVersion(image, objectBuild.stateArgs)
          : objectBuild.stateArgs
            ? `${objectBuild.buildKey}:state:${stableHash(objectBuild.stateArgs)}`
            : objectBuild.buildKey;
      }
    }
    const svc = this.doServices.get(doServiceKey(source, className));
    if (!svc || isInternalDOSource(source)) return null;
    const image = svc.imageId ? this.runtimeImages.get(svc.imageId) : null;
    return image ? runtimeIncarnationVersion(image) : svc.buildKey;
  }

  /** Resolve a userland DO method from the exact build bound to this object. */
  private workspaceRpcCatalogIndex(build: BuildResult): ReadonlyMap<string, WorkspaceRpcMethodDoc> {
    const cached = this.workspaceRpcCatalogIndexes.get(build);
    if (cached) return cached;
    const index = new Map<string, WorkspaceRpcMethodDoc>();
    for (const declaration of build.metadata.workspaceRpcCatalog ?? []) {
      const key = `${declaration.className}\0${declaration.name}`;
      if (!index.has(key)) index.set(key, declaration);
    }
    this.workspaceRpcCatalogIndexes.set(build, index);
    return index;
  }

  resolveDoRpcMethodAuthority(
    source: string,
    className: string,
    objectKey: string,
    method: string
  ):
    | (Pick<
        WorkspaceRpcMethodDoc,
        "effect" | "access" | "userlandCapability" | "producesHandle"
      > & { providerExecutionDigest: string })
    | null {
    if (isInternalDOSource(source)) return null;
    const objectBuild = this.doObjectBuilds.get(doObjectBuildKey(source, className, objectKey));
    const service = this.doServices.get(doServiceKey(source, className));
    const buildKey = objectBuild?.buildKey ?? service?.buildKey;
    if (!buildKey) return null;
    const build = this.requireWorkspaceProvider("direct DO authority").getBuildByKey(buildKey);
    if (!build || build.metadata.kind !== "worker") return null;
    const declaration = this.workspaceRpcCatalogIndex(build).get(`${className}\0${method}`) ?? null;
    return declaration && build.metadata.execution?.executionDigest
      ? {
          ...declaration,
          providerExecutionDigest: build.metadata.execution.executionDigest,
        }
      : null;
  }

  describeDoRpcCatalog(
    source: string,
    className: string,
    objectKey: string
  ): { activeBuildKey: string | null; declaredMethods: string[] } {
    if (isInternalDOSource(source)) return { activeBuildKey: null, declaredMethods: [] };
    const objectBuild = this.doObjectBuilds.get(doObjectBuildKey(source, className, objectKey));
    const service = this.doServices.get(doServiceKey(source, className));
    const activeBuildKey = objectBuild?.buildKey ?? service?.buildKey ?? null;
    if (!activeBuildKey) return { activeBuildKey, declaredMethods: [] };
    const build = this.requireWorkspaceProvider("direct DO catalog").getBuildByKey(activeBuildKey);
    if (!build || build.metadata.kind !== "worker") {
      return { activeBuildKey, declaredMethods: [] };
    }
    return {
      activeBuildKey,
      declaredMethods: (build.metadata.workspaceRpcCatalog ?? [])
        .filter((entry) => entry.className === className)
        .map((entry) => entry.name)
        .sort(),
    };
  }

  /**
   * Serializable code + env for a userland DO class, for the UniversalDO facet
   * host. Mirrors the per-class DO service bindings the old static config
   * generated. Capability bindings (globalOutbound) are attached by the host.
   * Returns null if the class isn't a registered userland DO.
   */
  async getDoCode(
    source: string,
    className: string,
    objectKey?: string
  ): Promise<{
    compatibilityDate: string;
    compatibilityFlags: string[];
    mainModule: string;
    modules: Record<string, string>;
    /** Extra pre-compiled wasm modules, base64 (e.g. terminal/Ink `yoga.wasm`).
     *  The UniversalDO host decodes these to ArrayBuffers for the loader. */
    wasmModules?: Record<string, string>;
    env: Record<string, unknown>;
  } | null> {
    const probe = objectKey ? this.schemaProbeBuilds.get(objectKey) : undefined;
    if (probe && probe.source === source && probe.className === className) {
      const wasmModules: Record<string, string> = {};
      for (const artifact of probe.build.artifacts) {
        if (artifact.role === "wasm") wasmModules[artifact.path] = artifact.content;
      }
      return {
        compatibilityDate: "2025-12-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "worker.js",
        modules: workerJavaScriptModules(probe.build),
        ...(Object.keys(wasmModules).length > 0 ? { wasmModules } : {}),
        env: {
          WORKER_SOURCE: source,
          WORKER_CLASS_NAME: className,
          VIBESTUDIO_SCHEMA_PROBE: true,
        },
      };
    }
    const serviceKey = doServiceKey(source, className);
    const svc = this.doServices.get(serviceKey);
    if (!svc || isInternalDOSource(source)) return null;

    const objectBuildKey = objectKey ? doObjectBuildKey(source, className, objectKey) : null;
    const objectBuild = objectBuildKey ? this.doObjectBuilds.get(objectBuildKey) : undefined;
    const resolved = objectBuild
      ? this.getSealedRuntimeImageBuild(objectBuild.imageId)
      : svc.imageId
        ? this.getMutableRuntimeImageBuild(svc.imageId)
        : null;
    if (!resolved) return null;
    const { image, build: buildResult } = resolved;
    if (objectBuildKey && objectBuild) {
      this.doObjectBuilds.set(objectBuildKey, {
        ...objectBuild,
        buildKey: image.artifact.buildKey,
      });
    } else {
      svc.buildKey = image.artifact.buildKey;
    }
    const modules = workerJavaScriptModules(buildResult);
    // Terminal (Ink) DOs import a pre-compiled `yoga.wasm` module — it must be
    // loaded alongside the JS bundle (the only way to run WASM in workerd).
    const wasmModules: Record<string, string> = {};
    for (const artifact of buildResult.artifacts) {
      if (artifact.role === "wasm") wasmModules[artifact.path] = artifact.content;
    }

    // Service-level token shared by all instances of this source:className;
    // `do-service:*` is a bearer identity, not an entity id.
    const serviceCallerId = `do-service:${serviceKey}`;
    const serviceToken = this.ensureWorkerBearer(serviceCallerId);
    // Keep the egress attribution registered for this class identity.
    this.registerDoEgressCaller(source, className, image, objectKey);

    const env: Record<string, unknown> = {
      RPC_AUTH_TOKEN: serviceToken,
      WORKER_SOURCE: source,
      WORKER_CLASS_NAME: className,
      WORKER_EFFECTIVE_VERSION: image.artifact.sourceState.effectiveVersion,
      WORKERD_SESSION_ID: this.sessionId,
      WORKERD_BOOT_GENERATION: String(this.configBootGeneration()),
      GATEWAY_URL: this.deps.getServerUrl(),
      WORKSPACE_ID: this.deps.workspaceId,
    };
    if (process.env["VIBESTUDIO_TEST_MODE"]) {
      env["VIBESTUDIO_TEST_MODE"] = process.env["VIBESTUDIO_TEST_MODE"];
    }
    forwardDiagnosticEnv(env);
    if (this.port) env["WORKERD_URL"] = `http://127.0.0.1:${this.port}`;
    const gatewayAliases = this.deps.getServerAliasUrls?.() ?? [];
    if (gatewayAliases.length > 0) {
      env["GATEWAY_URL_ALIASES"] = JSON.stringify(gatewayAliases);
    }
    if (objectBuild?.stateArgs && Object.keys(objectBuild.stateArgs).length > 0) {
      env["STATE_ARGS"] = objectBuild.stateArgs;
    }

    return {
      compatibilityDate: "2025-12-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules,
      ...(Object.keys(wasmModules).length > 0 ? { wasmModules } : {}),
      env,
    };
  }

  /** Register a userland DO class's identity (`source:className`) for attributed
   *  egress through the shared listener. The UniversalDO host stamps this id. */
  private registerDoEgressCaller(
    source: string,
    className: string,
    image: RuntimeImageRecord,
    objectKey?: string
  ): void {
    const classIdentity = `${source}:${className}`;
    const identity = objectKey ? `do:${source}:${className}:${objectKey}` : classIdentity;
    const caller = createVerifiedCaller(identity, objectKey ? "do" : "worker", {
      callerId: identity,
      callerKind: objectKey ? "do" : "worker",
      repoPath: source,
      effectiveVersion: image.artifact.sourceState.effectiveVersion,
      executionDigest: image.artifact.executionDigest,
      requested: image.authority.requests,
    });
    this.deps.registerEgressCaller(identity, caller);
  }

  // =========================================================================
  // Config generation
  // =========================================================================

  private async generateConfig(): Promise<object> {
    const services: object[] = [];

    // Collect DO service names that have been emitted (to avoid duplicating in regular loop)
    const doServiceNames = new Set<string>();

    // ── Internal DO services (one workerd service per source:className) ──
    // Userland DO classes do NOT get per-class services — they load
    // dynamically into the static `universal-do` facet host (built below), so a
    // new userland DO class needs no config change and no workerd restart.
    // Internal DOs (WorkspaceDO, EvalDO, …) stay static (foundational).
    for (const [serviceKey, doService] of this.doServices) {
      if (!isInternalDOSource(doService.source)) continue;
      const { className } = doService;
      const builtin = productBuiltinByIdentity(doService.source, className);
      if (!builtin) {
        throw new Error(`Internal Durable Object ${className} has no builtin catalog entry`);
      }
      // Internal DOs ship as a single pre-built bundle (no wasm artifacts).
      const internalBundle = this.internalDOBundle();
      const bundleContent = internalBundle.bundle;
      doService.buildKey = internalBundle.buildKey;

      doServiceNames.add(doService.serviceName);

      // Service-level auth token — shared by all DO instances of this source:className.
      // Created once when the service is first built, revoked only when the last instance is destroyed.
      // NOT tied to any individual instance's lifecycle.
      //
      // NOTE: `do-service:*` here is a WORKERD-SIDE bearer-token key, NOT an
      // entity id. There is no `entities` row for it; the runtime-entity
      // model only tracks concrete DO instances (`do:<source>:<cls>:<key>`).
      // Don't grep this string expecting to find a registered principal.
      const serviceCallerId = `do-service:${serviceKey}`;
      const serviceToken = this.ensureWorkerBearer(serviceCallerId);
      const serviceIdentity = internalDOExecutionIdentity(internalBundle, className);

      const serviceCaller = createVerifiedCaller(serviceCallerId, "worker", {
        callerId: serviceCallerId,
        callerKind: "worker",
        repoPath: serviceIdentity.source,
        effectiveVersion: serviceIdentity.effectiveVersion,
        executionDigest: serviceIdentity.executionDigest,
        requested: serviceIdentity.authority.requests,
      });
      const bindings: object[] = [
        { name: "RPC_AUTH_TOKEN", text: serviceToken },
        // Source-scoped class identity
        { name: "WORKER_SOURCE", text: doService.source },
        { name: "WORKER_CLASS_NAME", text: className },
        // Session ID for restart detection (changes on each WorkerdManager lifetime)
        { name: "WORKERD_SESSION_ID", text: this.sessionId },
        { name: "WORKERD_BOOT_GENERATION", text: String(this.configBootGeneration()) },
      ];

      if (builtin.workerd.injectWorkspaceId) {
        bindings.push({ name: "WORKSPACE_ID", text: this.deps.workspaceId });
      }

      // Gateway URL for RPC bridge (DOs use HttpRpcBridge via POST /rpc)
      bindings.push({ name: "GATEWAY_URL", text: this.deps.getServerUrl() });
      const gatewayAliases = this.deps.getServerAliasUrls?.() ?? [];
      if (gatewayAliases.length > 0) {
        bindings.push({ name: "GATEWAY_URL_ALIASES", json: JSON.stringify(gatewayAliases) });
      }

      // Manifest-declared provider bindings for this internal DO class
      // (meta/vibestudio.yml `providers.*` → e.g. EVAL_ENGINE_SOURCE for EvalDO). Injected here so internal
      // DOs consume workspace unit identities only through the manifest.
      const internalEnv = this.requireWorkspaceProvider(
        `internal Durable Object environment for ${className}`
      ).getInternalDoEnv(className);
      for (const [name, text] of Object.entries(internalEnv)) {
        bindings.push({ name, text });
      }

      // EvalDO runs sandboxed agent code and needs the workerd UnsafeEval API
      // (`new Function` is blocked in workerd isolates). `--experimental` is already
      // passed at spawn. `unsafeEval` is a Void union member in workerd's schema, so
      // it must render as `unsafeEval = void` — `null` triggers that in capnpValue
      // (an empty struct `{}` would emit `()`, which workerd rejects: "expected Void").
      if (builtin.workerd.unsafeEval) {
        bindings.push({ name: "UNSAFE_EVAL", unsafeEval: null });
      }

      // DO storage: create a disk service and reference it by name
      const diskServiceName = `${doService.serviceName}_disk`;
      const doStoragePath = stateLayout(this.deps.statePath).databases.workerdDoDir;
      fs.mkdirSync(doStoragePath, { recursive: true });

      const networkServiceName = `${doService.serviceName}_network`;
      const proxyPort = await this.deps.getProxyPort(serviceCaller);
      if (!proxyPort) {
        throw new Error("Egress proxy port not available");
      }

      const workerDef: Record<string, unknown> = {
        modules: [{ name: "worker.js", esModule: bundleContent }],
        bindings,
        compatibilityDate: "2025-12-01",
        // `nodejs_compat` gives worker DOs the Node-compatible subset workerd
        // ships (buffer, util, events, etc.). Build V2 admits registry
        // dependency closures against this one generic worker target.
        compatibilityFlags: ["nodejs_compat"],
        globalOutbound: networkServiceName,
        durableObjectNamespaces: [
          {
            className,
            uniqueKey: `${doService.source.replace(/\//g, "_")}:${className}`,
            enableSql: true,
          },
        ],
        durableObjectStorage: {
          localDisk: diskServiceName,
        },
      };

      services.push({ name: doService.serviceName, worker: workerDef });
      services.push({ name: diskServiceName, disk: { path: doStoragePath, writable: true } });
      services.push({
        name: networkServiceName,
        external: {
          address: `127.0.0.1:${proxyPort}`,
          http: { forwardedProtoHeader: "X-Forwarded-Proto" },
        },
      });
    }

    // Regular (non-durable) workers are NOT services anymore. They load
    // dynamically into the static `worker-host` service (built below) via
    // `env.LOADER`, so worker create/update/destroy never regenerates config
    // or restarts workerd. Per-instance code+env is served by `/_workercode`.

    // Collect DO class info for router generation (only those whose service was successfully built).
    // Each entry carries both the actual className (for workerd namespace binding) and the source
    // (for the /_w/ lookup key, so same-named classes from different sources don't collide).
    const doClassNames = Array.from(this.doServices.entries())
      .filter(([, svc]) => doServiceNames.has(svc.serviceName))
      .map(([, svc]) => ({
        className: svc.className,
        source: svc.source,
        serviceName: svc.serviceName,
      }));

    // Auto-generate router worker + the static dynamic-worker host.
    const hasUserlandDOs =
      this.schemaProbeBuilds.size > 0 ||
      Array.from(this.doServices.values()).some((svc) => !isInternalDOSource(svc.source));
    const hasAnyService = this.instances.size > 0 || doClassNames.length > 0 || hasUserlandDOs;
    if (hasAnyService) {
      // ── Static `worker-host` service: loads regular workers dynamically ──
      // Always present whenever workerd runs, so worker create/destroy never
      // restarts. Reached via the router's WORKER_HOST service binding.
      const gatewayHost = new URL(this.deps.getServerUrl()).host;
      const sharedEgressPort = await this.deps.getSharedEgressPort();
      services.push({
        name: "worker-host",
        worker: {
          modules: [{ name: "host.js", esModule: this.deps.workerdPrograms.workerHost }],
          // `experimental` is required for `env.LOADER` (workerLoader) and
          // `ctx.exports`. The host MUST carry it; loaded workers must NOT.
          compatibilityFlags: ["nodejs_compat", "experimental"],
          compatibilityDate: "2025-12-01",
          bindings: [
            { name: "LOADER", workerLoader: { id: "workers" } },
            { name: "GATEWAY", service: { name: "worker-host-gateway" } },
            { name: "EGRESS", service: { name: "worker-host-egress" } },
            { name: "WORKERD_LOADER_SECRET", text: this.loaderSecret },
            { name: "WORKERD_EGRESS_SECRET", text: this.egressSecret },
          ],
        },
      });
      services.push({
        name: "worker-host-gateway",
        external: { address: gatewayHost, http: {} },
      });
      services.push({
        name: "worker-host-egress",
        external: {
          address: `127.0.0.1:${sharedEgressPort}`,
          http: { forwardedProtoHeader: "X-Forwarded-Proto" },
        },
      });

      // ── Static `universal-do` service: hosts ALL userland DO classes as
      // durable facets, loaded dynamically via `env.LOADER`. A new userland DO
      // class needs no config change and no workerd restart — just `/_docode`.
      // Reuses the worker-host gateway + egress external services.
      const universalDoStoragePath = stateLayout(this.deps.statePath).databases
        .workerdUniversalDoDir;
      fs.mkdirSync(universalDoStoragePath, { recursive: true });
      services.push({
        name: "universal-do",
        worker: {
          modules: [{ name: "udo.js", esModule: this.deps.workerdPrograms.universalDo }],
          compatibilityFlags: ["nodejs_compat", "experimental"],
          compatibilityDate: "2025-12-01",
          bindings: [
            { name: "LOADER", workerLoader: { id: "userland-dos" } },
            { name: "GATEWAY", service: { name: "worker-host-gateway" } },
            { name: "EGRESS", service: { name: "worker-host-egress" } },
            { name: "WORKERD_LOADER_SECRET", text: this.loaderSecret },
            { name: "WORKERD_EGRESS_SECRET", text: this.egressSecret },
          ],
          durableObjectNamespaces: [
            { className: "UniversalDO", uniqueKey: UNIVERSAL_DO_UNIQUE_KEY, enableSql: true },
          ],
          durableObjectStorage: { localDisk: "universal-do-disk" },
        },
      });
      services.push({
        name: "universal-do-disk",
        disk: { path: universalDoStoragePath, writable: true },
      });

      const routerBindings: object[] = [
        { name: "WORKER_HOST", service: { name: "worker-host" } },
        {
          name: "UNIVERSAL_DO",
          durableObjectNamespace: { className: "UniversalDO", serviceName: "universal-do" },
        },
      ];
      const doBindingNames: Record<string, string> = {};

      // Add DO namespace bindings for the router (durableObjectNamespace, not service).
      // Binding names are source-scoped to match the generated router lookup.
      for (const { className, source, serviceName } of doClassNames) {
        const bindingName = `do_${source.replace(/[^a-zA-Z0-9_]/g, "_")}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        doBindingNames[`${source}:${className}`] = bindingName;
        routerBindings.push({
          name: bindingName,
          durableObjectNamespace: { className, serviceName },
        });
      }

      routerBindings.push({
        name: "WORKERD_DO_BINDINGS",
        json: JSON.stringify(doBindingNames),
      });
      routerBindings.push({
        name: "WORKERD_GATEWAY_TOKEN",
        text: this.deps.getWorkerdGatewayToken(),
      });
      routerBindings.push({
        name: "WORKERD_DISPATCH_SECRET",
        text: this.dispatchSecret,
      });

      services.push({
        name: "router",
        worker: {
          modules: [{ name: "router.js", esModule: this.deps.workerdPrograms.router }],
          bindings: routerBindings,
          compatibilityDate: "2024-01-01",
        },
      });
    }

    // Find a port
    if (!this.port) {
      const { findServicePort } = await import("./hostCore/portUtils.js");
      this.port = await findServicePort("workerd");
    }

    // Inject WORKERD_URL into DO services (needs port to be resolved)
    for (const svc of services) {
      const worker = (svc as Record<string, unknown>)["worker"] as
        | Record<string, unknown>
        | undefined;
      if (worker?.["durableObjectNamespaces"]) {
        (worker["bindings"] as object[]).push({
          name: "WORKERD_URL",
          text: `http://127.0.0.1:${this.port}`,
        });
      }
    }

    return {
      services,
      sockets: hasAnyService
        ? [
            {
              name: "http",
              address: `127.0.0.1:${this.port}`,
              http: {},
              service: { name: "router" },
            },
          ]
        : [],
    };
  }

  // =========================================================================
  // Cap'n Proto text config generation
  // =========================================================================

  /**
   * Convert the JSON config object to Cap'n Proto text format.
   * Workerd's JSON config was removed; the native format is capnp text.
   * Bundle code is written to separate files and referenced via `embed`.
   */
  private toCapnpText(config: Record<string, unknown>): string {
    this.bundleFileCounter = 0;
    this.pendingConfigWrites = [];
    const body = this.capnpValue(config, 1);
    return `using Workerd = import "/workerd/workerd.capnp";\n\nconst config :Workerd.Config = ${body};\n`;
  }

  /**
   * Flush bundle/wasm files collected during `toCapnpText` to disk asynchronously.
   * (Serialization stays sync for the recursion; the heavy IO is async so it
   * never blocks the relay event loop during a (re)start.)
   */
  private async flushConfigWrites(): Promise<void> {
    const writes = this.pendingConfigWrites;
    this.pendingConfigWrites = [];
    await Promise.all(
      writes.map((w) => fs.promises.writeFile(path.join(this.configDir, w.filename), w.content))
    );
  }

  private bundleFileCounter = 0;
  private pendingConfigWrites: Array<{ filename: string; content: string | Buffer }> = [];

  private capnpValue(value: unknown, depth: number): string {
    if (value === null || value === undefined) return "void";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    if (typeof value === "string") {
      // Escape for Cap'n Proto text strings (same as JSON string escaping)
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const indent = "  ".repeat(depth);
      const items = value.map((v) => `${indent}${this.capnpValue(v, depth + 1)},`);
      return `[\n${items.join("\n")}\n${"  ".repeat(depth - 1)}]`;
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const entries = Object.entries(obj);
      if (entries.length === 0) return "()";

      const indent = "  ".repeat(depth);
      const fields = entries.map(([k, v]) => {
        // esModule bundles: collect for async flush, reference via embed.
        if (k === "esModule" && typeof v === "string") {
          const filename = `bundle-${this.bundleFileCounter++}.js`;
          this.pendingConfigWrites.push({ filename, content: v });
          return `${indent}${k} = embed "${filename}",`;
        }
        // wasm module bindings: value is base64; decode to binary + embed.
        if (k === "wasm" && typeof v === "string") {
          const filename = `module-${this.bundleFileCounter++}.wasm`;
          this.pendingConfigWrites.push({ filename, content: Buffer.from(v, "base64") });
          return `${indent}${k} = embed "${filename}",`;
        }
        return `${indent}${k} = ${this.capnpValue(v, depth + 1)},`;
      });
      return `(\n${fields.join("\n")}\n${"  ".repeat(depth - 1)})`;
    }

    return String(value);
  }

  // =========================================================================
  // Process lifecycle
  // =========================================================================

  /**
   * Coalesced generation transition. Concurrent callers share one in-flight
   * run; a config change made during a run triggers at most one follow-up.
   * A run's failure propagates only to callers whose epoch that run actually
   * covered — waiters whose request was never attempted survive it and get
   * their own attempt (so a queued crash recovery is never lost to another
   * caller's failed restart).
   */
  private restartWorkerd(request: WorkerdRestartRequest = { kind: "planned" }): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("WorkerdManager is shutting down"));
    }
    const myEpoch = ++this.requestedEpoch;
    this.restartRequests.set(myEpoch, request);
    // Preemption rule: crash recovery must never queue behind a hung graceful
    // prepare. Prep is advisory — the process is being replaced either way.
    if (request.kind === "crash") this.preemptPreparingTransition(request.reason);
    return this.ensureRestartAtLeast(myEpoch);
  }

  private preemptPreparingTransition(reason: string): void {
    const transition = this.activeTransition;
    if (
      transition &&
      (transition.kind === "planned" || transition.kind === "stop") &&
      transition.state === "preparing"
    ) {
      transition.prepAbort.abort(
        new Error(`crash recovery preempted graceful workerd prepare: ${reason}`)
      );
    }
  }

  private async ensureRestartAtLeast(epoch: number): Promise<void> {
    while (this.appliedEpoch < epoch) {
      if (this.shuttingDown) return;
      const running = this.activeTransition;
      if (running) {
        // Never inherit another run's rejection unguarded: only a run that
        // actually covered this epoch owes this caller its failure.
        await running.promise.catch(() => {});
        if (running.failed && running.covered >= epoch) throw running.error;
        continue;
      }
      const transition = this.startGenerationTransition();
      await transition.promise.catch(() => {});
      if (transition.failed && transition.covered >= epoch) throw transition.error;
    }
  }

  /**
   * Become the generation-transition owner. Consumes queued restart requests
   * (they are deleted regardless of outcome — a failed run must not leak them
   * into misclassifying the next planned restart as a crash), classifies the
   * run (crash > planned > stop-if-idle), and starts the owner run.
   */
  private startGenerationTransition(): GenerationTransition {
    const requests = this.consumeQueuedRequests();
    const crash = [...requests].reverse().find((request) => request.kind === "crash");
    const hasPlanned = requests.some((request) => request.kind === "planned");
    const stop = [...requests]
      .reverse()
      .find((request): request is { kind: "stop"; reason: string } => request.kind === "stop");
    const onlyStopIfIdle =
      requests.length > 0 && requests.every((request) => request.kind === "stop-if-idle");
    // Severity order: crash > planned > stop > stop-if-idle. A planned restart
    // queued alongside a stop wins — the maintenance caller's file-lock
    // verification, not the process state, is its correctness arbiter.
    const transition: GenerationTransition = {
      correlationId: crypto.randomUUID(),
      kind: crash
        ? "crash"
        : hasPlanned
          ? "planned"
          : stop
            ? "stop"
            : onlyStopIfIdle
              ? "stop-if-idle"
              : "planned",
      state: "preparing",
      reason: crash
        ? crash.reason
        : hasPlanned
          ? "planned-restart"
          : stop
            ? stop.reason
            : onlyStopIfIdle
              ? "idle"
              : "planned-restart",
      alreadyExited: crash?.alreadyExited ?? false,
      prepAbort: new AbortController(),
      covered: this.requestedEpoch,
      failed: false,
      error: undefined,
      promise: Promise.resolve(),
    };
    this.activeTransition = transition;
    transition.promise = (async () => {
      try {
        await this._runGenerationTransition(transition);
        // Success applies every epoch the run consumed, including any absorbed
        // at the stopping-step re-drain after a crash preemption.
        this.appliedEpoch = Math.max(this.appliedEpoch, transition.covered);
      } catch (err) {
        transition.failed = true;
        transition.error = err;
        throw err;
      } finally {
        if (this.activeTransition === transition) this.activeTransition = null;
      }
    })();
    // The owner loop and every waiter attach their own catch; keep the raw
    // promise from surfacing as an unhandled rejection in the interim.
    transition.promise.catch(() => {});
    return transition;
  }

  /** Drain queued requests up to the current requested epoch (per-attempt). */
  private consumeQueuedRequests(): WorkerdRestartRequest[] {
    const applying = this.requestedEpoch;
    const consumed: WorkerdRestartRequest[] = [];
    for (const [requestEpoch, request] of [...this.restartRequests.entries()].sort(
      ([a], [b]) => a - b
    )) {
      if (requestEpoch > applying) continue;
      consumed.push(request);
      this.restartRequests.delete(requestEpoch);
    }
    return consumed;
  }

  /**
   * The one owner run: preparing → stopping → reaping → starting. No process
   * stop or start happens outside this method (and terminal `shutdown()`,
   * which first closes admission and quiesces the owner).
   */
  private async _runGenerationTransition(transition: GenerationTransition): Promise<void> {
    if (this.shuttingDown) return;
    const previousGeneration = this.bootGeneration === 0 ? null : this.bootGeneration;
    const nextGeneration = this.bootGeneration + 1;
    const hadRunningProcess = this.process !== null;

    // ── stop-if-idle: a pure stop transition; re-check idleness under the
    // owner (an instance/DO registered while queued wins — no stop).
    if (transition.kind === "stop-if-idle") {
      if (this.instances.size > 0 || this.doServices.size > 0 || this.schemaProbeBuilds.size > 0)
        return;
      transition.state = "stopping";
      if (hadRunningProcess) {
        await this.emitGenerationClosing({
          correlationId: transition.correlationId,
          generation: nextGeneration,
          reason: "idle",
        });
      }
      await this.stopWorkerd("idle");
      this.clearRetiredDynamicIsolatePressure();
      return;
    }

    // ── preparing (planned/stop; prep hooks may dispatch into workerd) ──
    let prepDegraded = false;
    if ((transition.kind === "planned" || transition.kind === "stop") && hadRunningProcess) {
      transition.state = "preparing";
      const outcome = await this.emitRestartBegin(
        {
          correlationId: transition.correlationId,
          generation: nextGeneration,
          reason: "planned",
          signal: transition.prepAbort.signal,
        },
        transition.prepAbort.signal
      );
      if (outcome === "failed") {
        // A failed/timed-out graceful prepare must not abort the restart: the
        // process replacement proceeds crash-style and listeners reconcile
        // runtime leases from durable state on the crash-ready event.
        prepDegraded = true;
        log.warn(
          "workerd graceful prepare failed or timed out; proceeding crash-style so the " +
            "generation transition still reaches the process boundary"
        );
      }
      // "aborted" needs no handling here: the crash request that fired the
      // abort is absorbed at the re-drain below and escalates the run.
    }

    // Absorb requests queued during prep. A crash request escalates the run
    // in place — this is how preemption completes inside the state machine.
    const lateCrash = [...this.consumeQueuedRequests()]
      .reverse()
      .find((request) => request.kind === "crash");
    if (lateCrash) {
      transition.kind = "crash";
      transition.reason = lateCrash.reason;
      transition.alreadyExited ||= lateCrash.alreadyExited;
    }
    transition.covered = Math.max(transition.covered, this.requestedEpoch);
    const crashStyle = transition.kind === "crash" || prepDegraded;

    // ── stopping: close the old generation in-process, then stop it ──
    transition.state = "stopping";
    if (hadRunningProcess || transition.kind === "crash") {
      await this.emitGenerationClosing({
        correlationId: transition.correlationId,
        generation: nextGeneration,
        reason: crashStyle ? "crash" : "planned",
      });
    }
    if (transition.kind === "crash" && transition.alreadyExited) {
      await destroyWorkerdConnections(`workerd process generation crashed: ${transition.reason}`);
    }
    transition.state = "reaping";
    await this.stopWorkerd(
      transition.kind === "crash"
        ? `unresponsive-sandbox:${transition.reason}`
        : transition.kind === "stop"
          ? transition.reason
          : "planned-restart"
    );
    this.clearRetiredDynamicIsolatePressure();

    if (this.shuttingDown) return;

    // ── stop: the caller wants the process boundary, not a replacement.
    // ensureWorkerdRunning restarts lazily on the next dispatch. Entities the
    // prepare released are resumed only by a restart-ready event, so a stop
    // taken with live services obligates the NEXT successful start to emit a
    // crash-style ready (reconstruct leases from durable state).
    if (transition.kind === "stop") {
      if (hadRunningProcess) this.resumeLifecycleAfterStop = true;
      return;
    }

    if (
      this.instances.size === 0 &&
      this.doServices.size === 0 &&
      this.schemaProbeBuilds.size === 0
    )
      return;

    // ── starting ──
    transition.state = "starting";
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.shuttingDown) return;
      try {
        this.pendingBootGeneration = nextGeneration;
        await this.startWorkerdOnce();
        if (this.shuttingDown) {
          this.pendingBootGeneration = null;
          await this.stopWorkerd("shutdown-during-restart");
          return;
        }
        this.bootGeneration = nextGeneration;
        this.pendingBootGeneration = null;
        this.writeBootGeneration(this.bootGeneration);
        const owedStopRecovery = this.resumeLifecycleAfterStop;
        this.resumeLifecycleAfterStop = false;
        if (crashStyle || hadRunningProcess || owedStopRecovery) {
          await this.emitRestartReady({
            correlationId: transition.correlationId,
            generation: this.bootGeneration,
            previousGeneration,
            // A start owing stop recovery has no prepared epoch of its own:
            // crash-style ready is the durable-state reconstruction path.
            reason: crashStyle || owedStopRecovery ? "crash" : "planned",
          });
        }
        return;
      } catch (err) {
        lastError = err;
        this.pendingBootGeneration = null;
        if (this.shuttingDown) {
          await this.stopWorkerd("shutdown-during-restart");
          return;
        }
        const detail = this.formatWorkerdStartupError(err);
        if (attempt < 3) {
          log.warn(
            `workerd startup attempt ${attempt} did not become ready; retrying with a fresh port. ${detail}`
          );
        } else {
          log.warn(`workerd startup attempt ${attempt} failed. ${detail}`);
        }
        await this.stopWorkerd("startup-retry");
      }
    }

    throw lastError instanceof Error ? lastError : new Error("workerd failed to start");
  }

  private configBootGeneration(): number {
    return this.pendingBootGeneration ?? this.bootGeneration;
  }

  private readBootGeneration(): number {
    try {
      const text = fs.readFileSync(this.bootGenerationFile, "utf8").trim();
      const parsed = Number.parseInt(text, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Failed to read workerd boot generation:", err);
      }
      return 0;
    }
  }

  private writeBootGeneration(generation: number): void {
    fs.mkdirSync(path.dirname(this.bootGenerationFile), { recursive: true });
    fs.writeFileSync(this.bootGenerationFile, `${generation}\n`);
  }

  /**
   * Run graceful-prepare hooks for a planned transition. Returns "aborted"
   * the moment `signal` fires (crash preemption — remaining hooks are skipped
   * and in-flight ones are abandoned with their rejections swallowed),
   * "failed" when any hook failed, "ok" otherwise. Never throws: prepare is
   * advisory and must not be able to abort the transition.
   */
  private async emitRestartBegin(
    event: RestartBeginEvent,
    signal: AbortSignal
  ): Promise<"ok" | "failed" | "aborted"> {
    let failed = false;
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    for (const hook of this.restartBeginHooks) {
      if (signal.aborted) return "aborted";
      const hookRun = (async () => {
        await hook(event);
        return "hook-done" as const;
      })().catch((err: unknown) => {
        log.warn("restart begin hook failed:", err);
        failed = true;
        return "hook-done" as const;
      });
      const winner = await Promise.race([hookRun, aborted]);
      if (winner === "aborted") return "aborted";
    }
    return failed ? "failed" : "ok";
  }

  /** In-process only; hook failures are logged, never propagated. */
  private async emitGenerationClosing(event: GenerationClosingEvent): Promise<void> {
    for (const hook of this.generationClosingHooks) {
      try {
        await hook(event);
      } catch (err) {
        log.warn("generation closing hook failed:", err);
      }
    }
  }

  private async emitRestartReady(event: RestartReadyEvent): Promise<void> {
    for (const hook of this.restartReadyHooks) {
      try {
        await hook(event);
      } catch (err) {
        log.warn("restart ready hook failed:", err);
      }
    }
  }

  private async startWorkerdOnce(): Promise<void> {
    if (this.shuttingDown) throw new Error("WorkerdManager is shutting down");
    const config = await this.generateConfig();
    if (this.shuttingDown) throw new Error("WorkerdManager is shutting down");
    const configPath = path.join(this.configDir, "config.capnp");
    const capnpText = this.toCapnpText(config as Record<string, unknown>);
    await this.flushConfigWrites();
    await fs.promises.writeFile(configPath, capnpText);
    if (this.shuttingDown) throw new Error("WorkerdManager is shutting down");

    const binary = this.findWorkerdBinary();
    if (!this.inspectorPort && workerdInspectorEnabled()) {
      const { findServicePort } = await import("./hostCore/portUtils.js");
      this.inspectorPort = await findServicePort("workerdInspector");
    }
    const args = [
      "serve",
      // Required: the static worker-host uses `workerLoader` (env.LOADER) and
      // `ctx.exports`, both gated behind workerd's experimental features.
      "--experimental",
      ...(this.inspectorPort ? [`--inspector-addr=127.0.0.1:${this.inspectorPort}`] : []),
      configPath,
    ];

    this.process = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    const spawnedProcess = this.process;
    const spawnedPid = spawnedProcess.pid;
    this.workerdStartedAtMs = Date.now();
    this.lastWorkerdRssBytes = null;
    this.startWorkerdMemorySampling(spawnedPid);
    this.lastWorkerdStartupOutput = [];

    spawnedProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this.rememberWorkerdStartupOutput(`stdout: ${line}`);
        log.verbose(`[workerd] ${line}`);
      }
    });

    spawnedProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this.rememberWorkerdStartupOutput(`stderr: ${line}`);
        log.warn(`[workerd] ${line}`);
      }
    });

    // Wait for startup readiness, detecting early failures (ENOENT, bind
    // conflicts, crashes, etc.). A surviving process is not enough: workerd
    // may print a fatal bind error and exit just after spawn, and DO dispatch
    // must not race ahead until the router accepts HTTP.
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onExit = (code: number | null, signal: string | null) => {
        this.logWorkerdExit(code, signal, spawnedPid);
        if (this.process === spawnedProcess) this.process = null;
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `workerd exited before accepting HTTP (code=${code}, signal=${signal})${this.recentWorkerdOutputSuffix()}`
            )
          );
        }
      };

      const onError = (err: Error) => {
        log.error("workerd process error:", err);
        if (this.process === spawnedProcess) this.process = null;
        if (!settled) {
          settled = true;
          reject(new Error(`workerd failed to start: ${err.message}`));
        }
      };

      spawnedProcess.on("exit", onExit);
      spawnedProcess.on("error", onError);

      this.waitForHttpReady(
        this.deps.workerdStartupReadyTimeoutMs ?? DEFAULT_WORKERD_STARTUP_READY_TIMEOUT_MS
      ).then(
        () => {
          if (settled) return;
          settled = true;
          // Keep the exit/error handlers for ongoing monitoring, but replace
          // them with non-rejecting versions since the promise is settled.
          spawnedProcess.removeListener("exit", onExit);
          spawnedProcess.removeListener("error", onError);
          spawnedProcess.on("exit", (code, signal) => {
            this.logWorkerdExit(code, signal, spawnedPid);
            const wasCurrent = this.process === spawnedProcess;
            if (wasCurrent) this.process = null;
            if (wasCurrent && !this.shuttingDown) {
              void this.recoverExitedSandbox(
                `unexpected exit (code=${code}, signal=${signal})`
              ).catch((err) => {
                log.error("failed to recover unexpectedly exited workerd:", err);
              });
            }
          });
          spawnedProcess.on("error", (err) => {
            log.error("workerd process error:", err);
            if (this.process === spawnedProcess) this.process = null;
          });
          resolve();
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              `${errorMessage(err)}. binary=${binary} port=${this.port} config=${configPath}${this.recentWorkerdOutputSuffix()}`
            )
          );
        }
      );
    });

    log.info(`workerd started on port ${this.port} with ${this.instances.size} worker(s)`);
  }

  private startWorkerdMemorySampling(pid: number | undefined): void {
    if (this.workerdMemorySampleTimer) {
      clearInterval(this.workerdMemorySampleTimer);
      this.workerdMemorySampleTimer = null;
    }
    this.workerdRssSamples = [];
    this.workerdMemorySamplePid = pid ?? null;
    if (!pid || process.platform !== "linux") return;
    const recordSample = (): void => {
      const rss = this.readProcessRssBytes(pid);
      if (rss === null) return;
      this.lastWorkerdRssBytes = rss;
      this.workerdRssSamples.push({ at: Date.now(), rssBytes: rss });
      if (this.workerdRssSamples.length > 120) this.workerdRssSamples.shift();
      this.maybeCompactRetiredDynamicIsolates(rss);
    };
    recordSample();
    this.workerdMemorySampleTimer = setInterval(() => {
      recordSample();
    }, 5_000);
    this.workerdMemorySampleTimer.unref?.();
  }

  private maybeCompactRetiredDynamicIsolates(rssBytes: number | null): void {
    const retiredGeneration = this.retiredDynamicIsolateGeneration;
    if (
      retiredGeneration === null ||
      (this.retiredDynamicIsolateIds.size < WORKERD_DYNAMIC_ISOLATE_COMPACTION_COUNT &&
        (rssBytes === null || rssBytes < WORKERD_DYNAMIC_ISOLATE_COMPACTION_RSS_BYTES)) ||
      this.dynamicIsolateCompactionFlight ||
      this.shuttingDown ||
      !this.process ||
      this.process.exitCode !== null ||
      this.hasLiveUserlandExecutions()
    ) {
      return;
    }
    const flight = this.restartWorkerd();
    this.dynamicIsolateCompactionFlight = flight;
    void flight
      .then(() => {
        log.info(
          `Compacted workerd generation containing retired dynamic isolates` +
            (rssBytes === null ? "" : ` at ${Math.round(rssBytes / (1024 * 1024))} MiB RSS`)
        );
      })
      .catch((error) => {
        log.warn("workerd dynamic-isolate compaction failed", error);
      })
      .finally(() => {
        if (this.dynamicIsolateCompactionFlight === flight) {
          this.dynamicIsolateCompactionFlight = null;
        }
      });
  }

  private clearRetiredDynamicIsolatePressure(): void {
    this.retiredDynamicIsolateGeneration = null;
    this.retiredDynamicIsolateIds.clear();
  }

  private hasLiveUserlandExecutions(): boolean {
    // Class-level runtime images remain registered so a future object can be
    // created without rebuilding; they are not live executions. Only actual
    // worker instances and object-specific DO bindings make a process restart
    // user-visible.
    return this.instances.size > 0 || this.doObjectBuilds.size > 0;
  }

  private stopWorkerdMemorySampling(): void {
    if (this.workerdMemorySampleTimer) {
      clearInterval(this.workerdMemorySampleTimer);
      this.workerdMemorySampleTimer = null;
    }
    this.workerdMemorySamplePid = null;
  }

  private readProcessRssBytes(pid: number): number | null {
    if (process.platform !== "linux") return null;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      return match ? Number(match[1]) * 1024 : null;
    } catch {
      return null;
    }
  }

  private logWorkerdExit(
    code: number | null,
    signal: string | null,
    pid: number | undefined
  ): void {
    log.info(
      `workerd exited (code=${code}, signal=${signal}); diagnostics=${JSON.stringify(
        this.workerdDiagnostics(pid)
      )}`
    );
    if (pid === this.workerdMemorySamplePid) this.stopWorkerdMemorySampling();
  }

  private workerdDiagnostics(pid: number | undefined): WorkerdPerformanceSnapshot {
    const currentRssBytes = pid ? this.readProcessRssBytes(pid) : null;
    const ownsSamples = pid !== undefined && pid === this.workerdMemorySamplePid;
    if (currentRssBytes !== null && ownsSamples) {
      this.lastWorkerdRssBytes = currentRssBytes;
      const latest = this.workerdRssSamples.at(-1);
      if (!latest || latest.rssBytes !== currentRssBytes) {
        this.workerdRssSamples.push({ at: Date.now(), rssBytes: currentRssBytes });
        if (this.workerdRssSamples.length > 120) this.workerdRssSamples.shift();
      }
    }
    const samples = ownsSamples ? this.workerdRssSamples : [];
    const firstRss = samples[0];
    const lastRss = samples.at(-1);
    return {
      pid: pid ?? null,
      port: this.port,
      uptimeMs:
        ownsSamples && this.workerdStartedAtMs ? Date.now() - this.workerdStartedAtMs : null,
      rssBytes: currentRssBytes,
      lastRssBytes: ownsSamples ? this.lastWorkerdRssBytes : currentRssBytes,
      rssSampleCount: samples.length,
      rssPeakBytes:
        samples.length > 0 ? Math.max(...samples.map((sample) => sample.rssBytes)) : null,
      rssGrowthBytes: firstRss && lastRss ? lastRss.rssBytes - firstRss.rssBytes : null,
      rssWindowMs: firstRss && lastRss ? lastRss.at - firstRss.at : null,
      regularWorkers: this.instances.size,
      doServices: this.doServices.size,
      doObjectBuilds: this.doObjectBuilds.size,
      runtimeImages: this.runtimeImages.list().length,
      sealedDoImages: this.sealedDoImages.size,
      runtimeImageRebinds: this.runtimeImageRebinds.size,
      bootGeneration: this.bootGeneration,
      pendingBootGeneration: this.pendingBootGeneration,
    };
  }

  /** Bounded, read-only resource/occupancy snapshot for userland profilers. */
  performanceSnapshot(): WorkerdPerformanceSnapshot {
    return this.workerdDiagnostics(this.process?.pid);
  }

  private rememberWorkerdStartupOutput(line: string): void {
    this.lastWorkerdStartupOutput.push(line);
    if (this.lastWorkerdStartupOutput.length > WORKERD_STARTUP_OUTPUT_LINES) {
      this.lastWorkerdStartupOutput.splice(
        0,
        this.lastWorkerdStartupOutput.length - WORKERD_STARTUP_OUTPUT_LINES
      );
    }
  }

  private recentWorkerdOutputSuffix(): string {
    if (this.lastWorkerdStartupOutput.length === 0) return "";
    return `; recent workerd output:\n${this.lastWorkerdStartupOutput.join("\n")}`;
  }

  private formatWorkerdStartupError(err: unknown): string {
    return errorMessage(err).replace(/\s+/gu, " ").slice(0, 1200);
  }

  private async stopWorkerd(reason = "unspecified"): Promise<void> {
    const proc = this.process;
    this.process = null;
    try {
      if (proc) {
        log.info(
          `stopping workerd (${reason}); diagnostics=${JSON.stringify(
            this.workerdDiagnostics(proc.pid)
          )}`
        );
        await destroyWorkerdConnections(`workerd process generation ended: ${reason}`);
        proc.kill("SIGTERM");
        // Wait for the process to exit so the port is released before respawn.
        // `proc.killed` only reports that a signal was *sent*, not that the
        // process actually died — so track exit observation explicitly.
        let exited = await this.waitForProcessExitEvent(
          proc,
          this.deps.workerdStopTimeoutsMs?.sigtermMs ?? 3000
        );
        if (!exited) {
          // SIGTERM timed out — force reap so the socket can be reclaimed.
          try {
            log.warn(
              `workerd did not exit after SIGTERM (${reason}); sending SIGKILL; diagnostics=${JSON.stringify(
                this.workerdDiagnostics(proc.pid)
              )}`
            );
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          // Confirm the reap from kernel state (kill(pid, 0)) rather than a
          // single libuv event window: a delayed 'exit' event must not fail a
          // reap that actually succeeded.
          exited = await this.waitForProcessReaped(
            proc,
            this.deps.workerdStopTimeoutsMs?.sigkillMs ?? 5000
          );
        }
        if (!exited) {
          // Refusal path: never overlap runtime generations. Watch this exact
          // pid in the background — when the kernel finally reaps it, re-enter
          // the transition owner so the runtime does not stay down forever.
          this.installUnkillableProcessWatch(proc, reason);
          throw new Error(
            `workerd process ${proc.pid ?? "unknown"} did not exit after SIGKILL (${reason}); refusing to overlap runtime generations`
          );
        }
      }
    } finally {
      // Always release the pinned ports — including on the SIGKILL-refusal
      // throw above — so the next transition re-probes via findServicePort.
      // findServicePort skips EADDRINUSE ports, which sidesteps both the
      // kernel-release race and the still-bound unkillable process.
      if (this.port) {
        const { releaseServicePort } = await import("./hostCore/portUtils.js");
        releaseServicePort("workerd", this.port);
      }
      this.port = null;
      if (this.inspectorPort) {
        const { releaseServicePort } = await import("./hostCore/portUtils.js");
        releaseServicePort("workerdInspector", this.inspectorPort);
      }
      this.inspectorPort = null;
    }
  }

  private waitForProcessExitEvent(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        proc.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      proc.once("exit", onExit);
    });
  }

  /**
   * True once the process is gone, judged by kernel state: either the 'exit'
   * event fires or kill(pid, 0) reports ESRCH. Polled, because a single
   * event-loop window can miss a reap that has already happened.
   */
  private async waitForProcessReaped(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    const pid = proc.pid;
    let exitObserved = proc.exitCode !== null || proc.signalCode !== null;
    const onExit = () => {
      exitObserved = true;
    };
    proc.once("exit", onExit);
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (exitObserved) return true;
        if (pid !== undefined && !this.isPidAlive(pid)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      proc.removeListener("exit", onExit);
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH: no such process (reaped). Anything else (e.g. EPERM) means the
      // pid still exists as far as the kernel is concerned.
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /**
   * Background watcher for a process that survived SIGKILL confirmation. The
   * moment its exit is finally observed, re-enter the generation-transition
   * owner with a crash request so recovery is driven by the lifecycle event,
   * not a clock — the runtime must not stay down because one reap was late.
   */
  private installUnkillableProcessWatch(proc: ChildProcess, reason: string): void {
    const pid = proc.pid ?? "unknown";
    proc.once("exit", () => {
      if (this.shuttingDown) return;
      log.warn(`previously unkillable workerd pid ${pid} finally exited; re-entering recovery`);
      void this.restartWorkerd({
        kind: "crash",
        reason: `late exit of unkillable workerd pid ${pid} (${reason})`,
        alreadyExited: true,
      }).catch((err) => {
        log.error("failed to recover after late exit of unkillable workerd:", err);
      });
    });
  }

  /**
   * Register a batch of DO classes. Internal DO classes are static workerd
   * services and trigger a single restart when new. Userland DO classes load
   * through universal-do; startup should prefer route metadata + lazy
   * ensureDORoute unless an explicit prewarm is required.
   */
  async registerAllDOClasses(
    doClasses: Array<{ source: string; className: string }>
  ): Promise<void> {
    let internalAdded = false;
    for (const { source, className } of doClasses) {
      const serviceKey = doServiceKey(source, className);
      if (this.doServices.has(serviceKey)) continue;

      if (!isInternalDOSource(source)) {
        this.requireWorkspaceProvider(`Durable Object class ${source}:${className}`);
      }
      const imageId = `do-service:${serviceKey}`;
      const image = isInternalDOSource(source)
        ? this.persistInternalRuntimeImage(imageId, className)
        : await this.bindRuntimeImage(imageId, source, undefined);
      const buildKey = image.artifact.buildKey;
      const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
      const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      this.doServices.set(serviceKey, {
        buildKey,
        className,
        imageId: image.id,
        serviceName,
        source,
      });
      if (!isInternalDOSource(source)) {
        this.registerRoutesForDoClass(source, className);
        this.registerDoEgressCaller(source, className, image);
      } else {
        internalAdded = true;
      }
    }

    // Only INTERNAL DO classes change the static config (and need a restart);
    // userland classes load on demand into the static universal-do host.
    if (internalAdded) {
      await this.restartWorkerd();
      log.info(`Pre-registered ${this.doServices.size} DO class(es)`);
    }
  }

  /** Register DO-backed routes from a source's manifest for the given class. */
  private registerRoutesForDoClass(source: string, className: string): void {
    if (!this.deps.routeRegistry) return;
    const provider = this.requireWorkspaceProvider("Durable Object route registration");
    const routes = provider.getManifestRoutes(source);
    if (routes.length === 0) return;
    this.deps.routeRegistry.registerDoRoutes(
      source,
      className,
      Array.from(routes),
      provider.singletonRegistry
    );
  }

  reconcileManifestRoutes(sources: Iterable<string>): void {
    const allSources = new Set(sources);
    for (const source of this.deps.routeRegistry?.getWorkerRouteSources() ?? []) {
      allSources.add(source);
    }
    for (const source of allSources) {
      this.reconcileManifestRoutesForSource(source);
    }
  }

  private reconcileManifestRoutesForSource(
    source: string,
    authoritativeDoClasses: Array<{ className: string }> | null = null
  ): void {
    if (!this.deps.routeRegistry) return;
    const provider = this.requireWorkspaceProvider("manifest route reconciliation");

    const liveDoClasses = new Set<string>();
    for (const cls of authoritativeDoClasses ?? provider.getManifestDoClasses(source)) {
      liveDoClasses.add(cls.className);
    }
    for (const svc of this.doServices.values()) {
      if (svc.source === source) liveDoClasses.add(svc.className);
    }

    const canonical = canonicalInstanceNameForSource(source);
    const hasCanonicalInstance =
      this.instances.has(canonical) &&
      assertPresent(this.instances.get(canonical)).source === source;

    this.deps.routeRegistry.reconcileWorkerRoutes(
      source,
      Array.from(provider.getManifestRoutes(source)),
      liveDoClasses,
      hasCanonicalInstance ? canonical : null,
      provider.singletonRegistry
    );
  }

  /**
   * Ensure a DO class is registered and workerd is running. Does NOT bootstrap any instance.
   * Use for infrastructure DOs that don't need DOIdentity.
   */
  async ensureDOClass(
    source: string,
    className: string,
    opts: {
      scopeRef?: string;
      objectKey?: string;
      imageId?: string;
      stateArgs?: unknown;
    } = {}
  ): Promise<string | undefined> {
    if (!isInternalDOSource(source)) {
      this.requireWorkspaceProvider(`Durable Object class ${source}:${className}`);
    }
    const serviceKey = doServiceKey(source, className);
    const isNew = !this.doServices.has(serviceKey);
    let buildKey: string | undefined;
    let image: RuntimeImageRecord | null = null;
    if (isNew) {
      const sourceSegments = source.split("/").filter(Boolean);
      if (!isInternalDOSource(source) && sourceSegments.length !== 2) {
        throw new Error(`DO source path must be exactly 2 segments, got: "${source}"`);
      }
      if (isInternalDOSource(source)) {
        image = this.persistInternalRuntimeImage(`do-service:${serviceKey}`, className);
        buildKey = image.artifact.buildKey;
      } else {
        image = await this.bindRuntimeImage(`do-service:${serviceKey}`, source, opts.scopeRef);
        buildKey = image.artifact.buildKey;
      }
      const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
      const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      this.doServices.set(serviceKey, {
        buildKey,
        className,
        ...(image ? { imageId: image.id } : {}),
        serviceName,
        source,
        scopeRef: image?.scopeRef ?? opts.scopeRef,
      });
      if (!isInternalDOSource(source)) {
        this.registerRoutesForDoClass(source, className);
        this.registerDoEgressCaller(source, className, assertPresent(image));
      }
    }

    const serviceScopeRef =
      image?.scopeRef ?? opts.scopeRef ?? this.doServices.get(serviceKey)?.scopeRef;
    if (!isInternalDOSource(source) && serviceScopeRef && opts.objectKey) {
      const imageId =
        opts.imageId ?? canonicalEntityId({ kind: "do", source, className, key: opts.objectKey });
      image = await this.bindRuntimeImage(imageId, source, serviceScopeRef);
      buildKey = image.artifact.buildKey;
    }

    if (!isInternalDOSource(source) && opts.objectKey) {
      const svc = this.doServices.get(serviceKey);
      const imageId = image?.id ?? svc?.imageId;
      const buildKey = image?.artifact.buildKey ?? svc?.buildKey;
      if (imageId && buildKey) {
        const stateArgs = recordStateArgs(opts.stateArgs);
        this.doObjectBuilds.set(doObjectBuildKey(source, className, opts.objectKey), {
          imageId,
          ...(serviceScopeRef ? { scopeRef: serviceScopeRef } : {}),
          buildKey,
          ...(stateArgs ? { stateArgs } : {}),
        });
      }
    }

    // Userland DO classes load dynamically into the static `universal-do` facet
    // host — registering one needs NO config change and NO restart. Just make
    // sure workerd is up so the host is serving.
    if (!isInternalDOSource(source)) {
      await this.ensureWorkerdRunning();
      return buildKey;
    }

    // Internal DOs are static workerd services: a new one requires a config
    // regeneration + restart (startup-rare, foundational classes only).
    if (isNew) {
      await this.restartWorkerd();
    } else if (!this.process || this.process.exitCode !== null) {
      await this.restartWorkerd();
    }
    // Do NOT probe-and-restart a live workerd (false positives killed all DOs
    // and fed the relay/restart cascade). The relay path retries transients.
    return buildKey;
  }

  /**
   * Ensure a Durable Object class is registered and workerd is running.
   * DOs self-bootstrap from env bindings on first request — no external bootstrap call needed.
   * Used by explicit lifecycle and route preparation before a caller dispatches
   * to the object. Dispatch transports never call this as an implicit retry.
   */
  async ensureDO(
    source: string,
    className: string,
    objectKey: string,
    opts: { contextId?: string; ref?: string } = {}
  ): Promise<void> {
    if (!isInternalDOSource(source)) {
      throw new Error(
        `Userland Durable Object ${source}:${className}/${objectKey} requires a sealed entity record`
      );
    }
    const scopeRef = opts.contextId
      ? entityScopeRef(opts.ref, opts.contextId)
      : explicitScopeRef(opts.ref);
    await this.ensureDOClass(source, className, { scopeRef, objectKey });
  }

  private async waitForHttpReady(timeoutMs = 5_000): Promise<void> {
    if (!this.port) {
      throw new Error("workerd has no assigned port");
    }
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/__vibestudio_workerd_ready`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.deps.getWorkerdGatewayToken()}`,
          },
        });
        await response.arrayBuffer().catch(() => undefined);
        if (response.ok) return;
        lastError = new Error(`workerd readiness returned HTTP ${response.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `workerd did not accept HTTP on port ${this.port} within ${timeoutMs}ms; last readiness error: ${
        lastError ? errorMessage(lastError) : "none"
      }`
    );
  }

  /** Run schema installation in the serving workerd, over an isolated disposable facet. */
  async probeDurableObjectSchema(
    source: string,
    className: string,
    build: BuildResult,
    timeoutMs = 10_000
  ): Promise<DurableObjectPublishedSchemaDescriptor> {
    if (build.metadata.kind !== "worker" || build.metadata.sourcePath !== source) {
      throw new Error(`Schema probe build does not belong to worker source ${source}`);
    }
    const objectKey = `__vibestudio_schema_probe:${crypto.randomUUID()}`;
    const ref = { source, className, objectKey };
    this.schemaProbeBuilds.set(objectKey, { source, className, build });
    try {
      await this.ensureWorkerdRunning();
      const key = encodeUniversalKey(ref);
      const response = await fetch(
        `http://127.0.0.1:${assertPresent(this.port)}/_u/${encodeURIComponent(key)}/__vibestudio_schema_descriptor`,
        {
          headers: {
            Authorization: `Bearer ${this.deps.getWorkerdGatewayToken()}`,
            "X-Vibestudio-Dispatch-Secret": this.dispatchSecret,
          },
          signal: AbortSignal.timeout(timeoutMs),
          dispatcher: getWorkerdConnectionDispatcher(),
        } as RequestInit
      );
      if (!response.ok) {
        throw new Error(
          `${source}:${className} schema probe failed (${response.status}): ${await response.text()}`
        );
      }
      const descriptor = (await response.json()) as DurableObjectRuntimeSchemaDescriptor;
      if (
        descriptor.className !== className ||
        !Number.isSafeInteger(descriptor.version) ||
        descriptor.version < 1 ||
        typeof descriptor.freshSchemaFingerprint !== "string"
      ) {
        throw new Error(`${source}:${className} returned a malformed schema descriptor`);
      }
      return descriptor;
    } finally {
      await this.abortUserlandDOFacet(ref, "__vibestudio_retire").catch(() => undefined);
      this.schemaProbeBuilds.delete(objectKey);
      await this.destroyDO(ref).catch((error) => {
        log.warn(`Failed to destroy schema probe storage for ${source}:${className}`, error);
      });
      await this.stopWorkerdIfIdle();
    }
  }

  /** Stage exact current-candidate descriptors; no prior generation is admitted. */
  validateAndStageDurableObjectSchemas(
    stateHash: string,
    candidates: ReadonlyArray<{
      source: string;
      effectiveVersion: string;
      descriptor: DurableObjectPublishedSchemaDescriptor;
    }>
  ): string[] {
    const failures: string[] = [];
    const insertDescriptor = this.doSchemaDescriptorDb.prepare(
      `INSERT OR REPLACE INTO do_schema_descriptors
       (source, effective_version, class_name, descriptor_json) VALUES (?, ?, ?, ?)`
    );
    const insertCandidate = this.doSchemaDescriptorDb.prepare(
      `INSERT OR REPLACE INTO do_schema_candidates
       (state_hash, source, class_name, effective_version) VALUES (?, ?, ?, ?)`
    );
    this.doSchemaDescriptorDb.exec("BEGIN IMMEDIATE");
    try {
      this.doSchemaDescriptorDb
        .prepare(`DELETE FROM do_schema_candidates WHERE state_hash = ?`)
        .run(stateHash);
      for (const candidate of candidates) {
        insertDescriptor.run(
          candidate.source,
          candidate.effectiveVersion,
          candidate.descriptor.className,
          canonicalJson(candidate.descriptor)
        );
        insertCandidate.run(
          stateHash,
          candidate.source,
          candidate.descriptor.className,
          candidate.effectiveVersion
        );
      }
      if (failures.length > 0) {
        this.doSchemaDescriptorDb.exec("ROLLBACK");
      } else {
        this.doSchemaDescriptorDb.exec("COMMIT");
      }
    } catch (error) {
      this.doSchemaDescriptorDb.exec("ROLLBACK");
      throw error;
    }
    return failures;
  }

  commitDurableObjectSchemas(stateHash: string): void {
    this.doSchemaDescriptorDb.exec("BEGIN IMMEDIATE");
    try {
      this.doSchemaDescriptorDb
        .prepare(
          `INSERT OR REPLACE INTO do_schema_installed (source, class_name, effective_version)
           SELECT source, class_name, effective_version FROM do_schema_candidates WHERE state_hash = ?`
        )
        .run(stateHash);
      this.doSchemaDescriptorDb
        .prepare(`DELETE FROM do_schema_candidates WHERE state_hash = ?`)
        .run(stateHash);
      this.doSchemaDescriptorDb.exec("COMMIT");
    } catch (error) {
      this.doSchemaDescriptorDb.exec("ROLLBACK");
      throw error;
    }
  }

  // =========================================================================
  // DO cloning (filesystem-level SQLite copy)
  // =========================================================================

  /** Directory holding the UniversalDO facet storage (per-host-object files). */
  private universalDoStorageDir(): string {
    return path.join(
      stateLayout(this.deps.statePath).databases.workerdUniversalDoDir,
      UNIVERSAL_DO_UNIQUE_KEY
    );
  }

  /** workerd host-object storage hash for a userland DO ref (its facet lives in
   *  `<dir>/<hash>.1.sqlite`, with `<hash>.sqlite`/`.facets` siblings). */
  private universalHostHash(ref: DORef): string {
    return computeWorkerdObjectIdHash(UNIVERSAL_DO_UNIQUE_KEY, encodeUniversalKey(ref));
  }

  private durableObjectTargetId(ref: DORef): string {
    return canonicalEntityId({
      kind: "do",
      source: ref.source,
      className: ref.className,
      key: ref.objectKey,
    });
  }

  private durableObjectMaintenanceError(row: DurableObjectMaintenanceRow) {
    return {
      code: "DO_MAINTENANCE_IN_PROGRESS",
      message:
        `${row.className} (${row.source}/${row.objectKey}) storage maintenance ` +
        `${row.operationId} is in progress`,
      errorData: {
        operationId: row.operationId,
        operation: row.kind,
        source: row.source,
        className: row.className,
        objectKey: row.objectKey,
      },
    };
  }

  private readOpenDurableObjectMaintenance(): DurableObjectMaintenanceRow[] {
    return this.doMaintenanceDb
      .prepare(
        `SELECT operation_id, kind, target_id, source, class_name, object_key,
                intent, backup_operation_id, step, created_at
         FROM do_maintenance WHERE status = 'open' ORDER BY created_at`
      )
      .all()
      .map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          operationId: String(row["operation_id"]),
          kind: row["kind"] as "reset" | "restore" | "destroy",
          targetId: String(row["target_id"]),
          source: String(row["source"]),
          className: String(row["class_name"]),
          objectKey: String(row["object_key"]),
          intent: String(row["intent"]),
          backupOperationId:
            row["backup_operation_id"] === null ? null : String(row["backup_operation_id"]),
          step: String(row["step"]),
          createdAt: Number(row["created_at"]),
        };
      });
  }

  private updateDurableObjectMaintenance(operationId: string, step: string): void {
    this.doMaintenanceDb
      .prepare(`UPDATE do_maintenance SET step = ?, updated_at = ? WHERE operation_id = ?`)
      .run(step, Date.now(), operationId);
  }

  private completeDurableObjectMaintenance(operationId: string): void {
    this.doMaintenanceDb
      .prepare(
        `UPDATE do_maintenance SET status = 'complete', step = 'complete', updated_at = ?
         WHERE operation_id = ?`
      )
      .run(Date.now(), operationId);
  }

  private async fenceDurableObjectMaintenance(row: DurableObjectMaintenanceRow): Promise<void> {
    await sealAndDrainDurableObjectRelays(
      row.targetId,
      row.operationId,
      this.durableObjectMaintenanceError(row)
    );
  }

  /** On-disk location of one DO's storage files (`<hash>.…` under `dir`). */
  private durableObjectStorageLocation(ref: DORef): { dir: string; hash: string } {
    if (isInternalDOSource(ref.source)) {
      // Internal classes get one workerd namespace each:
      // workerd-do/<uniqueKey>/<objectIdHash>.sqlite (+ namespace metadata.sqlite,
      // which is workerd-owned and never matched by the hash prefix).
      const uniqueKey = `${ref.source.replace(/\//g, "_")}:${ref.className}`;
      return {
        dir: path.join(stateLayout(this.deps.statePath).databases.workerdDoDir, uniqueKey),
        hash: computeWorkerdObjectIdHash(uniqueKey, ref.objectKey),
      };
    }
    return { dir: this.universalDoStorageDir(), hash: this.universalHostHash(ref) };
  }

  private async quiesceDurableObjectStorage(ref: DORef): Promise<void> {
    if (isInternalDOSource(ref.source)) {
      // Internal DOs are plain workerd classes with no per-facet abort: the
      // only guaranteed file-handle-release boundary is the process itself.
      // Graceful stop, no restart; the maintenance fence keeps THIS object
      // from reactivating when other traffic lazily restarts workerd, and the
      // lock-acquiring verification below stays the correctness arbiter.
      if (this.process && this.process.exitCode === null) {
        await this.restartWorkerd({ kind: "stop", reason: "do-storage-maintenance" });
      }
    } else if (this.process && this.process.exitCode === null && this.port) {
      await this.abortUserlandDOFacet(ref, "__vibestudio_retire");
    }
    // Release proof, not an assumption: open every database read-write and run
    // integrity_check. The open must acquire SQLite's file lock (it fails if
    // workerd still holds the facet's connection) and recovers any residual
    // WAL, so the files a subsequent copy reads are locked-free and coherent.
    const { dir: storageDir, hash } = this.durableObjectStorageLocation(ref);
    const files = (await fs.promises.readdir(storageDir).catch(() => [] as string[])).filter(
      (file) => file.startsWith(`${hash}.`) && file.endsWith(".sqlite")
    );
    try {
      await this.sqliteIntegrityWorker.verify(
        files.map((file) => path.join(storageDir, file)),
        { readOnly: false }
      );
    } catch (cause) {
      throw new Error(
        `workerd has not released or coherently stored Durable Object data: ${errorMessage(cause)}`,
        { cause }
      );
    }
  }

  private durableObjectBackupDir(operationId: string): string {
    return path.join(
      stateLayout(this.deps.statePath).databases.durableObjectBackupsDir,
      operationId
    );
  }

  private async copyDurableObjectStorageToBackup(
    ref: DORef,
    operationId: string,
    intent: string,
    createdAt: number
  ): Promise<void> {
    const { dir: storageDir, hash } = this.durableObjectStorageLocation(ref);
    const backupDir = this.durableObjectBackupDir(operationId);
    await fs.promises.mkdir(backupDir, { recursive: true });
    const existing = await fs.promises.readdir(backupDir).catch(() => [] as string[]);
    for (const file of existing) {
      if (file !== "manifest.json") await fs.promises.unlink(path.join(backupDir, file));
    }
    const files = (await fs.promises.readdir(storageDir).catch(() => [] as string[])).filter(
      (file) => file.startsWith(`${hash}.`)
    );
    for (const file of files) {
      await fs.promises.copyFile(path.join(storageDir, file), path.join(backupDir, file));
    }
    await fs.promises.writeFile(
      path.join(backupDir, "manifest.json"),
      JSON.stringify({ operationId, target: ref, intent, createdAt, files }, null, 2),
      { mode: 0o600 }
    );
  }

  private async verifyDurableObjectBackup(operationId: string): Promise<void> {
    const backupDir = this.durableObjectBackupDir(operationId);
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(backupDir, "manifest.json"), "utf8")
    ) as { files?: unknown };
    if (!Array.isArray(manifest.files))
      throw new Error(`Backup ${operationId} has no file manifest`);
    await this.sqliteIntegrityWorker.verify(
      manifest.files
        .filter((file): file is string => typeof file === "string" && file.endsWith(".sqlite"))
        .map((file) => path.join(backupDir, file))
    );
  }

  private async restoreDurableObjectFiles(ref: DORef, backupOperationId: string): Promise<void> {
    await this.verifyDurableObjectBackup(backupOperationId);
    const backupDir = this.durableObjectBackupDir(backupOperationId);
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(backupDir, "manifest.json"), "utf8")
    ) as { target?: DORef; files?: string[] };
    if (
      manifest.target?.source !== ref.source ||
      manifest.target?.className !== ref.className ||
      manifest.target?.objectKey !== ref.objectKey
    ) {
      throw new Error(`Backup ${backupOperationId} does not belong to the exact requested target`);
    }
    await this.destroyDurableObjectStorageFiles(ref);
    const { dir: storageDir } = this.durableObjectStorageLocation(ref);
    await fs.promises.mkdir(storageDir, { recursive: true });
    for (const file of manifest.files ?? []) {
      await fs.promises.copyFile(path.join(backupDir, file), path.join(storageDir, file));
    }
  }

  private async resumeDurableObjectMaintenance(row: DurableObjectMaintenanceRow): Promise<void> {
    const ref = { source: row.source, className: row.className, objectKey: row.objectKey };
    await this.fenceDurableObjectMaintenance(row);
    try {
      if (row.step === "journaled") {
        this.updateDurableObjectMaintenance(row.operationId, "fenced");
        row.step = "fenced";
      }
      if (row.step === "fenced") {
        await this.quiesceDurableObjectStorage(ref);
        this.updateDurableObjectMaintenance(row.operationId, "retired");
        row.step = "retired";
      }
      if (row.step === "retired") {
        if (row.kind === "destroy") {
          await this.destroyDurableObjectStorageFiles(ref);
          this.updateDurableObjectMaintenance(row.operationId, "replaced");
          row.step = "replaced";
        }
      }
      if (row.step === "retired") {
        await this.copyDurableObjectStorageToBackup(
          ref,
          row.operationId,
          row.intent,
          row.createdAt
        );
        this.updateDurableObjectMaintenance(row.operationId, "backed-up");
        row.step = "backed-up";
      }
      if (row.step === "backed-up") {
        await this.verifyDurableObjectBackup(row.operationId);
        this.updateDurableObjectMaintenance(row.operationId, "verified");
        row.step = "verified";
      }
      if (row.step === "verified") {
        if (row.kind === "reset") await this.destroyDurableObjectStorageFiles(ref);
        else await this.restoreDurableObjectFiles(ref, assertPresent(row.backupOperationId));
        this.updateDurableObjectMaintenance(row.operationId, "replaced");
        row.step = "replaced";
      }
      if (row.step === "replaced") this.completeDurableObjectMaintenance(row.operationId);
    } finally {
      const stillOpen = this.doMaintenanceDb
        .prepare(`SELECT 1 AS open FROM do_maintenance WHERE operation_id = ? AND status = 'open'`)
        .get(row.operationId);
      if (!stillOpen) releaseDurableObjectRelaySeal(row.targetId, row.operationId);
      // An internal-DO quiesce stops the whole workerd process. Bring it back
      // before the operation resolves so unrelated services never depend on a
      // later caller happening to trigger the lazy restart.
      if (
        isInternalDOSource(ref.source) &&
        !this.shuttingDown &&
        !(this.process && this.process.exitCode === null) &&
        (this.instances.size > 0 || this.doServices.size > 0)
      ) {
        await this.ensureWorkerdRunning().catch((error) => {
          log.warn("workerd restart after internal DO storage maintenance failed", error);
        });
      }
    }
  }

  private async startDurableObjectMaintenance(input: {
    kind: "reset" | "restore" | "destroy";
    ref: DORef;
    intent: string;
    backupOperationId?: string;
    journalOnly?: boolean;
  }): Promise<string> {
    await this.doMaintenanceRecovery;
    if (!input.intent.trim()) throw new Error("Durable Object storage maintenance requires intent");
    const targetId = this.durableObjectTargetId(input.ref);
    const previous = this.doMaintenanceChains.get(targetId);
    if (previous) await previous;
    const open = this.readOpenDurableObjectMaintenance().find((row) => row.targetId === targetId);
    if (open) {
      if (input.journalOnly) {
        if (
          open.kind === input.kind &&
          open.backupOperationId === (input.backupOperationId ?? null)
        ) {
          return open.operationId;
        }
        throw new Error(
          `Durable Object storage maintenance ${open.operationId} is already open for ${targetId}`
        );
      }
      await this.resumeDurableObjectMaintenance(open);
      if (
        open.kind === input.kind &&
        open.backupOperationId === (input.backupOperationId ?? null)
      ) {
        return open.operationId;
      }
    }
    const operationId = crypto.randomUUID();
    const createdAt = Date.now();
    const row: DurableObjectMaintenanceRow = {
      operationId,
      kind: input.kind,
      targetId,
      ...input.ref,
      intent: input.intent.trim(),
      backupOperationId: input.backupOperationId ?? null,
      step: "journaled",
      createdAt,
    };
    this.doMaintenanceDb
      .prepare(
        `INSERT INTO do_maintenance (
           operation_id, kind, target_id, source, class_name, object_key, intent,
           backup_operation_id, step, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'journaled', 'open', ?, ?)`
      )
      .run(
        operationId,
        input.kind,
        targetId,
        input.ref.source,
        input.ref.className,
        input.ref.objectKey,
        input.intent.trim(),
        input.backupOperationId ?? null,
        createdAt,
        createdAt
      );
    if (input.journalOnly) {
      await this.fenceDurableObjectMaintenance(row);
      return operationId;
    }
    const execute = () =>
      this.resumeDurableObjectMaintenance(row).then(async () => {
        if (input.kind !== "destroy") await this.sweepDurableObjectBackups(input.ref, 5);
      });
    const run = execute().finally(() => {
      if (this.doMaintenanceChains.get(targetId) === run) this.doMaintenanceChains.delete(targetId);
    });
    this.doMaintenanceChains.set(targetId, run);
    await run;
    return operationId;
  }

  async resetDOStorage(ref: DORef, intent: string): Promise<{ operationId: string }> {
    return {
      operationId: await this.startDurableObjectMaintenance({ kind: "reset", ref, intent }),
    };
  }

  async restoreDOStorageBackup(
    ref: DORef,
    backupOperationId: string,
    intent: string
  ): Promise<{ operationId: string }> {
    return {
      operationId: await this.startDurableObjectMaintenance({
        kind: "restore",
        ref,
        intent,
        backupOperationId,
      }),
    };
  }

  async listDOStorageBackups(ref: DORef): Promise<DurableObjectStorageBackup[]> {
    const root = stateLayout(this.deps.statePath).databases.durableObjectBackupsDir;
    const directories = await fs.promises.readdir(root).catch(() => [] as string[]);
    const backups: DurableObjectStorageBackup[] = [];
    for (const operationId of directories) {
      try {
        const completed = this.doMaintenanceDb
          .prepare(
            `SELECT 1 AS completed FROM do_maintenance
             WHERE operation_id = ? AND status = 'complete'`
          )
          .get(operationId);
        if (!completed) continue;
        const manifest = JSON.parse(
          await fs.promises.readFile(path.join(root, operationId, "manifest.json"), "utf8")
        ) as DurableObjectStorageBackup;
        if (
          manifest.target?.source === ref.source &&
          manifest.target.className === ref.className &&
          manifest.target.objectKey === ref.objectKey
        ) {
          backups.push(manifest);
        }
      } catch {
        // Half-written crash artifacts are resumed from the journal, never listed.
      }
    }
    return backups.sort((a, b) => b.createdAt - a.createdAt);
  }

  private async sweepDurableObjectBackups(ref: DORef, retain: number): Promise<void> {
    const backups = await this.listDOStorageBackups(ref);
    for (const backup of backups.slice(retain)) {
      await fs.promises.rm(this.durableObjectBackupDir(backup.operationId), {
        recursive: true,
        force: true,
      });
    }
  }

  /**
   * Clone a DO's storage to a new object key. The clone starts with identical
   * state. Used for channel forking.
   *
   * Userland DOs run as facets of the static UniversalDO host: each host object
   * owns one facet whose storage is the set of files prefixed by the host's id
   * hash (`<hash>.sqlite`, `<hash>.1.sqlite`, `<hash>.facets`, + WAL/SHM). The
   * facet name is constant, so the layout is portable across host objects.
   *
   * The ordinary path fences and retires the source facet before copying its
   * released files. When the verified runtime caller is the source object
   * itself, retiring it would deadlock the call that requested the clone. That
   * exact actor is already serialized and paused on the host RPC, so the
   * cooperative path uses SQLite's online backup API for each database and
   * copies the stable facet descriptor without retiring the caller.
   */
  async cloneDO(
    ref: DORef,
    newObjectKey: string,
    options: { cooperativelyPaused?: boolean } = {}
  ): Promise<DORef> {
    if (isInternalDOSource(ref.source)) {
      throw new Error(`cloneDO is not supported for internal DO source "${ref.source}"`);
    }
    if (options.cooperativelyPaused) {
      await this.cloneCooperativelyPausedDOStorage(ref, newObjectKey);
      return { source: ref.source, className: ref.className, objectKey: newObjectKey };
    }
    const targetId = this.durableObjectTargetId(ref);
    const sealOwnerId = `clone:${crypto.randomUUID()}`;
    await sealAndDrainDurableObjectRelays(targetId, sealOwnerId, {
      code: "DO_MAINTENANCE_IN_PROGRESS",
      message: `Durable Object ${targetId} is being quiesced for a storage snapshot`,
      errorData: { operation: "clone-snapshot", ...ref },
    });
    try {
      await this.quiesceDurableObjectStorage(ref);
      const dir = this.universalDoStorageDir();
      const srcHash = this.universalHostHash(ref);
      const tgtHash = this.universalHostHash({ ...ref, objectKey: newObjectKey });

      const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
      // Upsert-safe (idempotent) for cloneContext targetKey retries: if the target
      // already has facet storage, a prior clone attempt succeeded — skip rather
      // than double-write (which could clobber a clone that has since diverged).
      if (files.some((f) => f.startsWith(`${tgtHash}.`))) {
        return { source: ref.source, className: ref.className, objectKey: newObjectKey };
      }
      const srcFiles = files.filter((f) => f.startsWith(`${srcHash}.`));
      if (srcFiles.length === 0) {
        throw new Error(
          `Source DO storage not found: ${ref.className}/${ref.objectKey} (no facet storage for host ${srcHash} under ${dir})`
        );
      }
      for (const file of srcFiles) {
        await fs.promises.copyFile(
          path.join(dir, file),
          path.join(dir, `${tgtHash}${file.slice(srcHash.length)}`)
        );
      }
      return { source: ref.source, className: ref.className, objectKey: newObjectKey };
    } finally {
      releaseDurableObjectRelaySeal(targetId, sealOwnerId);
    }
  }

  private async cloneCooperativelyPausedDOStorage(ref: DORef, newObjectKey: string): Promise<void> {
    const dir = this.universalDoStorageDir();
    const srcHash = this.universalHostHash(ref);
    const tgtHash = this.universalHostHash({ ...ref, objectKey: newObjectKey });
    const files = await fs.promises.readdir(dir);

    // A deterministic clone target is immutable at creation time. Once any
    // target storage exists, a retry must preserve it rather than overwrite a
    // clone that may already have advanced independently.
    if (files.some((file) => file.startsWith(`${tgtHash}.`))) return;

    const sourceDatabases = files.filter(
      (file) => file.startsWith(`${srcHash}.`) && file.endsWith(".sqlite")
    );
    const facetDescriptor = `${srcHash}.facets`;
    if (sourceDatabases.length === 0 || !files.includes(facetDescriptor)) {
      throw new Error(
        `Source DO storage not found: ${ref.className}/${ref.objectKey} ` +
          `(incomplete facet storage for host ${srcHash} under ${dir})`
      );
    }

    const createdTargets: string[] = [];
    try {
      for (const file of sourceDatabases) {
        const sourcePath = path.join(dir, file);
        const targetFile = `${tgtHash}${file.slice(srcHash.length)}`;
        const targetPath = path.join(dir, targetFile);
        createdTargets.push(targetPath);
        const database = new DatabaseSync(sourcePath, { readOnly: true });
        try {
          await backup(database, targetPath);
        } finally {
          database.close();
        }
      }
      const targetDescriptor = path.join(dir, `${tgtHash}.facets`);
      createdTargets.push(targetDescriptor);
      await fs.promises.copyFile(path.join(dir, facetDescriptor), targetDescriptor);
    } catch (cause) {
      const cleanupFailures: Error[] = [];
      for (const target of createdTargets.reverse()) {
        try {
          await fs.promises.unlink(target);
        } catch (cleanupCause) {
          const error = cleanupCause as NodeJS.ErrnoException;
          if (error.code !== "ENOENT") cleanupFailures.push(error);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [cause, ...cleanupFailures],
          `Cooperative clone of ${this.durableObjectTargetId(ref)} failed and cleanup was incomplete`
        );
      }
      throw cause;
    }
  }

  /**
   * Destroy a userland DO's facet storage — every file prefixed by the host id
   * hash (main + facet + index + WAL/SHM). Used to clean up orphaned clones on
   * fork failure.
   */
  async destroyDO(ref: DORef): Promise<void> {
    if (isInternalDOSource(ref.source)) {
      throw new Error(`destroyDO is not supported for internal DO source "${ref.source}"`);
    }
    await this.destroyDurableObjectStorageFiles(ref);
  }

  /** Reclaim storage after the runtime registry has retired an entity.
   * Userland facets are already quiesced by retirement and are removed before
   * this call resolves. Internal objects share one workerd process: their
   * logical deletion is durably journaled here, then physical collection runs
   * only after that process has stopped (orderly shutdown or startup recovery).
   * Context teardown must never restart every unrelated DO to collect one
   * retired EvalDO. */
  async destroyRetiredDOStorage(ref: DORef): Promise<void> {
    if (!isInternalDOSource(ref.source)) {
      await this.destroyDO(ref);
      return;
    }
    await this.startDurableObjectMaintenance({
      kind: "destroy",
      ref,
      intent: `reclaim storage for retired ${ref.className}/${ref.objectKey}`,
      journalOnly: true,
    });
  }

  /** Delete one exact object's storage files. Maintenance-path primitive:
   *  callers own quiesce and fencing; internal refs are reachable only through
   *  the journaled maintenance flow, never the userland destroy surface. */
  private async destroyDurableObjectStorageFiles(ref: DORef): Promise<void> {
    const { dir, hash } = this.durableObjectStorageLocation(ref);
    const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      files
        .filter((f) => f.startsWith(`${hash}.`))
        .map((f) =>
          fs.promises.unlink(path.join(dir, f)).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          })
        )
    );
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(() => this.doMaintenanceRecovery);
    const maintenanceResults = await Promise.allSettled([...this.doMaintenanceChains.values()]);
    for (const result of maintenanceResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (this.activeTransition) await attempt(() => this.activeTransition!.promise);
    await attempt(() => this.stopWorkerd("shutdown"));
    // Internal-object destruction is a tombstone while the shared process is
    // live. Once shutdown owns a stopped process, collect every tombstone and
    // retain all failures rather than abandoning the rest of the sweep.
    if (!(this.process && this.process.exitCode === null)) {
      const pendingDestructions = this.readOpenDurableObjectMaintenance().filter(
        (row) => row.kind === "destroy"
      );
      for (const row of pendingDestructions) {
        await attempt(() => this.resumeDurableObjectMaintenance(row));
      }
    }

    // Cleanup all instances
    for (const [, instance] of this.instances) {
      this.revokeWorkerBearer(instance.callerId);
      this.deps.fsService.closeHandlesForCaller(instance.callerId);
    }
    this.instances.clear();

    // Cleanup DO tracking — revoke service-level tokens
    for (const [serviceKey] of this.doServices) {
      this.revokeWorkerBearer(`do-service:${serviceKey}`);
    }
    this.doServices.clear();
    this.doObjectBuilds.clear();

    // Clean up config dir
    await attempt(() => fs.promises.rm(this.configDir, { recursive: true, force: true }));
    await attempt(() => this.sqliteIntegrityWorker.close());

    this.doMaintenanceDb.close();
    this.doSchemaDescriptorDb.close();

    log.info("WorkerdManager shut down");
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `WorkerdManager shutdown failed in ${failures.length} phase(s)`
      );
    }
  }

  /**
   * Called by push trigger when a worker source is rebuilt.
   * Restarts HEAD-tracking instances (no ref) running the given source.
   *
   * DO class reconciliation:
   *   - `doClasses === null`: the rebuild is not for the authoritative main
   *     manifest, so DO service membership is unchanged.
   *   - `doClasses` is an explicit array (possibly empty): treat it as the
   *     authoritative current list. Classes in the list that aren't yet
   *     registered get registered; classes registered but missing from the
   *     list get torn down (service-level token revoked, entry removed from
   *     `doServices`, workerd restarted).
   *
   * This is what lets a manifest edit that DROPS a DO class actually remove
   * the stale workerd service on the next rebuild, rather than leaving an
   * orphaned class bound forever.
   */
  async reconcileMutableSourceBuild(
    source: string,
    doClasses: Array<{ className: string }> | null,
    trigger?: ProtectedPublicationEvent,
    completedBuildKey?: string
  ): Promise<void> {
    const provider = this.requireWorkspaceProvider("source rebuild reconciliation");
    // Dynamic loading makes a rebuild a loader-cache eviction, NOT a restart:
    // runtime image generations advance, so the next request loads fresh code.
    // No workerd restart — concurrent agents keep running.

    const completed = completedBuildKey ? provider.getBuildByKey(completedBuildKey) : null;
    if (completed?.metadata.kind === "worker") {
      const activeDefinitionDigests = new Set<string>();
      for (const method of completed.metadata.workspaceRpcCatalog ?? []) {
        if (method.userlandCapability) {
          activeDefinitionDigests.add(method.userlandCapability.definitionDigest);
        }
        if (method.producesHandle) {
          activeDefinitionDigests.add(method.producesHandle.definitionDigest);
        }
      }
      this.deps.resourceHandleLifecycle?.reconcileProviderDefinitions(source, [
        ...activeDefinitionDigests,
      ]);
    }
    if (doClasses !== null) {
      this.deps.resourceHandleLifecycle?.reconcileReceiverClasses(
        source,
        doClasses.map(({ className }) => className)
      );
    }
    const updateImageFromCompleted = (
      imageId: string,
      scopeRef: string | undefined
    ): RuntimeImageRecord | null => {
      if (!completedBuildKey || !trigger || !completed) return null;
      return this.runtimeImages.upsert({
        id: imageId,
        source,
        unitName: completed.metadata.name,
        artifact: executionArtifactRefFromBuild(this.deps.workspaceId, completed),
        authority: assertPresent(completed.metadata.authority),
        ...(scopeRef ? { scopeRef } : {}),
      });
    };

    // Workers tracking this head reload on their next request.
    for (const instance of this.instances.values()) {
      if (instance.source === source && scopeTracksProtectedMain(instance.scopeRef)) {
        const image = updateImageFromCompleted(instance.runtimeImageId, instance.scopeRef);
        if (image) {
          instance.buildKey = image.artifact.buildKey;
          instance.executionDigest = image.artifact.executionDigest;
          instance.effectiveVersion = image.artifact.sourceState.effectiveVersion;
          this.advanceWorkerCodeVersion(instance, image.generation);
          this.registerEgressCaller(instance);
        }
      }
    }

    // Refresh the build version for this source's userland DO classes so their
    // facets reload. (Internal DOs aren't rebuilt through this push path.)
    const trackedServices = Array.from(this.doServices.values()).filter(
      (s) => s.source === source && scopeTracksProtectedMain(s.scopeRef)
    );
    for (const svc of trackedServices) {
      if (!svc.imageId) continue;
      const image = updateImageFromCompleted(svc.imageId, svc.scopeRef);
      if (image) {
        svc.buildKey = image.artifact.buildKey;
        this.registerDoEgressCaller(svc.source, svc.className, image);
      }
    }
    // Object-specific DO images are sealed by their durable entity records.
    // Publication advances those records through WorkspaceEntityStore and then
    // calls restoreDurableObjectEntity(); this source-level callback must never
    // move a live object ahead of its durable identity.

    // Reconcile DO classes for this source against the new manifest — add new,
    // drop removed. All loader-cache changes; no restart.
    if (doClasses !== null) {
      const newClassNames = new Set(doClasses.map((c) => c.className));
      for (const [serviceKey, svc] of Array.from(this.doServices.entries())) {
        if (svc.source !== source || newClassNames.has(svc.className)) continue;
        this.revokeWorkerBearer(`do-service:${serviceKey}`);
        this.deps.unregisterEgressCaller(`${svc.source}:${svc.className}`);
        this.doServices.delete(serviceKey);
        if (svc.imageId) this.runtimeImages.delete(svc.imageId);
        for (const key of Array.from(this.doObjectBuilds.keys())) {
          if (key.startsWith(`${source}:${svc.className}/`)) {
            const objectBuild = this.doObjectBuilds.get(key);
            if (objectBuild) {
              this.runtimeImages.delete(objectBuild.imageId);
              this.sealedDoImages.delete(objectBuild.imageId);
            }
            this.doObjectBuilds.delete(key);
          }
        }
        this.deps.routeRegistry?.unregisterDoRoutes(source, svc.className);
        log.info(`Unregistered stale DO class ${serviceKey} after manifest change`);
      }
      for (const { className } of doClasses) {
        const serviceKey = `${source}:${className}`;
        if (this.doServices.has(serviceKey)) continue;
        const imageId = `do-service:${serviceKey}`;
        const image = updateImageFromCompleted(imageId, undefined);
        if (!image) continue;
        const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
        const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        this.doServices.set(serviceKey, {
          buildKey: image.artifact.buildKey,
          className,
          imageId,
          serviceName,
          source,
        });
        this.registerRoutesForDoClass(source, className);
        this.registerDoEgressCaller(source, className, image);
        log.info(`Registered new DO class ${source}:${className} from push (no restart)`);
      }
    }

    // Reconcile routes: worker source rebuilds and meta-only route edits share
    // the same route-table convergence path.
    this.reconcileManifestRoutesForSource(source, doClasses);
  }
}
