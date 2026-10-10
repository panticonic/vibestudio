import { formatRpcFailure } from "@vibestudio/rpc";
import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import { isRemoteRpcError } from "@vibestudio/rpc";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { RuntimeEntityHandle } from "@vibestudio/shared/runtime/entitySpec";
import {
  systemTestFailedRunSchema,
  systemTestDescriptorSchema,
  systemTestDoctorResultSchema,
  systemTestRunCompletionSchema,
  systemTestRunReleaseResultSchema,
  systemTestRunStartResultSchema,
  systemTestRunConfigSchema,
  systemTestTrajectoryPageSchema,
  systemTestRunnerSnapshotSchema,
  systemTestRunnerRpcMethods,
  type SystemTestDoctorResult,
  type SystemTestRunnerClient,
  type SystemTestRunnerSnapshot,
} from "@vibestudio/service-schemas/systemTestRunner";
import { runtimeMethods } from "@vibestudio/service-schemas/runtime";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import type { WorkspaceCreationReviewState } from "@vibestudio/service-schemas/shellApproval";
import type {
  PendingApproval,
  PendingUnitInstallReviewApproval,
} from "@vibestudio/shared/approvals";
import { defaultAcceptance } from "@vibestudio/shared/authority/unitInstallReview";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import {
  CliError,
  ConnectionError,
  EXIT_AUTH,
  UsageError,
  jsonMode,
  printError,
  printResult,
  redactCliSecrets,
} from "./output.js";
import {
  DEFAULT_SESSION,
  findContextBinding,
  resolveSessionScope,
  SCOPE_FLAGS,
  type SessionScope,
} from "./agent/sessionContext.js";
import { ensureNamedAgentSession } from "./agent/index.js";
import { RpcError } from "./rpcClient.js";
import { loadAgentSession } from "./sessionStore.js";
import { typedClient } from "./typedClients.js";
import {
  loadSystemTestRun,
  loadSystemTestArtifact,
  listSystemTestRuns,
  saveSystemTestRun,
  systemTestArtifactDir,
  systemTestRunDir,
  writeSystemTestArtifact,
  type StoredSystemTestRun,
} from "./systemTestStore.js";

type EvalStatus = Omit<SystemTestRunnerSnapshot, "result"> & {
  result?: NonNullable<SystemTestRunnerSnapshot["result"]> & { returnValue?: unknown };
};

const DEFAULT_POLL_MS = 1_000;
type SystemTestThinkingLevel = NonNullable<StoredSystemTestRun["config"]["thinkingLevel"]>;
const SYSTEM_TEST_THINKING_LEVELS = new Set<SystemTestThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
function isSystemTestThinkingLevel(value: unknown): value is SystemTestThinkingLevel {
  return (
    typeof value === "string" && SYSTEM_TEST_THINKING_LEVELS.has(value as SystemTestThinkingLevel)
  );
}
const MAX_CONSECUTIVE_STATUS_READ_FAILURES = 5;
const SYSTEM_TEST_TRAJECTORY_PAGE_CHARS = 128 * 1024;
const STARTUP_READINESS_DEADLINE_MS = 60_000;
const STALE_STATUS_ATTESTATION_RE =
  /host authority attestation nonce was replayed or is outside the receiver's retention bound/u;

function makeSystemTestRunnerCaller(scope: SessionScope, targetId: string): SystemTestRunnerClient {
  const call = (method: { name: string }, args: unknown[]) =>
    scope.client.callTarget(targetId, method.name, args);
  return {
    doctor: async (model) =>
      systemTestDoctorResultSchema.parse(await call(systemTestRunnerRpcMethods.doctor, [model])),
    listSystemTests: async (category) =>
      systemTestDescriptorSchema
        .array()
        .parse(await call(systemTestRunnerRpcMethods.listSystemTests, [category])),
    startSystemTestRun: async (options) =>
      systemTestRunStartResultSchema.parse(
        await call(systemTestRunnerRpcMethods.startSystemTestRun, [
          systemTestRunConfigSchema.parse(options),
        ])
      ),
    getSystemTestRunSnapshot: async (runId) =>
      systemTestRunnerSnapshotSchema.parse(
        await call(systemTestRunnerRpcMethods.getSystemTestRunSnapshot, [runId])
      ),
    getSystemTestRunResult: async (runId) =>
      systemTestRunCompletionSchema.parse(
        await call(systemTestRunnerRpcMethods.getSystemTestRunResult, [runId])
      ),
    releaseSystemTestRunExecution: async (runId) =>
      systemTestRunReleaseResultSchema.parse(
        await call(systemTestRunnerRpcMethods.releaseSystemTestRunExecution, [runId])
      ),
    cancelSystemTestRun: async (runId) =>
      systemTestRunCompletionSchema.parse(
        await call(systemTestRunnerRpcMethods.cancelSystemTestRun, [runId])
      ),
    inspectSystemTestRun: (runId, testName) =>
      call(systemTestRunnerRpcMethods.inspectSystemTestRun, [runId, testName]),
    readSystemTestTrajectoryPage: async (runId, testName, full, offset, limit) =>
      systemTestTrajectoryPageSchema.parse(
        await call(systemTestRunnerRpcMethods.readSystemTestTrajectoryPage, [
          runId,
          testName,
          full,
          offset,
          limit,
        ])
      ),
    getFailedSystemTestRun: async (runId) =>
      systemTestFailedRunSchema.parse(
        await call(systemTestRunnerRpcMethods.getFailedSystemTestRun, [runId])
      ),
  };
}

type SystemTestRunnerCaller = SystemTestRunnerClient;

export function systemTestDoctorRecovery(error: unknown): {
  ok: false;
  classification: "infrastructure";
  recoverable: true;
  automaticRecovery: "create_ephemeral_instance";
  command: "pnpm system-test doctor";
  error: string;
  exitCode: number;
} | null {
  if (!(error instanceof CliError) || error.exitCode !== EXIT_AUTH) return null;
  return {
    ok: false,
    classification: "infrastructure",
    recoverable: true,
    automaticRecovery: "create_ephemeral_instance",
    command: "pnpm system-test doctor",
    error: redactCliSecrets(error.message),
    exitCode: error.exitCode,
  };
}

/**
 * The dedicated CLI session system tests run under. Its context forks
 * protected main when it is created, so anything a run must see has to be
 * published before the first system-test command creates it.
 */
const SYSTEM_TEST_SESSION = "system-tests";
const SYSTEM_TEST_RUNNER_SOURCE = "workers/system-test-runner";
const SYSTEM_TEST_RUNNER_CLASS = "SystemTestRunnerDO";

function systemTestRecordOwnerKey(ownerId: string): string {
  return `cli-runs-${createHash("sha256").update(ownerId).digest("hex")}`;
}

async function systemTestRunnerFor(
  scope: SessionScope,
  contextId: string,
  key: string
): Promise<RuntimeEntityHandle> {
  const runtime = typedClient("runtime", runtimeMethods, scope.client);
  return runtime.createEntity({
    kind: "do",
    execution: { surface: "code", source: SYSTEM_TEST_RUNNER_SOURCE },
    className: SYSTEM_TEST_RUNNER_CLASS,
    key,
    contextId,
  });
}

async function withIsolatedSystemTestRunner<T>(
  scope: SessionScope,
  use: (runner: RuntimeEntityHandle) => Promise<T>
): Promise<T> {
  const runtime = typedClient("runtime", runtimeMethods, scope.client);
  const context = await runtime.createContext({});
  let runner: RuntimeEntityHandle | null = null;
  let result: T | undefined;
  let operationFailure: unknown = null;
  try {
    runner = await systemTestRunnerFor(scope, context.contextId, `cli-utility-${randomUUID()}`);
    result = await use(runner);
  } catch (error) {
    operationFailure = error;
  }

  const cleanupFailures: unknown[] = [];
  if (runner) {
    try {
      await runtime.retireEntity({ id: runner.id });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await runtime.destroyContext({ contextId: context.contextId, recursive: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (operationFailure || cleanupFailures.length > 0) {
    const failures = [operationFailure, ...cleanupFailures].filter(
      (failure): failure is NonNullable<typeof failure> => failure !== null
    );
    if (failures.length === 1) throw failures[0];
    const details = failures
      .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
      .join("; ");
    throw new AggregateError(
      failures,
      `System-test utility execution or cleanup failed: ${details}`
    );
  }
  return result as T;
}

async function resolveSystemTestScope(
  inv: ParsedInvocation,
  preferredSession = SYSTEM_TEST_SESSION
): Promise<SessionScope> {
  const explicitSession =
    typeof inv.flags["session"] === "string" ? inv.flags["session"] : undefined;
  if (explicitSession) {
    return await ensureSystemTestSession(inv, explicitSession);
  }

  // System tests are a self-contained CLI workflow. When no ordinary scope
  // source exists, create/recover a dedicated session instead of requiring a
  // prior `agent attach default`. Preserve explicit context, mirrored-folder,
  // and an existing default-session precedence.
  const hasAmbientScope =
    typeof inv.flags["context"] === "string" ||
    findContextBinding() !== null ||
    loadAgentSession(DEFAULT_SESSION) !== null;
  if (!hasAmbientScope) {
    const sessionInvocation = {
      ...inv,
      flags: { ...inv.flags, session: preferredSession },
    };
    return await ensureSystemTestSession(sessionInvocation, preferredSession);
  }
  return resolveSessionScope(inv);
}

async function ensureSystemTestSession(inv: ParsedInvocation, name: string): Promise<SessionScope> {
  await ensureNamedAgentSession(name);
  return resolveSessionScope(inv);
}

function positiveInt(inv: ParsedInvocation, name: string, fallback?: number): number | undefined {
  const raw = inv.flags[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") throw new UsageError(`--${name} requires a value`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive integer`);
  }
  return value;
}

function requireRunId(inv: ParsedInvocation): string {
  const runId = inv.positionals[0];
  if (!runId) throw new UsageError("missing run id");
  return runId;
}

function assertRunOwner(scope: SessionScope, stored: StoredSystemTestRun): void {
  if (stored.ownerId !== scope.session.entityId) {
    throw new CliError(
      `system-test run ${stored.runId} belongs to session ${stored.sessionName} ` +
        `(${stored.ownerId}); select that session with --session ${stored.sessionName}`
    );
  }
}

/** The sealed runner owns the execution; a CLI connection only observes it. */
export async function readSystemTestDriverState(
  call: SystemTestRunnerCaller,
  runId: string
): Promise<EvalStatus> {
  const snapshot = await call.getSystemTestRunSnapshot(runId);
  if (snapshot.status !== "done" || !snapshot.result?.success) return snapshot;
  const record = await call.getSystemTestRunResult(runId);
  // Collecting the terminal record precedes releasing its finite eval scope.
  // The record owner remains available for inspection and another observer.
  await call.releaseSystemTestRunExecution(runId);
  return { ...snapshot, result: { ...snapshot.result, returnValue: record.summary } };
}

function readRunState(scope: SessionScope, stored: StoredSystemTestRun): Promise<EvalStatus> {
  assertRunOwner(scope, stored);
  return readSystemTestDriverState(
    makeSystemTestRunnerCaller(scope, stored.runnerTargetId),
    stored.runId
  );
}

async function cancelRun(scope: SessionScope, stored: StoredSystemTestRun): Promise<void> {
  assertRunOwner(scope, stored);
  const call = makeSystemTestRunnerCaller(scope, stored.runnerTargetId);
  await call.cancelSystemTestRun(stored.runId);
  await call.releaseSystemTestRunExecution(stored.runId);
}

async function startRun(
  scope: SessionScope,
  config: StoredSystemTestRun["config"],
  artifactRoot?: string,
  onCreated?: (stored: StoredSystemTestRun) => void
): Promise<StoredSystemTestRun> {
  const runId = `st_${randomUUID().replaceAll("-", "")}`;
  const runner = await systemTestRunnerFor(
    scope,
    scope.contextId,
    systemTestRecordOwnerKey(scope.session.entityId)
  );
  const stored: StoredSystemTestRun = {
    schemaVersion: 2,
    runId,
    createdAt: Date.now(),
    serverUrl: scope.session.serverUrl,
    sessionName: scope.session.name,
    ownerId: scope.session.entityId,
    contextId: scope.contextId,
    runnerEntityId: runner.id,
    runnerTargetId: runner.targetId,
    artifactDir: systemTestArtifactDir(runId, artifactRoot),
    config,
  };
  // Record the durable address before start so ambiguous acknowledgements and
  // process signals still have the exact execution owner available.
  saveSystemTestRun(stored);
  onCreated?.(stored);
  await makeSystemTestRunnerCaller(scope, runner.targetId).startSystemTestRun({
    runId,
    ...config,
    contextId: scope.contextId,
  });
  return stored;
}

async function waitForRun(
  scope: SessionScope,
  stored: StoredSystemTestRun,
  pollMs: number
): Promise<EvalStatus> {
  // Hold one transport for the bounded wait. Re-negotiating the single-peer
  // Polling readiness every second races process teardown and can starve an
  // independent inspector. Local headless runs normally use doctor's verified
  // direct gateway, so status/inspect/cancel remain concurrently available;
  // remote users who need that concurrency can start the durable run detached.
  const connection = scope.client;
  const release = connection.retainConnection();
  let consecutiveReadFailures = 0;
  try {
    for (;;) {
      let status: EvalStatus;
      try {
        status = await readRunState(scope, stored);
        consecutiveReadFailures = 0;
      } catch (error) {
        const retryable = isRetryableSystemTestStatusReadFailure(error);
        consecutiveReadFailures += 1;
        if (!retryable || consecutiveReadFailures >= MAX_CONSECUTIVE_STATUS_READ_FAILURES) {
          throw error;
        }
        if (isStaleSystemTestStatusAttestation(error)) {
          // A long-lived retained connection can outlive the receiver's
          // one-invocation attestation retention window. Status reads are
          // idempotent, so force the next poll through a newly authenticated
          // transport instead of surfacing a false system-test failure.
          await connection.close().catch(() => undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      if (!["pending", "running", "cancelling"].includes(status.status)) return status;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    await release();
  }
}

function isStaleSystemTestStatusAttestation(error: unknown): boolean {
  return (
    (error instanceof RpcError || isRemoteRpcError(error)) &&
    STALE_STATUS_ATTESTATION_RE.test(error.message)
  );
}

export function isRetryableSystemTestStatusReadFailure(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    isStaleSystemTestStatusAttestation(error) ||
    ((error instanceof RpcError || isRemoteRpcError(error)) &&
      (error.errorKind === "transport" ||
        error.errorKind === "internal" ||
        error.errorKind === "service"))
  );
}

/**
 * Own the remote lifetime of a foreground durable run. A CLI process can be
 * interrupted independently of its EvalDO, so SIGINT/SIGTERM must become the
 * same authenticated cancellation operation as `system-test cancel`.
 */
function installSystemTestRunCancellation(
  scope: SessionScope,
  getStored: () => StoredSystemTestRun | null
): {
  wasInterrupted(): boolean;
  ensureCancellation(): Promise<boolean>;
  dispose(): void;
} {
  let received: NodeJS.Signals | null = null;
  let cancellation: Promise<void> | null = null;
  let disposed = false;
  let dispose = (): void => undefined;

  const beginCancellation = (): void => {
    if (!received || cancellation || disposed) return;
    const stored = getStored();
    if (!stored) return;
    console.error(
      `[system-test] ${received} received; cancelling durable run ${stored.runId} before exit`
    );
    cancellation = cancelRun(scope, stored);
    // The eventual await in ensureCancellation owns error reporting; this
    // branch merely prevents an async signal handler rejection from becoming
    // an unhandled-rejection process failure.
    void cancellation.catch(() => undefined);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (received) {
      // A second signal is an explicit request to abandon cleanup. Preserve
      // the normal Unix exit semantics after the first signal gave cancellation
      // a chance to run.
      console.error("[system-test] cancellation still running; forcing process exit");
      dispose();
      process.kill(process.pid, signal);
      return;
    }
    received = signal;
    beginCancellation();
  };
  dispose = (): void => {
    if (disposed) return;
    disposed = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    wasInterrupted: () => received !== null,
    ensureCancellation: async () => {
      beginCancellation();
      if (cancellation) await cancellation;
      return received !== null;
    },
    dispose,
  };
}

/**
 * What a run produced, or why the CLI cannot say.
 *
 * An orchestration that dies mid-run — its sandbox restarted under it, say —
 * still leaves every finished test durably recorded in the run's progress.
 * Reporting only the orchestration's own error message throws that away and
 * leaves the operator without the run id, without knowing that most of the
 * suite had already answered, and without the command that reads it back.
 */
export function resultValue(status: EvalStatus, runId: string): unknown {
  if (status.status === "unknown") throw new CliError("system-test run is unknown to the server");
  if (status.status === "cancelled") throw new CliError("system-test run was cancelled");
  if (status.status !== "done") return undefined;
  if (!status.result?.success) {
    throw new CliError(
      `system-test run ${runId} did not finish: ${
        status.result?.error ?? "system-test orchestration failed"
      }${interruptedRunEvidence(status, runId)}`
    );
  }
  return status.result.returnValue;
}

/** Name the results an unfinished run already has, and how to read them. */
function interruptedRunEvidence(status: EvalStatus, runId: string): string {
  const progress = status.progress as { total?: unknown; completed?: unknown } | null | undefined;
  const completed = Array.isArray(progress?.completed) ? progress.completed : [];
  if (completed.length === 0) return "";
  const counts = new Map<string, number>();
  for (const entry of completed) {
    const outcome =
      entry &&
      typeof entry === "object" &&
      typeof (entry as { outcome?: unknown }).outcome === "string"
        ? (entry as { outcome: string }).outcome
        : "unknown";
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const total = typeof progress?.total === "number" ? progress.total : completed.length;
  const breakdown = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outcome, count]) => `${count} ${outcome}`)
    .join(", ");
  return (
    `. ${completed.length} of ${total} tests completed before it stopped (${breakdown}); ` +
    `those results are preserved: vibestudio system-test inspect ${runId} --json`
  );
}

export function failedSummary(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return (
    summary["status"] === "errored" ||
    ["failed", "errored", "toolFailureCount"].some(
      (key) => typeof summary[key] === "number" && summary[key] > 0
    )
  );
}

function printRun(value: unknown, json: boolean, artifact?: string): void {
  printResult(value, {
    json,
    human: () => {
      const summary = value as Record<string, unknown>;
      console.log(`run: ${String(summary["runId"] ?? "unknown")}`);
      console.log(
        `${String(summary["passed"] ?? 0)} passed, ${String(summary["failed"] ?? 0)} failed, ` +
          `${String(summary["errored"] ?? 0)} errored, ${String(summary["toolFailureCount"] ?? 0)} unexpected tool failures`
      );
      if (artifact) console.log(`artifact: ${artifact}`);
    },
  });
}

async function list(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const scope = await resolveSystemTestScope(inv);
    const tests = await withIsolatedSystemTestRunner(scope, (runner) =>
      makeSystemTestRunnerCaller(scope, runner.targetId).listSystemTests(
        typeof inv.flags["category"] === "string" ? inv.flags["category"] : undefined
      )
    );
    printResult(tests, {
      json,
      human: () => {
        for (const test of tests) {
          console.log(`${test.name}\t${test.category}\t${test.description}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function run(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const names = [...inv.positionals, ...inv.flagsMulti("name")];
    const all = inv.flags["all"] === true;
    const category = typeof inv.flags["category"] === "string" ? inv.flags["category"] : undefined;
    if (all && names.length > 0) throw new UsageError("choose --all or exact test names, not both");
    if (!all && names.length === 0 && !category) {
      throw new UsageError("select exact test names, --category CATEGORY, or --all");
    }
    const scope = await resolveSystemTestScope(inv);
    const testTimeoutMs = positiveInt(inv, "test-timeout-ms");
    const thinkingLevel = inv.flags["thinking-level"];
    if (thinkingLevel !== undefined && !isSystemTestThinkingLevel(thinkingLevel)) {
      throw new UsageError("--thinking-level must be minimal, low, medium, high, xhigh, or max");
    }
    const config: StoredSystemTestRun["config"] = {
      names,
      ...(category ? { category } : {}),
      all,
      ...(typeof inv.flags["model"] === "string" ? { model: inv.flags["model"] } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      concurrency: positiveInt(inv, "concurrency", 1) ?? 1,
      ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
    };
    let stored: StoredSystemTestRun | null = null;
    const signalCancellation = installSystemTestRunCancellation(scope, () => stored);
    try {
      stored = await startRun(scope, config, outDir(inv), (created) => {
        stored = created;
      });
      if (await signalCancellation.ensureCancellation()) return 130;
      if (inv.flags["detach"] === true) {
        const value = {
          runId: stored.runId,
          status: "running",
          artifactDir: stored.artifactDir,
        };
        printResult(value, { json });
        return 0;
      }
      const status = await waitForRun(
        scope,
        stored,
        positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS
      );
      if (await signalCancellation.ensureCancellation()) return 130;
      const value = resultValue(status, stored.runId);
      const artifact = writeSystemTestArtifact(stored.runId, "summary", value, stored.artifactDir);
      await retainFailedRunEvidence(scope, stored, value);
      printRun(value, json, artifact);
      return failedSummary(value) ? 1 : 0;
    } finally {
      signalCancellation.dispose();
    }
  } catch (error) {
    return printError(error, { json });
  }
}

async function status(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const runId = requireRunId(inv);
    const stored = loadSystemTestRun(runId);
    const scope = await resolveSystemTestScope(inv, stored?.sessionName ?? SYSTEM_TEST_SESSION);
    if (!stored) throw new CliError(`no local metadata for system-test run ${runId}`);
    const state =
      inv.flags["wait"] === true
        ? await waitForRun(
            scope,
            stored,
            positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS
          )
        : await readRunState(scope, stored);
    const progress = withElapsedProgress(state.progress);
    const value = {
      runId,
      status: state.status,
      ...(progress ? { progress } : {}),
      ...(state.status === "done" && state.result?.success
        ? { summary: state.result.returnValue }
        : state.result?.error
          ? { error: state.result.error }
          : {}),
    };
    // Detached runs often outlive (or are followed by a restart of) the
    // workspace they ran in. Persist the terminal summary at the moment
    // status observes it so `rerun RUN_ID` can recover failed/tool-failure test
    // names without depending on the old EvalDO still existing.
    if (state.status === "done" && state.result?.success) {
      writeSystemTestArtifact(
        runId,
        "summary",
        state.result.returnValue,
        storedArtifactDir(runId, stored)
      );
      await retainFailedRunEvidence(scope, stored, state.result.returnValue);
    }
    printResult(value, { json });
    if (state.status === "unknown" || state.status === "cancelled") return 1;
    if (state.status === "done") {
      if (!state.result?.success) return 1;
      return failedSummary(state.result.returnValue) ? 1 : 0;
    }
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

/** Ergonomic alias for `status RUN_ID --wait`. Kept as a real command instead
 * of a shell-level alias so JSON output, scope routing, exit codes, and future
 * polling options remain identical on every platform. */
async function wait(inv: ParsedInvocation): Promise<number> {
  return status({ ...inv, flags: { ...inv.flags, wait: true } });
}

function withElapsedProgress(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const progress = value as Record<string, unknown>;
  const terminalAt =
    progress["status"] !== "running" && typeof progress["updatedAt"] === "string"
      ? Date.parse(progress["updatedAt"])
      : NaN;
  const now = Number.isFinite(terminalAt) ? terminalAt : Date.now();
  const startedAt = typeof progress["startedAt"] === "string" ? progress["startedAt"] : null;
  const running = Array.isArray(progress["running"])
    ? progress["running"].map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
        const test = raw as Record<string, unknown>;
        const testStartedAt = typeof test["startedAt"] === "string" ? test["startedAt"] : null;
        const phaseStartedAt =
          typeof test["phaseStartedAt"] === "string" ? test["phaseStartedAt"] : null;
        return {
          ...test,
          ...(testStartedAt ? { elapsedMs: Math.max(0, now - Date.parse(testStartedAt)) } : {}),
          ...(phaseStartedAt
            ? { phaseElapsedMs: Math.max(0, now - Date.parse(phaseStartedAt)) }
            : {}),
        };
      })
    : [];
  // Full live trajectories are retained in the authenticated EvalDO heartbeat
  // for inspect/trajectory, but ordinary status output must stay bounded and
  // must not expose sensitive conversation content.
  const { liveInspection: _liveInspection, ...publicProgress } = progress;
  return {
    ...publicProgress,
    ...(startedAt ? { elapsedMs: Math.max(0, now - Date.parse(startedAt)) } : {}),
    running,
  };
}

async function runs(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const values = listSystemTestRuns().map((run) => ({
      runId: run.runId,
      createdAt: run.createdAt,
      session: run.sessionName,
      serverUrl: run.serverUrl,
      config: run.config,
      artifactDir: storedArtifactDir(run.runId, run),
    }));
    printResult(values, {
      json,
      human: () => {
        if (values.length === 0) {
          console.log("no local system-test runs");
          return;
        }
        for (const value of values) {
          console.log(
            `${value.runId}\t${new Date(value.createdAt).toISOString()}\t${value.config.names.join(",") || (value.config.category ?? "all")}`
          );
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function readPersisted(
  inv: ParsedInvocation,
  method: "inspectSystemTestRun" | "getFailedSystemTestRun",
  testName?: string,
  readLive?: (progress: Record<string, unknown>) => unknown
): Promise<{ runId: string; stored: StoredSystemTestRun; value: unknown }> {
  const runId = requireRunId(inv);
  const stored = loadSystemTestRun(runId);
  if (!stored) throw new CliError(`no local metadata for system-test run ${runId}`);
  const scope = await resolveSystemTestScope(inv, stored.sessionName);
  try {
    const call = makeSystemTestRunnerCaller(scope, stored.runnerTargetId);
    const value =
      method === "inspectSystemTestRun"
        ? await call.inspectSystemTestRun(runId, testName)
        : await call.getFailedSystemTestRun(runId);
    return { runId, stored, value };
  } catch (durableError) {
    if (!readLive) throw durableError;
    const outer = await readRunState(scope, stored);
    const progress =
      outer.progress && typeof outer.progress === "object" && !Array.isArray(outer.progress)
        ? (outer.progress as Record<string, unknown>)
        : null;
    const live = progress ? readLive(progress) : undefined;
    if (live !== undefined) return { runId, stored, value: live };
    throw durableError;
  }
}

async function fetchTrajectory(
  scope: SessionScope,
  stored: StoredSystemTestRun,
  testName: string,
  full: boolean
): Promise<unknown> {
  let offset = 0;
  let length: number | null = null;
  let text = "";
  do {
    const page = await makeSystemTestRunnerCaller(
      scope,
      stored.runnerTargetId
    ).readSystemTestTrajectoryPage(
      stored.runId,
      testName,
      full,
      offset,
      SYSTEM_TEST_TRAJECTORY_PAGE_CHARS
    );
    if (
      !Number.isSafeInteger(page.length) ||
      page.length < 0 ||
      page.encoding !== "plain-string" ||
      typeof page.chunk !== "string"
    ) {
      throw new CliError("invalid page while retrieving system-test trajectory");
    }
    length ??= page.length;
    if (page.length !== length) {
      throw new CliError("system-test trajectory changed while it was being retrieved");
    }
    if (page.chunk.length === 0 && offset < length) {
      throw new CliError("system-test trajectory returned an empty page before completion");
    }
    text += page.chunk;
    offset += page.chunk.length;
  } while (length === null || offset < length);
  if (text.length !== length) {
    throw new CliError(
      `system-test trajectory is incomplete (expected ${length} chars, received ${text.length})`
    );
  }
  return JSON.parse(text) as unknown;
}

async function readPersistedTrajectory(
  inv: ParsedInvocation,
  testName: string,
  full: boolean,
  readLive?: (progress: Record<string, unknown>) => unknown
): Promise<{ runId: string; stored: StoredSystemTestRun; value: unknown }> {
  const runId = requireRunId(inv);
  const stored = loadSystemTestRun(runId);
  if (!stored) throw new CliError(`no local metadata for system-test run ${runId}`);
  const scope = await resolveSystemTestScope(inv, stored.sessionName);
  try {
    return { runId, stored, value: await fetchTrajectory(scope, stored, testName, full) };
  } catch (durableError) {
    if (!readLive) throw durableError;
    const outer = await readRunState(scope, stored);
    const progress =
      outer.progress && typeof outer.progress === "object" && !Array.isArray(outer.progress)
        ? (outer.progress as Record<string, unknown>)
        : null;
    const live = progress ? readLive(progress) : undefined;
    if (live !== undefined) return { runId, stored, value: live };
    throw unavailableTrajectory(runId, testName, durableError);
  }
}

/** Retained failure evidence lives apart from user exports, which may hold
 * live snapshots of a run that was still in progress. */
function failureEvidenceDir(stored: StoredSystemTestRun): string {
  return path.join(stored.artifactDir, "failure-evidence");
}

/** Artifact names shared by retained evidence and the `inspect`/`trajectory`
 * commands' own exports. */
function inspectionArtifactName(testName?: string): string {
  return testName ? `inspect-${safeName(testName)}` : "inspect";
}

function trajectoryArtifactName(testName: string, full: boolean): string {
  return `trajectory-${safeName(testName)}${full ? "-full" : ""}`;
}

function failedSummaryTestNames(summary: unknown): string[] {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return [];
  const record = summary as Record<string, unknown>;
  return [
    ...new Set(
      [record["failedTests"], record["testsWithUnexpectedToolFailures"]]
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .filter((value): value is string => typeof value === "string")
    ),
  ];
}

/**
 * A failed run's evidence must outlive the instance that produced it. When a
 * terminal summary reports failures, keep the bounded inspection packet and the
 * full trajectory of every failed test beside the run metadata (mode `0600`,
 * trajectories gzipped). The inspection packet is written last, so its presence
 * marks the evidence complete and a later observer does not refetch it.
 */
export async function retainFailedRunEvidence(
  scope: SessionScope,
  stored: StoredSystemTestRun,
  summary: unknown
): Promise<void> {
  if (!failedSummary(summary)) return;
  const dir = failureEvidenceDir(stored);
  if (loadSystemTestArtifact(stored.runId, inspectionArtifactName(), dir) !== null) return;
  try {
    for (const testName of failedSummaryTestNames(summary)) {
      writeSystemTestArtifact(
        stored.runId,
        inspectionArtifactName(testName),
        await makeSystemTestRunnerCaller(scope, stored.runnerTargetId).inspectSystemTestRun(
          stored.runId,
          testName
        ),
        dir
      );
      writeSystemTestArtifact(
        stored.runId,
        trajectoryArtifactName(testName, false),
        await fetchTrajectory(scope, stored, testName, false),
        dir
      );
      writeSystemTestArtifact(
        stored.runId,
        trajectoryArtifactName(testName, true),
        await fetchTrajectory(scope, stored, testName, true),
        dir
      );
    }
    const inspection = await makeSystemTestRunnerCaller(
      scope,
      stored.runnerTargetId
    ).inspectSystemTestRun(stored.runId);
    writeSystemTestArtifact(stored.runId, inspectionArtifactName(), inspection, dir);
  } catch (error) {
    throw new CliError(
      `system-test run ${stored.runId} failed, and its failure evidence could not be retained ` +
        `in ${dir}: ${formatRpcFailure(error)}`
    );
  }
}

/** Read evidence retained when a failed run completed, without contacting the
 * instance that produced it. */
function loadRetainedFailureEvidence(
  runId: string,
  name: string
): { runId: string; stored: StoredSystemTestRun; value: unknown } | null {
  const stored = loadSystemTestRun(runId);
  if (!stored) return null;
  const value = loadSystemTestArtifact(runId, name, failureEvidenceDir(stored));
  return value === null ? null : { runId, stored, value };
}

/**
 * Explain a trajectory that neither source can produce.
 *
 * Older runners can have neither a retained checkpoint nor a live trajectory.
 * A large heartbeat may omit its entire inspection payload, so the bounded
 * inspection is a possible diagnostic route rather than a promised record.
 */
export function unavailableTrajectory(runId: string, testName: string, cause: unknown): CliError {
  const detail = formatRpcFailure(cause);
  return new CliError(
    `no trajectory for ${testName} in system-test run ${runId}: ${detail}. A run large ` +
      "enough to overflow the durable progress heartbeat may omit live inspection too. " +
      `Check for retained bounded diagnostics with: vibestudio system-test inspect ${runId} --test ${testName}`
  );
}

async function inspect(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const testName = typeof inv.flags["test"] === "string" ? inv.flags["test"] : undefined;
    const retained = loadRetainedFailureEvidence(
      requireRunId(inv),
      inspectionArtifactName(testName)
    );
    const { runId, stored, value } =
      retained ??
      (await readPersisted(inv, "inspectSystemTestRun", testName, (progress) => {
        const live = progress["liveInspection"] as Record<string, unknown> | undefined;
        if (!live) return undefined;
        if (!testName) return live["inspect"];
        const byTest = live["inspectByTest"] as Record<string, unknown> | undefined;
        if (byTest?.[testName] !== undefined) return byTest[testName];
        const trajectories = live["trajectories"] as Record<string, unknown> | undefined;
        const row = trajectories?.[testName] as Record<string, unknown> | undefined;
        return row?.["bounded"];
      }));
    const artifact = writeSystemTestArtifact(
      runId,
      inspectionArtifactName(testName),
      value,
      requestedArtifactDir(inv, runId, stored)
    );
    printResult(value, {
      json,
      human: () => {
        console.log(JSON.stringify(value, null, 2));
        console.log(`artifact: ${artifact}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function trajectory(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const testName = inv.positionals[1];
    if (!testName)
      throw new UsageError("usage: vibestudio system-test trajectory RUN_ID TEST_NAME");
    const full = inv.flags["full"] === true;
    const retained = loadRetainedFailureEvidence(
      requireRunId(inv),
      trajectoryArtifactName(testName, full)
    );
    const { runId, stored, value } =
      retained ??
      (await readPersistedTrajectory(inv, testName, full, (progress) => {
        const live = progress["liveInspection"] as Record<string, unknown> | undefined;
        const trajectories = live?.["trajectories"] as Record<string, unknown> | undefined;
        const row = trajectories?.[testName] as Record<string, unknown> | undefined;
        if (!row) return undefined;
        if (!full) return row["bounded"];
        if (row["full"] !== undefined) return row["full"];
        return {
          available: false,
          live: true,
          reason: "Full trajectory becomes available when the running test completes",
          bounded: row["bounded"],
        };
      }));
    const artifact = writeSystemTestArtifact(
      runId,
      trajectoryArtifactName(testName, full),
      value,
      requestedArtifactDir(inv, runId, stored)
    );
    printResult(value, {
      json,
      human: () => {
        console.log(JSON.stringify(value, null, 2));
        console.log(`artifact: ${artifact}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function rerun(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const sourceRunId = requireRunId(inv);
    const storedPrior = loadSystemTestRun(sourceRunId);
    if (!storedPrior) throw new CliError(`no local metadata for system-test run ${sourceRunId}`);
    const localSummary = loadSystemTestArtifact(sourceRunId, "summary", storedPrior.artifactDir);
    const summary =
      localSummary && typeof localSummary === "object" && !Array.isArray(localSummary)
        ? (localSummary as Record<string, unknown>)
        : null;
    const localNames = summary
      ? [summary["failedTests"], summary["testsWithUnexpectedToolFailures"]]
          .flatMap((value) => (Array.isArray(value) ? value : []))
          .filter((value): value is string => typeof value === "string")
      : [];
    const prior =
      localNames.length > 0
        ? { config: storedPrior.config, names: [...new Set(localNames)] }
        : systemTestFailedRunSchema.parse(
            (await readPersisted(inv, "getFailedSystemTestRun")).value
          );
    const names = prior.names;
    if (!Array.isArray(names) || names.length === 0) {
      throw new CliError(`system-test run ${sourceRunId} has no failed tests to rerun`);
    }
    if (!prior.config) {
      throw new CliError(`system-test run ${sourceRunId} has no retained run configuration`);
    }
    const scope = await resolveSystemTestScope(inv, storedPrior.sessionName);
    const concurrency = positiveInt(inv, "concurrency");
    const testTimeoutMs = positiveInt(inv, "test-timeout-ms");
    const thinkingLevel = inv.flags["thinking-level"];
    if (thinkingLevel !== undefined && !isSystemTestThinkingLevel(thinkingLevel)) {
      throw new UsageError("--thinking-level must be minimal, low, medium, high, xhigh, or max");
    }
    let stored: StoredSystemTestRun | null = null;
    const signalCancellation = installSystemTestRunCancellation(scope, () => stored);
    try {
      stored = await startRun(
        scope,
        {
          ...prior.config,
          names,
          all: false,
          ...(typeof inv.flags["model"] === "string" ? { model: inv.flags["model"] } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
        },
        outDir(inv),
        (created) => {
          stored = created;
        }
      );
      if (await signalCancellation.ensureCancellation()) return 130;
      if (inv.flags["detach"] === true) {
        printResult(
          { runId: stored.runId, rerunOf: sourceRunId, tests: names, status: "running" },
          { json }
        );
        return 0;
      }
      const state = await waitForRun(
        scope,
        stored,
        positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS
      );
      if (await signalCancellation.ensureCancellation()) return 130;
      const result = resultValue(state, stored.runId);
      const artifact = writeSystemTestArtifact(stored.runId, "summary", result, stored.artifactDir);
      await retainFailedRunEvidence(scope, stored, result);
      printRun(result, json, artifact);
      return failedSummary(result) ? 1 : 0;
    } finally {
      signalCancellation.dispose();
    }
  } catch (error) {
    return printError(error, { json });
  }
}

async function cancel(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const runId = requireRunId(inv);
    const stored = loadSystemTestRun(runId);
    const scope = await resolveSystemTestScope(inv, stored?.sessionName ?? SYSTEM_TEST_SESSION);
    if (!stored) throw new CliError(`no local metadata for system-test run ${runId}`);
    await cancelRun(scope, stored);
    printResult({ runId, ok: true }, { json });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function doctor(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const scope = await resolveSystemTestScope(inv);
    const result = await withIsolatedSystemTestRunner(scope, async (runner) => {
      const readDoctor = (): Promise<SystemTestDoctorResult> =>
        makeSystemTestRunnerCaller(scope, runner.targetId).doctor(
          typeof inv.flags["model"] === "string" ? inv.flags["model"] : undefined
        );
      let prepared: Awaited<ReturnType<typeof settleSystemTestStartup>> | null = null;
      if (inv.flags["approve-startup"] === true) {
        const approvals = await startupApprovalPort(scope);
        try {
          prepared = await settleSystemTestStartup(readDoctor, approvals, {
            onStatus: (status) => console.error(`[system-test] waiting for startup: ${status}`),
          });
        } finally {
          await approvals.close();
        }
      }
      const value = prepared?.doctor ?? (await readDoctor());
      return prepared ? { ...value, startupApprovals: prepared.startupApprovals } : value;
    });
    const value = result;
    printResult(result, {
      json,
      human: () => {
        for (const check of value.checks ?? []) {
          console.log(`${check.ok ? "PASS" : "FAIL"}\t${check.name}\t${check.detail}`);
        }
      },
    });
    return value.ok ? 0 : 1;
  } catch (error) {
    const recovery = systemTestDoctorRecovery(error);
    if (recovery) {
      if (json) console.error(JSON.stringify(recovery));
      else {
        console.error(recovery.error);
        console.error(`Automatic recovery: ${recovery.command}`);
      }
      return recovery.exitCode;
    }
    return printError(error, { json });
  }
}

export async function settleSystemTestStartup(
  readDoctor: () => Promise<SystemTestDoctorResult>,
  approvals: {
    listPending(): Promise<PendingApproval[]>;
    getWorkspaceCreationReviewState(): Promise<WorkspaceCreationReviewState>;
    resolveInstallReview(approval: PendingUnitInstallReviewApproval): Promise<void>;
    startObserving?(): Promise<void>;
    observationRevision?(): number;
    waitForChange?(afterRevision: number): Promise<void>;
  },
  options: { deadlineMs?: number; pollMs?: number; onStatus?: (status: string) => void } = {}
): Promise<{
  doctor: SystemTestDoctorResult;
  startupApprovals: {
    approvedReviewIds: string[];
    approvedPartCount: number;
    creationReviewStatus: WorkspaceCreationReviewState["status"];
  };
}> {
  const deadline = options.deadlineMs === undefined ? null : Date.now() + options.deadlineMs;
  const pollMs = options.pollMs ?? 250;
  const approved = new Set<string>();
  const approvedFingerprints = new Map<string, string>();
  let approvedPartCount = 0;

  let lastStatus = "";
  await approvals.startObserving?.();
  while (true) {
    const observedRevision = approvals.observationRevision?.() ?? 0;
    const reviewState = await approvals.getWorkspaceCreationReviewState();
    if (reviewState.status === "failed") {
      throw new CliError(`workspace creation review preparation failed: ${reviewState.error}`);
    }
    if (reviewState.status === "unresolved") {
      throw new CliError("workspace creation review was dismissed or denied during preparation");
    }
    const pending = await approvals.listPending();
    const startupReviews = pending.filter(isManagedStartupInstallReview);
    const unrelated = pending.filter((approval) => !isManagedStartupInstallReview(approval));
    for (const batch of startupReviews) {
      // The approval id names the durable review slot, not one immutable
      // review payload. Compiler/source changes can republish that slot with
      // new version-bound parts while startup is settling. Remembering only
      // the id silently treats that new code as already reviewed and leaves
      // the managed instance waiting forever. Conversely, resolving every
      // observation can race the pending-change event and submit the same
      // payload twice. Key the suppression to exactly what is being admitted.
      const fingerprint = JSON.stringify({
        mode: batch.mode,
        parts: batch.parts.map((part) => ({
          identityKey: part.identityKey,
          effectiveVersion: part.effectiveVersion,
          change: part.change,
        })),
      });
      if (approvedFingerprints.get(batch.approvalId) === fingerprint) continue;
      await approvals.resolveInstallReview(batch);
      approvedFingerprints.set(batch.approvalId, fingerprint);
      approved.add(batch.approvalId);
      approvedPartCount += batch.parts.length;
    }

    const result = await readDoctor();
    const waitingForBuilds = doctorIsWaitingForApprovedBuilds(result, { allowMissing: true });
    const reviewPreparationComplete =
      reviewState.status === "not-required" || reviewState.status === "resolved";
    if (
      !result.ok &&
      !waitingForBuilds &&
      reviewPreparationComplete &&
      startupReviews.length === 0
    ) {
      return {
        doctor: result,
        startupApprovals: {
          approvedReviewIds: [...approved],
          approvedPartCount,
          creationReviewStatus: reviewState.status,
        },
      };
    }
    const status = `creation review: ${reviewState.status}; managed startup approvals: ${startupReviews.length}; unrelated approvals left untouched: ${unrelated.length}; ${
      result.ok
        ? "doctor ready"
        : (result.checks ?? [])
            .filter((check) => !check.ok)
            .map((check) => `${check.name}=${check.detail}`)
            .join("; ") || "doctor not ready"
    }`;
    if (status !== lastStatus) {
      lastStatus = status;
      options.onStatus?.(status);
    }
    if (result.ok && reviewPreparationComplete && startupReviews.length === 0) {
      return {
        doctor: result,
        startupApprovals: {
          approvedReviewIds: [...approved],
          approvedPartCount,
          creationReviewStatus: reviewState.status,
        },
      };
    }
    if (deadline !== null && Date.now() >= deadline) {
      throw new CliError(
        `timed out waiting for semantic startup preparation (creation review: ${reviewState.status})`
      );
    }
    if (approvals.waitForChange) await approvals.waitForChange(observedRevision);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function isManagedStartupInstallReview(
  approval: PendingApproval
): approval is PendingUnitInstallReviewApproval {
  return (
    approval.kind === "unit-install-review" &&
    approval.mode === "adopt-root" &&
    (approval.callerId === "system:units" || approval.callerId === "system:workspace-creation")
  );
}

export async function settleSystemTestDoctor(
  readDoctor: () => Promise<SystemTestDoctorResult>,
  options: { deadlineMs?: number; pollMs?: number } = {}
): Promise<SystemTestDoctorResult> {
  const deadline = Date.now() + (options.deadlineMs ?? STARTUP_READINESS_DEADLINE_MS);
  const pollMs = options.pollMs ?? 250;

  while (true) {
    const result = await readDoctor();
    if (result.ok || !doctorIsWaitingForApprovedBuilds(result) || Date.now() >= deadline) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function doctorIsWaitingForApprovedBuilds(
  result: SystemTestDoctorResult,
  options: { allowMissing?: boolean } = {}
): boolean {
  const failures = (result.checks ?? []).filter((check) => !check.ok);
  const transientStates = options.allowMissing
    ? /\b(?:missing|pending-approval|approval-required|building)\b/
    : /\b(?:pending-approval|approval-required|building)\b/;
  const requiredExtensions = (result.checks ?? []).find(
    (check) => check.name === "required-extensions"
  );
  if (!requiredExtensions) return false;
  const structuredStatuses = Array.isArray(requiredExtensions.data)
    ? requiredExtensions.data.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        return typeof record["status"] === "string"
          ? [
              {
                source: typeof record["source"] === "string" ? record["source"] : "",
                name: typeof record["name"] === "string" ? record["name"] : "",
                status: record["status"],
              },
            ]
          : [];
      })
    : [];
  const requiredExtensionsWaiting =
    (!requiredExtensions.ok && transientStates.test(requiredExtensions.detail)) ||
    structuredStatuses.some(({ status }) => transientStates.test(status));
  if (!requiredExtensionsWaiting) return false;
  return failures.every((check) => check === requiredExtensions);
}

async function startupApprovalPort(scope: SessionScope): Promise<{
  listPending(): Promise<PendingApproval[]>;
  getWorkspaceCreationReviewState(): Promise<WorkspaceCreationReviewState>;
  resolveInstallReview(approval: PendingUnitInstallReviewApproval): Promise<void>;
  startObserving(): Promise<void>;
  observationRevision(): number;
  waitForChange(afterRevision: number): Promise<void>;
  close(): Promise<void>;
}> {
  const client = typedClient("shellApproval", shellApprovalMethods, scope.client);
  const eventRpc = await scope.client.openSiblingConnection();
  const events = new EventsClient(
    schemaRpcCaller({
      call: eventRpc.callTarget.bind(eventRpc),
      stream: eventRpc.stream.bind(eventRpc),
    })
  );
  let revision = 0;
  const waiters = new Set<() => void>();
  const changed = () => {
    revision += 1;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const removeApprovalListener = events.on("shell-approval:pending-changed", changed);
  const removeBuildListener = events.on("build:complete", changed);
  return {
    listPending: () => client.listPending(),
    getWorkspaceCreationReviewState: () => client.getWorkspaceCreationReviewState(),
    resolveInstallReview: (approval) =>
      client
        .resolveInstallReview(approval.approvalId, defaultAcceptance(approval.mode, approval.parts))
        .then(() => undefined),
    startObserving: () => events.subscribeAll(["shell-approval:pending-changed", "build:complete"]),
    observationRevision: () => revision,
    waitForChange: (afterRevision) => {
      if (revision !== afterRevision) return Promise.resolve();
      // Events own normal continuation. This slow reconciliation tick covers a
      // server restart or a state transition that predates event publication;
      // it is not a completion deadline.
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 5_000);
        timer.unref?.();
        waiters.add(finish);
      });
    },
    close: async () => {
      removeApprovalListener();
      removeBuildListener();
      for (const resolve of waiters) resolve();
      waiters.clear();
      try {
        await events.unsubscribeAll();
      } finally {
        await eventRpc.close();
      }
    },
  };
}

function outDir(inv: ParsedInvocation): string | undefined {
  return typeof inv.flags["out-dir"] === "string" ? inv.flags["out-dir"] : undefined;
}

function storedArtifactDir(runId: string, stored: StoredSystemTestRun | null): string {
  return stored?.artifactDir ?? systemTestRunDir(runId);
}

function requestedArtifactDir(
  inv: ParsedInvocation,
  runId: string,
  stored: StoredSystemTestRun | null
): string {
  const requestedRoot = outDir(inv);
  return requestedRoot
    ? systemTestArtifactDir(runId, requestedRoot)
    : storedArtifactDir(runId, stored);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 100);
}

const RUN_FLAGS = [
  { name: "name", takesValue: true, multiple: true, description: "Exact test name (repeatable)" },
  { name: "category", takesValue: true, description: "Select one test category" },
  { name: "all", takesValue: false, description: "Run the complete catalog" },
  { name: "model", takesValue: true, description: "Model ref for spawned test agents" },
  {
    name: "thinking-level",
    takesValue: true,
    description: "Thinking level for spawned test agents",
  },
  { name: "concurrency", takesValue: true, description: "Maximum concurrent test agents" },
  {
    name: "test-timeout-ms",
    takesValue: true,
    description: "Optional per-test timeout in milliseconds (no timeout when omitted)",
  },
  { name: "poll-ms", takesValue: true, description: "Status polling interval (default 1000)" },
  {
    name: "detach",
    takesValue: false,
    description: "Start the durable run and return immediately",
  },
  { name: "out-dir", takesValue: true, description: "Local artifact directory" },
] as const;

const READ_FLAGS = [
  { name: "out-dir", takesValue: true, description: "Local artifact directory" },
  ...SCOPE_FLAGS,
  JSON_FLAG,
];

export const systemTestCommands: CliCommand[] = [
  {
    group: "system-test",
    name: "doctor",
    summary: "Check catalog, build, agent worker, and model readiness",
    usage: "vibestudio system-test doctor [--session NAME] [--model REF] [--approve-startup]",
    flags: [
      { name: "model", takesValue: true, description: "Require this model ref to be usable" },
      {
        name: "approve-startup",
        takesValue: false,
        description:
          "Approve only exact version-bound startup install reviews before checking readiness",
      },
      ...SCOPE_FLAGS,
      JSON_FLAG,
    ],
    run: doctor,
  },
  {
    group: "system-test",
    name: "list",
    summary: "List headless agentic system tests",
    usage: "vibestudio system-test list [--category CATEGORY]",
    flags: [{ name: "category", takesValue: true }, ...SCOPE_FLAGS, JSON_FLAG],
    run: list,
  },
  {
    group: "system-test",
    name: "run",
    summary: "Run exact tests, a category, or the complete catalog",
    usage: "vibestudio system-test run [TEST_NAME ...] [--category CATEGORY | --all]",
    flags: [...RUN_FLAGS, ...SCOPE_FLAGS, JSON_FLAG],
    run,
  },
  {
    group: "system-test",
    name: "status",
    summary: "Poll a durable system-test run",
    usage: "vibestudio system-test status RUN_ID [--wait]",
    flags: [
      {
        name: "wait",
        takesValue: false,
        description: "Wait until the run reaches a terminal state",
      },
      { name: "poll-ms", takesValue: true, description: "Status polling interval (default 1000)" },
      ...SCOPE_FLAGS,
      JSON_FLAG,
    ],
    run: status,
  },
  {
    group: "system-test",
    name: "wait",
    summary: "Wait for a durable system-test run to finish",
    usage: "vibestudio system-test wait RUN_ID",
    flags: [
      { name: "poll-ms", takesValue: true, description: "Status polling interval (default 1000)" },
      ...SCOPE_FLAGS,
      JSON_FLAG,
    ],
    run: wait,
  },
  {
    group: "system-test",
    name: "runs",
    summary: "List locally known durable system-test runs",
    usage: "vibestudio system-test runs",
    flags: [JSON_FLAG],
    run: runs,
  },
  {
    group: "system-test",
    name: "inspect",
    summary: "Read bounded diagnostics for a run or one test",
    usage: "vibestudio system-test inspect RUN_ID [--test TEST_NAME]",
    flags: [{ name: "test", takesValue: true }, ...READ_FLAGS],
    run: inspect,
  },
  {
    group: "system-test",
    name: "trajectory",
    summary: "Export one test trajectory and invocation record",
    usage: "vibestudio system-test trajectory RUN_ID TEST_NAME [--full]",
    flags: [{ name: "full", takesValue: false }, ...READ_FLAGS],
    run: trajectory,
  },
  {
    group: "system-test",
    name: "rerun",
    summary: "Rerun failed tests from an earlier run",
    usage: "vibestudio system-test rerun RUN_ID [--thinking-level LEVEL] [--detach]",
    flags: [
      { name: "model", takesValue: true },
      {
        name: "thinking-level",
        takesValue: true,
        description: "Thinking level for spawned test agents",
      },
      { name: "concurrency", takesValue: true },
      {
        name: "test-timeout-ms",
        takesValue: true,
        description:
          "Replace the prior run's optional per-test timeout in milliseconds (otherwise preserve it)",
      },
      { name: "poll-ms", takesValue: true },
      { name: "detach", takesValue: false },
      { name: "out-dir", takesValue: true },
      ...SCOPE_FLAGS,
      JSON_FLAG,
    ],
    run: rerun,
  },
  {
    group: "system-test",
    name: "cancel",
    summary: "Cancel a pending or running system-test job",
    usage: "vibestudio system-test cancel RUN_ID",
    flags: [...SCOPE_FLAGS, JSON_FLAG],
    run: cancel,
  },
];
