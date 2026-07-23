import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  invocationReturnValue,
  walkRecords,
} from "./_scenario-evidence.js";

function buildResult(values: readonly unknown[]): boolean {
  return walkRecords(values).some(
    (record) => {
      const artifactBuild =
        typeof record["dir"] === "string" &&
        Array.isArray(record["artifacts"]) &&
        record["artifacts"].length > 0 &&
        record["metadata"] !== null &&
        typeof record["metadata"] === "object";
      const successfulReport =
        record["success"] === true ||
        record["status"] === "ok" ||
        (Array.isArray(record["builds"]) &&
          record["builds"].length > 0 &&
          record["builds"].every(
            (build) =>
              build !== null &&
              typeof build === "object" &&
              (build as Record<string, unknown>)["status"] === "ok"
          ));
      return artifactBuild || successfulReport;
    }
  );
}

function validateWorkspaceBuild(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  if (!/build\.(?:getBuild|build|recompute)|services\.build/gu.test(base.evidence.evalCode)) {
    return { passed: false, reason: "Completed eval did not invoke the workspace build surface" };
  }
  return buildResult(base.evidence.evalValues)
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "Completed build call did not return artifacts and metadata" };
}

function validateNpmImport(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const evalCall = base.evidence.calls.find(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      call.arguments?.["imports"] !== null &&
      typeof call.arguments?.["imports"] === "object" &&
      Object.values(call.arguments!["imports"] as Record<string, unknown>).some(
        (value) => typeof value === "string" && value.startsWith("npm:")
      )
  );
  if (!evalCall) {
    return { passed: false, reason: "No successful eval resolved an npm import-map entry" };
  }
  const returned = invocationReturnValue(evalCall);
  return returned.present && hasNonEmptyStructuredResult([returned.value])
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The npm import produced no observable result" };
}

function validateWorkspaceImport(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const imported = base.evidence.calls.find((call) => {
    if (call.name !== "eval" || call.execution?.status !== "complete" || call.execution.isError) {
      return false;
    }
    const code = String(call.arguments?.["code"] ?? "");
    const imports = call.arguments?.["imports"];
    const hasWorkspaceImportMapEntry =
      imports !== null &&
      typeof imports === "object" &&
      !Array.isArray(imports) &&
      Object.values(imports as Record<string, unknown>).some(
        (value) => typeof value === "string" && !value.startsWith("npm:")
      );
    const hasDirectWorkspaceImport =
      /\b(?:from\s*|import\s*(?:\(\s*)?)["']@workspace(?:-[a-z0-9-]+)?\//u.test(code);
    return hasWorkspaceImportMapEntry || hasDirectWorkspaceImport;
  });
  if (!imported || !/\bimport\b/u.test(String(imported.arguments?.["code"] ?? ""))) {
    return { passed: false, reason: "No successful eval imported a workspace-built package" };
  }
  const returned = invocationReturnValue(imported);
  return returned.present && hasNonEmptyStructuredResult([returned.value])
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The workspace import exposed no structured exports" };
}

export const buildTests: TestCase[] = [
  {
    name: "build-workspace-package",
    description: "Build a workspace package and verify success",
    category: "build",
    prompt: "Build a small existing workspace UI unit and tell me whether it succeeded.",
    validate: validateWorkspaceBuild,
  },
  {
    name: "build-npm-package",
    description: "Build an npm package and get a bundle",
    category: "build",
    prompt:
      "Load a small pure-JavaScript dependency from npm in the sandbox and demonstrate that it works.",
    validate: validateNpmImport,
  },
  {
    name: "import-built-package",
    description: "Import a built package and inspect its exports",
    category: "build",
    prompt:
      "Import an existing workspace-built package in the sandbox and describe the exports you observed.",
    validate: validateWorkspaceImport,
  },
];
