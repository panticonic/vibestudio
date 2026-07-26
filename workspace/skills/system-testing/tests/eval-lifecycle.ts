import type { TestCase, TestExecutionResult, TestOrchestrationContext } from "../types.js";
import { getToolCalls } from "./_helpers.js";
import {
  completedScenarioEvidence,
  invocationReturnValue,
  walkArrays,
  walkRecords,
} from "./_scenario-evidence.js";

function successfulEvalCalls(result: TestExecutionResult) {
  return getToolCalls(result).filter(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
}

function invocationKernelIncarnation(call: ReturnType<typeof getToolCalls>[number]): string | null {
  const result = call.execution?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const details = (result as Record<string, unknown>)["details"];
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const kernel = (details as Record<string, unknown>)["kernel"];
  if (!kernel || typeof kernel !== "object" || Array.isArray(kernel)) return null;
  const incarnationId = (kernel as Record<string, unknown>)["incarnationId"];
  return typeof incarnationId === "string" && incarnationId.length > 0 ? incarnationId : null;
}

function validateDbPersistence(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const calls = successfulEvalCalls(result);
  if (calls.length < 2) {
    return {
      passed: false,
      reason: "Database persistence was not exercised across separate eval calls",
    };
  }
  const writer = calls.findIndex((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      /\bCREATE\b/iu.test(code) && /\bINSERT\b/iu.test(code) && /\bdb\.(?:run|exec)\b/u.test(code)
    );
  });
  const reader = calls.findIndex((call, index) => {
    const code = String(call.arguments?.["code"] ?? "");
    return index > writer && /\bSELECT\b/iu.test(code) && /\bdb\.exec\b/u.test(code);
  });
  const readerCall = calls[reader];
  if (writer < 0 || reader < 0 || !readerCall) {
    return {
      passed: false,
      reason: "Separate eval calls did not write and later read the local database",
    };
  }
  const readValue = invocationReturnValue(readerCall);
  return readValue.present && walkArrays([readValue.value]).some((rows) => rows.length >= 1)
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The later database read did not return the persisted rows" };
}

async function orchestrateDbPersistence(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const session = await context.runner.spawn();
  let error: string | undefined;
  try {
    await context.sendAndWait(
      session,
      "Using exactly one eval call, use synchronous db.run to create a table named system_test_eval_db and insert the row ('probe', 'DB_PERSISTENCE_OK'). Return the inserted value. Do not inspect the API or make any other tool call.",
      "write eval database row"
    );
    await context.sendAndWait(
      session,
      "Using exactly one separate eval call, read system_test_eval_db with db.exec, which directly returns an array of rows. Return that array unchanged. Do not write or recreate the row.",
      "read eval database row"
    );
  } catch (cause) {
    error = formatError(cause);
  }
  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    ...(error ? { error } : {}),
  };
  try {
    await session.close();
  } catch (cause) {
    execution.cleanupErrors = [`close: ${formatError(cause)}`];
  }
  return execution;
}

function resetResultProvesFresh(result: TestExecutionResult, resetCallIndex: number): boolean {
  const resetCall = successfulEvalCalls(result)[resetCallIndex];
  if (!resetCall) return false;
  const returned = invocationReturnValue(resetCall);
  const values = returned.present ? [returned.value] : [];
  return (
    values.some((value) => value === false || value === null) ||
    walkArrays(values).some((value) => value.length === 0) ||
    walkRecords(values).some(
      (record) =>
        record["fresh"] === true ||
        record["present"] === false ||
        record["exists"] === false ||
        record["oldValue"] === null
    )
  );
}

function validateScopeReset(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const calls = successfulEvalCalls(result);
  const resetIndex = calls.findIndex(
    (call, index) => index >= 2 && call.arguments?.["reset"] === true
  );
  if (resetIndex < 2) {
    return {
      passed: false,
      reason:
        "A successful atomic reset did not follow separate scope write and confirmation calls",
    };
  }
  const priorCode = calls
    .slice(0, resetIndex)
    .map((call) => String(call.arguments?.["code"] ?? ""));
  if (
    !priorCode.some((code) => /scope\s*(?:\.|\[)/u.test(code)) ||
    !priorCode.slice(1).some((code) => /scope\s*(?:\.|\[)/u.test(code))
  ) {
    return {
      passed: false,
      reason: "Persistent scope was not written and observed in separate calls",
    };
  }
  return resetResultProvesFresh(result, resetIndex)
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The reset call did not return evidence that the old scope value is absent",
      };
}

function validateCancellation(result: TestExecutionResult) {
  if (result.error) return { passed: false, reason: result.error };
  const probe = result.diagnostics?.["evalCancellation"];
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    return { passed: false, reason: "The harness did not record eval cancellation evidence" };
  }
  const record = probe as {
    runId?: unknown;
    cancel?: { ok?: unknown; forcedReset?: unknown };
    terminal?: { status?: unknown };
  };
  if (
    typeof record.runId !== "string" ||
    record.cancel?.ok !== true ||
    record.cancel.forcedReset !== false ||
    record.terminal?.status !== "cancelled"
  ) {
    return {
      passed: false,
      reason: `Expected one cooperative cancelled terminal without a forced reset; observed ${JSON.stringify(
        probe
      )}`,
    };
  }
  return { passed: true, reason: undefined };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function orchestrateCancellation(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  try {
    const probe = await context.runner.probeEvalCancellation();
    return {
      messages: [],
      duration: Date.now() - startedAt,
      diagnostics: { evalCancellation: probe },
    };
  } catch (cause) {
    return {
      messages: [],
      duration: Date.now() - startedAt,
      error: formatError(cause),
    };
  }
}

async function orchestrateLiveKernelContinuity(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const session = await context.runner.spawn();
  let error: string | undefined;
  try {
    await context.sendAndWait(
      session,
      "Using exactly one eval call, assign scope.__kernelContinuityProbe to a live object with a ping method that returns the string LIVE_KERNEL_OK. Return its method type and result. Do not use db or a second eval.",
      "create live notebook object"
    );
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    await context.sendAndWait(
      session,
      "Without assigning, recreating, or replacing scope.__kernelContinuityProbe, use exactly one eval call to invoke its existing ping method and return { methodType, value }. If it is missing, report that failure rather than reconstructing it.",
      "invoke live notebook object after idle"
    );
  } catch (cause) {
    error = formatError(cause);
  }

  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    ...(error ? { error } : {}),
  };
  try {
    await session.close();
  } catch (cause) {
    execution.cleanupErrors = [`close: ${formatError(cause)}`];
  }
  const cleanupErrors = session
    .snapshot()
    .cleanupErrors.map((entry) => `${entry.phase}: ${entry.message}`);
  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = [...(execution.cleanupErrors ?? []), ...cleanupErrors];
    execution.error ??= `Headless cleanup failed: ${cleanupErrors.join("; ")}`;
  }
  return execution;
}

function validateLiveKernelContinuity(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const calls = successfulEvalCalls(result);
  const writer = calls.findIndex((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return /scope\.__kernelContinuityProbe\s*=/u.test(code) && /\bping\b/u.test(code);
  });
  const reader = calls.findIndex((call, index) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      index > writer &&
      /scope\.__kernelContinuityProbe\b/u.test(code) &&
      /\.ping\s*\(/u.test(code) &&
      !/scope\.__kernelContinuityProbe\s*=/u.test(code)
    );
  });
  const writerCall = calls[writer];
  const readerCall = calls[reader];
  if (writer < 0 || reader < 0 || !writerCall || !readerCall) {
    return {
      passed: false,
      reason: "The agent did not create and later invoke one unchanged live scope object",
    };
  }
  const writerIncarnation = invocationKernelIncarnation(writerCall);
  const readerIncarnation = invocationKernelIncarnation(readerCall);
  if (!writerIncarnation || !readerIncarnation || writerIncarnation !== readerIncarnation) {
    return {
      passed: false,
      reason: "The eval kernel incarnation changed across the inter-cell idle boundary",
    };
  }
  const returned = invocationReturnValue(readerCall);
  const records = returned.present ? walkRecords([returned.value]) : [];
  return records.some(
    (record) => record["methodType"] === "function" && record["value"] === "LIVE_KERNEL_OK"
  )
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The live scope object's method did not survive the 15-second inter-cell idle",
      };
}

export const evalLifecycleTests: TestCase[] = [
  {
    name: "eval-live-kernel-continuity",
    description: "A live scope object retains its methods across idle eval cells",
    category: "eval-lifecycle",
    prompt: "Harness-orchestrated live notebook continuity check.",
    orchestrate: orchestrateLiveKernelContinuity,
    validate: validateLiveKernelContinuity,
  },
  {
    name: "eval-db-persistence",
    description: "The eval-local database persists rows across separate eval calls",
    category: "eval-lifecycle",
    prompt: "Harness-orchestrated eval database continuity check.",
    orchestrate: orchestrateDbPersistence,
    validate: validateDbPersistence,
  },
  {
    name: "eval-scope-reset",
    description: "Resetting the sandbox produces a genuinely fresh persistent scope",
    category: "eval-lifecycle",
    prompt:
      "Put a value in persistent sandbox scope, confirm it later, reset the sandbox, and check whether the old value remains.",
    validate: validateScopeReset,
  },
  {
    name: "eval-cancel-run",
    description: "A long-running sandbox run can be cancelled and the cancellation is visible",
    category: "eval-lifecycle",
    prompt: "Harness-orchestrated asynchronous eval cancellation check.",
    orchestrate: orchestrateCancellation,
    validate: validateCancellation,
  },
];
