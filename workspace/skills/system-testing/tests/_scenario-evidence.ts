import type { TestExecutionResult } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
  type InvocationCardPayloadLike,
} from "./_helpers.js";
import { isPreExecutionArgumentRejection } from "../tool-failure-classification.js";

export interface ScenarioEvidence {
  calls: InvocationCardPayloadLike[];
  evalCode: string;
  evalValues: unknown[];
}

export function invocationReturnValue(
  call: InvocationCardPayloadLike
): { present: true; value: unknown } | { present: false } {
  const result = call.execution?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return { present: false };
  const details = (result as Record<string, unknown>)["details"];
  if (!details || typeof details !== "object" || Array.isArray(details)) return { present: false };
  return Object.prototype.hasOwnProperty.call(details, "returnValue")
    ? { present: true, value: (details as Record<string, unknown>)["returnValue"] }
    : { present: false };
}

export function invocationConsoleOutput(call: InvocationCardPayloadLike): string | null {
  const result = call.execution?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const details = (result as Record<string, unknown>)["details"];
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const consoleOutput = (details as Record<string, unknown>)["console"];
  return typeof consoleOutput === "string" ? consoleOutput : null;
}

export function completedScenarioEvidence(
  result: TestExecutionResult,
  requiredTools: readonly string[] = ["eval"],
  options: { allowFailed?: (call: InvocationCardPayloadLike) => boolean } = {}
): { passed: true; evidence: ScenarioEvidence } | { passed: false; reason: string } {
  if (!findLastAgentMessage(result).trim()) {
    return { passed: false, reason: "No non-empty agent response received" };
  }
  const incomplete = noIncompleteInvocations(result);
  if (!incomplete.passed)
    return { passed: false, reason: incomplete.reason ?? "Incomplete tool call" };
  const calls = getToolCalls(result);
  const failed = calls.filter(
    (call) =>
      !isPreExecutionArgumentRejection(
        call.execution?.error,
        call.execution?.result,
        call.execution?.description
      ) &&
      (call.execution?.isError === true ||
        call.execution?.status === "error" ||
        call.execution?.status === "failed" ||
        call.execution?.status === "cancelled" ||
        call.execution?.status === "abandoned" ||
        call.execution?.terminalOutcome === "cancelled" ||
        call.execution?.terminalOutcome === "abandoned")
  );
  const unexpected = failed.filter((call) => !options.allowFailed?.(call));
  if (unexpected.length > 0) {
    return {
      passed: false,
      reason: `Unexpected failed tool calls: ${unexpected.map((call) => call.name).join(", ")}`,
    };
  }
  const completed = new Set(
    calls
      .filter((call) => call.execution?.status === "complete" && call.execution.isError !== true)
      .map((call) => call.name)
  );
  const missing = requiredTools.filter((name) => !completed.has(name));
  if (missing.length > 0) {
    return { passed: false, reason: `Missing completed tool evidence: ${missing.join(", ")}` };
  }
  return {
    passed: true,
    evidence: {
      calls,
      evalCode: successfulEvalCode(result),
      evalValues: successfulEvalReturnValues(result),
    },
  };
}

export function requireCodeOperations(
  code: string,
  alternatives: readonly (readonly string[])[]
): { passed: true; reason: undefined } | { passed: false; reason: string } {
  const matched = alternatives.some((tokens) =>
    tokens.every((token) => code.includes(token) || importedFsOperation(code, token))
  );
  return matched
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: `Completed eval did not exercise a supported operation set: ${alternatives
          .map((tokens) => tokens.join(" + "))
          .join(" or ")}`,
      };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Normalize the ordinary named-import spelling of scoped filesystem calls.
 * Requiring `fs.mkdir(...)` specifically made semantic validation depend on a
 * cosmetic import choice even though `import { mkdir } from "fs/promises"`
 * reaches the exact same reviewed facade.
 */
function importedFsOperation(code: string, token: string): boolean {
  const match = /^fs\.([A-Za-z_$][\w$]*)$/u.exec(token);
  if (!match) return false;
  const operation = match[1];
  if (!operation) return false;

  const imports =
    /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/gu;
  for (const declaration of code.matchAll(imports)) {
    const members = declaration[1]?.split(",") ?? [];
    for (const member of members) {
      const parsed =
        /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/u.exec(
          member
        );
      if (parsed?.[1] !== operation) continue;
      const localName = parsed[2] ?? parsed[1];
      if (new RegExp(`\\b${escapeRegExp(localName)}\\s*\\(`, "u").test(code)) return true;
    }
  }
  return false;
}

export function walkRecords(values: readonly unknown[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value)) records.push(value as Record<string, unknown>);
    for (const child of Object.values(value)) visit(child);
  };
  for (const value of values) visit(value);
  return records;
}

export function walkArrays(values: readonly unknown[]): unknown[][] {
  const arrays: unknown[][] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) arrays.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  for (const value of values) visit(value);
  return arrays;
}

export function hasTruthyProof(values: readonly unknown[]): boolean {
  return walkRecords(values).some((record) =>
    Object.values(record).some((value) => value === true)
  );
}

export function hasNonEmptyStructuredResult(values: readonly unknown[]): boolean {
  return values.some(
    (value) =>
      (Array.isArray(value) && value.length > 0) ||
      (value !== null && typeof value === "object" && Object.keys(value).length > 0) ||
      (typeof value === "string" && value.length > 0) ||
      typeof value === "number"
  );
}
