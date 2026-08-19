import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RuntimeEntityHandle } from "@vibestudio/shared/runtime/entitySpec";
import {
  EVAL_RESULT_RETURN_PREVIEW_CHARS,
  createEvalExecutor,
  evalMethods,
} from "@vibestudio/service-schemas/eval";
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
import { RpcClient, RpcError } from "./rpcClient.js";
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

type EvalClient = ReturnType<typeof evalClientFor>;
type EvalStatus = Awaited<ReturnType<EvalClient["get"]>>;

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
// Diagnostic commands must fail visibly when an unhealthy EvalDO cannot
// reconstruct a persisted run. An unbounded inspector is especially harmful:
// it turns the primary recovery surface into another silent stall.
const SYSTEM_TEST_INSPECTION_TIMEOUT_MS = 30_000;
// The first page is returned through eval itself. Reserve an object-envelope
// budget and assume worst-case JSON escaping (one code unit → six characters)
// so the pager can never compact its own response into another truncation
// envelope. Later pages use the direct scope reader.
const EVAL_RETURN_PAGE_ENVELOPE_CHARS = 1_024;
const EVAL_RETURN_PAGE_CHARS = Math.floor(
  (EVAL_RESULT_RETURN_PREVIEW_CHARS - EVAL_RETURN_PAGE_ENVELOPE_CHARS) / 6
);
// Once the first eval has cached the source string, direct owner-scoped scope
// reads bypass the EvalDO run-result envelope. A 128 Ki-code-unit page becomes
// ~342 KiB as UTF-16LE base64, comfortably bounded while reducing round trips.
const DIRECT_SCOPE_PAGE_CHARS = 128 * 1024;
const STARTUP_READINESS_DEADLINE_MS = 60_000;
const STALE_STATUS_ATTESTATION_RE =
  /host authority attestation nonce was replayed or is outside the receiver's retention bound/u;

type SystemTestDoctorResult = {
  ok?: boolean;
  checks?: Array<{ name: string; ok: boolean; detail: string; data?: unknown }>;
};

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

function evalClientFor(scope: SessionScope) {
  return typedClient("eval", evalMethods, scope.client);
}

function evalExecutorFor(scope: SessionScope) {
  return createEvalExecutor(<T>(method: string, args: unknown[]) =>
    scope.client.call<T>(method, args)
  );
}

const SYSTEM_TEST_SESSION = "system-tests";
const SYSTEM_TEST_RUNNER_SOURCE = "workers/system-test-runner";
const SYSTEM_TEST_RUNNER_CLASS = "SystemTestRunnerDO";

export function systemTestCoordinatorScopeKey(runId: string): string {
  return `system-test-coordinator:${runId}`;
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

function routing(scope: SessionScope, stored?: StoredSystemTestRun | null) {
  if (stored && stored.ownerId !== scope.session.entityId) {
    throw new CliError(
      `system-test run ${stored.runId} belongs to session ${stored.sessionName} ` +
        `(${stored.ownerId}); select that session with --session ${stored.sessionName}`
    );
  }
  return {
    // The server derives the current context from this live session entity.
    // Stored context remains provenance only, so recovery survives rebinding.
    target: {
      kind: "owner-session" as const,
      sessionId: stored?.ownerId ?? scope.session.entityId,
    },
    scopeKey: stored?.subKey ?? scope.session.scopeKey,
  };
}

function startRouting(scope: SessionScope, stored?: StoredSystemTestRun | null) {
  const route = routing(scope, stored);
  return {
    target: route.target,
    scope: { key: route.scopeKey },
  };
}

export function systemTestRunCode(runId: string, config: StoredSystemTestRun["config"]): string {
  const options = JSON.stringify({ runId, ...config });
  return `
    const progressKey = ${JSON.stringify(runId)};
    // EvalDO durably stores each progress payload with a 64 KiB ceiling. Leave
    // room for its event envelope and encoded strings instead of measuring
    // against the larger transient RPC transport limit.
    const durableHeartbeatLimit = 48 * 1024;
    let lastProgress = null;
    const publishProgress = (progress) => {
      let durable = { ...progress, updatedAt: new Date().toISOString() };
      if (JSON.stringify(durable).length > durableHeartbeatLimit && durable.liveInspection) {
        durable = {
          ...durable,
          liveInspection: { inspect: durable.liveInspection.inspect, trajectories: {} },
        };
      }
      if (JSON.stringify(durable).length > durableHeartbeatLimit) {
        const { liveInspection: _omitted, ...withoutInspection } = durable;
        durable = withoutInspection;
      }
      lastProgress = durable;
      (ctx as any).reportProgress(durable);
    };
    let driver = null;
    let driverContextId = null;
    let driverRetired = false;
    let driverContextDestroyed = false;
    let driverResultReleased = false;
    let driverResourcesReleased = false;
    let cancellationCleanup = null;
    let cancellationRequested = false;
    const describeCleanupFailure = (error) => {
      if (error instanceof AggregateError) {
        const nested = [...error.errors].map(describeCleanupFailure).join("; ");
        return nested ? error.message + ": " + nested : error.message;
      }
      return error instanceof Error ? error.name + ": " + error.message : String(error);
    };
    const retireDriver = async () => {
      if (!driver || driverRetired) return;
      await services.runtime.retireEntity({ id: driver.id });
      driverRetired = true;
    };
    const releaseDriverResources = async () => {
      if (!driver || driverResourcesReleased) return;
      try {
        if (!driverResultReleased) {
          await rpc.call(driver.targetId, "releaseSystemTestRunResult", [progressKey]);
          driverResultReleased = true;
        }
        await retireDriver();
        if (driverContextId && !driverContextDestroyed) {
          await services.runtime.destroyContext({
            contextId: driverContextId,
            recursive: true,
          });
          driverContextDestroyed = true;
        }
        driverResourcesReleased = true;
      } catch (error) {
        throw new AggregateError([error], "System-test driver cleanup failed");
      }
    };
    try {
      const driverContext = await services.runtime.createContext({});
      driverContextId = driverContext.contextId;
      driver = await services.runtime.createEntity({
        kind: "do",
        execution: {
          surface: "code",
          source: "workers/system-test-runner",
        },
        className: "SystemTestRunnerDO",
        key: progressKey,
        contextId: driverContextId,
      });
      await rpc.call(driver.targetId, "startSystemTestRun", [{
        ...${options},
        contextId: driverContextId,
      }]);
      ctx.onCancel(async () => {
        cancellationRequested = true;
        const cleanup = (async () => {
          const cancelledRecord = await rpc.call(
            driver.targetId,
            "cancelSystemTestRun",
            [progressKey],
          );
          if (cancelledRecord) {
            const runs = scope.systemTestRuns && typeof scope.systemTestRuns === "object"
              ? scope.systemTestRuns
              : {};
            runs[progressKey] = cancelledRecord;
            scope.systemTestRuns = runs;
          }
          const prior = lastProgress && typeof lastProgress === "object"
            ? lastProgress
            : { runId: progressKey, startedAt: new Date().toISOString(), total: 0, queued: [], running: [], completed: [] };
          publishProgress({
            ...prior,
            status: "cancelled",
            updatedAt: new Date().toISOString(),
            running: [],
          });
        })();
        cancellationCleanup = cleanup;
        await cleanup;
      });
      for (;;) {
        const snapshot = await rpc.call(
          driver.targetId,
          "getSystemTestRunSnapshot",
          [progressKey],
        );
        if (snapshot?.progress) publishProgress(snapshot.progress);
        if (
          snapshot?.status === "pending" ||
          snapshot?.status === "running" ||
          snapshot?.status === "cancelling"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          continue;
        }
        if (snapshot?.status === "done") {
          if (!snapshot.result?.success) {
            throw new Error(
              snapshot.result?.error || "System-test driver reported a failed inner eval"
            );
          }
          const record = await rpc.call(
            driver.targetId,
            "getSystemTestRunResult",
            [progressKey],
          );
          if (!record) throw new Error("System-test driver returned no record for " + progressKey);
          const runs = scope.systemTestRuns && typeof scope.systemTestRuns === "object"
            ? scope.systemTestRuns
            : {};
          runs[progressKey] = record;
          scope.systemTestRuns = runs;
          await releaseDriverResources();
          return record.summary;
        }
        throw new Error(
          "System-test inner eval became " + (snapshot?.status || "unknown")
        );
      }
    } catch (error) {
      if (cancellationRequested) {
        // The cancellation owner has already stopped the nested run and
        // recorded its terminal result. Wait for that phase here so an
        // in-flight parent relay cannot turn normal cancellation into an
        // infrastructure error or race driver retirement.
        await cancellationCleanup;
      } else {
        const prior = lastProgress && typeof lastProgress === "object"
          ? lastProgress
          : { runId: progressKey, startedAt: new Date().toISOString(), total: 0, queued: [], running: [], completed: [] };
        publishProgress({
          ...prior,
          status: "errored",
          updatedAt: new Date().toISOString(),
          running: [],
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    } finally {
      // EvalDO starts registered cancellation cleanup before aborting ordinary
      // execution. Let it settle first, then unconditionally release both the
      // finite inner EvalDO and its driver. Validation errors, transport errors,
      // and successful runs therefore share one exact terminal path.
      let cancellationFailure = null;
      if (cancellationCleanup) {
        try {
          await cancellationCleanup;
        } catch (error) {
          cancellationFailure = error;
        }
      }
      let releaseFailure = null;
      try {
        await releaseDriverResources();
      } catch (error) {
        releaseFailure = error;
      }
      if (cancellationFailure || releaseFailure) {
        const failures = [cancellationFailure, releaseFailure].filter(Boolean);
        throw new AggregateError(
          failures,
          "System-test terminal cleanup failed: " +
            failures.map(describeCleanupFailure).join("; "),
        );
      }
    }
  `;
}

function readCode(runId: string, expression: string): string {
  return `
    import {
      failedSystemTestNames,
      getSystemTestRun,
      inspectSystemTestRun,
      systemTestTrajectory,
    } from "@workspace-skills/system-testing/cli";
    const record = getSystemTestRun(scope.systemTestRuns, ${JSON.stringify(runId)});
    if (!record) throw new Error("No persisted system-test result for run ${runId}");
    return ${expression};
  `;
}

async function startRun(
  scope: SessionScope,
  config: StoredSystemTestRun["config"],
  artifactRoot?: string,
  onCreated?: (stored: StoredSystemTestRun) => void
): Promise<StoredSystemTestRun> {
  const runId = `st_${randomUUID().replaceAll("-", "")}`;
  const stored: StoredSystemTestRun = {
    schemaVersion: 1,
    runId,
    createdAt: Date.now(),
    serverUrl: scope.session.serverUrl,
    sessionName: scope.session.name,
    ownerId: scope.session.entityId,
    contextId: scope.contextId,
    // The durable CLI coordinator and the blessed runner are different
    // notebook trust units even when a direct invocation resolves both to the
    // same owner session. Give the coordinator its own address; the runner
    // deliberately keeps runId for its finite test notebook.
    subKey: systemTestCoordinatorScopeKey(runId),
    artifactDir: systemTestArtifactDir(runId, artifactRoot),
    config,
  };
  const client = evalClientFor(scope);
  // Persist the address before transport admission. If the CLI receives a
  // signal during start (or the acknowledgement is ambiguous), the signal
  // handler still has the exact owner/scope/run route needed to cancel the
  // durable EvalDO run instead of abandoning an unaddressable execution.
  saveSystemTestRun(stored);
  onCreated?.(stored);
  await client.start({
    ...startRouting(scope, stored),
    runId,
    source: {
      kind: "inline",
      code: systemTestRunCode(runId, config),
      syntax: "typescript",
    },
  });
  return stored;
}

async function waitForRun(
  client: EvalClient,
  route: ReturnType<typeof routing>,
  runId: string,
  pollMs: number,
  connection: RpcClient
): Promise<EvalStatus> {
  // Hold one transport for the bounded wait. Re-negotiating the single-peer
  // WebRTC room every second races signaling teardown and can starve an
  // independent inspector. Local headless runs normally use doctor's verified
  // direct gateway, so status/inspect/cancel remain concurrently available;
  // remote users who need that concurrency can start the durable run detached.
  const release = connection.retainConnection();
  let consecutiveReadFailures = 0;
  try {
    for (;;) {
      let status: EvalStatus;
      try {
        status = await client.get({ ...route, runId });
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
  return error instanceof RpcError && STALE_STATUS_ATTESTATION_RE.test(error.message);
}

export function isRetryableSystemTestStatusReadFailure(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    isStaleSystemTestStatusAttestation(error) ||
    (error instanceof RpcError &&
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
    cancellation = evalClientFor(scope)
      .cancel({ ...routing(scope, stored), runId: stored.runId })
      .then(() => undefined);
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

function resultValue(status: EvalStatus): unknown {
  if (status.status === "unknown") throw new CliError("system-test run is unknown to the server");
  if (status.status === "cancelled") throw new CliError("system-test run was cancelled");
  if (status.status !== "done") return undefined;
  if (!status.result?.success) {
    throw new CliError(status.result?.error ?? "system-test orchestration failed");
  }
  return status.result.returnValue;
}

function failedSummary(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return ["failed", "errored", "toolFailureCount"].some(
    (key) => typeof summary[key] === "number" && summary[key] > 0
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
      scope.client.callTarget(runner.targetId, "listSystemTests", [
        typeof inv.flags["category"] === "string" ? inv.flags["category"] : undefined,
      ])
    );
    printResult(tests, {
      json,
      human: () => {
        for (const test of tests as Array<{
          name: string;
          category: string;
          description: string;
        }>) {
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
        evalClientFor(scope),
        routing(scope, stored),
        stored.runId,
        positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS,
        scope.client
      );
      if (await signalCancellation.ensureCancellation()) return 130;
      const value = resultValue(status);
      const artifact = writeSystemTestArtifact(stored.runId, "summary", value, stored.artifactDir);
      await retainRunDiagnostics(scope, stored, value);
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
    const client = evalClientFor(scope);
    const state =
      inv.flags["wait"] === true
        ? await waitForRun(
            client,
            routing(scope, stored),
            runId,
            positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS,
            scope.client
          )
        : await client.get({ ...routing(scope, stored), runId });
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
    // Detached runs often outlive (or are followed by a restart of) an
    // ephemeral source workspace. Persist the terminal summary at the moment
    // status observes it so `rerun RUN_ID` can recover failed/tool-failure test
    // names without depending on the old EvalDO still existing.
    if (state.status === "done" && state.result?.success) {
      writeSystemTestArtifact(
        runId,
        "summary",
        state.result.returnValue,
        storedArtifactDir(runId, stored)
      );
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
  code: (runId: string) => string,
  readLive?: (progress: Record<string, unknown>) => unknown,
  pageCode?: (runId: string, start: number, end: number, pageKey: string) => string
): Promise<{ runId: string; stored: StoredSystemTestRun | null; value: unknown }> {
  const runId = requireRunId(inv);
  const stored = loadSystemTestRun(runId);
  const scope = await resolveSystemTestScope(inv, stored?.sessionName ?? SYSTEM_TEST_SESSION);
  const outer = await evalClientFor(scope).get({ ...routing(scope, stored), runId });
  const progress =
    outer.progress && typeof outer.progress === "object" && !Array.isArray(outer.progress)
      ? (outer.progress as Record<string, unknown>)
      : null;
  // The runner heartbeat retains the completed bounded/full inspection packet.
  // Prefer it even after terminal completion: enqueuing a second eval behind an
  // unhealthy or still-unwinding owner EvalDO defeats the purpose of the
  // diagnostic command and can make `inspect` appear to hang.
  const live = progress && readLive ? readLive(progress) : undefined;
  if (live !== undefined) return { runId, stored, value: live };
  // Eval run handles are process-local. After a source-server restart a
  // completed system-test run is legitimately "unknown", while its record is
  // still durable in the owner's EvalDO scope. Probe that durable record below
  // instead of making the volatile orchestration handle a prerequisite for
  // inspect/trajectory/rerun.
  if (outer.status !== "done" && outer.status !== "unknown" && outer.status !== "cancelled") {
    throw new CliError(
      `system-test run ${runId} is ${outer.status}; live inspection is not available yet, retry shortly`
    );
  }
  if (outer.status === "done") resultValue(outer);
  const result = await evalExecutorFor(scope)({
    ...startRouting(scope, stored),
    runId: randomUUID(),
    source: { kind: "inline", code: code(runId), syntax: "typescript" },
    timeoutMs: SYSTEM_TEST_INSPECTION_TIMEOUT_MS,
  });
  if (!result.success) throw new CliError(result.error ?? "could not inspect system-test run");
  const value = await expandTruncatedReturn(
    scope,
    stored,
    result.returnValue,
    pageCode ? (start, end, pageKey) => pageCode(runId, start, end, pageKey) : undefined
  );
  return { runId, stored, value };
}

function truncatedReturn(value: unknown): {
  scopeKey: string;
  originalChars: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row["truncated"] === true &&
    typeof row["scopeKey"] === "string" &&
    typeof row["originalChars"] === "number"
    ? { scopeKey: row["scopeKey"], originalChars: row["originalChars"] }
    : null;
}

/**
 * Build an owner-scoped deterministic pager for a persisted diagnostic value.
 * This deliberately does not read `$lastLargeReturn`: that shared recovery slot
 * can be replaced by another diagnostic eval between the truncation envelope
 * and the first page read.
 */
export function systemTestJsonPageExpression(
  expression: string,
  start: number,
  end: number,
  pageKey: string
): string {
  return `(() => {
    const pageKey = ${JSON.stringify(pageKey)};
    if (!Object.prototype.hasOwnProperty.call(scope, pageKey)) {
      const value = (${expression});
      scope[pageKey] = JSON.stringify(value, null, 2);
    }
    const source = scope[pageKey];
    if (typeof source !== "string") {
      throw new Error("Cached system-test diagnostic is not text");
    }
    const chunk = source.slice(${start}, ${end});
    return {
      length: source.length,
      encoding: "plain-string",
      chunk,
    };
  })()`;
}

async function expandTruncatedReturn(
  scope: SessionScope,
  stored: StoredSystemTestRun | null,
  value: unknown,
  pageCode?: (start: number, end: number, pageKey: string) => string
): Promise<unknown> {
  const truncated = truncatedReturn(value);
  if (!truncated) return value;

  // Ordinary large eval returns are recovered from the stable scope key named
  // by the truncation envelope (currently scope.$lastLargeReturn). Callers
  // that can deterministically reconstruct the value (notably persisted full
  // trajectories) provide pageCode instead: EvalDO deliberately caps the
  // generic scope spill at 1 MiB, while pathological trajectories can exceed
  // that. A deterministic pager caches its serialized reconstruction under a
  // temporary scope key, then returns bounded slices. This avoids both claiming
  // recoverability from a capped spill and rebuilding/stringifying a
  // multi-megabyte trajectory once per page.
  const pageKey = `__systemTestReturn_${randomUUID().replaceAll("-", "")}`;
  const client = evalClientFor(scope);
  let text = "";
  let reportedLength: number | null = null;
  let targetLength = truncated.originalChars;
  try {
    let offset = 0;
    while (offset < targetLength) {
      const requestedChars = offset === 0 ? EVAL_RETURN_PAGE_CHARS : DIRECT_SCOPE_PAGE_CHARS;
      // The first page is an eval because it atomically snapshots either the
      // envelope's stable spill key or a deterministic reconstruction into
      // `pageKey`. Every
      // subsequent page is a direct scope read: no compilation, no run row,
      // no result compaction, and no repeated trajectory serialization.
      let resolvedRow: {
        length?: unknown;
        chunk?: unknown;
        encoding?: unknown;
      } | null = null;
      if (offset === 0) {
        const page = await evalExecutorFor(scope)({
          ...startRouting(scope, stored),
          runId: randomUUID(),
          source: {
            kind: "inline",
            code:
              pageCode?.(offset, offset + requestedChars, pageKey) ??
              `
              const pageKey = ${JSON.stringify(pageKey)};
              if (!Object.prototype.hasOwnProperty.call(scope, pageKey)) {
                scope[pageKey] = scope[${JSON.stringify(truncated.scopeKey)}];
              }
              const source = scope[pageKey];
              if (typeof source !== "string") {
                throw new Error("Large eval return spill is unavailable or is not text");
              }
              const chunk = source.slice(${offset}, ${offset + requestedChars});
              return {
                length: source.length,
                encoding: "plain-string",
                chunk,
              };
            `,
            syntax: "typescript",
          },
          timeoutMs: SYSTEM_TEST_INSPECTION_TIMEOUT_MS,
        });
        if (!page.success) {
          throw new CliError(page.error ?? "could not page large system-test result");
        }
        resolvedRow = page.returnValue as typeof resolvedRow;
      } else {
        resolvedRow = await client.readScopeTextPage({
          ...routing(scope, stored),
          key: pageKey,
          offset,
          limit: requestedChars,
        });
      }
      if (
        typeof resolvedRow?.length !== "number" ||
        typeof resolvedRow.chunk !== "string" ||
        (resolvedRow.encoding !== "utf16le-base64" && resolvedRow.encoding !== "plain-string")
      ) {
        throw new CliError("invalid page while retrieving large system-test result");
      }
      const decodedChunk =
        resolvedRow.encoding === "plain-string"
          ? resolvedRow.chunk
          : Buffer.from(resolvedRow.chunk, "base64").toString("utf16le");
      reportedLength ??= resolvedRow.length;
      if (resolvedRow.length !== reportedLength) {
        throw new CliError("large system-test result changed while it was being retrieved");
      }
      // A caller-supplied deterministic pager may serialize the source value
      // slightly differently from EvalDO's generic return serializer. Its
      // first page is authoritative for that reconstructed JSON stream. The
      // generic spill path must still match the advertised original length so
      // a capped spill is never mistaken for a complete value.
      targetLength = reportedLength;
      text += decodedChunk;
      if (decodedChunk.length === 0 && offset < targetLength) {
        throw new CliError("large system-test result returned an empty page before completion");
      }
      offset += decodedChunk.length;
    }
  } finally {
    await client
      .deleteScopeValue({ ...routing(scope, stored), key: pageKey })
      .catch(() => undefined);
  }

  if (
    reportedLength === null ||
    (!pageCode && reportedLength !== truncated.originalChars) ||
    text.length !== reportedLength
  ) {
    const expected =
      !pageCode && reportedLength !== truncated.originalChars
        ? `${truncated.originalChars} advertised / ${reportedLength ?? "unknown"} paged`
        : String(reportedLength ?? truncated.originalChars);
    throw new CliError(
      `large system-test result is incomplete (expected ${expected} chars, received ${text.length})`
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(
      `large system-test result was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Capture the diagnostics packet while the workspace that produced it still
 * exists.
 *
 * `inspect` and `trajectory` read the run out of the *workspace*, so every
 * failure's evidence dies with the instance that produced it. Since a change to
 * workspace source only takes effect on reprovision, the ordinary repair loop —
 * run, read the failure, fix, run again — destroys the evidence at exactly the
 * moment it becomes worth reading. Persisting the packet at completion, next to
 * the summary this command already retains, makes a failed run inspectable
 * afterwards.
 */
async function retainRunDiagnostics(
  scope: SessionScope,
  stored: StoredSystemTestRun,
  summary: unknown
): Promise<void> {
  if (!failedSummary(summary)) return;
  try {
    const result = await evalExecutorFor(scope)({
      ...startRouting(scope, stored),
      runId: randomUUID(),
      source: {
        kind: "inline",
        code: readCode(stored.runId, "inspectSystemTestRun(record, {})"),
        syntax: "typescript",
      },
      timeoutMs: SYSTEM_TEST_INSPECTION_TIMEOUT_MS,
    });
    if (!result.success) return;
    const packet = await expandTruncatedReturn(scope, stored, result.returnValue);
    writeSystemTestArtifact(stored.runId, "inspect", packet, stored.artifactDir);
  } catch {
    // Best effort: a run that cannot be inspected here is still reportable, and
    // failing the run over its own post-mortem would be worse than the gap.
  }
}

/**
 * The retained packet, used only when the producing workspace is gone. A live
 * workspace always answers first, so this never shadows fresher evidence.
 */
function retainedInspection(
  inv: ParsedInvocation,
  testName: string | undefined
): { value: unknown; artifact: string } | null {
  if (testName) return null;
  let runId: string;
  try {
    runId = requireRunId(inv);
  } catch {
    return null;
  }
  const stored = loadSystemTestRun(runId);
  const dir = storedArtifactDir(runId, stored);
  const value = loadSystemTestArtifact(runId, "inspect", dir);
  return value === null
    ? null
    : { value, artifact: path.join(systemTestArtifactDir(runId, dir), "inspect.json") };
}

async function inspect(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const testName = typeof inv.flags["test"] === "string" ? inv.flags["test"] : undefined;
    const retained = retainedInspection(inv, testName);
    if (retained) {
      printResult(retained.value, {
        json,
        human: () => {
          console.log(JSON.stringify(retained.value, null, 2));
          console.log(
            `retained: ${retained.artifact} (the workspace that ran this no longer has it)`
          );
        },
      });
      return 0;
    }
    const inspectExpression = `inspectSystemTestRun(record, ${
      testName ? `{ testName: ${JSON.stringify(testName)} }` : "{}"
    })`;
    const { runId, stored, value } = await readPersisted(
      inv,
      (id) => readCode(id, inspectExpression),
      (progress) => {
        const live = progress["liveInspection"] as Record<string, unknown> | undefined;
        if (!live) return undefined;
        if (!testName) return live["inspect"];
        const byTest = live["inspectByTest"] as Record<string, unknown> | undefined;
        if (byTest?.[testName] !== undefined) return byTest[testName];
        const trajectories = live["trajectories"] as Record<string, unknown> | undefined;
        const row = trajectories?.[testName] as Record<string, unknown> | undefined;
        return row?.["bounded"];
      },
      (id, start, end, pageKey) =>
        readCode(id, systemTestJsonPageExpression(inspectExpression, start, end, pageKey))
    );
    const artifact = writeSystemTestArtifact(
      runId,
      testName ? `inspect-${safeName(testName)}` : "inspect",
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
    const trajectoryExpression = `systemTestTrajectory(record, ${JSON.stringify(testName)}, { full: ${full ? "true" : "false"} })`;
    const { runId, stored, value } = await readPersisted(
      inv,
      (id) => readCode(id, trajectoryExpression),
      (progress) => {
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
      },
      full
        ? (id, start, end, pageKey) =>
            readCode(id, systemTestJsonPageExpression(trajectoryExpression, start, end, pageKey))
        : undefined
    );
    const artifact = writeSystemTestArtifact(
      runId,
      `trajectory-${safeName(testName)}${full ? "-full" : ""}`,
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
        : ((
            await readPersisted(inv, (id) =>
              readCode(id, "({ config: record.config, names: failedSystemTestNames(record) })")
            )
          ).value as { config?: StoredSystemTestRun["config"]; names?: string[] });
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
        evalClientFor(scope),
        routing(scope, stored),
        stored.runId,
        positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS,
        scope.client
      );
      if (await signalCancellation.ensureCancellation()) return 130;
      const result = resultValue(state);
      const artifact = writeSystemTestArtifact(stored.runId, "summary", result, stored.artifactDir);
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
    const value = await evalClientFor(scope).cancel({ ...routing(scope, stored), runId });
    printResult({ runId, ...value }, { json });
    return value.ok ? 0 : 1;
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
        scope.client.callTarget(runner.targetId, "doctor", [
          typeof inv.flags["model"] === "string" ? inv.flags["model"] : undefined,
        ]);
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
  startupApprovals: { approvedReviewIds: string[]; approvedPartCount: number };
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
    if (!result.ok && !waitingForBuilds) {
      return {
        doctor: result,
        startupApprovals: {
          approvedReviewIds: [...approved],
          approvedPartCount,
        },
      };
    }
    const reviewPreparationComplete =
      reviewState.status === "not-required" || reviewState.status === "resolved";
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
  const claudeCodeWaiting =
    structuredStatuses.some(
      ({ source, name, status }) =>
        (source === "extensions/claude-code" || name === "@workspace-extensions/claude-code") &&
        transientStates.test(status)
    ) ||
    (!requiredExtensions.ok &&
      /claude-code[^,;]*(?:missing|pending-approval|approval-required|building)/u.test(
        requiredExtensions.detail
      ));
  return failures.every(
    (check) =>
      check === requiredExtensions ||
      (check.name === "claude-code-extension" &&
        claudeCodeWaiting &&
        /(?:pending-approval|approval-required|not installed|no active approved build)/u.test(
          check.detail
        ))
  );
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
  const events = new EventsClient(eventRpc);
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
