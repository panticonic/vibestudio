import type { TestCase, TestExecutionResult } from "../types.js";
import { OPTIMIZABLE_PANEL_WORKSPACE_REPO_FIXTURE } from "../types.js";
import {
  completedScenarioEvidence,
  hasNonEmptyStructuredResult,
  invocationReturnValue,
  walkRecords,
} from "./_scenario-evidence.js";
import type { InvocationCardPayloadLike } from "./_helpers.js";
import {
  eventRef,
  managedMutation,
  record,
  stringArray,
  successfulToolDetails,
  unitForPath,
  verificationMatches,
  workspacePath,
  zeroWorkingCounts,
} from "./_managed-unit-evidence.js";

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

interface BuildProfileEvidence {
  index: number;
  unit: string;
  contextId: string;
  initialBytes: Map<string, number>;
}

function buildProfileEvidence(
  call: InvocationCardPayloadLike,
  index: number
): BuildProfileEvidence | null {
  if (
    call.name !== "eval" ||
    call.execution?.status !== "complete" ||
    call.execution.isError === true ||
    !/\b(?:profileBuild|getPerformanceProfile)\b/u.test(String(call.arguments?.["code"] ?? ""))
  ) {
    return null;
  }
  const returned = invocationReturnValue(call);
  if (!returned.present) return null;
  const profiles = walkRecords([returned.value]).filter(
    (candidate) =>
      candidate["version"] === 1 &&
      typeof candidate["source"] === "string" &&
      typeof candidate["ref"] === "string" &&
      record(candidate["report"]) !== null &&
      Array.isArray(candidate["targets"])
  );
  if (profiles.length !== 1) return null;

  const profile = profiles[0]!;
  const unit = unitForPath(profile["source"], "panels");
  const ref = profile["ref"];
  const contextId = typeof ref === "string" && ref.startsWith("ctx:") ? ref.slice(4) : null;
  const report = record(profile["report"]);
  const verifiedCacheRun = record(profile["verifiedCacheRun"]);
  if (
    !unit ||
    !contextId ||
    workspacePath(profile["source"]) !== unit ||
    workspacePath(report?.["repoPath"]) !== unit ||
    report?.["status"] !== "ok" ||
    verifiedCacheRun?.["sameBuildKeys"] !== true
  ) {
    return null;
  }

  const initialBytes = new Map<string, number>();
  for (const targetValue of profile["targets"] as unknown[]) {
    const target = record(targetValue);
    const bundleReport = record(target?.["bundleReport"]);
    const initial = record(bundleReport?.["initial"]);
    if (
      typeof target?.["target"] !== "string" ||
      typeof target["buildKey"] !== "string" ||
      typeof initial?.["bytes"] !== "number" ||
      initial["bytes"] < 0
    ) {
      continue;
    }
    initialBytes.set(target["target"], initial["bytes"]);
  }
  return initialBytes.size > 0 ? { index, unit, contextId, initialBytes } : null;
}

function profileImproved(before: BuildProfileEvidence, after: BuildProfileEvidence): boolean {
  if (before.unit !== after.unit || before.contextId !== after.contextId) return false;
  return [...before.initialBytes].some(
    ([target, bytes]) =>
      typeof after.initialBytes.get(target) === "number" && after.initialBytes.get(target)! < bytes
  );
}

function validatePanelPerformanceRepair(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["eval", "verify", "vcs"]);
  if (!base.passed) return base;
  const calls = base.evidence.calls;
  const profiles = calls.flatMap((call, index) => {
    const evidence = buildProfileEvidence(call, index);
    return evidence ? [evidence] : [];
  });
  const mutations = calls.flatMap((call, index) => {
    const evidence = managedMutation(call, index, "panels");
    return evidence ? [evidence] : [];
  });
  if (mutations.length === 0) {
    return { passed: false, reason: "No completed managed panel optimization was observed" };
  }
  const units = new Set(mutations.map(({ unit }) => unit));
  const contexts = new Set(mutations.map(({ contextId }) => contextId));
  const applicationIds = mutations.map(({ applicationId }) => applicationId);
  if (
    units.size !== 1 ||
    contexts.size !== 1 ||
    new Set(applicationIds).size !== applicationIds.length
  ) {
    return {
      passed: false,
      reason: "Panel optimization mutations did not form one context-local chain for one unit",
    };
  }
  const unit = [...units][0]!;
  const contextId = [...contexts][0]!;
  const firstMutationIndex = mutations[0]!.index;
  const lastMutationIndex = mutations.at(-1)!.index;

  for (const before of profiles) {
    if (
      before.index >= firstMutationIndex ||
      before.unit !== unit ||
      before.contextId !== contextId
    ) {
      continue;
    }
    for (const after of profiles) {
      if (after.index <= lastMutationIndex || !profileImproved(before, after)) continue;

      for (let buildIndex = after.index + 1; buildIndex < calls.length; buildIndex += 1) {
        if (!verificationMatches(calls[buildIndex]!, "build", unit, contextId)) continue;

        for (let commitIndex = buildIndex + 1; commitIndex < calls.length; commitIndex += 1) {
          const commitCall = calls[commitIndex]!;
          if (commitCall.name !== "vcs" || commitCall.arguments?.["operation"] !== "commit") {
            continue;
          }
          const commitDetails = successfulToolDetails(commitCall, "vcs");
          const commit = record(commitDetails?.["result"]);
          const event = record(commit?.["event"]);
          const eventId = event?.["kind"] === "event" ? event["eventId"] : null;
          const committedApplicationIds = commit?.["committedApplicationIds"];
          if (
            commit?.["contextId"] !== contextId ||
            typeof eventId !== "string" ||
            !stringArray(committedApplicationIds) ||
            committedApplicationIds.length !== applicationIds.length ||
            !committedApplicationIds.every((id, index) => id === applicationIds[index])
          ) {
            continue;
          }

          for (let statusIndex = commitIndex + 1; statusIndex < calls.length; statusIndex += 1) {
            const statusCall = calls[statusIndex]!;
            if (statusCall.name !== "vcs" || statusCall.arguments?.["operation"] !== "status") {
              continue;
            }
            const status = record(successfulToolDetails(statusCall, "vcs")?.["result"]);
            if (
              status?.["contextId"] === contextId &&
              status["clean"] === true &&
              eventRef(status["committed"], eventId) &&
              eventRef(status["workingHead"], eventId) &&
              zeroWorkingCounts(status["workingCounts"])
            ) {
              return { passed: true, reason: undefined };
            }
          }
        }
      }
    }
  }
  return {
    passed: false,
    reason:
      "No causal optimization episode joined a same-context baseline, managed panel mutation, smaller initial payload profile, exact final build, complete application-chain commit, and matching clean event",
  };
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
