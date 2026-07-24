import {
  BUILDABLE_PANEL_WITH_DERIVED_WORKSPACE_REPO_FIXTURE,
  CREATED_PACKAGE_WORKSPACE_REPO_FIXTURE,
  CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import { findLastAgentMessage, getToolCalls, type InvocationCardPayloadLike } from "./_helpers.js";
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

function hasBootReadyPanelEvidence(values: readonly unknown[]): boolean {
  const records = walkRecords(values);
  const observations = records.filter(
    (record) =>
      record["phase"] === "ready" &&
      typeof record["panelId"] === "string" &&
      typeof record["attemptId"] === "string" &&
      typeof record["runtimeEntityId"] === "string" &&
      typeof record["buildKey"] === "string" &&
      record["buildKey"].length > 0
  );
  return observations.some((observation) =>
    records.some(
      (record) =>
        record["panelId"] === observation["panelId"] &&
        record["attemptId"] === observation["attemptId"] &&
        record["runtimeEntityId"] === observation["runtimeEntityId"] &&
        record["buildKey"] === observation["buildKey"] &&
        typeof record["capturedAt"] === "number" &&
        isRecord(record["document"]) &&
        record["document"]["kind"] === "synth" &&
        isRecord(record["document"]["structure"])
    )
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
  return returned.present && hasBootReadyPanelEvidence([returned.value])
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "The completed lifecycle returned no matching boot-ready observation and provenance-bearing snapshot",
      };
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
  return returned.present && hasBootReadyPanelEvidence([returned.value])
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "The committed fork returned no matching boot-ready observation and provenance-bearing snapshot",
      };
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

function returnedRecords(call: InvocationCardPayloadLike): Record<string, unknown>[] {
  const returned = invocationReturnValue(call);
  return returned.present ? walkRecords([returned.value]) : [];
}

function compilerCheckSummary(call: InvocationCardPayloadLike): Record<string, unknown> | null {
  if (call.name !== "eval") return null;
  const code = String(call.arguments?.["code"] ?? "");
  const records = returnedRecords(call);
  if (code.includes("typecheck-service") && code.includes("checkPanel")) {
    return (
      records.find(
        (record) => typeof record["errorCount"] === "number" && Array.isArray(record["diagnostics"])
      ) ?? null
    );
  }
  if (!code.includes("getBuildReport")) return null;
  const report = records.find(
    (record) =>
      record["kind"] === "panel" &&
      typeof record["status"] === "string" &&
      Array.isArray(record["builds"])
  );
  if (!report) return null;
  const diagnostics = [
    ...(Array.isArray(report["diagnostics"]) ? report["diagnostics"] : []),
    ...walkRecords(Array.isArray(report["builds"]) ? report["builds"] : []).flatMap((build) =>
      Array.isArray(build["diagnostics"]) ? build["diagnostics"] : []
    ),
  ].filter(isRecord);
  const compilerErrors = diagnostics.filter(
    (diagnostic) =>
      diagnostic["severity"] === "error" &&
      (diagnostic["source"] === "tsc" || diagnostic["source"] === "esbuild")
  );
  if (report["status"] !== "ok" && compilerErrors.length === 0) return null;
  return {
    diagnostics,
    errorCount: compilerErrors.length,
    warningCount: diagnostics.filter((diagnostic) => diagnostic["severity"] === "warning").length,
  };
}

function successfulPanelMutation(
  call: InvocationCardPayloadLike,
  source: string
): Record<string, unknown> | null {
  const path = call.arguments?.["path"];
  if (typeof path !== "string" || !path.startsWith(`${source}/`)) return null;
  const mutation = mutationResult(call);
  return mutation &&
    typeof mutation["applicationId"] === "string" &&
    isRecord(mutation["workingHead"]) &&
    mutation["workingHead"]["kind"] === "application" &&
    mutation["workingHead"]["applicationId"] === mutation["applicationId"]
    ? mutation
    : null;
}

function operationResult(
  call: InvocationCardPayloadLike,
  operation: "push" | "status"
): Record<string, unknown> | null {
  const focused = call.name === operation;
  const generic = call.name === "vcs" && call.arguments?.["operation"] === operation;
  if (!focused && !generic) return null;
  const value = details(call);
  return value && isRecord(value["result"]) ? value["result"] : value;
}

function isInitialPanelInspection(call: InvocationCardPayloadLike): boolean {
  if (call.name !== "eval") return false;
  const code = String(call.arguments?.["code"] ?? "");
  return (
    code.includes("openPanel") &&
    (code.includes("lightweightPage") ||
      code.includes(".diagnose(") ||
      code.includes(".observe(") ||
      code.includes(".screenshot("))
  );
}

function isCompleteTodoRuntimeVerification(call: InvocationCardPayloadLike): boolean {
  if (call.name !== "eval") return false;
  const code = String(call.arguments?.["code"] ?? "");
  const lower = code.toLowerCase();
  const exercisesTextEntry = /\.(?:fill|type|press)\s*\(/u.test(code);
  const exercisesClick = /\.click\s*\(/u.test(code);
  const inspectsDom = /\.(?:evaluate|textContent|innerText|locator)\s*\(/u.test(code);
  const rebuildsSamePanel = /\.(?:rebuild|reload)\s*\(/u.test(code);
  const exercisesFiltering = /\b(?:filter|active|completed)\b/u.test(lower);
  const exercisesRemoval = /\b(?:delete|remove)\b/u.test(lower);
  if (
    !code.includes("lightweightPage") ||
    !code.includes("consoleHistory") ||
    !code.includes("screenshot") ||
    !exercisesTextEntry ||
    !exercisesClick ||
    !inspectsDom ||
    !rebuildsSamePanel ||
    !exercisesFiltering ||
    !exercisesRemoval
  ) {
    return false;
  }
  return returnedRecords(call).some(
    (record) => Array.isArray(record["errors"]) && record["errors"].length === 0
  );
}

function validateTodoDebugLoop(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const calls = base.evidence.calls;

  let creationIndex = -1;
  let source = "";
  for (const [index, call] of calls.entries()) {
    if (call.name !== "eval") continue;
    const created = returnedRecords(call).find((record) => createdProject(record, "panels"));
    if (created && typeof created["created"] === "string") {
      creationIndex = index;
      source = created["created"];
      break;
    }
  }
  if (creationIndex < 0) {
    return { passed: false, reason: "No completed eval returned the created To-Do panel identity" };
  }

  const brokenTypecheckIndex = calls.findIndex((call, index) => {
    const summary = index > creationIndex ? compilerCheckSummary(call) : null;
    return summary !== null && Number(summary["errorCount"]) > 0;
  });
  if (brokenTypecheckIndex < 0) {
    return {
      passed: false,
      reason:
        "The deliberate compiler defect was not observed through a structured panel typecheck",
    };
  }
  const authoredBrokenPanel = calls
    .slice(creationIndex + 1, brokenTypecheckIndex)
    .some((call) => successfulPanelMutation(call, source) !== null);
  if (!authoredBrokenPanel) {
    return {
      passed: false,
      reason: "No managed panel edit preceded the failing typecheck",
    };
  }

  const firstCleanTypecheckIndex = calls.findIndex((call, index) => {
    const summary = index > brokenTypecheckIndex ? compilerCheckSummary(call) : null;
    return summary !== null && summary["errorCount"] === 0;
  });
  if (firstCleanTypecheckIndex < 0) {
    return {
      passed: false,
      reason: "No later structured typecheck proved that the compiler defect was repaired",
    };
  }

  const firstInspectionIndex = calls.findIndex(
    (call, index) => index > firstCleanTypecheckIndex && isInitialPanelInspection(call)
  );
  if (firstInspectionIndex < 0) {
    return {
      passed: false,
      reason: "The compile-clean panel was not launched and inspected before UX repair",
    };
  }

  let uxMutationIndex = -1;
  let uxApplicationId = "";
  for (let index = firstInspectionIndex + 1; index < calls.length; index += 1) {
    const mutation = successfulPanelMutation(calls[index]!, source);
    if (mutation) {
      uxMutationIndex = index;
      uxApplicationId = String(mutation["applicationId"]);
      break;
    }
  }
  if (uxMutationIndex < 0) {
    return {
      passed: false,
      reason: "No managed source edit repaired the UX after inspecting the running panel",
    };
  }

  const finalCleanTypecheckIndex = calls.findIndex((call, index) => {
    const summary = index > uxMutationIndex ? compilerCheckSummary(call) : null;
    return summary !== null && summary["errorCount"] === 0;
  });
  if (finalCleanTypecheckIndex < 0) {
    return {
      passed: false,
      reason: "The UX repair was not followed by a clean structured typecheck",
    };
  }

  const finalRuntimeIndex = calls.findIndex(
    (call, index) => index > finalCleanTypecheckIndex && isCompleteTodoRuntimeVerification(call)
  );
  if (finalRuntimeIndex < 0) {
    return {
      passed: false,
      reason:
        "No final live-panel verification rebuilt the same panel, exercised add/complete/filter/delete behavior, captured the UI, and returned an empty console error list",
    };
  }

  let publishedEventId = "";
  for (let index = uxMutationIndex + 1; index < calls.length; index += 1) {
    const committed = commitResult(calls[index]!);
    const event = committed?.["event"];
    if (
      !committed ||
      !Array.isArray(committed["committedApplicationIds"]) ||
      !committed["committedApplicationIds"].includes(uxApplicationId) ||
      !isRecord(event) ||
      typeof event["eventId"] !== "string"
    ) {
      continue;
    }
    for (let pushIndex = index + 1; pushIndex < calls.length; pushIndex += 1) {
      const pushed = operationResult(calls[pushIndex]!, "push");
      if (pushed?.["eventId"] === event["eventId"] && pushed["mainEventId"] === event["eventId"]) {
        publishedEventId = event["eventId"];
        break;
      }
    }
    if (publishedEventId) break;
  }
  if (!publishedEventId) {
    return {
      passed: false,
      reason: "The exact UX-repair application was not joined to a committed and published event",
    };
  }

  const finalStatus = calls
    .slice(finalRuntimeIndex + 1)
    .map((call) => operationResult(call, "status"))
    .find(
      (status) =>
        status?.["clean"] === true &&
        status["mainEventId"] === publishedEventId &&
        isRecord(status["workingHead"]) &&
        status["workingHead"]["kind"] === "event" &&
        status["workingHead"]["eventId"] === publishedEventId
    );
  if (!finalStatus) {
    return {
      passed: false,
      reason: "No final status proved the tested panel was clean at the published event",
    };
  }

  const final = findLastAgentMessage(result);
  if (
    !final.includes(publishedEventId) ||
    !/compil|type.?check/iu.test(final) ||
    !/\\bux\\b|usab|experience/iu.test(final) ||
    !/add|complete|filter|delete/iu.test(final)
  ) {
    return {
      passed: false,
      reason:
        "The final response did not report the observed compiler defect, UX repair, live behavior, and exact published event",
    };
  }
  return { passed: true, reason: undefined };
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
  {
    name: "panel-todo-debug-polish",
    description: "Build, debug, polish, and publish a To-Do panel through the live UI",
    category: "project-lifecycle",
    resources: ["vcs:protected-main"],
    workspaceRepoFixture: CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: {
      authority: [
        {
          ruleId: "inspect-created-panel",
          capability: "panel.inspect",
          resource: { kind: "exact", key: "panel.inspect" },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [],
    },
    prompt:
      "Build a simple, polished To-Do list as a brand-new isolated panel. Begin with two small deliberate defects—one compiler error and one obvious usability problem—so the development loop has real failures to find. Then carry the app through the normal workspace development workflow: diagnose the compiler failure, launch and inspect the actual panel, repair both defects, exercise the add, complete, filter, and delete flows in the live UI, and publish the finished result. Make the final experience keyboard-friendly, responsive, visually polished, and free of runtime or console errors. Report the defects you observed and concrete final verification.",
    validate: validateTodoDebugLoop,
  },
];
