import {
  BUILDABLE_PANEL_WITH_DERIVED_WORKSPACE_REPO_FIXTURE,
  CREATED_PACKAGE_WORKSPACE_REPO_FIXTURE,
  CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import { getToolCalls, type InvocationCardPayloadLike } from "./_helpers.js";
import {
  completedScenarioEvidence,
  invocationReturnValue,
  walkRecords,
} from "./_scenario-evidence.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function details(call: InvocationCardPayloadLike): Record<string, unknown> | null {
  if (
    call.execution?.status !== "complete" ||
    call.execution.isError === true ||
    !isRecord(call.execution.result)
  ) {
    return null;
  }
  return isRecord(call.execution.result["details"])
    ? call.execution.result["details"]
    : call.execution.result;
}

function successfulEvalCalls(result: TestExecutionResult) {
  return getToolCalls(result).filter(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
}

function findLifecycleResult(
  result: TestExecutionResult,
  codeRequired: readonly string[],
  predicate: (record: Record<string, unknown>) => boolean
) {
  return successfulEvalCalls(result).find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    if (!codeRequired.every((token) => code.includes(token))) return false;
    const returned = invocationReturnValue(call);
    return returned.present && walkRecords([returned.value]).some(predicate);
  });
}

function createdProject(record: Record<string, unknown>, section: "panels" | "packages") {
  const publication = record["publication"];
  const preflight = record["preflight"];
  return (
    typeof record["created"] === "string" &&
    record["created"].startsWith(`${section}/`) &&
    Array.isArray(record["files"]) &&
    record["files"].length > 0 &&
    isRecord(preflight) &&
    preflight["ok"] === true &&
    preflight["projectType"] === (section === "panels" ? "panel" : "package") &&
    Array.isArray(preflight["checked"]) &&
    preflight["checked"].length > 0 &&
    isRecord(publication) &&
    publication["published"] === true &&
    typeof publication["committedEventId"] === "string" &&
    typeof publication["publishedEventId"] === "string" &&
    typeof publication["mainEventId"] === "string" &&
    typeof publication["effectId"] === "string"
  );
}

function hasOpenedPanel(values: readonly unknown[]): boolean {
  return walkRecords(values).some(
    (record) =>
      (typeof record["openedPanelId"] === "string" && record["openedPanelId"].length > 0) ||
      (typeof record["panelId"] === "string" && record["panelId"].length > 0) ||
      (typeof record["id"] === "string" && record["id"].length > 0)
  );
}

function validatePanelCreate(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const call = findLifecycleResult(result, ["createProject", "openPanel"], (record) =>
    createdProject(record, "panels")
  );
  if (!call) {
    return {
      passed: false,
      reason: "No completed eval returned the created panel lifecycle result",
    };
  }
  const code = String(call.arguments?.["code"] ?? "");
  if (code.indexOf("createProject") >= code.lastIndexOf("openPanel")) {
    return { passed: false, reason: "The panel was not opened after project creation" };
  }
  const returned = invocationReturnValue(call);
  return returned.present && hasOpenedPanel([returned.value])
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The completed lifecycle returned no opened panel identity" };
}

function validatePanelFork(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const call = findLifecycleResult(result, ["forkProject", "openPanel"], (record) =>
    Boolean(
      typeof record["created"] === "string" &&
      record["created"].startsWith("panels/") &&
      record["committed"] === true &&
      record["dryRun"] === false &&
      isRecord(record["preflight"]) &&
      record["preflight"]["ok"] === true &&
      record["preflight"]["projectType"] === "panel" &&
      isRecord(record["publication"]) &&
      record["publication"]["published"] === true &&
      typeof record["publication"]["committedEventId"] === "string" &&
      Array.isArray(record["files"]) &&
      record["files"].length > 0
    )
  );
  if (!call) {
    return { passed: false, reason: "No completed eval returned a committed panel-fork result" };
  }
  const code = String(call.arguments?.["code"] ?? "");
  if ((code.match(/forkProject\s*\(/gu)?.length ?? 0) < 2 || !/dryRun\s*:\s*true/u.test(code)) {
    return { passed: false, reason: "The panel fork was not planned before it was applied" };
  }
  const returned = invocationReturnValue(call);
  return returned.present && hasOpenedPanel([returned.value])
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The committed fork returned no opened panel identity" };
}

function validateWorkerForkPlan(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const call = findLifecycleResult(result, ["forkProject"], (record) =>
    Boolean(
      typeof record["source"] === "string" &&
      record["source"].startsWith("workers/") &&
      typeof record["created"] === "string" &&
      record["created"].startsWith("workers/") &&
      record["source"] !== record["created"] &&
      record["committed"] === false &&
      record["dryRun"] === true &&
      isRecord(record["preflight"]) &&
      record["preflight"]["ok"] === true &&
      record["preflight"]["projectType"] === "worker" &&
      Array.isArray(record["files"]) &&
      record["files"].length > 0
    )
  );
  return call && /dryRun\s*:\s*true/u.test(String(call.arguments?.["code"] ?? ""))
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "No completed eval returned a non-mutating worker fork plan" };
}

function mutationResult(call: InvocationCardPayloadLike): Record<string, unknown> | null {
  if (call.name !== "edit" && call.name !== "write") return null;
  const value = details(call);
  return value?.["storage"] === "vcs" && isRecord(value["vcsResult"]) ? value["vcsResult"] : null;
}

function commitResult(call: InvocationCardPayloadLike): Record<string, unknown> | null {
  if (call.name !== "commit") return null;
  const value = details(call);
  return value && isRecord(value["result"]) ? value["result"] : value;
}

function validateProjectCommit(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, []);
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const creationIndex = calls.findIndex((call) => {
    if (call.name !== "eval") return false;
    const returned = invocationReturnValue(call);
    return (
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      String(call.arguments?.["code"] ?? "").includes("createProject") &&
      returned.present &&
      walkRecords([returned.value]).some((record) => createdProject(record, "packages"))
    );
  });
  if (creationIndex < 0) {
    return { passed: false, reason: "No completed eval returned the created package identity" };
  }
  for (let mutationIndex = creationIndex + 1; mutationIndex < calls.length; mutationIndex += 1) {
    const mutationCall = calls[mutationIndex]!;
    const mutation = mutationResult(mutationCall);
    if (!mutation) continue;
    const applicationId = mutation["applicationId"];
    const changeIds = mutation["changeIds"];
    if (
      typeof applicationId !== "string" ||
      !Array.isArray(changeIds) ||
      changeIds.length < 1 ||
      !changeIds.every((changeId) => typeof changeId === "string") ||
      !isRecord(mutation["workingHead"]) ||
      mutation["workingHead"]["kind"] !== "application" ||
      mutation["workingHead"]["applicationId"] !== applicationId
    ) {
      continue;
    }
    const path = mutationCall.arguments?.["path"];
    if (typeof path !== "string" || !path.startsWith("packages/")) continue;
    for (const call of calls.slice(mutationIndex + 1)) {
      const committed = commitResult(call);
      const event = committed?.["event"];
      if (
        Array.isArray(committed?.["committedApplicationIds"]) &&
        committed["committedApplicationIds"].includes(applicationId) &&
        isRecord(event) &&
        event["kind"] === "event" &&
        typeof event["eventId"] === "string"
      ) {
        return { passed: true, reason: undefined };
      }
    }
  }
  return {
    passed: false,
    reason: "The package creation was not followed by an identity-joined managed change and commit",
  };
}

export const projectLifecycleTests: TestCase[] = [
  {
    name: "panel-create-commit-open",
    description: "Create and open a new panel project",
    category: "project-lifecycle",
    workspaceRepoFixture: CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
    prompt: "Create a brand-new isolated panel project and open it for use.",
    validate: validatePanelCreate,
  },
  {
    name: "panel-fork-dry-run-and-commit",
    description: "Fork and open a panel project",
    category: "project-lifecycle",
    workspaceRepoFixture: BUILDABLE_PANEL_WITH_DERIVED_WORKSPACE_REPO_FIXTURE,
    prompt: "Fork the existing panel into a new isolated panel and open the result.",
    validate: validatePanelFork,
  },
  {
    name: "worker-fork-classmap-dry-run",
    description: "Plan a worker fork",
    category: "project-lifecycle",
    prompt: "Plan a safe isolated fork of an existing worker without applying it.",
    validate: validateWorkerForkPlan,
  },
  {
    name: "commit-existing-project",
    description: "Create, change, and commit a package project",
    category: "project-lifecycle",
    workspaceRepoFixture: CREATED_PACKAGE_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Create an isolated package project, make one follow-up change, and commit that change.",
    validate: validateProjectCommit,
  },
];
