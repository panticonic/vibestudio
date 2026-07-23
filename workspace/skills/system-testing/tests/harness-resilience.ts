import type { TestCase, TestExecutionResult, TestOrchestrationContext } from "../types.js";
import { getToolCalls } from "./_helpers.js";
import {
  completedScenarioEvidence,
  invocationReturnValue,
} from "./_scenario-evidence.js";

type ToolCall = ReturnType<typeof getToolCalls>[number];

function isFailure(call: ToolCall): boolean {
  return (
    call.execution?.isError === true ||
    call.execution?.status === "error" ||
    call.execution?.status === "failed"
  );
}

function errorText(call: ToolCall): string {
  return JSON.stringify({
    status: call.execution?.status,
    outcome: call.execution?.terminalOutcome,
    result: call.execution?.result,
    error: call.execution?.error,
  });
}

function recoverySequence(
  result: TestExecutionResult,
  expected: (call: ToolCall) => boolean,
  label: string,
  sameTool = false
) {
  const base = completedScenarioEvidence(result, [], { allowFailed: expected });
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const failures = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => isFailure(call) && expected(call));
  if (failures.length !== 1) {
    return {
      passed: false,
      reason: `Expected exactly one ${label} failure; observed ${failures.length}`,
    };
  }
  const failed = failures[0]!;
  const recovered = calls.slice(failed.index + 1).some((call) => {
    if (
      ((sameTool || failed.call.name === "eval") && call.name !== failed.call.name) ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      return false;
    }
    if (call.name === "eval") return true;
    return call.execution?.result !== undefined;
  });
  return recovered
    ? { passed: true, reason: undefined }
    : { passed: false, reason: `The ${label} failure had no observable later recovery` };
}

function thrownEval(call: ToolCall): boolean {
  return (
    call.name === "eval" &&
    isFailure(call) &&
    /throw/iu.test(String(call.arguments?.["code"] ?? "")) &&
    /intentional|deliberate|recovery|thrown/iu.test(errorText(call))
  );
}

function validateHugeReturn(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const bounded = base.evidence.calls.some((call) => {
    if (
      call.name !== "eval" ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      return false;
    }
    const code = String(call.arguments?.["code"] ?? "");
    const returned = invocationReturnValue(call);
    if (!/Array|repeat|fill|map/iu.test(code) || !returned.present) return false;
    try {
      const executionResult = call.execution?.result;
      if (
        !executionResult ||
        typeof executionResult !== "object" ||
        Array.isArray(executionResult)
      ) {
        return false;
      }
      const protocolContent = (executionResult as Record<string, unknown>)["protocolContent"];
      if (!Array.isArray(protocolContent)) return false;
      const protocolText = protocolContent
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item)
        )
        .map((item) =>
          item["type"] === "text" && typeof item["text"] === "string" ? item["text"] : ""
        )
        .join("\n");
      const marker = returned.value;
      const isBoundedMarker = Boolean(
        marker &&
          typeof marker === "object" &&
          !Array.isArray(marker) &&
          (marker as Record<string, unknown>)["truncated"] === true &&
          typeof (marker as Record<string, unknown>)["originalChars"] === "number" &&
          ((marker as Record<string, unknown>)["originalChars"] as number) > 100_000 &&
          (marker as Record<string, unknown>)["scopeKey"] === "$lastReturn"
      );
      return (
        isBoundedMarker &&
        protocolText.length < 100_000 &&
        /truncated/iu.test(protocolText) &&
        /scope\.\$lastReturn/u.test(protocolText)
      );
    } catch {
      return false;
    }
  });
  return bounded
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "No completed eval paired a huge return with bounded protocol output and recovery guidance",
      };
}

function timedOutEval(call: ToolCall): boolean {
  const timeoutMs = call.arguments?.["timeoutMs"];
  return (
    call.name === "eval" &&
    typeof timeoutMs === "number" &&
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0 &&
    isFailure(call) &&
    errorText(call).toLowerCase().includes(`timed out after ${timeoutMs}ms`)
  );
}

function invalidToolArguments(call: ToolCall): boolean {
  return (
    ["docs_search", "eval", "vcs"].includes(call.name) &&
    isFailure(call) &&
    /invalid|schema validation/iu.test(errorText(call))
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function orchestrateFollowupTurn(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const session = await context.runner.spawn();
  let error: string | undefined;
  try {
    await context.sendAndWait(
      session,
      "Use a harmless read-only tool to inspect something small and summarize it.",
      "initial tool-using turn"
    );
    await context.sendAndWait(
      session,
      "Now give me a fresh one-sentence recap of what you observed.",
      "follow-up turn"
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
  }
  return execution;
}

function validateFollowupTurn(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, []);
  if (!base.passed) return base;
  if (result.error || (result.cleanupErrors?.length ?? 0) > 0) {
    return { passed: false, reason: "The two-turn session or its cleanup failed" };
  }
  const userId = result.messages[0]?.senderId;
  const isVisibleAgentMessage = (index: number) => {
    const message = result.messages[index];
    return Boolean(
      message &&
      message.senderId !== userId &&
      message.kind === "message" &&
      message.complete &&
      message.contentType !== "invocation" &&
      message.contentType !== "thinking" &&
      message.content?.trim()
    );
  };
  const toolIndex = result.messages.findIndex(
    (message) =>
      message.contentType === "invocation" &&
      message.invocation?.execution?.status === "complete" &&
      message.invocation.execution.isError !== true
  );
  const firstAnswer = result.messages.findIndex(
    (_message, index) => index > toolIndex && isVisibleAgentMessage(index)
  );
  const followup = result.messages.findIndex(
    (message, index) => index > firstAnswer && message.senderId === userId
  );
  const secondAnswer = result.messages.findIndex(
    (_message, index) => index > followup && isVisibleAgentMessage(index)
  );
  return toolIndex >= 0 &&
    firstAnswer > toolIndex &&
    followup > firstAnswer &&
    secondAnswer > followup
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "The transcript did not prove a tool-backed first answer and a later fresh follow-up answer",
      };
}

export const harnessResilienceTests: TestCase[] = [
  {
    name: "eval-thrown-error-then-continues",
    description:
      "A failed eval surfaces an error and the same turn can still produce a final response",
    category: "harness-resilience",
    prompt:
      "Show that a deliberate sandbox exception is visible and does not prevent a later successful evaluation.",
    expectedToolFailures: [{ name: "eval" }],
    validate: (result) => recoverySequence(result, thrownEval, "thrown-eval"),
  },
  {
    name: "eval-huge-return-bounded-terminal",
    description: "A large eval return is bounded and does not silently stall the turn",
    category: "harness-resilience",
    prompt:
      "Check how the sandbox handles a return value far too large for a normal tool response.",
    validate: validateHugeReturn,
  },
  {
    name: "eval-timeout-error-visible",
    description: "An explicitly bounded eval timeout is visible and leaves no pending tool",
    category: "harness-resilience",
    prompt:
      "Show that an explicitly bounded sandbox run can time out visibly and that the sandbox remains usable afterward.",
    expectedToolFailures: [{ name: "eval", errorIncludes: "timed out" }],
    validate: (result) => recoverySequence(result, timedOutEval, "timed-out eval"),
  },
  {
    name: "invalid-tool-args-visible-retry",
    description:
      "Tool validation errors are visible and retry succeeds without poisoning the transcript",
    category: "harness-resilience",
    prompt:
      "Show that a malformed tool request is visible and a corrected request of the same kind still works.",
    expectedToolFailures: [
      { name: "docs_search", errorIncludes: "invalid" },
      { name: "eval", errorIncludes: "invalid" },
      { name: "vcs", errorIncludes: "schema validation" },
    ],
    validate: (result) => recoverySequence(result, invalidToolArguments, "invalid-argument", true),
  },
  {
    name: "post-tool-followup-turn",
    description: "A follow-up instruction after tool use still gets a fresh assistant response",
    category: "harness-resilience",
    prompt: "Use a harmless read-only tool to inspect something small and summarize it.",
    orchestrate: orchestrateFollowupTurn,
    validate: validateFollowupTurn,
  },
];
