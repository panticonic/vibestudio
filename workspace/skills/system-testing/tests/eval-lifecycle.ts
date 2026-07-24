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
    return /\bCREATE\b/iu.test(code) && /\bINSERT\b/iu.test(code) && /\bdb\.run\b/u.test(code);
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
  return readValue.present && walkArrays([readValue.value]).some((rows) => rows.length >= 2)
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The later database read did not return the persisted rows" };
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
  const resetIndex = calls.findIndex((call) => call.arguments?.["reset"] === true);
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

function cancellationText(call: ReturnType<typeof getToolCalls>[number]): string {
  return JSON.stringify({
    outcome: call.execution?.terminalOutcome,
    result: call.execution?.result,
    error: call.execution?.error,
  });
}

function validateCancellation(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, [], {
    allowFailed: (call) => call.name === "eval" && /cancel|abort/iu.test(cancellationText(call)),
  });
  if (!base.passed) return base;
  const cancelled = getToolCalls(result).filter(
    (call) =>
      call.name === "eval" &&
      (call.execution?.isError === true ||
        call.execution?.status === "error" ||
        call.execution?.status === "failed" ||
        call.execution?.status === "cancelled" ||
        call.execution?.terminalOutcome === "cancelled") &&
      /cancel|abort/iu.test(cancellationText(call))
  );
  return cancelled.length === 1
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: `Expected exactly one terminal cancelled eval invocation; observed ${cancelled.length}`,
      };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      /scope\.__kernelContinuityProbe(?:\?|\.)[\s\S]*\.?ping\s*\(/u.test(code) &&
      !/scope\.__kernelContinuityProbe\s*=/u.test(code)
    );
  });
  const readerCall = calls[reader];
  if (writer < 0 || reader < 0 || !readerCall) {
    return {
      passed: false,
      reason: "The agent did not create and later invoke one unchanged live scope object",
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
    prompt: "Show whether the sandbox local database retains rows between separate evaluations.",
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
    prompt:
      "Start cancellable long-running sandbox work, cancel it, verify its terminal state, and leave nothing pending.",
    expectedToolFailures: [{ name: "eval", errorIncludes: "cancel" }],
    validate: validateCancellation,
  },
];
