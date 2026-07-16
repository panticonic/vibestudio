import { randomUUID } from "node:crypto";
import { evalMethods } from "@vibestudio/service-schemas/eval";
import { executeEval } from "@vibestudio/service-schemas/clients/evalClient";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import { CliError, UsageError, jsonMode, printError, printResult } from "./output.js";
import {
  DEFAULT_SESSION,
  findContextMarker,
  resolveSessionScope,
  SCOPE_FLAGS,
  type SessionScope,
} from "./agent/sessionContext.js";
import { ensureNamedAgentSession } from "./agent/index.js";
import { loadCliCredentials } from "./credentialStore.js";
import { RpcClient } from "@vibestudio/direct-client";
import { loadAgentSession } from "./sessionStore.js";
import { typedClient } from "./typedClients.js";
import { resolveVerifiedLocalWorkspaceClient } from "./verifiedLocalWorkspaceClient.js";
import {
  loadSystemTestRun,
  loadSystemTestArtifact,
  listSystemTestRuns,
  saveSystemTestRun,
  saveSystemTestTarget,
  systemTestArtifactDir,
  systemTestRunDir,
  writeSystemTestArtifact,
  type StoredSystemTestRun,
} from "./systemTestStore.js";

type EvalClient = ReturnType<typeof evalClientFor>;
type EvalStatus = Awaited<ReturnType<EvalClient["get"]>>;

const DEFAULT_POLL_MS = 1_000;
// Stay below EvalDO's 60k structured-return preview threshold even after wire
// serialization. Pages are returned as UTF-16LE base64 (2 bytes per JS code
// unit, then 4/3 expansion), so 20k source chars remain ~53.4k plus a tiny
// object envelope regardless of quotes, backslashes, control chars, or Unicode.
const EVAL_RETURN_PAGE_CHARS = 20_000;
// Once the first eval has cached the source string, direct owner-scoped scope
// reads bypass the EvalDO run-result envelope. A 128 Ki-code-unit page becomes
// ~342 KiB as UTF-16LE base64, comfortably bounded while reducing round trips.
const DIRECT_SCOPE_PAGE_CHARS = 128 * 1024;

function evalClientFor(scope: SessionScope) {
  return typedClient("eval", evalMethods, scope.client);
}

const SYSTEM_TEST_SESSION = "system-tests";

async function resolveSystemTestScope(
  inv: ParsedInvocation,
  preferredSession = SYSTEM_TEST_SESSION
): Promise<SessionScope> {
  const credentials = loadCliCredentials();
  const localResolution = credentials
    ? await resolveVerifiedLocalWorkspaceClient(credentials)
    : { local: null };
  if (localResolution.unavailableReason) {
    console.warn(
      `[system-test] doctor-verified local gateway became unavailable: ${localResolution.unavailableReason}; ` +
        "continuing over the paired transport"
    );
  }
  const localClient = localResolution.local?.client;
  const explicitSession =
    typeof inv.flags["session"] === "string" ? inv.flags["session"] : undefined;
  if (explicitSession) {
    await ensureNamedAgentSession(explicitSession, localClient);
    return replaceScopeClient(resolveSessionScope(inv), localClient);
  }

  // System tests are a self-contained CLI workflow. When no ordinary scope
  // source exists, create/recover a dedicated session instead of requiring a
  // prior `agent attach default`. Preserve explicit context, agent-token,
  // mirrored-folder, and an existing default-session precedence.
  const hasNonSessionAmbientScope =
    typeof inv.flags["context"] === "string" ||
    Boolean(process.env["VIBESTUDIO_AGENT_TOKEN"]) ||
    findContextMarker() !== null;
  if (!hasNonSessionAmbientScope && loadAgentSession(DEFAULT_SESSION) !== null) {
    // A disposable checkout restart retires its runtime entities while the
    // local session file necessarily survives. Reconcile before selecting the
    // context so doctor/list/run never issue eval.start against a dead owner.
    await ensureNamedAgentSession(DEFAULT_SESSION, localClient);
    return replaceScopeClient(resolveSessionScope(inv), localClient);
  }
  if (!hasNonSessionAmbientScope) {
    await ensureNamedAgentSession(preferredSession, localClient);
    return replaceScopeClient(
      resolveSessionScope({
        ...inv,
        flags: { ...inv.flags, session: preferredSession },
      }),
      localClient
    );
  }
  return replaceScopeClient(resolveSessionScope(inv), localClient);
}

function replaceScopeClient(scope: SessionScope, client?: RpcClient): SessionScope {
  if (!client) return scope;
  // resolveSessionScope constructs its transport lazily. Replacing it here does
  // not open WebRTC, and closing remains correct if that implementation changes.
  void scope.client.close().catch(() => undefined);
  return { ...scope, client };
}

function isLoopbackServerUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
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

function approvalPolicy(inv: ParsedInvocation): "fail-fast" | "wait" | "reachable" {
  const value = inv.flags["approval-policy"] ?? "fail-fast";
  if (value === "fail-fast" || value === "wait" || value === "reachable") return value;
  throw new UsageError("--approval-policy must be fail-fast, wait, or reachable");
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
    target: {
      kind: "attached-session" as const,
      ownerId: stored?.ownerId ?? scope.session.entityId,
      // A session entity and its eval scope are durable, but its context is not:
      // always route an old run through the owner's current registered context.
      contextId: scope.contextId,
    },
    scope: { key: stored?.subKey ?? scope.session.scopeKey },
  };
}

async function executeSystemEval(
  scope: SessionScope,
  code: string,
  stored?: StoredSystemTestRun | null
) {
  return await executeEval(evalClientFor(scope), {
    ...routing(scope, stored),
    source: { kind: "inline", code, syntax: "typescript" },
  });
}

function runCode(runId: string, config: StoredSystemTestRun["config"]): string {
  const options = JSON.stringify({ runId, ...config });
  return `
    import {
      inspectSystemTestRun,
      runSystemTests,
      systemTestTrajectory,
    } from "@workspace-skills/system-testing/cli";
    const progressKey = ${JSON.stringify(runId)};
    const durableHeartbeatLimit = 220 * 1024;
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
    try {
      const record = await runSystemTests({
        ...${options},
        contextId: ctx.contextId,
        signal: ctx.signal,
        onProgress: publishProgress,
        onInspectionUpdate: (liveRecord) => {
          const limits = { failures: 2, messages: 4, invocations: 6, debugEvents: 6, text: 300 };
          const inspect = inspectSystemTestRun(liveRecord, { limits });
          const base = { ...(lastProgress || {}) };
          const trajectories = {};
          for (const entry of liveRecord.suite.results) {
            const name = entry.test.name;
            const candidate = {
              ...trajectories,
              [name]: { bounded: systemTestTrajectory(liveRecord, name, { limits }) },
            };
            const heartbeat = { ...base, liveInspection: { inspect, trajectories: candidate } };
            if (JSON.stringify(heartbeat).length <= durableHeartbeatLimit) {
              Object.assign(trajectories, candidate);
            }
          }
          publishProgress({
            ...base,
            liveInspection: { inspect, trajectories },
          });
        },
        registerTerminalCleanup: (cleanup) => ctx.onCleanup(async () => {
          const cancelledRecord = await cleanup();
          if (cancelledRecord) {
            const runs = scope.systemTestRuns && typeof scope.systemTestRuns === "object"
              ? scope.systemTestRuns
              : {};
            runs[progressKey] = cancelledRecord;
            scope.systemTestRuns = runs;
          }
        }),
      });
      const runs = scope.systemTestRuns && typeof scope.systemTestRuns === "object"
        ? scope.systemTestRuns
        : {};
      runs[progressKey] = record;
      scope.systemTestRuns = runs;
      return record.summary;
    } catch (error) {
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

function pagedReadCode(
  runId: string,
  expression: string,
  start: number,
  end: number,
  pageKey: string,
  description: string
): string {
  return readCode(
    runId,
    `(() => {
      const pageKey = ${JSON.stringify(pageKey)};
      if (!Object.prototype.hasOwnProperty.call(scope, pageKey)) {
        const value = ${expression};
        scope[pageKey] = JSON.stringify(value, null, 2);
      }
      const source = scope[pageKey];
      if (typeof source !== "string") {
        throw new Error(${JSON.stringify(`Cached system-test ${description} is not text`)});
      }
      const chunk = source.slice(${start}, ${end});
      return {
        length: source.length,
        encoding: "utf16le-base64",
        chunk: Buffer.from(chunk, "utf16le").toString("base64"),
      };
    })()`
  );
}

async function startSystemTestRun(
  scope: SessionScope,
  config: StoredSystemTestRun["config"],
  artifactRoot?: string
): Promise<StoredSystemTestRun> {
  const runId = `st_${randomUUID().replaceAll("-", "")}`;
  const client = evalClientFor(scope);
  const handle = await client.start({
    ...routing(scope),
    source: { kind: "inline", code: runCode(runId, config), syntax: "typescript" },
    idempotencyKey: runId,
  });
  const stored: StoredSystemTestRun = {
    schemaVersion: 2,
    runId,
    evalRunId: handle.runId,
    createdAt: Date.now(),
    serverUrl: scope.session.serverUrl,
    sessionName: scope.session.name,
    ownerId: scope.session.entityId,
    contextId: scope.contextId,
    subKey: scope.session.scopeKey,
    artifactDir: systemTestArtifactDir(runId, artifactRoot),
    config,
  };
  saveSystemTestRun(stored);
  return stored;
}

async function waitForRun(
  client: EvalClient,
  route: ReturnType<typeof routing>,
  runId: string,
  pollMs: number,
  connection: RpcClient,
  signal?: AbortSignal
): Promise<EvalStatus> {
  // Hold one transport for the bounded wait. Re-negotiating the single-peer
  // WebRTC room every second races signaling teardown and can starve an
  // independent inspector. Local headless runs normally use doctor's verified
  // direct gateway, so status/inspect/cancel remain concurrently available;
  // remote users who need that concurrency can start the durable run detached.
  const release = connection.retainConnection();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const status = await client.get({ ...route, runId });
      if (["succeeded", "failed", "cancelled", "expired", "interrupted"].includes(status.status)) {
        return status;
      }
      await new Promise<void>((resolve, reject) => {
        const complete = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(complete, pollMs);
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason ?? new Error("system-test wait interrupted"));
        };
        if (!signal) return;
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
  } finally {
    await release();
  }
}

async function waitForForegroundRun(
  client: EvalClient,
  route: ReturnType<typeof routing>,
  runId: string,
  pollMs: number,
  connection: RpcClient
): Promise<EvalStatus> {
  const controller = new AbortController();
  let interruptedBy: "SIGINT" | "SIGTERM" | null = null;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    if (controller.signal.aborted) return;
    interruptedBy = signal;
    controller.abort(new Error(`system-test foreground wait interrupted by ${signal}`));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await waitForRun(client, route, runId, pollMs, connection, controller.signal);
  } catch (error) {
    if (!interruptedBy) throw error;
    try {
      const cancellation = await client.cancel({ ...route, runId });
      throw new CliError(
        `system-test run cancellation ${cancellation.status} after ${interruptedBy}`
      );
    } catch (cancelError) {
      if (cancelError instanceof CliError) throw cancelError;
      throw new CliError(
        `could not cancel interrupted system-test run after ${interruptedBy}: ${
          cancelError instanceof Error ? cancelError.message : String(cancelError)
        }`
      );
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

function resultValue(status: EvalStatus): unknown {
  if (["cancelled", "expired", "interrupted"].includes(status.status)) {
    throw new CliError(status.terminalReason ?? `system-test run ${status.status}`);
  }
  if (status.status !== "succeeded" && status.status !== "failed") return undefined;
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
    const result = await executeSystemEval(
      scope,
      `
        import { listSystemTests } from "@workspace-skills/system-testing/cli";
        const category = ${JSON.stringify(typeof inv.flags["category"] === "string" ? inv.flags["category"] : null)};
        return listSystemTests().filter((test) => !category || test.category === category);
      `
    );
    if (!result.success) throw new CliError(result.error ?? "could not list system tests");
    const tests = result.returnValue;
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
    const config: StoredSystemTestRun["config"] = {
      names,
      ...(category ? { category } : {}),
      all,
      ...(typeof inv.flags["model"] === "string" ? { model: inv.flags["model"] } : {}),
      concurrency: positiveInt(inv, "concurrency", 1) ?? 1,
      ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
      approvalPolicy: approvalPolicy(inv),
    };
    const stored = await startSystemTestRun(scope, config, outDir(inv));
    if (inv.flags["detach"] === true) {
      const value = {
        runId: stored.runId,
        status: "running",
        artifactDir: stored.artifactDir,
      };
      printResult(value, { json });
      return 0;
    }
    const status = await waitForForegroundRun(
      evalClientFor(scope),
      routing(scope, stored),
      stored.evalRunId,
      positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS,
      scope.client
    );
    const value = resultValue(status);
    const artifact = writeSystemTestArtifact(stored.runId, "summary", value, stored.artifactDir);
    printRun(value, json, artifact);
    return failedSummary(value) ? 1 : 0;
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
            stored?.evalRunId ?? runId,
            positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS,
            scope.client
          )
        : await client.get({ ...routing(scope, stored), runId: stored?.evalRunId ?? runId });
    const progress = withElapsedProgress(state.progress);
    const value = {
      runId,
      status: state.status,
      ...(progress ? { progress } : {}),
      ...(state.status === "succeeded" && state.result?.success
        ? { summary: state.result.returnValue }
        : state.result?.error
          ? { error: state.result.error }
          : {}),
    };
    // Detached runs often outlive (or are followed by a restart of) an
    // ephemeral source workspace. Persist the terminal summary at the moment
    // status observes it so `rerun RUN_ID` can recover failed/tool-failure test
    // names without depending on the old EvalDO still existing.
    if (state.status === "succeeded" && state.result?.success) {
      writeSystemTestArtifact(
        runId,
        "summary",
        state.result.returnValue,
        storedArtifactDir(runId, stored)
      );
    }
    printResult(value, { json });
    if (["cancelled", "expired", "interrupted"].includes(state.status)) return 1;
    if (state.status === "succeeded" || state.status === "failed") {
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
        return {
          ...test,
          ...(testStartedAt ? { elapsedMs: Math.max(0, now - Date.parse(testStartedAt)) } : {}),
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
  if (!stored) throw new CliError(`no local metadata for system-test run ${runId}`);
  const outer = await evalClientFor(scope).get({
    ...routing(scope, stored),
    runId: stored.evalRunId,
  });
  if (!["succeeded", "failed", "cancelled", "expired", "interrupted"].includes(outer.status)) {
    const progress =
      outer.progress && typeof outer.progress === "object" && !Array.isArray(outer.progress)
        ? (outer.progress as Record<string, unknown>)
        : null;
    const live = progress && readLive ? readLive(progress) : undefined;
    if (live !== undefined) return { runId, stored, value: live };
    throw new CliError(
      `system-test run ${runId} is ${outer.status}; live inspection is not available yet, retry shortly`
    );
  }
  if (outer.status === "succeeded" || outer.status === "failed") resultValue(outer);
  const result = await executeSystemEval(scope, code(runId), stored);
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

async function expandTruncatedReturn(
  scope: SessionScope,
  stored: StoredSystemTestRun | null,
  value: unknown,
  pageCode?: (start: number, end: number, pageKey: string) => string
): Promise<unknown> {
  const truncated = truncatedReturn(value);
  if (!truncated) return value;

  // Ordinary large eval returns are recovered from scope.$lastReturn. Callers
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
      // The first page is an eval because it atomically snapshots either
      // `$lastReturn` or a deterministic reconstruction into `pageKey`. Every
      // subsequent page is a direct scope read: no compilation, no run row,
      // no result compaction, and no repeated trajectory serialization.
      let resolvedRow: {
        length?: unknown;
        chunk?: unknown;
        encoding?: unknown;
      } | null = null;
      if (offset === 0) {
        const page = await executeEval(client, {
          ...routing(scope, stored),
          source: {
            kind: "inline",
            syntax: "typescript",
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
                encoding: "utf16le-base64",
                chunk: Buffer.from(chunk, "utf16le").toString("base64"),
              };
            `,
          },
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
        resolvedRow.encoding !== "utf16le-base64"
      ) {
        throw new CliError("invalid page while retrieving large system-test result");
      }
      const decodedChunk = Buffer.from(resolvedRow.chunk, "base64").toString("utf16le");
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
    throw new CliError(
      `large system-test result is incomplete (expected ${reportedLength ?? truncated.originalChars} chars, received ${text.length})`
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

async function inspect(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const testName = typeof inv.flags["test"] === "string" ? inv.flags["test"] : undefined;
    const inspectExpression = `inspectSystemTestRun(record, ${testName ? `{ testName: ${JSON.stringify(testName)} }` : "{}"})`;
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
        pagedReadCode(id, inspectExpression, start, end, pageKey, "inspection")
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
            pagedReadCode(id, trajectoryExpression, start, end, pageKey, "trajectory")
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
    const nextApprovalPolicy =
      typeof inv.flags["approval-policy"] === "string" ? approvalPolicy(inv) : undefined;
    const stored = await startSystemTestRun(
      scope,
      {
        ...prior.config,
        names,
        all: false,
        ...(typeof inv.flags["model"] === "string" ? { model: inv.flags["model"] } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(nextApprovalPolicy !== undefined ? { approvalPolicy: nextApprovalPolicy } : {}),
      },
      outDir(inv)
    );
    if (inv.flags["detach"] === true) {
      printResult(
        { runId: stored.runId, rerunOf: sourceRunId, tests: names, status: "running" },
        { json }
      );
      return 0;
    }
    const state = await waitForForegroundRun(
      evalClientFor(scope),
      routing(scope, stored),
      stored.evalRunId,
      positiveInt(inv, "poll-ms", DEFAULT_POLL_MS) ?? DEFAULT_POLL_MS,
      scope.client
    );
    const result = resultValue(state);
    const artifact = writeSystemTestArtifact(stored.runId, "summary", result, stored.artifactDir);
    printRun(result, json, artifact);
    return failedSummary(result) ? 1 : 0;
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
    const value = await evalClientFor(scope).cancel({
      ...routing(scope, stored),
      runId: stored.evalRunId,
    });
    printResult({ runId, ...value }, { json });
    return value.status === "terminal" ? 1 : 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function doctor(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const scope = await resolveSystemTestScope(inv);
    const result = await executeSystemEval(
      scope,
      `
        import { systemTestDoctor } from "@workspace-skills/system-testing/cli";
        return await systemTestDoctor(${JSON.stringify(typeof inv.flags["model"] === "string" ? inv.flags["model"] : undefined)});
      `
    );
    if (!result.success) throw new CliError(result.error ?? "system-test doctor failed");
    const value = result.returnValue as {
      ok?: boolean;
      checks?: Array<{ name: string; ok: boolean; detail: string; data?: unknown }>;
    };
    const serverCheck = value.checks?.find((check) => check.name === "server" && check.ok);
    const server =
      serverCheck?.data && typeof serverCheck.data === "object" && !Array.isArray(serverCheck.data)
        ? (serverCheck.data as Record<string, unknown>)
        : null;
    const credentials = loadCliCredentials();
    if (
      credentials &&
      server &&
      isLoopbackServerUrl(server["serverUrl"]) &&
      server["serverId"] === credentials.serverId &&
      typeof server["serverBootId"] === "string" &&
      typeof server["workspaceId"] === "string"
    ) {
      saveSystemTestTarget({
        schemaVersion: 1,
        pairedUrl: credentials.url,
        workspaceName: credentials.workspaceName,
        serverUrl: server["serverUrl"],
        serverId: credentials.serverId,
        serverBootId: server["serverBootId"],
        workspaceId: server["workspaceId"],
        verifiedAt: Date.now(),
      });
    }
    printResult(value, {
      json,
      human: () => {
        for (const check of value.checks ?? []) {
          console.log(`${check.ok ? "PASS" : "FAIL"}\t${check.name}\t${check.detail}`);
        }
      },
    });
    return value.ok ? 0 : 1;
  } catch (error) {
    return printError(error, { json });
  }
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
  { name: "concurrency", takesValue: true, description: "Maximum concurrent test agents" },
  {
    name: "approval-policy",
    takesValue: true,
    description: "Approval handling: fail-fast (default), wait, or reachable",
  },
  {
    name: "test-timeout-ms",
    takesValue: true,
    description: "Optional operator-requested per-test cancellation deadline in milliseconds",
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
    usage: "vibestudio system-test doctor [--session NAME]",
    flags: [
      { name: "model", takesValue: true, description: "Require this model ref to be usable" },
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
    usage: "vibestudio system-test rerun RUN_ID [--detach]",
    flags: [
      { name: "model", takesValue: true },
      { name: "concurrency", takesValue: true },
      { name: "approval-policy", takesValue: true },
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
