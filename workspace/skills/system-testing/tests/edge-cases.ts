import type { TestCase, TestExecutionResult } from "../types.js";
import { getToolCalls } from "./_helpers.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  invocationReturnValue,
  walkRecords,
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

function invalidEvalRequest(call: ToolCall): boolean {
  if (call.name !== "eval" || !isFailure(call)) return false;
  const args = call.arguments ?? {};
  const malformed =
    Object.keys(args).some(
      (key) =>
        !["code", "path", "sourcePath", "syntax", "imports", "reset", "timeoutMs"].includes(key)
    ) ||
    ("code" in args && typeof args["code"] !== "string");
  const invalidArguments =
    malformed && /invalid args|code must be a string|schema validation/iu.test(errorText(call));
  const invalidSyntax =
    typeof args["code"] === "string" &&
    /unexpected token|parse|syntax/iu.test(errorText(call));
  return invalidArguments || invalidSyntax;
}

function invalidImport(call: ToolCall): boolean {
  if (call.name !== "eval" || !isFailure(call)) return false;
  const imports = call.arguments?.["imports"];
  const code = String(call.arguments?.["code"] ?? "");
  const attemptedImport =
    /\bimport\s*(?:\(|["'])/u.test(code) ||
    (imports !== null &&
      typeof imports === "object" &&
      !Array.isArray(imports) &&
      Object.keys(imports).length > 0);
  return (
    attemptedImport &&
    /module .*not available|unknown build unit|cannot find|not found|resolve|invalid npm package specifier/iu.test(
      errorText(call)
    )
  );
}

function validateInvalidImportRecovery(result: TestExecutionResult) {
  const completed = completedScenarioEvidence(result);
  if (completed.passed) {
    const caughtAndRecovered = getToolCalls(result).some((call) => {
      if (
        call.name !== "eval" ||
        call.execution?.status !== "complete" ||
        call.execution.isError === true ||
        !/\bimport\s*(?:\(|["'])/u.test(String(call.arguments?.["code"] ?? ""))
      ) {
        return false;
      }
      const returned = invocationReturnValue(call);
      if (!returned.present || !returned.value || typeof returned.value !== "object") return false;
      const records = walkRecords([returned.value]);
      const unresolvedImport = records.some((record) =>
        Object.entries(record).some(
          ([key, value]) =>
            /error/iu.test(key) &&
            typeof value === "string" &&
            /module .*not available|unknown build unit|cannot find|not found|resolve|invalid npm package specifier/iu.test(
              value
            )
        )
      );
      const observedRecovery = records.some((record) =>
        Object.entries(record).some(
          ([key, value]) =>
            /(?:sandboxStillWorks|continued|following|usable|works)/iu.test(key) &&
            (value === true ||
              (typeof value === "number" && value > 0) ||
              (typeof value === "string" && value.length > 0))
        )
      );
      return unresolvedImport && observedRecovery;
    });
    if (caughtAndRecovered) return { passed: true, reason: undefined };
  }
  return validateRecovery(result, invalidImport, "unresolved-import");
}

function missingFile(call: ToolCall): boolean {
  return (
    call.name === "eval" &&
    isFailure(call) &&
    /fs\.readFile/u.test(String(call.arguments?.["code"] ?? "")) &&
    /not found|enoent|does not exist/iu.test(errorText(call))
  );
}

function validateMissingFileRecovery(result: TestExecutionResult) {
  const completed = completedScenarioEvidence(result);
  if (completed.passed) {
    const caughtAndRecovered = getToolCalls(result).some((call) => {
      if (
        call.name !== "eval" ||
        call.execution?.status !== "complete" ||
        call.execution.isError === true ||
        !/fs\.readFile/u.test(String(call.arguments?.["code"] ?? ""))
      ) {
        return false;
      }
      const returned = invocationReturnValue(call);
      if (!returned.present || !returned.value || typeof returned.value !== "object") return false;
      const records = walkRecords([returned.value]);
      const missingError = records.some((record) =>
        Object.entries(record).some(
          ([key, value]) =>
            ((/code/iu.test(key) && value === "ENOENT") ||
              (/message|error/iu.test(key) &&
                typeof value === "string" &&
                /not found|enoent|does not exist/iu.test(value)))
        )
      );
      const observedRecovery = records.some((record) =>
        Object.entries(record).some(
          ([key, value]) =>
            /(?:ok|following|continued|readLength|works)/iu.test(key) &&
            (value === true ||
              (typeof value === "number" && value > 0) ||
              (typeof value === "string" && value.length > 0))
        )
      );
      return missingError && observedRecovery;
    });
    if (caughtAndRecovered) return { passed: true, reason: undefined };
  }
  return validateRecovery(result, missingFile, "missing-file");
}

export const edgeCaseTests: TestCase[] = [
  {
    name: "eval-extra-argument",
    description: "Reject unsupported eval arguments clearly",
    category: "edge-cases",
    prompt:
      "Check that a malformed sandbox request is rejected and that a corrected request still works afterward.",
    expectedToolFailures: [{ name: "eval" }],
    validate: (result) => validateRecovery(result, invalidEvalRequest, "invalid-request"),
  },
  {
    name: "invalid-import",
    description: "Graceful error for importing something that doesn't exist",
    category: "edge-cases",
    authorityPolicy: {
      authority: [
        {
          ruleId: "inspect-npm-dependency",
          capability: { kind: "exact", key: "workspace.dependencies.inspect" },
          resource: { kind: "exact", key: "workspace.dependencies.inspect" },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [],
    },
    prompt:
      "Check that a nonexistent package import fails clearly without preventing later sandbox work.",
    expectedToolFailures: [{ name: "eval" }],
    validate: validateInvalidImportRecovery,
  },
  {
    name: "fs-not-found",
    description: "Graceful error for reading a nonexistent file",
    category: "edge-cases",
    prompt:
      "Check that reading a nonexistent file fails clearly without preventing later sandbox work.",
    expectedToolFailures: [{ name: "eval" }],
    validate: validateMissingFileRecovery,
  },
];
