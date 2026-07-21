import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  requireCodeOperations,
  walkArrays,
  walkRecords,
} from "./_scenario-evidence.js";

function extensionEvidence(
  result: TestExecutionResult,
  alternatives: readonly (readonly string[])[]
) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const exercised = requireCodeOperations(base.evidence.evalCode, alternatives);
  return exercised.passed ? { passed: true as const, evidence: base.evidence } : exercised;
}

function hasDiagnostics(values: readonly unknown[]): boolean {
  return walkRecords(values).some(
    (record) =>
      Array.isArray(record["diagnostics"]) ||
      (record["result"] !== null &&
        typeof record["result"] === "object" &&
        Array.isArray((record["result"] as Record<string, unknown>)["diagnostics"]))
  );
}

function hasInvocationResult(values: readonly unknown[]): boolean {
  return walkRecords(values).some((record) => {
    const value = record["result"] ?? record["value"];
    return hasNonEmptyStructuredResult([value]);
  });
}

export const extensionSurfaceTests: TestCase[] = [
  {
    name: "extension-list",
    description: "List the extensions available in this workspace",
    category: "extensions",
    prompt: "Which extensions are available in this workspace?",
    validate: (result) => {
      const base = extensionEvidence(result, [["extensions.list"]]);
      if (!base.passed) return base;
      return walkArrays(base.evidence.evalValues).some((entries) => entries.length > 0)
        ? { passed: true, reason: undefined }
        : { passed: false, reason: "The completed extension registry call returned no entries" };
    },
  },
  {
    name: "extension-typecheck-unit",
    description: "Typecheck a workspace unit through the typecheck extension",
    category: "extensions",
    prompt:
      "Type-check a small existing workspace unit through its extension surface and summarize the diagnostics.",
    validate: (result) => {
      const base = extensionEvidence(result, [
        ["extensions.invoke", "typecheck", "check"],
        ["extensions.use", "typecheck", "check"],
      ]);
      if (!base.passed) return base;
      return hasDiagnostics(base.evidence.evalValues)
        ? { passed: true, reason: undefined }
        : {
            passed: false,
            reason: "The completed typecheck invocation returned no diagnostics collection",
          };
    },
  },
  {
    name: "extension-invoke-roundtrip",
    description: "Invoke a harmless extension method and report the structured result",
    category: "extensions",
    prompt:
      "Use an available extension for a harmless read-only operation and summarize its structured result.",
    validate: (result) => {
      const base = extensionEvidence(result, [["extensions.list", "extensions.invoke"]]);
      if (!base.passed) return base;
      return hasInvocationResult(base.evidence.evalValues)
        ? { passed: true, reason: undefined }
        : {
            passed: false,
            reason: "The completed extension invocation returned no observable result",
          };
    },
  },
];
