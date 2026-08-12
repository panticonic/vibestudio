import {
  CREATED_PACKAGE_WORKSPACE_REPO_FIXTURE,
  CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
  CREATED_PROJECT_WORKSPACE_REPO_FIXTURE,
  CREATED_SKILL_WORKSPACE_REPO_FIXTURE,
  CREATED_WORKER_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
  type WorkspaceRepoCreationScope,
} from "../types.js";
import { getToolCalls } from "./_helpers.js";
import { completedScenarioEvidence, walkRecords } from "./_scenario-evidence.js";

type ExecutableScaffold = {
  name: string;
  description: string;
  prompt: string;
  projectType: "panel" | "worker" | "package" | "skill";
  section: "panels" | "workers" | "packages" | "skills";
  fixture: WorkspaceRepoCreationScope;
};

const EXECUTABLE_SCAFFOLDS: ExecutableScaffold[] = [
  {
    name: "scaffold-react-panel-build",
    description: "Build the default React panel scaffold",
    prompt:
      "Create and publish a brand-new isolated panel using the default React scaffold, then run its exact structured build check and report whether it is clean.",
    projectType: "panel",
    section: "panels",
    fixture: CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
  },
  {
    name: "scaffold-svelte-panel-build",
    description: "Build the Svelte panel scaffold",
    prompt:
      "Create and publish a brand-new isolated panel using the available Svelte scaffold, then run its exact structured build check and report whether it is clean.",
    projectType: "panel",
    section: "panels",
    fixture: CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
  },
  {
    name: "scaffold-stateless-worker-build",
    description: "Build the stateless worker scaffold",
    prompt:
      "Create and publish a brand-new isolated stateless worker from the standard scaffold, then run its exact structured build check and report whether it is clean.",
    projectType: "worker",
    section: "workers",
    fixture: CREATED_WORKER_WORKSPACE_REPO_FIXTURE,
  },
  {
    name: "scaffold-agentic-worker-build",
    description: "Build the durable agent worker scaffold",
    prompt:
      "Create and publish a brand-new isolated durable agent worker from the agentic scaffold, then run its exact structured build check and report whether it is clean.",
    projectType: "worker",
    section: "workers",
    fixture: CREATED_WORKER_WORKSPACE_REPO_FIXTURE,
  },
  {
    name: "scaffold-package-build",
    description: "Build the package scaffold",
    prompt:
      "Create and publish a brand-new isolated workspace package from the standard scaffold, then run its exact structured build check and report whether it is clean.",
    projectType: "package",
    section: "packages",
    fixture: CREATED_PACKAGE_WORKSPACE_REPO_FIXTURE,
  },
  {
    name: "scaffold-skill-build",
    description: "Build the skill scaffold",
    prompt:
      "Create and publish a brand-new isolated workspace skill from the standard scaffold, then run its exact structured build check and report whether it is clean.",
    projectType: "skill",
    section: "skills",
    fixture: CREATED_SKILL_WORKSPACE_REPO_FIXTURE,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function details(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value["details"]) ? value["details"] : value;
}

function createdScaffold(
  record: Record<string, unknown>,
  projectType: ExecutableScaffold["projectType"] | "project",
  section: ExecutableScaffold["section"] | "projects"
): boolean {
  const preflight = record["preflight"];
  const publication = record["publication"];
  return (
    typeof record["created"] === "string" &&
    record["created"].startsWith(`${section}/`) &&
    isRecord(preflight) &&
    preflight["ok"] === true &&
    preflight["projectType"] === projectType &&
    isRecord(publication) &&
    publication["published"] === true &&
    typeof publication["committedEventId"] === "string" &&
    typeof publication["publishedEventId"] === "string"
  );
}

function successfulBuildReceipt(record: Record<string, unknown>, target: string): boolean {
  const receipt = record["receipt"];
  if (!isRecord(receipt) || receipt["protocol"] !== "build-verification-receipt.v1") {
    return false;
  }
  const unit = receipt["unit"];
  const builds = receipt["builds"];
  return (
    receipt["target"] === target &&
    receipt["status"] === "ok" &&
    typeof receipt["contextId"] === "string" &&
    receipt["ref"] === `ctx:${receipt["contextId"]}` &&
    typeof receipt["reportDigest"] === "string" &&
    receipt["reportDigest"].length === 64 &&
    isRecord(unit) &&
    unit["repoPath"] === target &&
    Array.isArray(builds) &&
    builds.length > 0 &&
    builds.every(
      (build) =>
        isRecord(build) &&
        typeof build["target"] === "string" &&
        typeof build["buildKey"] === "string"
    )
  );
}

function validateExecutableScaffold(result: TestExecutionResult, variant: ExecutableScaffold) {
  const base = completedScenarioEvidence(result, ["eval", "verify"]);
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const createIndex = calls.findIndex(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      walkRecords([details(call.execution.result)]).some((record) =>
        createdScaffold(record, variant.projectType, variant.section)
      )
  );
  if (createIndex < 0) {
    return { passed: false, reason: `No published ${variant.projectType} scaffold was returned` };
  }
  const target = walkRecords([details(calls[createIndex]!.execution?.result)])
    .map((record) => record["created"])
    .find(
      (value): value is string =>
        typeof value === "string" && value.startsWith(`${variant.section}/`)
    );
  if (!target) return { passed: false, reason: "The scaffold result had no exact repository path" };
  const buildIndex = calls.findIndex((call, index) => {
    if (index <= createIndex || call.name !== "verify" || call.execution?.isError === true) {
      return false;
    }
    const value = details(call.execution?.result);
    return Boolean(value && successfulBuildReceipt(value, target));
  });
  return buildIndex >= 0
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The published scaffold was not followed by a clean exact build receipt",
      };
}

function validateContentScaffold(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["eval"]);
  if (!base.passed) return base;
  return walkRecords(base.evidence.evalValues).some((record) =>
    createdScaffold(record, "project", "projects")
  )
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "No published content-only project scaffold was returned" };
}

export const scaffoldMatrixTests: TestCase[] = [
  ...EXECUTABLE_SCAFFOLDS.map(
    (variant): TestCase => ({
      name: variant.name,
      description: variant.description,
      category: "scaffold-matrix",
      workspaceRepoFixture: variant.fixture,
      prompt: variant.prompt,
      validate: (result) => validateExecutableScaffold(result, variant),
    })
  ),
  {
    name: "scaffold-content-project-preflight",
    description: "Publish the content-only project scaffold",
    category: "scaffold-matrix",
    workspaceRepoFixture: CREATED_PROJECT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Create and publish a brand-new isolated content-only workspace project from the standard scaffold and report its validated preflight result.",
    validate: validateContentScaffold,
  },
];
