import type { TestCase, TestExecutionResult } from "../types.js";
import { getToolCalls } from "./_helpers.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  invocationReturnValue,
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

function errorText(call: ReturnType<typeof getToolCalls>[number]): string {
  return JSON.stringify({
    status: call.execution?.status,
    outcome: call.execution?.terminalOutcome,
    result: call.execution?.result,
    error: call.execution?.error,
  });
}

function matchingScopeRoundTrip(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const calls = successfulEvalCalls(result);
  for (let writerIndex = 0; writerIndex < calls.length - 1; writerIndex += 1) {
    const writer = calls[writerIndex]!;
    const writerCode = String(writer.arguments?.["code"] ?? "");
    if (!/scope\s*(?:\.|\[)[^=\n]*=/u.test(writerCode)) continue;
    const written = invocationReturnValue(writer);
    if (!written.present || !hasNonEmptyStructuredResult([written.value])) continue;
    for (const reader of calls.slice(writerIndex + 1)) {
      if (!/scope\s*(?:\.|\[)/u.test(String(reader.arguments?.["code"] ?? ""))) continue;
      const read = invocationReturnValue(reader);
      if (read.present && JSON.stringify(read.value) === JSON.stringify(written.value)) {
        return { passed: true, reason: undefined };
      }
    }
  }
  return {
    passed: false,
    reason: "Separate completed eval calls did not return the same persistent scope value",
  };
}

function deliberateFailureRecovery(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["eval"], {
    allowFailed: (call) =>
      call.name === "eval" &&
      /intentional|deliberate|recovery/iu.test(errorText(call)) &&
      /throw/iu.test(String(call.arguments?.["code"] ?? "")),
  });
  if (!base.passed) return base;
  const calls = getToolCalls(result).filter((call) => call.name === "eval");
  const failures = calls
    .map((call, index) => ({ call, index }))
    .filter(
      ({ call }) =>
        (call.execution?.isError === true ||
          call.execution?.status === "error" ||
          call.execution?.status === "failed") &&
        /intentional|deliberate|recovery/iu.test(errorText(call)) &&
        /throw/iu.test(String(call.arguments?.["code"] ?? ""))
    );
  if (failures.length !== 1) {
    return {
      passed: false,
      reason: `Expected exactly one deliberate thrown eval failure; observed ${failures.length}`,
    };
  }
  const recovered = calls.slice(failures[0]!.index + 1).some((call) => {
    if (call.execution?.status !== "complete" || call.execution.isError === true) return false;
    const returned = invocationReturnValue(call);
    return returned.present && hasNonEmptyStructuredResult([returned.value]);
  });
  return recovered
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The deliberate failure was not followed by an observable eval result",
      };
}

function validateLargeSummary(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const calls = successfulEvalCalls(result);
  const summarized = calls.some((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    if (!/(?:Array\.|\.length|length\s*:)/u.test(code)) return false;
    const returned = invocationReturnValue(call);
    if (!returned.present) return false;
    if (typeof returned.value === "number") return returned.value >= 1_000;
    return walkRecords([returned.value]).some(
      (record) => typeof record["count"] === "number" && record["count"] >= 1_000
    );
  });
  return summarized
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "No completed eval returned a compact count for a large collection",
      };
}

function validateDynamicImport(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const call = successfulEvalCalls(result).find((candidate) => {
    const imports = candidate.arguments?.["imports"];
    return (
      imports !== null &&
      typeof imports === "object" &&
      !Array.isArray(imports) &&
      Object.values(imports as Record<string, unknown>).some(
        (value) => typeof value === "string" && value.startsWith("npm:")
      ) &&
      /\bimport\s*\(/u.test(String(candidate.arguments?.["code"] ?? ""))
    );
  });
  const returned = call ? invocationReturnValue(call) : { present: false as const };
  return returned.present && hasNonEmptyStructuredResult([returned.value])
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "No completed dynamic npm import returned an observable value" };
}

function validateConsoleCapture(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const captured = successfulEvalCalls(result).some((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    const details =
      call.execution?.result && typeof call.execution.result === "object"
        ? (call.execution.result as Record<string, unknown>)["details"]
        : null;
    const consoleText =
      details && typeof details === "object"
        ? (details as Record<string, unknown>)["console"]
        : undefined;
    return (
      /console\.(?:log|info|warn|error)/u.test(code) &&
      typeof consoleText === "string" &&
      consoleText.split(/\r?\n/u).filter(Boolean).length === 3
    );
  });
  return captured
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "A completed eval did not capture exactly three console lines" };
}

function validateIndependentScope(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const calls = successfulEvalCalls(result);
  for (let index = 0; index < calls.length - 1; index += 1) {
    const code = String(calls[index]!.arguments?.["code"] ?? "");
    const directKeys = [...code.matchAll(/scope\.([A-Za-z_$][\w$]*)\s*=/gu)].map(
      (match) => match[1]!
    );
    const writesThree = new Set(directKeys).size >= 3 || /Object\.assign\s*\(\s*scope/gu.test(code);
    if (!writesThree) continue;
    const reader = calls.slice(index + 1).find((call) => {
      const returned = invocationReturnValue(call);
      return (
        /scope\s*(?:\.|\[)/u.test(String(call.arguments?.["code"] ?? "")) &&
        returned.present &&
        walkRecords([returned.value]).some((record) => Object.keys(record).length === 3)
      );
    });
    if (reader) return { passed: true, reason: undefined };
  }
  return {
    passed: false,
    reason: "Three independent scope values were not written and returned by a later eval",
  };
}

export const agentCapabilityTests: TestCase[] = [
  {
    name: "multi-turn",
    description: "Agent stores something in scope and retrieves it later",
    category: "agent-capabilities",
    prompt: "Show whether a sandbox value persists between separate evaluations.",
    validate: matchingScopeRoundTrip,
  },
  {
    name: "error-recovery",
    description: "Agent recovers from a thrown error and retries successfully",
    category: "agent-capabilities",
    prompt: "Show that the sandbox remains usable after a deliberate failure.",
    expectedToolFailures: [{ name: "eval" }],
    validate: deliberateFailureRecovery,
  },
  {
    name: "large-output",
    description: "Agent generates a large data structure and reports on it",
    category: "agent-capabilities",
    prompt: "Generate a large in-memory collection and summarize it without dumping its contents.",
    validate: validateLargeSummary,
  },
  {
    name: "dynamic-import",
    description: "Dynamically import an external package and use it",
    category: "agent-capabilities",
    prompt:
      "Check whether a small external JavaScript package can be loaded dynamically and used here.",
    validate: validateDynamicImport,
  },
  {
    name: "console-streaming",
    description: "Console output is captured and reported",
    category: "agent-capabilities",
    prompt: "Check what the sandbox captures when a program writes three console lines.",
    validate: validateConsoleCapture,
  },
  {
    name: "concurrent-scope",
    description: "Multiple scope assignments persist independently",
    category: "agent-capabilities",
    prompt: "Store three independent sandbox values and check them again in a later evaluation.",
    validate: validateIndependentScope,
  },
];
