import { rpc, workers, workspace } from "@workspace/runtime";
import { logIdForChannel } from "@vibestudio/trajectory-identity";
import { summarizeEntry, summarizeFailures, type DiagnosticLimits } from "./diagnostics.js";
import { HeadlessRunner } from "./runner.js";
import { allTests } from "./stages.js";
import { TestRunner } from "./test-runner.js";
import type { TestCase, TestSuiteResult, TestSuiteResultEntry } from "./types.js";
import { SYSTEM_TEST_AGENT_MODEL, systemTestModelRoute } from "./config.js";

export const SYSTEM_TEST_RUN_SCHEMA_VERSION = 1 as const;

export interface SystemTestDescriptor {
  name: string;
  category: string;
  description: string;
  orchestrated: boolean;
}

export interface SystemTestRunOptions {
  runId: string;
  contextId: string;
  names?: string[];
  category?: string;
  all?: boolean;
  model?: string;
  concurrency?: number;
  testTimeoutMs?: number;
  /** Durable orchestration heartbeat supplied by CLI/UI hosts. */
  onProgress?: (progress: SystemTestRunProgress) => void | Promise<void>;
  /** EvalDO cancellation hook; lets a cancelled orchestration retire children before RPC abort. */
  registerCancellationCleanup?: (cleanup: () => Promise<SystemTestRunRecord | void>) => void;
  /** Periodic, non-blocking record used by the CLI to inspect a running case. */
  onInspectionUpdate?: (record: SystemTestRunRecord) => void | Promise<void>;
}

export interface SystemTestRunProgress {
  runId: string;
  status: "running" | "completed" | "cancelled" | "errored";
  startedAt: string;
  updatedAt: string;
  total: number;
  queued: string[];
  running: Array<{ name: string; category: string; startedAt: string }>;
  completed: Array<{
    name: string;
    category: string;
    outcome: "passed" | "failed" | "errored";
    durationMs: number;
    reason?: string;
    channelId?: string;
  }>;
  error?: string;
}

export interface SystemTestRunSummary {
  runId: string;
  status: "running" | "completed" | "cancelled";
  total: number;
  passed: number;
  failed: number;
  errored: number;
  toolFailureCount: number;
  testsWithToolFailures: number;
  skipped: number;
  durationMs: number;
  failedTests: string[];
  testsWithUnexpectedToolFailures: string[];
}

export interface SystemTestRunRecord {
  schemaVersion: typeof SYSTEM_TEST_RUN_SCHEMA_VERSION;
  runId: string;
  status: "running" | "completed" | "cancelled";
  startedAt: string;
  /** Last durable observation/checkpoint time for every run state. */
  updatedAt: string;
  /** Present only after the run reaches a terminal state. */
  completedAt?: string;
  config: {
    contextId: string;
    names: string[];
    category?: string;
    all: boolean;
    model?: string;
    modelPolicy: ReturnType<HeadlessRunner["modelPolicySnapshot"]>;
    concurrency: number;
    testTimeoutMs?: number;
  };
  provenance: {
    connection?: unknown;
    connectionError?: string;
    systemTestingBuild?: unknown;
    buildError?: string;
  };
  summary: SystemTestRunSummary;
  suite: TestSuiteResult;
}

export interface SystemTestDoctorResult {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    data?: unknown;
  }>;
}

const DEFAULT_CONCURRENCY = 1;
const LIVE_COMPLETED_PROBLEM_LIMIT = 4;
const LIVE_MESSAGE_LIMIT = 20;
const LIVE_INVOCATION_LIMIT = 30;
const LIVE_DEBUG_EVENT_LIMIT = 40;

export function listSystemTests(): SystemTestDescriptor[] {
  return allTests().map((test) => ({
    name: test.name,
    category: test.category,
    description: test.description,
    orchestrated: typeof test.orchestrate === "function",
  }));
}

export async function runSystemTests(options: SystemTestRunOptions): Promise<SystemTestRunRecord> {
  const startedAt = new Date().toISOString();
  const selected = selectTests(options);
  const concurrency = normalizePositiveInt(options.concurrency, DEFAULT_CONCURRENCY);
  const testTimeoutMs =
    options.testTimeoutMs === undefined
      ? undefined
      : normalizePositiveInt(options.testTimeoutMs, options.testTimeoutMs);
  const provenance: SystemTestRunRecord["provenance"] = {};
  const queued = new Set(selected.map((test) => test.name));
  const running = new Map<string, { name: string; category: string; startedAt: string }>();
  const completed: SystemTestRunProgress["completed"] = [];
  const completedEntries: TestSuiteResultEntry[] = [];
  const publishProgress = async (status: SystemTestRunProgress["status"]): Promise<void> => {
    if (!options.onProgress) return;
    await options.onProgress({
      runId: options.runId,
      status,
      startedAt,
      updatedAt: new Date().toISOString(),
      total: selected.length,
      queued: [...queued],
      running: [...running.values()],
      completed: [...completed],
    });
  };
  const publishInBackground = (label: string, task: Promise<void>): void => {
    void task.catch((error: unknown) => {
      console.error(
        JSON.stringify({
          message: `system-test ${label} publication failed`,
          runId: options.runId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    });
  };
  await publishProgress("running");

  try {
    provenance.connection = await rpc.call("main", "auth.getConnectionInfo", []);
  } catch (error) {
    provenance.connectionError = error instanceof Error ? error.message : String(error);
  }
  try {
    provenance.systemTestingBuild = await rpc.call("main", "build.inspectBuildProvenance", [
      "@workspace-skills/system-testing",
    ]);
  } catch (error) {
    provenance.buildError = error instanceof Error ? error.message : String(error);
  }

  const model = options.model ?? SYSTEM_TEST_AGENT_MODEL;
  const runner = new HeadlessRunner(options.contextId, { model });
  const tester = new TestRunner(runner, {
    ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
    onTestStart: (test) => {
      queued.delete(test.name);
      running.set(test.name, {
        name: test.name,
        category: test.category,
        startedAt: new Date().toISOString(),
      });
      publishInBackground("progress", publishProgress("running"));
    },
    onTestResult: async (entry) => {
      completedEntries.push(entry);
      running.delete(entry.test.name);
      completed.push({
        name: entry.test.name,
        category: entry.test.category,
        outcome: entry.execution.error ? "errored" : entry.result.passed ? "passed" : "failed",
        durationMs: entry.execution.duration,
        ...(entry.result.reason ? { reason: entry.result.reason } : {}),
        ...(entry.execution.provenance?.channelId
          ? { channelId: entry.execution.provenance.channelId }
          : {}),
      });
      await publishProgress("running");
    },
  });
  let inspectionPublishing = false;
  const publishInspection = async (): Promise<void> => {
    if (!options.onInspectionUpdate || inspectionPublishing) return;
    inspectionPublishing = true;
    try {
      // Keep completed successes out of the heartbeat, but retain a bounded tail
      // of failures and unexpected tool failures. This makes an active suite's
      // first failure immediately inspectable without letting every heartbeat
      // grow with the total suite size.
      const results: TestSuiteResultEntry[] = completedEntries
        .filter(
          (entry) =>
            entry.execution.error != null ||
            !entry.result.passed ||
            (entry.execution.toolFailures?.length ?? 0) > 0
        )
        .slice(-LIVE_COMPLETED_PROBLEM_LIMIT)
        .map(boundedLiveEntry);
      const snapshots = runner.snapshotAll();
      for (const active of running.values()) {
        const test = selected.find((candidate) => candidate.name === active.name);
        const snapshot = snapshots.filter((row) => row.testName === active.name).at(-1)?.snapshot;
        if (!test || !snapshot) continue;
        results.push({
          test: {
            name: test.name,
            category: test.category,
            description: test.description,
            prompt: test.prompt,
          },
          result: { passed: false, reason: "System test is still running" },
          execution: {
            messages: [...snapshot.messages],
            duration: Math.max(0, Date.now() - Date.parse(active.startedAt)),
            snapshot,
            modelExecutionEvidence: snapshot.modelExecutionEvidence,
            provenance: snapshotProvenance(snapshot),
            toolFailures: snapshot.invocations
              .filter((invocation) => /failed|error|cancel/i.test(invocation.status))
              .map((invocation) => ({
                id: invocation.id,
                name: invocation.name,
                status: invocation.status,
                ...(invocation.error ? { error: invocation.error } : {}),
                source: "snapshot" as const,
              })),
          },
        });
      }
      const suite = suiteFromEntries(
        results,
        Math.max(0, listSystemTests().length - selected.length),
        Date.now() - Date.parse(startedAt)
      );
      await options.onInspectionUpdate({
        schemaVersion: SYSTEM_TEST_RUN_SCHEMA_VERSION,
        runId: options.runId,
        status: "running",
        startedAt,
        updatedAt: new Date().toISOString(),
        config: runConfig(options, selected, model, concurrency, testTimeoutMs, runner),
        provenance,
        summary: summarizeRun(options.runId, suite, "running"),
        suite,
      });
    } finally {
      inspectionPublishing = false;
    }
  };
  const inspectionTimer = options.onInspectionUpdate
    ? setInterval(() => publishInBackground("inspection", publishInspection()), 5_000)
    : undefined;
  let resolveTerminalRecord!: (record: SystemTestRunRecord | void) => void;
  const terminalRecord = new Promise<SystemTestRunRecord | void>((resolve) => {
    resolveTerminalRecord = resolve;
  });
  options.registerCancellationCleanup?.(async () => {
    tester.cancel(new Error(`System-test run ${options.runId} cancelled`));
    return await terminalRecord;
  });
  let suite: TestSuiteResult;
  try {
    suite = await runSelectedByCategory(tester, selected, concurrency);
  } catch (error) {
    resolveTerminalRecord();
    throw error;
  } finally {
    if (inspectionTimer !== undefined) clearInterval(inspectionTimer);
  }
  suite.skipped = Math.max(0, listSystemTests().length - selected.length);
  const status = tester.cancelled ? "cancelled" : "completed";
  const summary = summarizeRun(options.runId, suite, status);
  if (tester.cancelled) queued.clear();
  try {
    await publishProgress(status);
  } catch (error) {
    resolveTerminalRecord();
    throw error;
  }

  const completedAt = new Date().toISOString();
  const record: SystemTestRunRecord = {
    schemaVersion: SYSTEM_TEST_RUN_SCHEMA_VERSION,
    runId: options.runId,
    status,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    config: runConfig(options, selected, model, concurrency, testTimeoutMs, runner),
    provenance,
    summary,
    suite,
  };
  resolveTerminalRecord(record);
  return record;
}

function boundedLiveEntry(entry: TestSuiteResultEntry): TestSuiteResultEntry {
  const snapshot = entry.execution.snapshot;
  return {
    ...entry,
    execution: {
      ...entry.execution,
      messages: entry.execution.messages.slice(-LIVE_MESSAGE_LIMIT),
      ...(snapshot
        ? {
            snapshot: {
              ...snapshot,
              messages: snapshot.messages.slice(-LIVE_MESSAGE_LIMIT),
              invocations: snapshot.invocations.slice(-LIVE_INVOCATION_LIMIT),
              debugEvents: snapshot.debugEvents.slice(-LIVE_DEBUG_EVENT_LIMIT),
            },
          }
        : {}),
    },
  };
}

export function getSystemTestRun(runs: unknown, runId: string): SystemTestRunRecord | null {
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) return null;
  const record = (runs as Record<string, unknown>)[runId];
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const candidate = record as Partial<SystemTestRunRecord>;
  return candidate.schemaVersion === SYSTEM_TEST_RUN_SCHEMA_VERSION && candidate.runId === runId
    ? (candidate as SystemTestRunRecord)
    : null;
}

export function inspectSystemTestRun(
  record: SystemTestRunRecord,
  options?: { testName?: string; limits?: Partial<DiagnosticLimits> }
): unknown {
  if (options?.testName) {
    return summarizeEntry(requireEntry(record, options.testName), options.limits);
  }
  return {
    ...record.summary,
    config: record.config,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt ?? record.completedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    provenance: record.provenance,
    diagnostics: summarizeFailures(record.suite, options?.limits),
  };
}

export function systemTestTrajectory(
  record: SystemTestRunRecord,
  testName: string,
  options?: { full?: boolean; limits?: Partial<DiagnosticLimits> }
): unknown {
  const entry = requireEntry(record, testName);
  if (options?.full) return entry;
  return summarizeEntry(entry, options?.limits);
}

export function failedSystemTestNames(record: SystemTestRunRecord): string[] {
  return record.suite.results
    .filter(
      (entry) =>
        !entry.result.passed ||
        Boolean(entry.execution.error) ||
        (entry.execution.toolFailures ?? []).some((failure) => failure.expected !== true)
    )
    .map((entry) => entry.test.name);
}

export async function systemTestDoctor(
  expectedModel = SYSTEM_TEST_AGENT_MODEL
): Promise<SystemTestDoctorResult> {
  const checks: SystemTestDoctorResult["checks"] = [];
  const capture = async (name: string, operation: () => Promise<unknown>, detail: string) => {
    try {
      const data = await operation();
      checks.push({ name, ok: true, detail, data });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  checks.push({
    name: "test-catalog",
    ok: listSystemTests().length > 0,
    detail: `${listSystemTests().length} tests discovered`,
  });
  await capture(
    "server",
    () => rpc.call("main", "auth.getConnectionInfo", []),
    "server identity and workspace are reachable"
  );
  await capture(
    "system-testing-build",
    () => rpc.call("main", "build.inspectBuildProvenance", ["@workspace-skills/system-testing"]),
    "system-testing package is importable"
  );
  await capture(
    "agent-worker",
    async () => {
      const units = await workspace.units.list();
      const agentUnit = units.find(
        (unit) => unit.name === "workers/agent-worker" || unit.name.includes("agent-worker")
      );
      if (!agentUnit) throw new Error("workers/agent-worker is not registered");
      if (agentUnit.status === "error") {
        throw new Error(agentUnit.lastError || "workers/agent-worker is in error state");
      }
      return agentUnit;
    },
    "agent worker is registered"
  );
  await capture(
    "model",
    async () => {
      const modelRoute = systemTestModelRoute(expectedModel);
      const service = await workers.resolveService("vibestudio.models.v1", null);
      if (service.kind !== "durable-object" || !service.targetId) {
        throw new Error("vibestudio.models.v1 did not resolve to a Durable Object");
      }
      const settings = (await rpc.call(service.targetId, "getDefaultModel", [])) as {
        defaultModel?: string;
        catalog?: { models?: Array<{ ref?: string; availability?: { state?: string } }> };
      };
      const required = [
        modelRoute.primaryModel,
        ...(modelRoute.fallbackModel ? [modelRoute.fallbackModel] : []),
      ];
      const availability = required.map((modelRef) => {
        const selected = settings.catalog?.models?.find((model) => model.ref === modelRef);
        return { model: modelRef, availability: selected?.availability?.state ?? "unknown" };
      });
      const unusable = availability.find(
        (entry) => entry.availability !== "ready" && entry.availability !== "startable"
      );
      if (unusable) {
        throw new Error(`model ${unusable.model} is not usable (${unusable.availability})`);
      }
      return {
        primary: availability[0],
        usageLimitFallback:
          modelRoute.fallbackModel === null
            ? null
            : {
                ...availability[1],
                thinkingLevel: modelRoute.fallbackThinkingLevel,
              },
      };
    },
    "system-test agent models are configured and credentialed"
  );

  return { ok: checks.every((check) => check.ok), checks };
}

function selectTests(options: SystemTestRunOptions): TestCase[] {
  const tests = allTests();
  const names = [...new Set((options.names ?? []).filter(Boolean))];
  const known = new Map(tests.map((test) => [test.name, test]));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown system test(s): ${unknown.join(", ")}`);

  let selected = options.all === true ? tests : names.map((name) => known.get(name)!);
  if (options.category) {
    selected = (options.all === true || names.length === 0 ? tests : selected).filter(
      (test) => test.category === options.category
    );
  }
  if (selected.length === 0) {
    throw new Error("No system tests selected; pass exact names, a category, or all=true");
  }
  return selected;
}

function summarizeRun(
  runId: string,
  suite: TestSuiteResult,
  status: SystemTestRunSummary["status"]
): SystemTestRunSummary {
  const failedTests = suite.results
    .filter((entry) => !entry.result.passed || Boolean(entry.execution.error))
    .map((entry) => entry.test.name);
  const testsWithUnexpectedToolFailures = suite.results
    .filter((entry) =>
      (entry.execution.toolFailures ?? []).some((failure) => failure.expected !== true)
    )
    .map((entry) => entry.test.name);
  return {
    runId,
    status,
    total: suite.total,
    passed: suite.passed,
    failed: suite.failed,
    errored: suite.errored,
    toolFailureCount: suite.toolFailureCount ?? 0,
    testsWithToolFailures: suite.testsWithToolFailures ?? 0,
    skipped: suite.skipped,
    durationMs: suite.duration,
    failedTests,
    testsWithUnexpectedToolFailures,
  };
}

function runConfig(
  options: SystemTestRunOptions,
  selected: TestCase[],
  model: string,
  concurrency: number,
  testTimeoutMs: number | undefined,
  runner: HeadlessRunner
): SystemTestRunRecord["config"] {
  return {
    contextId: options.contextId,
    names: selected.map((test) => test.name),
    ...(options.category ? { category: options.category } : {}),
    all: options.all === true,
    model,
    modelPolicy: runner.modelPolicySnapshot(),
    concurrency,
    ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
  };
}

function snapshotProvenance(snapshot: import("@workspace/agentic-session").SessionSnapshot) {
  return {
    channelId: snapshot.channelId,
    branchId: snapshot.channelId ? logIdForChannel(snapshot.channelId) : null,
    agentEntityId: snapshot.agentEntityId,
    agentTargetId: snapshot.agentTargetId,
    contextId: snapshot.agentContextId,
  };
}

function suiteFromEntries(
  results: TestSuiteResultEntry[],
  skipped: number,
  duration: number
): TestSuiteResult {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let toolFailureCount = 0;
  let testsWithToolFailures = 0;
  for (const entry of results) {
    if (entry.execution.error) errored++;
    else if (entry.result.passed) passed++;
    else failed++;
    const failures = (entry.execution.toolFailures ?? []).filter(
      (failure) => failure.expected !== true
    ).length;
    toolFailureCount += failures;
    if (failures > 0) testsWithToolFailures++;
  }
  return {
    total: results.length,
    passed,
    failed,
    errored,
    toolFailureCount,
    testsWithToolFailures,
    skipped,
    duration,
    results,
  };
}

async function runSelectedByCategory(
  tester: TestRunner,
  selected: TestCase[],
  concurrency: number
): Promise<TestSuiteResult> {
  const startedAt = Date.now();
  const aggregate: TestSuiteResult = {
    total: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    toolFailureCount: 0,
    testsWithToolFailures: 0,
    skipped: 0,
    duration: 0,
    results: [],
  };
  const categories = [...new Set(selected.map((test) => test.category))];
  for (const category of categories) {
    const tests = selected.filter((test) => test.category === category);
    const partial = await tester.runSuite(tests, {
      concurrency: category === "workers" ? 1 : Math.min(concurrency, tests.length),
    });
    aggregate.total += partial.total;
    aggregate.passed += partial.passed;
    aggregate.failed += partial.failed;
    aggregate.errored += partial.errored;
    aggregate.toolFailureCount =
      (aggregate.toolFailureCount ?? 0) + (partial.toolFailureCount ?? 0);
    aggregate.testsWithToolFailures =
      (aggregate.testsWithToolFailures ?? 0) + (partial.testsWithToolFailures ?? 0);
    aggregate.results.push(...partial.results);
  }
  aggregate.duration = Date.now() - startedAt;
  return aggregate;
}

function requireEntry(record: SystemTestRunRecord, testName: string): TestSuiteResultEntry {
  const entry = record.suite.results.find((candidate) => candidate.test.name === testName);
  if (!entry) throw new Error(`Run ${record.runId} has no test named ${testName}`);
  return entry;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}
