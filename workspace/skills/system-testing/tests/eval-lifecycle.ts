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

function validateAgentReplay(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const probe = result.diagnostics?.["evalAgentReplay"];
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    return { passed: false, reason: "The harness did not record the exact vessel crash" };
  }
  const record = probe as {
    targetId?: unknown;
    invocationId?: unknown;
    statusBeforeAbort?: unknown;
    aborted?: unknown;
  };
  if (
    typeof record.targetId !== "string" ||
    typeof record.invocationId !== "string" ||
    (record.statusBeforeAbort !== "pending" && record.statusBeforeAbort !== "running") ||
    record.aborted !== true
  ) {
    return {
      passed: false,
      reason: `The vessel was not fault-aborted while its eval invocation was live: ${JSON.stringify(
        probe
      )}`,
    };
  }

  const allEvalCalls = getToolCalls(result).filter((call) => call.name === "eval");
  const uniqueEvalCalls = new Map(allEvalCalls.map((call) => [call.id, call]));
  if (uniqueEvalCalls.size !== 1 || allEvalCalls.length !== 1) {
    return {
      passed: false,
      reason: `Expected one durable eval invocation across replay; observed ${allEvalCalls.length} cards and ${uniqueEvalCalls.size} ids`,
    };
  }
  const [call] = [...uniqueEvalCalls.values()];
  if (
    !call ||
    call.id !== record.invocationId ||
    call.execution?.status !== "complete" ||
    call.execution.isError === true
  ) {
    return {
      passed: false,
      reason: "The original eval invocation did not settle successfully after vessel recovery",
    };
  }
  const returned = invocationReturnValue(call);
  const records = returned.present ? walkRecords([returned.value]) : [];
  return records.some(
    (value) => value["marker"] === "EVAL_AGENT_REPLAY_OK" && value["completionCount"] === 1
  )
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The recovered invocation lost its result or executed the eval more than once",
      };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authorityFrom(
  call: ReturnType<typeof getToolCalls>[number]
): Record<string, unknown> | null {
  const authority = call.arguments?.["authority"];
  return authority && typeof authority === "object" && !Array.isArray(authority)
    ? (authority as Record<string, unknown>)
    : null;
}

function exactPermissionsListIntent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return (
    intent["service"] === "permissions" &&
    intent["method"] === "list" &&
    Array.isArray(intent["args"]) &&
    intent["args"].length === 0
  );
}

function validateExactAuthority(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const call = successfulEvalCalls(result).find((candidate) => {
    const authority = authorityFrom(candidate);
    return Array.isArray(authority?.["requests"]);
  });
  const authority = call && authorityFrom(call);
  const requests = authority?.["requests"];
  if (
    !call ||
    authority?.["effects"] !== "read-only" ||
    authority?.["approvals"] !== "pregranted-only" ||
    !Array.isArray(requests) ||
    requests.length !== 1 ||
    JSON.stringify(requests[0]) !==
      JSON.stringify({
        capability: "permissions.read",
        resource: { kind: "exact", key: "permissions.read" },
      })
  ) {
    return { passed: false, reason: "Eval did not submit the exact read-only request allowlist" };
  }
  const returned = invocationReturnValue(call);
  return returned.present && Array.isArray(returned.value)
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Exact-authority eval did not return the structured permissions result",
      };
}

function validatePregrantedOnly(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const call = successfulEvalCalls(result).find(
    (candidate) => authorityFrom(candidate)?.["approvals"] === "pregranted-only"
  );
  const authority = call && authorityFrom(call);
  if (!call || !Array.isArray(authority?.["requests"]) || authority["requests"].length !== 0) {
    return {
      passed: false,
      reason: "The denied operation was not run under an empty pregranted-only request allowlist",
    };
  }
  const returned = invocationReturnValue(call);
  const records = returned.present ? walkRecords([returned.value]) : [];
  return records.some(
    (record) =>
      record["denied"] === true &&
      typeof record["message"] === "string" &&
      /authority|permission|grant|denied/iu.test(record["message"])
  )
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The ungranted operation did not return a structured authority denial",
      };
}

function validatePreauthorization(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const call = successfulEvalCalls(result).find((candidate) => {
    const preauthorize = authorityFrom(candidate)?.["preauthorize"];
    return Array.isArray(preauthorize) && preauthorize.some(exactPermissionsListIntent);
  });
  const authority = call && authorityFrom(call);
  const preauthorize = authority?.["preauthorize"];
  if (
    !call ||
    authority?.["approvals"] !== "prompt" ||
    !Array.isArray(preauthorize) ||
    preauthorize.length !== 1 ||
    !exactPermissionsListIntent(preauthorize[0])
  ) {
    return {
      passed: false,
      reason: "Eval did not preauthorize the exact permissions.list invocation",
    };
  }
  const returned = invocationReturnValue(call);
  return returned.present && Array.isArray(returned.value)
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Preauthorized eval did not return the structured permissions result",
      };
}

function validateEventPages(result: TestExecutionResult) {
  if (result.error) return { passed: false, reason: result.error };
  const probe = result.diagnostics?.["evalEventPages"];
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    return { passed: false, reason: "The harness did not record durable eval event-page evidence" };
  }
  const value = probe as {
    terminal?: { status?: unknown; result?: { success?: unknown } };
    firstPage?: { events?: Array<{ sequence?: unknown }>; next?: unknown; hasMore?: unknown };
    repeatedFirstPage?: unknown;
    pages?: Array<{ events?: Array<{ sequence?: unknown }>; next?: unknown; hasMore?: unknown }>;
  };
  if (value.terminal?.status !== "done" || value.terminal.result?.success !== true) {
    return { passed: false, reason: "The event probe did not settle a successful eval run" };
  }
  if (JSON.stringify(value.firstPage) !== JSON.stringify(value.repeatedFirstPage)) {
    return { passed: false, reason: "The same durable event cursor returned different pages" };
  }
  if (
    !Array.isArray(value.pages) ||
    value.pages.length < 2 ||
    value.pages.at(-1)?.hasMore !== false
  ) {
    return {
      passed: false,
      reason: "The event probe did not exhaust bounded durable cursor pages",
    };
  }
  const sequences = value.pages
    .flatMap((page) => page.events ?? [])
    .map((event) => event.sequence)
    .filter((sequence): sequence is number => typeof sequence === "number");
  if (
    sequences.length < 2 ||
    value.pages.flatMap((page) => page.events ?? []).length !== sequences.length ||
    sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1]!)
  ) {
    return {
      passed: false,
      reason: "Durable eval event pages were not strictly ordered by cursor sequence",
    };
  }
  return { passed: true, reason: undefined };
}

async function orchestrateEventPages(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  try {
    const probe = await context.runner.probeEvalEventPages();
    return {
      messages: [],
      duration: Date.now() - startedAt,
      diagnostics: { evalEventPages: probe },
    };
  } catch (cause) {
    return { messages: [], duration: Date.now() - startedAt, error: formatError(cause) };
  }
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

async function orchestrateAgentReplay(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const session = await context.runner.spawn();
  let error: string | undefined;
  let replayEvidence: Record<string, unknown> | undefined;
  try {
    const targetId = session.agentTargetId;
    if (!targetId) throw new Error("Spawned system-test agent has no exact runtime target");

    const turn = context
      .sendAndWait(
        session,
        [
          "Using exactly one eval call, run the following logic with timeoutMs 60000:",
          "await new Promise(resolve => setTimeout(resolve, 15000));",
          "scope.__evalAgentReplayCompletionCount = (scope.__evalAgentReplayCompletionCount ?? 0) + 1;",
          'return { marker: "EVAL_AGENT_REPLAY_OK", completionCount: scope.__evalAgentReplayCompletionCount };',
          "Return the eval result. Do not make any other tool call.",
        ].join("\n"),
        "start eval before vessel crash"
      )
      .then(
        () => ({ error: null as unknown }),
        (cause) => ({ error: cause })
      );

    const liveDeadline = Date.now() + 20_000;
    let live: { id: string; status: "pending" | "running" } | undefined;
    while (Date.now() < liveDeadline) {
      const invocation = session
        .snapshot()
        .invocations.find(
          (candidate) =>
            candidate.name === "eval" &&
            (candidate.status === "pending" || candidate.status === "running")
        );
      if (invocation) {
        live = {
          id: invocation.id,
          status: invocation.status as "pending" | "running",
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!live) throw new Error("Eval invocation did not become live before the fault deadline");

    const fault = await context.runner.faultAbortAgentVesselForReplayProbe(targetId);
    replayEvidence = {
      targetId,
      invocationId: live.id,
      statusBeforeAbort: live.status,
      aborted: fault.aborted,
    };

    const settled = await turn;
    if (settled.error) throw settled.error;
  } catch (cause) {
    error = formatError(cause);
  }

  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    diagnostics: {
      ...(replayEvidence ? { evalAgentReplay: replayEvidence } : {}),
    },
    ...(error ? { error } : {}),
  };
  try {
    await session.close();
  } catch (cause) {
    execution.cleanupErrors = [`close: ${formatError(cause)}`];
  }
  return execution;
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
    name: "eval-exact-authority",
    description: "An eval request allowlist admits only its exact read-only permission request",
    category: "eval-lifecycle",
    authorityPolicy: {
      authority: [
        {
          ruleId: "eval-permissions-read",
          capability: { kind: "exact", key: "permissions.read" },
          resource: { kind: "exact", key: "permissions.read" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Use a sandbox evaluation to list the current workspace permissions while explicitly confining that evaluation to the one read permission it needs. Summarize the result and whether the authority stayed limited to that operation.",
    validate: validateExactAuthority,
  },
  {
    name: "eval-pregranted-only",
    description:
      "An operation outside an empty eval allowlist is denied without an approval prompt",
    category: "eval-lifecycle",
    authorityPolicy: {
      authority: [
        {
          ruleId: "eval-permissions-read",
          capability: { kind: "exact", key: "permissions.read" },
          resource: { kind: "exact", key: "permissions.read" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Demonstrate that a sandbox evaluation with no granted authority cannot list workspace permissions. Keep the expected refusal contained, do not request broader access, and explain what the system refused.",
    validate: validatePregrantedOnly,
  },
  {
    name: "eval-preauthorization",
    description: "A prompted eval preauthorizes one exact service invocation before executing it",
    category: "eval-lifecycle",
    authorityPolicy: {
      authority: [
        {
          ruleId: "eval-permissions-read",
          capability: { kind: "exact", key: "permissions.read" },
          resource: { kind: "exact", key: "permissions.read" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Use a sandbox evaluation to list workspace permissions through the normal approval-before-execution flow. Report what was approved and the resulting permission summary.",
    validate: validatePreauthorization,
  },
  {
    name: "eval-events",
    description: "A completed eval exposes stable ordered durable event cursor pages",
    category: "eval-lifecycle",
    prompt: "Harness-orchestrated durable eval event pagination check.",
    orchestrate: orchestrateEventPages,
    validation: "harness",
    validate: validateEventPages,
  },
  {
    name: "eval-agent-replay",
    description:
      "An in-flight eval result survives an exact agent-vessel crash without duplicate execution",
    category: "eval-lifecycle",
    prompt: "Harness-orchestrated exact agent-vessel crash and durable eval replay check.",
    orchestrate: orchestrateAgentReplay,
    validation: "harness",
    validate: validateAgentReplay,
  },
  {
    name: "eval-live-kernel-continuity",
    description: "A live scope object retains its methods across idle eval cells",
    category: "eval-lifecycle",
    prompt: "Harness-orchestrated live notebook continuity check.",
    orchestrate: orchestrateLiveKernelContinuity,
    validation: "harness",
    validate: validateLiveKernelContinuity,
  },
  {
    name: "eval-db-persistence",
    description: "The eval-local database persists rows across separate eval calls",
    category: "eval-lifecycle",
    prompt: "Harness-orchestrated eval database continuity check.",
    orchestrate: orchestrateDbPersistence,
    validation: "harness",
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
    validation: "harness",
    validate: validateCancellation,
  },
];
