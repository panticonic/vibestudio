import {
  BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
  CONTENT_WORKSPACE_REPO_FIXTURE,
  CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import { panelControlAuthorityPolicy, PANEL_AUTOMATION_RESOURCE } from "../panel-authority.js";
import { finalMessageHasAll, getToolCalls, type InvocationCardPayloadLike } from "./_helpers.js";
import { completedScenarioEvidence, walkRecords } from "./_scenario-evidence.js";
import { orchestratePanelGoal } from "./_panel-tree-invariant.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function records(call: InvocationCardPayloadLike): Record<string, unknown>[] {
  return walkRecords([call.execution?.result]);
}

function isFailed(call: InvocationCardPayloadLike): boolean {
  return (
    call.execution?.isError === true ||
    call.execution?.status === "error" ||
    call.execution?.status === "failed"
  );
}

function isComplete(call: InvocationCardPayloadLike): boolean {
  return call.execution?.status === "complete" && call.execution.isError !== true;
}

function failure(call: InvocationCardPayloadLike, code: string): Record<string, unknown> | null {
  return (
    records(call).find(
      (record) => record["protocol"] === "agent-tool-failure.v1" && record["code"] === code
    ) ?? null
  );
}

function createdPublishedPanel(call: InvocationCardPayloadLike): boolean {
  return records(call).some((record) => {
    const preflight = record["preflight"];
    const publication = record["publication"];
    return (
      typeof record["created"] === "string" &&
      record["created"].startsWith("panels/") &&
      isRecord(preflight) &&
      preflight["ok"] === true &&
      preflight["projectType"] === "panel" &&
      isRecord(publication) &&
      publication["published"] === true
    );
  });
}

function validateInvalidIconRecovery(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["eval"]);
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const rejectedIndex = calls.findIndex((call) => {
    if (call.name !== "eval" || !isFailed(call)) return false;
    const typed = failure(call, "project_icon_invalid");
    const recovery = typed?.["recovery"];
    return (
      isRecord(recovery) &&
      recovery["action"] === "correct-request" &&
      records(call).some((record) => record["protocol"] === "workspace-dev-catalog.v1")
    );
  });
  const discoveredIndex = calls.findIndex(
    (call, index) =>
      index > rejectedIndex &&
      call.name === "eval" &&
      isComplete(call) &&
      records(call).some(
        (record) =>
          record["protocol"] === "workspace-dev-catalog.v1" &&
          Array.isArray(record["entries"]) &&
          record["entries"].length > 0
      )
  );
  // Proactive discovery is the best outcome and must not be penalized for
  // avoiding a predictable failure. When the unsupported icon is attempted,
  // the typed failure's embedded bounded catalog is already sufficient
  // correction evidence; an extra catalog round trip is optional.
  const catalogIndex =
    discoveredIndex >= 0 ? discoveredIndex : rejectedIndex >= 0 ? rejectedIndex : -1;
  const createIndex = calls.findIndex(
    (call, index) => index > catalogIndex && call.name === "eval" && createdPublishedPanel(call)
  );
  return catalogIndex >= 0 && createIndex > catalogIndex
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The agent did not discover the bounded catalog and create the corrected panel",
      };
}

function validateRecoverableInfrastructureContinuation(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, [], {
    allowFailed: (call) =>
      call.name === "eval" && failure(call, "recoverable_infrastructure_probe") !== null,
  });
  if (!base.passed) return base;
  const failed = getToolCalls(result).find((call) => {
    const typed = call.name === "eval" ? failure(call, "recoverable_infrastructure_probe") : null;
    const recovery = typed?.["recovery"];
    return (
      isFailed(call) &&
      call.execution?.terminalOutcome === "infrastructure_error" &&
      isRecord(recovery) &&
      recovery["action"] === "reobserve"
    );
  });
  if (!failed) {
    return {
      passed: false,
      reason: "The eval failure did not retain its infrastructure origin and typed recovery",
    };
  }
  return finalMessageHasAll(result, ["RECOVERED_IN_SAME_TURN"]);
}

function buildReceipt(record: Record<string, unknown>, status: "ok" | "failed") {
  const receipt = record["receipt"];
  return isRecord(receipt) &&
    receipt["protocol"] === "build-verification-receipt.v1" &&
    receipt["status"] === status
    ? receipt
    : null;
}

function validateBoundedBuildDiagnostics(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["verify"], {
    allowFailed: (call) => call.name === "verify",
  });
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const failedIndex = calls.findIndex((call) => {
    if (call.name !== "verify" || !isFailed(call)) return false;
    return records(call).some((record) => {
      const receipt = buildReceipt(record, "failed");
      const report = record["report"];
      return (
        receipt !== null &&
        isRecord(report) &&
        Array.isArray(report["diagnostics"]) &&
        report["diagnostics"].length <= 40 &&
        typeof record["truncatedDiagnostics"] === "number" &&
        record["truncatedDiagnostics"] > 0
      );
    });
  });
  if (failedIndex < 0) {
    return {
      passed: false,
      reason: "No failed build returned a bounded report and exact failed-build receipt",
    };
  }
  const cleanIndex = calls.findIndex(
    (call, index) =>
      index > failedIndex &&
      call.name === "verify" &&
      isComplete(call) &&
      records(call).some((record) => buildReceipt(record, "ok") !== null)
  );
  return cleanIndex > failedIndex
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The bounded failed build was not repaired and rebuilt cleanly" };
}

function extensionlessTarget(call: InvocationCardPayloadLike): boolean {
  const target = call.arguments?.["target"] ?? call.arguments?.["path"];
  if (typeof target !== "string") return false;
  const path = target.replace(/^file:/u, "");
  const basename = path.split("/").at(-1) ?? "";
  return basename.length > 0 && !/\.[A-Za-z0-9]{1,8}$/u.test(basename);
}

function normalizedFilePath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? value.replace(/^file:(?:\/\/)?/iu, "")
    : null;
}

function screenshotPaths(call: InvocationCardPayloadLike): Set<string> {
  const paths = new Set<string>();
  for (const record of records(call)) {
    const direct = normalizedFilePath(record["path"] ?? record["screenshot"]);
    if (direct) paths.add(direct);
    const returned = record["returnValue"];
    const returnedPath = isRecord(returned)
      ? normalizedFilePath(returned["path"] ?? returned["screenshot"])
      : normalizedFilePath(returned);
    if (returnedPath) paths.add(returnedPath);
  }
  return paths;
}

function isNativeImageRead(call: InvocationCardPayloadLike): boolean {
  return records(call).some(
    (record) =>
      typeof record["mimeType"] === "string" &&
      record["mimeType"].startsWith("image/") &&
      typeof record["size"] === "number" &&
      record["size"] > 0
  );
}

function validateExtensionlessScreenshot(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["eval", "read"]);
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const capturedPaths = new Set(
    calls.flatMap((call) =>
      call.name === "eval" &&
      isComplete(call) &&
      /\.screenshot\s*\(/u.test(String(call.arguments?.["code"] ?? "")) &&
      /fs\.writeFile\s*\(/u.test(String(call.arguments?.["code"] ?? ""))
        ? [...screenshotPaths(call)]
        : []
    )
  );
  const imageRead = calls.some(
    (call) =>
      call.name === "read" &&
      isComplete(call) &&
      extensionlessTarget(call) &&
      isNativeImageRead(call) &&
      capturedPaths.has(
        normalizedFilePath(call.arguments?.["target"] ?? call.arguments?.["path"]) ?? ""
      )
  );
  return capturedPaths.size > 0 && imageRead
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "The extensionless screenshot was not returned through read as native image content",
      };
}

function validatePanelGenerationRecovery(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["eval", "verify", "apply_patch"]);
  if (!base.passed) return base;
  const evalCalls = getToolCalls(result).filter((call) => call.name === "eval" && isComplete(call));
  const initial = evalCalls.findIndex((call) =>
    String(call.arguments?.["code"] ?? "").includes("cdp.session")
  );
  const refresh = evalCalls.findIndex((call, index) => {
    if (index <= initial) return false;
    const code = String(call.arguments?.["code"] ?? "");
    return (
      code.includes(".rebuild(") &&
      code.includes(".refresh(") &&
      records(call).some((record) => record["status"] === "replaced")
    );
  });
  const observedInteraction = evalCalls.slice(Math.max(0, refresh)).some((call) =>
    records(call).some((record) => {
      const effect = record["effect"];
      return (
        record["protocol"] === "cdp-interaction-outcome.v1" &&
        record["delivery"] === "dispatched" &&
        isRecord(effect) &&
        effect["status"] === "observed"
      );
    })
  );
  return initial >= 0 && refresh > initial && observedInteraction
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "The panel was not rebuilt through a replaced generation and verified by a semantic interaction outcome",
      };
}

function validateStaleEditRecovery(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result, ["read", "apply_patch"], {
    allowFailed: (call) => call.name === "apply_patch",
  });
  if (!base.passed) return base;
  const calls = getToolCalls(result);
  const readIndex = calls.findIndex(
    (call) =>
      call.name === "read" &&
      isComplete(call) &&
      records(call).some((record) => record["protocol"] === "workspace-read-receipt.v1")
  );
  const staleIndex = calls.findIndex((call, index) => {
    if (index <= readIndex || call.name !== "apply_patch" || !isFailed(call)) return false;
    const typed = failure(call, "WorkspaceReadConflict");
    const recovery = typed?.["recovery"];
    return (
      isRecord(recovery) &&
      recovery["action"] === "reobserve" &&
      records(call).some(
        (record) =>
          record["protocol"] === "workspace-read-receipt.v1" &&
          typeof record["contentHash"] === "string"
      )
    );
  });
  const recoveredIndex = calls.findIndex(
    (call, index) => index > staleIndex && call.name === "apply_patch" && isComplete(call)
  );
  return readIndex >= 0 && staleIndex > readIndex && recoveredIndex > staleIndex
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "The stale receipt was not rejected with fresh evidence and followed by a corrected edit",
      };
}

const SCREENSHOT_PROMPT =
  "Open a tiny disposable browser view, capture its rendered pixels to a scratch file with no filename extension, read that file as an image, and report the visible heading. Clean up the view when finished.";

export const developerErgonomicsTests: TestCase[] = [
  {
    name: "recoverable-infrastructure-failure-continues-turn",
    description: "Continue the same agent turn after a typed recoverable infrastructure failure",
    category: "developer-ergonomics",
    validation: "agent-evidence",
    prompt:
      "Exercise the agent failure protocol once: use eval to throw an Error whose errorData is { code: 'recoverable_infrastructure_probe', failureKind: 'infrastructure', recovery: { action: 'reobserve', instruction: 'Continue this same turn and report RECOVERED_IN_SAME_TURN.' } }. The eval is expected to fail. After receiving that failed tool result, continue in this same turn and answer with exactly RECOVERED_IN_SAME_TURN. Do not retry the eval.",
    expectedToolFailures: [{ name: "eval", errorIncludes: "recoverable infrastructure probe" }],
    validate: validateRecoverableInfrastructureContinuation,
  },
  {
    name: "invalid-icon-discover-recover-create",
    description: "Resolve an unsupported curated icon through bounded discovery",
    category: "developer-ergonomics",
    validation: "agent-evidence",
    workspaceRepoFixture: CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
    prompt:
      "Create and publish a brand-new isolated panel whose requested built-in icon is lucide:columns-3. If that exact icon is unavailable, use the returned workspace catalog evidence to choose the closest supported columns or layout icon and finish the panel creation.",
    expectedToolFailures: [{ name: "eval", errorIncludes: "project_icon_invalid" }],
    validate: validateInvalidIconRecovery,
  },
  {
    name: "failed-build-bounded-diagnostics",
    description: "Recover from a diagnostic-heavy build without flooding the trajectory",
    category: "developer-ergonomics",
    validation: "agent-evidence",
    workspaceRepoFixture: BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
    prompt:
      "In the disposable package, deliberately introduce more than fifty independent TypeScript errors, inspect the exact structured build failure, then repair the package and prove the same target builds cleanly. Do not publish the deliberate breakage.",
    expectedToolFailures: [{ name: "verify", errorIncludes: "Build failed" }],
    validate: validateBoundedBuildDiagnostics,
  },
  {
    name: "extensionless-screenshot-resource-read",
    description: "Read an extensionless screenshot as native image content",
    category: "developer-ergonomics",
    validation: "agent-evidence",
    authorityPolicy: panelControlAuthorityPolicy("inspect-extensionless-screenshot"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt: SCREENSHOT_PROMPT,
    orchestrate: (context) =>
      orchestratePanelGoal(context, SCREENSHOT_PROMPT, "inspect an extensionless screenshot"),
    validate: validateExtensionlessScreenshot,
  },
  {
    name: "panel-rebuild-reacquire-and-interact",
    description: "Refresh a generation-fenced CDP session after rebuilding a panel",
    category: "developer-ergonomics",
    validation: "agent-evidence",
    workspaceRepoFixture: CREATED_PANEL_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: panelControlAuthorityPolicy("inspect-rebuilt-generation"),
    resources: [PANEL_AUTOMATION_RESOURCE],
    prompt:
      "Create and publish a small isolated counter panel, build and open it, and exercise one increment through a semantic interaction assertion. Then make a visible source improvement, rebuild the same panel, refresh the existing generation-fenced automation session, and prove another increment on the replacement runtime without replaying an uncertain click.",
    validate: validatePanelGenerationRecovery,
  },
  {
    name: "stale-edit-reobserve-and-apply",
    description: "Recover an optimistic file edit from a stale read receipt",
    category: "developer-ergonomics",
    validation: "agent-evidence",
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    prompt:
      "In the disposable project, read its main note and preserve that exact read receipt. Make one legitimate update, then demonstrate that a second change based on the old receipt is safely rejected. Use the returned current evidence to form and apply the corrected second change. Do not publish.",
    expectedToolFailures: [{ name: "apply_patch", errorIncludes: "WorkspaceReadConflict" }],
    validate: validateStaleEditRecovery,
  },
];
