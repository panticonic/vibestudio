import type { TestCase, TestExecutionResult } from "../types.js";
import { OPTIMIZABLE_PANEL_WORKSPACE_REPO_FIXTURE } from "../types.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  invocationReturnValue,
  walkRecords,
} from "./_scenario-evidence.js";

function buildResult(values: readonly unknown[]): boolean {
  return walkRecords(values).some((record) => {
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
  });
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

function buildPerformanceResult(values: readonly unknown[]): boolean {
  return walkRecords(values).some((record) => {
    const firstRun = record["firstRun"];
    const verifiedCacheRun = record["verifiedCacheRun"];
    const targets = record["targets"];
    return (
      record["version"] === 1 &&
      typeof record["source"] === "string" &&
      firstRun !== null &&
      typeof firstRun === "object" &&
      typeof (firstRun as Record<string, unknown>)["elapsedMs"] === "number" &&
      typeof (firstRun as Record<string, unknown>)["cacheState"] === "string" &&
      verifiedCacheRun !== null &&
      typeof verifiedCacheRun === "object" &&
      typeof (verifiedCacheRun as Record<string, unknown>)["elapsedMs"] === "number" &&
      (verifiedCacheRun as Record<string, unknown>)["sameBuildKeys"] === true &&
      Array.isArray(targets) &&
      targets.length > 0 &&
      targets.every((target) => {
        if (target === null || typeof target !== "object") return false;
        const value = target as Record<string, unknown>;
        return (
          typeof value["buildKey"] === "string" &&
          typeof value["artifactBytes"] === "number" &&
          typeof value["executableModuleCount"] === "number" &&
          typeof value["executableSourceBytes"] === "number"
        );
      })
    );
  });
}

function validateBuildPerformanceProfile(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  if (!/\b(?:profileBuild|getPerformanceProfile)\b/u.test(base.evidence.evalCode)) {
    return {
      passed: false,
      reason: "Completed eval did not invoke the bounded workspace build profiler",
    };
  }
  return buildPerformanceResult(base.evidence.evalValues)
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "Build profiling returned no structured first-run, verified-cache, and size evidence",
      };
}

function callDetails(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const details = (value as Record<string, unknown>)["details"];
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}

function validatePanelPerformanceRepair(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["eval", "verify", "vcs"]);
  if (!base.passed) return base;
  const completed = base.evidence.calls.filter(
    (call) => call.execution?.status === "complete" && call.execution.isError !== true
  );
  const profiles = completed.filter(
    (call) =>
      call.name === "eval" &&
      /\b(?:profileBuild|getPerformanceProfile)\b/u.test(String(call.arguments?.["code"] ?? ""))
  );
  const buildVerified = completed.some((call) => {
    if (call.name !== "verify" || call.arguments?.["operation"] !== "build") return false;
    const details = callDetails(call.execution?.result);
    return details?.["operation"] === "build" && details["status"] === "ok";
  });
  const committed = completed.some(
    (call) => call.name === "vcs" && call.arguments?.["operation"] === "commit"
  );
  const clean = completed.some((call) => {
    if (call.name !== "vcs" || call.arguments?.["operation"] !== "status") return false;
    const status = callDetails(call.execution?.result)?.["result"];
    return Boolean(
      status &&
      typeof status === "object" &&
      !Array.isArray(status) &&
      (status as Record<string, unknown>)["clean"] === true
    );
  });
  if (profiles.length < 2 || !buildVerified || !committed || !clean) {
    return {
      passed: false,
      reason:
        "The trajectory did not prove before/after profiling, a successful final build, a committed repair, and a clean task state",
    };
  }
  return { passed: true, reason: undefined };
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
    name: "panel-performance-optimize",
    description: "Measure and remove a disposable panel's avoidable bundle-size waste",
    category: "performance",
    workspaceRepoFixture: OPTIMIZABLE_PANEL_WORKSPACE_REPO_FIXTURE,
    prompt:
      "The disposable panel is much larger than its tiny UI warrants. Please investigate and fix it without changing what it displays.",
    validation: "agent-evidence",
    validate: validatePanelPerformanceRepair,
  },
  {
    name: "build-performance-profile",
    description:
      "Profile one exact workspace build and attribute its verified-cache and payload costs",
    category: "build",
    prompt:
      "Use the shipped performance guidance to profile a small existing workspace UI unit in this exact context. Compare the observed first build path with a verified-cache repeat, attribute artifact, executable-module, and bundle size where available, and report the exact measurements plus whether the build keys matched. Keep source and bundle contents out of the result.",
    validate: validateBuildPerformanceProfile,
  },
  {
    name: "build-workspace-package",
    description: "Build and type-check a workspace unit and verify success",
    category: "build",
    prompt:
      "Build and type-check a small existing workspace UI unit and tell me whether it succeeded, including any diagnostics you observed.",
    validate: validateWorkspaceBuild,
  },
  {
    name: "build-npm-package",
    description: "Build an npm package and get a bundle",
    category: "build",
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
    },
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
