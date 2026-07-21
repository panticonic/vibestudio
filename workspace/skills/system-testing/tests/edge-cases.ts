import type { TestCase, TestExecutionResult } from "../types.js";
import { getToolCalls } from "./_helpers.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  invocationReturnValue,
} from "./_scenario-evidence.js";

type ToolCall = ReturnType<typeof getToolCalls>[number];

function errorText(call: ToolCall): string {
  return JSON.stringify({
    status: call.execution?.status,
    outcome: call.execution?.terminalOutcome,
    result: call.execution?.result,
    error: call.execution?.error,
  });
}

function isFailure(call: ToolCall): boolean {
  return (
    call.execution?.isError === true ||
    call.execution?.status === "error" ||
    call.execution?.status === "failed"
  );
}

function validateRecovery(
  result: TestExecutionResult,
  matchesExpected: (call: ToolCall) => boolean,
  label: string
) {
  const base = completedScenarioEvidence(result, ["eval"], {
    allowFailed: matchesExpected,
  });
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const failures = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => isFailure(call) && matchesExpected(call));
  if (failures.length !== 1) {
    return {
      passed: false,
      reason: `Expected exactly one ${label} failure; observed ${failures.length}`,
    };
  }
  const recovered = calls.slice(failures[0]!.index + 1).some((call) => {
    if (
      call.name !== "eval" ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      return false;
    }
    const returned = invocationReturnValue(call);
    return returned.present && hasNonEmptyStructuredResult([returned.value]);
  });
  return recovered
    ? { passed: true, reason: undefined }
    : { passed: false, reason: `The ${label} failure was not followed by an observable recovery` };
}

function invalidEvalArguments(call: ToolCall): boolean {
  if (call.name !== "eval" || !isFailure(call)) return false;
  const args = call.arguments ?? {};
  const malformed =
    Object.keys(args).some(
      (key) =>
        !["code", "path", "sourcePath", "syntax", "imports", "reset", "timeoutMs"].includes(key)
    ) ||
    ("code" in args && typeof args["code"] !== "string");
  return (
    malformed && /invalid args|code must be a string|schema validation/iu.test(errorText(call))
  );
}

function invalidImport(call: ToolCall): boolean {
  if (call.name !== "eval" || !isFailure(call)) return false;
  const imports = call.arguments?.["imports"];
  return (
    imports !== null &&
    typeof imports === "object" &&
    !Array.isArray(imports) &&
    Object.keys(imports).length > 0 &&
    /unknown build unit|cannot find|not found|resolve/iu.test(errorText(call))
  );
}

function missingFile(call: ToolCall): boolean {
  return (
    call.name === "eval" &&
    isFailure(call) &&
    /fs\.readFile/u.test(String(call.arguments?.["code"] ?? "")) &&
    /not found|enoent|does not exist/iu.test(errorText(call))
  );
}

export const edgeCaseTests: TestCase[] = [
  {
    name: "eval-extra-argument",
    description: "Reject unsupported eval arguments clearly",
    category: "edge-cases",
    prompt:
      "Check that a malformed sandbox request is rejected and that a corrected request still works afterward.",
    expectedToolFailures: [{ name: "eval" }],
    validate: (result) => validateRecovery(result, invalidEvalArguments, "invalid-argument"),
  },
  {
    name: "invalid-import",
    description: "Graceful error for importing something that doesn't exist",
    category: "edge-cases",
    prompt:
      "Check that a nonexistent package import fails clearly without preventing later sandbox work.",
    expectedToolFailures: [{ name: "eval" }],
    validate: (result) => validateRecovery(result, invalidImport, "unresolved-import"),
  },
  {
    name: "fs-not-found",
    description: "Graceful error for reading a nonexistent file",
    category: "edge-cases",
    prompt:
      "Check that reading a nonexistent file fails clearly without preventing later sandbox work.",
    expectedToolFailures: [{ name: "eval" }],
    validate: (result) => validateRecovery(result, missingFile, "missing-file"),
  },
];
