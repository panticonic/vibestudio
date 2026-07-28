import type {
  TestCase,
  TestExecutionResult,
  TestOrchestrationContext,
} from "../types.js";
import { walkRecords } from "./_scenario-evidence.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION = /^[a-f0-9]{32}$/u;
const TERMINAL_RUN_STATES = new Set([
  "ready",
  "succeeded",
  "stopped",
  "failed",
  "cancelled",
  "requires-repair",
]);

interface HarnessOperation {
  service: "development" | "vcs" | "attachedHosts";
  method: string;
  result: unknown;
}

interface SelfDevelopmentReceipt {
  scenario: string;
  source: "system-test-harness";
  operations: HarnessOperation[];
  prerequisite: { available: boolean; reason: string | null };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function captured(
  result: TestExecutionResult,
  scenario: string
):
  | { passed: true; receipt: SelfDevelopmentReceipt; rows: Record<string, unknown>[] }
  | { passed: false; reason: string } {
  const value = result.diagnostics?.["selfDevelopment"];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { passed: false, reason: "Harness did not capture self-development RPC evidence" };
  }
  const receipt = value as unknown as SelfDevelopmentReceipt;
  if (receipt.source !== "system-test-harness" || receipt.scenario !== scenario) {
    return { passed: false, reason: "Harness evidence is not bound to this exact scenario" };
  }
  if (!receipt.prerequisite.available) {
    return {
      passed: false,
      reason: `Self-development prerequisite unavailable: ${receipt.prerequisite.reason ?? "unknown"}`,
    };
  }
  if (result.error) return { passed: false, reason: result.error };
  return {
    passed: true,
    receipt,
    rows: walkRecords(receipt.operations.map(({ result: operationResult }) => operationResult)),
  };
}

function validateCurrentClient(result: TestExecutionResult) {
  const checked = captured(result, "self-development-current-client");
  if (!checked.passed) return checked;
  const run = checked.rows.find(
    (row) =>
      object(row["target"])?.["kind"] === "current-host-client" &&
      (row["state"] === "ready" || row["state"] === "succeeded")
  );
  const client = object(run?.["client"]);
  const snapshot = object(run?.["snapshot"]);
  const artifact = object(run?.["artifact"]);
  return run &&
    (run["state"] === "ready" || run["state"] === "succeeded") &&
    run["commitPoint"] === "ready" &&
    client?.["state"] === "ready" &&
    typeof client["providerId"] === "string" &&
    typeof client["childRuntimeId"] === "string" &&
    typeof client["attestedAt"] === "number" &&
    validDigest(client["executionDigest"]) &&
    artifact?.["executionDigest"] === client["executionDigest"] &&
    validDigest(snapshot?.["snapshotDigest"])
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Host-captured calls contain no ready current-host client attestation",
      };
}

function validateIsolatedHost(result: TestExecutionResult) {
  const checked = captured(result, "self-development-isolated-host");
  if (!checked.passed) return checked;
  const run = checked.rows.find(
    (row) =>
      object(row["target"])?.["kind"] === "isolated-host" &&
      (row["state"] === "ready" || row["state"] === "succeeded")
  );
  const instance = object(run?.["instance"]);
  const route = object(run?.["attachedHost"]);
  const artifact = object(run?.["artifact"]);
  return run &&
    (run["state"] === "ready" || run["state"] === "succeeded") &&
    run["commitPoint"] === "ready" &&
    run["hostReadiness"] === "ready" &&
    instance?.["state"] === "ready" &&
    typeof instance["generationId"] === "string" &&
    GENERATION.test(instance["generationId"]) &&
    validDigest(instance["executionDigest"]) &&
    artifact?.["executionDigest"] === instance["executionDigest"] &&
    route?.["state"] === "ready" &&
    route["childGenerationId"] === instance["generationId"] &&
    validDigest(route["authorityCeilingDigest"])
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Host-captured calls contain no same-generation ready instance and route",
      };
}

function validateDirtySemanticState(result: TestExecutionResult) {
  const checked = captured(result, "self-development-dirty-semantic-state");
  if (!checked.passed) return checked;
  const edit = checked.receipt.operations.find(
    ({ service, method }) => service === "vcs" && method === "edit"
  );
  const session = checked.rows.find(
    (row) => object(object(row["basis"])?.["parentWorkingHead"])?.["kind"] === "application"
  );
  const parent = object(object(session?.["basis"])?.["parentWorkingHead"]);
  const run = checked.rows.find(
    (row) =>
      row["sessionId"] === session?.["sessionId"] &&
      row["state"] === "succeeded" &&
      row["commitPoint"] === "artifacts-verified" &&
      object(row["target"])?.["kind"] === "build-only"
  );
  const snapshot = object(run?.["snapshot"]);
  const source = object(snapshot?.["repositoryState"]);
  const artifact = object(run?.["artifact"]);
  const artifactSource = object(artifact?.["sourceState"]);
  const artifactState = object(artifactSource?.["state"]);
  const contentRoots = Array.isArray(artifactSource?.["contentRoots"])
    ? artifactSource["contentRoots"]
    : [];
  const exactContentRoot = contentRoots.some((candidate) => {
    const root = object(candidate);
    return (
      root &&
      root["repoPath"] === snapshot?.["repoPath"] &&
      root["stateHash"] === snapshot?.["contentRoot"]
    );
  });
  return edit &&
    session &&
    run &&
    typeof parent?.["applicationId"] === "string" &&
    object(edit.result)?.["applicationId"] === parent["applicationId"] &&
    source?.["kind"] === "application" &&
    source["applicationId"] === parent["applicationId"] &&
    validDigest(snapshot?.["snapshotDigest"]) &&
    typeof snapshot["contentRoot"] === "string" &&
    /^state:[a-f0-9]{64}$/u.test(snapshot["contentRoot"]) &&
    artifactSource?.["kind"] === "workspace" &&
    artifactState?.["kind"] === "application" &&
    artifactState["applicationId"] === parent["applicationId"] &&
    exactContentRoot &&
    validDigest(artifact?.["executionDigest"]) &&
    session["contextId"] !== session["parentContextId"]
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "No successful exact build artifact is joined to the harness-authored dirty application and source closure",
      };
}

function validateNativeCheckpoint(result: TestExecutionResult) {
  const checked = captured(result, "self-development-native-checkpoint");
  if (!checked.passed) return checked;
  const availability = checked.receipt.operations.find(
    ({ service, method }) => service === "development" && method === "listNativeTools"
  );
  const tools = Array.isArray(availability?.result) ? availability.result : [];
  const session = checked.rows.find(
    (row) =>
      row["mode"] === "native-tool" &&
      object(object(row["native"])?.["lastCheckpoint"]) !== null
  );
  const native = object(session?.["native"]);
  const checkpoint = object(native?.["lastCheckpoint"]);
  const imported = object(checkpoint?.["imported"]);
  const repository = object(session?.["repository"]);
  const selected = tools.find(
    (tool) => object(tool)?.["toolId"] === native?.["toolId"]
  );
  return object(selected)?.["available"] === true &&
    object(selected)?.["interactiveTerminal"] === true &&
    session &&
    checkpoint &&
    typeof checkpoint["snapshotRevision"] === "string" &&
    validDigest(checkpoint["descriptorDigest"]) &&
    imported !== null &&
    imported?.["contextId"] === session["contextId"] &&
    typeof imported["eventId"] === "string" &&
    Array.isArray(imported["importedRepositoryIds"]) &&
    imported["importedRepositoryIds"].includes(repository?.["repositoryId"]) &&
    native?.["pendingChanges"] === "none"
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "No available reviewed native executor produced an exact imported checkpoint",
      };
}

function validateBuildFailureRecovery(result: TestExecutionResult) {
  const checked = captured(result, "self-development-build-failure-recovery");
  if (!checked.passed) return checked;
  const armedOperation = checked.receipt.operations.find(
    ({ service, method }) =>
      service === "development" && method === "faultFailBuildAfterSnapshotRetained"
  );
  const armed = object(armedOperation?.result);
  const failed = checked.rows.find(
    (row) =>
      row["runId"] === armed?.["runId"] &&
      row["state"] === "failed" &&
      row["commitPoint"] === "snapshot-retained" &&
      object(row["repair"])?.["retryable"] === true &&
      object(object(row["repair"])?.["primaryError"])?.["code"] ===
        "ESYSTEMTEST_INJECTED_BUILD"
  );
  const recovered = checked.rows.find(
    (row) =>
      row["runId"] === failed?.["runId"] &&
      row["state"] === "succeeded" &&
      row["commitPoint"] === "artifacts-verified"
  );
  const retry = checked.receipt.operations.find(
    ({ service, method }) => service === "development" && method === "retry"
  );
  const eventPage = checked.receipt.operations.find(
    ({ service, method }) => service === "development" && method === "events"
  );
  const diagnostic = walkRecords([eventPage?.result]).find(
    (row) =>
      row["kind"] === "diagnostic" &&
      object(row["payload"])?.["code"] === "ESYSTEMTEST_INJECTED_BUILD"
  );
  const diagnosticPayload = object(diagnostic?.["payload"]);
  const failedSnapshot = object(failed?.["snapshot"]);
  const recoveredSnapshot = object(recovered?.["snapshot"]);
  return armed &&
    typeof armed["faultId"] === "string" &&
    armed["faultId"].length > 0 &&
    armed["phase"] === "after-snapshot-retained" &&
    typeof armed["armedAt"] === "number" &&
    failed &&
    retry &&
    recovered &&
    validDigest(failedSnapshot?.["snapshotDigest"]) &&
    recoveredSnapshot?.["snapshotDigest"] === failedSnapshot["snapshotDigest"] &&
    diagnosticPayload?.["faultId"] === armed["faultId"] &&
    diagnosticPayload["phase"] === armed["phase"]
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "Host-captured calls do not bind one consumed retained-snapshot fault to an exact same-run retry",
      };
}

function validateChildEval(result: TestExecutionResult) {
  const checked = captured(result, "self-development-child-eval");
  if (!checked.passed) return checked;
  const attachedRun = checked.rows.find((row) => object(row["attachedHost"])?.["state"] === "ready");
  const route = object(attachedRun?.["attachedHost"]);
  const instance = object(attachedRun?.["instance"]);
  const started = checked.receipt.operations.find(
    ({ service, method }) => service === "attachedHosts" && method === "eval.start"
  );
  const startedRunId = object(started?.result)?.["runId"];
  const resultRecord = checked.rows.find(
    (row) =>
      row["developmentRunId"] === attachedRun?.["runId"] &&
      row["attachedHostSessionId"] === route?.["sessionId"] &&
      row["evalRunId"] === startedRunId &&
      object(row["evalSnapshot"])?.["status"] === "done" &&
      object(object(row["evalSnapshot"])?.["result"])?.["success"] === true
  );
  const invoked = checked.receipt.operations.some(
    ({ service, method }) => service === "attachedHosts" && method === "eval.get"
  );
  return attachedRun &&
    route &&
    instance?.["state"] === "ready" &&
    route["childGenerationId"] === instance["generationId"] &&
    validDigest(instance["executionDigest"]) &&
    typeof startedRunId === "string" &&
    startedRunId.length > 0 &&
    resultRecord &&
    invoked
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "Ordinary attached-host eval result is not joined to its exact run, route, generation, and eval id",
      };
}

function validateChildApproval(result: TestExecutionResult) {
  const checked = captured(result, "self-development-child-approval");
  if (!checked.passed) return checked;
  const attachedRun = checked.rows.find((row) => object(row["attachedHost"])?.["state"] === "ready");
  const route = object(attachedRun?.["attachedHost"]);
  const invocation = checked.receipt.operations.find(
    ({ service, method }) => service === "attachedHosts" && method === "permissions.list"
  );
  const auditOperation = checked.receipt.operations.find(
    ({ service, method }) =>
      service === "attachedHosts" && method === "listApprovalAudit.after"
  );
  const auditPage = object(auditOperation?.result);
  const events = Array.isArray(auditPage?.["events"]) ? auditPage["events"] : [];
  const proof = events.length === 1 ? object(events[0]) : null;
  const invocationResult = object(invocation?.result);
  return attachedRun &&
    route &&
    invocationResult &&
    proof &&
    invocationResult["developmentRunId"] === attachedRun["runId"] &&
    invocationResult["attachedHostSessionId"] === route["sessionId"] &&
    proof?.["sessionId"] === route["sessionId"] &&
    proof["developmentRunId"] === attachedRun["runId"] &&
    proof["childGenerationId"] === route["childGenerationId"] &&
    proof["service"] === "permissions" &&
    proof["method"] === "list" &&
    typeof proof["requestId"] === "string" &&
    proof["requestId"].length > 0 &&
    validDigest(proof["invocationSnapshotDigest"]) &&
    validDigest(proof["preparedOperationDigest"]) &&
    validDigest(proof["shownPresentationDigest"]) &&
    proof["decision"] === "once" &&
    typeof proof["challengedAt"] === "number" &&
    typeof proof["decidedAt"] === "number" &&
    proof["decidedAt"] >= proof["challengedAt"]
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "No unique canonical child approval receipt joins the ordinary invocation to its exact run, route, and generation",
      };
}

function validateOwnedCleanup(result: TestExecutionResult) {
  const checked = captured(result, "self-development-owned-cleanup");
  if (!checked.passed) return checked;
  const terminal = checked.rows.find(
    (row) =>
      ["stopped", "cancelled"].includes(String(row["state"])) &&
      object(row["instance"])?.["state"] === "stopped"
  );
  const instance = object(terminal?.["instance"]);
  const client = object(terminal?.["client"]);
  const route = object(terminal?.["attachedHost"]);
  const session = checked.rows.find(
    (row) => row["sessionId"] === terminal?.["sessionId"] && row["state"] === "closed"
  );
  return terminal &&
    session &&
    typeof instance?.["stoppedAt"] === "number" &&
    (!client || client["state"] === "stopped") &&
    (!route || route["state"] === "closed") &&
    session["contextEffect"] !== "unknown"
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Captured cleanup lacks typed terminal outcomes for every owned effect",
      };
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function operation(
  receipt: SelfDevelopmentReceipt,
  service: HarnessOperation["service"],
  method: string,
  result: unknown
): unknown {
  receipt.operations.push({ service, method, result });
  return result;
}

function unavailable(receipt: SelfDevelopmentReceipt, reason: string): void {
  receipt.prerequisite = { available: false, reason };
}

async function orchestrate(
  scenario: string,
  context: TestOrchestrationContext,
  run: (receipt: SelfDevelopmentReceipt) => Promise<void>
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const receipt: SelfDevelopmentReceipt = {
    scenario,
    source: "system-test-harness",
    operations: [],
    prerequisite: { available: true, reason: null },
  };
  let error: string | undefined;
  try {
    await run(receipt);
  } catch (cause) {
    error = formatError(cause);
  }
  return {
    messages: [],
    duration: Date.now() - startedAt,
    diagnostics: { selfDevelopment: receipt },
    ...(error ? { error } : {}),
  };
}

async function repositoryAndRecipe(
  context: TestOrchestrationContext,
  receipt: SelfDevelopmentReceipt,
  targetKind: "build-only" | "current-host-client" | "isolated-host"
) {
  const repository = await context.runner.resolveSelfDevelopmentRepository();
  operation(receipt, "vcs", "resolveRepository", repository);
  const recipes = await context.runner.callSelfDevelopment<Record<string, unknown>[]>("listRecipes");
  operation(receipt, "development", "listRecipes", recipes);
  const recipe = recipes.find((candidate) => object(candidate["target"])?.["kind"] === targetKind);
  if (!recipe || typeof recipe["recipeId"] !== "string") {
    unavailable(receipt, `no reviewed ${targetKind} recipe is provisioned`);
    return null;
  }
  return { repository, recipe };
}

async function openSemantic(
  context: TestOrchestrationContext,
  receipt: SelfDevelopmentReceipt,
  repositoryId: string
) {
  const opened = await context.runner.callSelfDevelopment<Record<string, unknown>>("openSession", {
    repositoryId,
    mode: "semantic",
    idempotencyKey: `system-test-open-${crypto.randomUUID()}`,
  });
  operation(receipt, "development", "openSession", opened);
  if (opened["kind"] !== "opened") {
    unavailable(receipt, `repository was not adopted: ${JSON.stringify(opened)}`);
    return null;
  }
  const session = object(opened["session"]);
  if (!session || typeof session["sessionId"] !== "string") {
    throw new Error("development.openSession returned no typed session");
  }
  return session;
}

async function waitForRun(
  context: TestOrchestrationContext,
  receipt: SelfDevelopmentReceipt,
  runId: string,
  phase: string
): Promise<Record<string, unknown>> {
  const remaining = context.remainingTimeMs();
  const deadline = Date.now() + Math.min(remaining ?? 10 * 60_000, 10 * 60_000);
  let latest: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    latest = await context.runner.callSelfDevelopment<Record<string, unknown> | null>("get", {
      runId,
    });
    if (!latest) throw new Error(`development run ${runId} disappeared during ${phase}`);
    if (TERMINAL_RUN_STATES.has(String(latest["state"]))) {
      operation(receipt, "development", "get", latest);
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`development run ${runId} did not reach a stable state during ${phase}`);
}

async function startRun(
  context: TestOrchestrationContext,
  receipt: SelfDevelopmentReceipt,
  sessionId: string,
  recipe: Record<string, unknown>,
  target: Record<string, unknown>
) {
  const runId = `system-test-development-${crypto.randomUUID()}`;
  const started = await context.runner.callSelfDevelopment<Record<string, unknown>>("start", {
    sessionId,
    runId,
    recipeId: recipe["recipeId"],
    target,
  });
  operation(receipt, "development", "start", started);
  return waitForRun(context, receipt, runId, "build/start");
}

async function stopAndClose(
  context: TestOrchestrationContext,
  receipt: SelfDevelopmentReceipt,
  capturedRun: Record<string, unknown> | null,
  sessionId: string
): Promise<void> {
  let run = capturedRun;
  if (!run) {
    const page = await context.runner.callSelfDevelopment<Record<string, unknown>>("list", {
      sessionId,
      limit: 200,
    });
    operation(receipt, "development", "list", page);
    const runs = Array.isArray(page["runs"]) ? page["runs"] : [];
    run =
      runs
        .map(object)
        .find(
          (candidate) =>
            candidate &&
            !["stopped", "failed", "cancelled", "requires-repair", "succeeded"].includes(
              String(candidate["state"])
            )
        ) ?? null;
  }
  const runId = run?.["runId"];
  if (
    typeof runId === "string" &&
    !["stopped", "failed", "cancelled", "requires-repair", "succeeded"].includes(
      String(run?.["state"])
    )
  ) {
    const stopped = await context.runner.callSelfDevelopment("stop", {
      runId,
      idempotencyKey: `system-test-stop-${crypto.randomUUID()}`,
    });
    operation(receipt, "development", "stop", stopped);
  }
  const closed = await context.runner.callSelfDevelopment("closeSession", {
    sessionId,
    idempotencyKey: `system-test-close-${crypto.randomUUID()}`,
  });
  operation(receipt, "development", "closeSession", closed);
}

async function currentClient(context: TestOrchestrationContext) {
  return orchestrate("self-development-current-client", context, async (receipt) => {
    const setup = await repositoryAndRecipe(context, receipt, "current-host-client");
    if (!setup) return;
    const session = await openSemantic(context, receipt, setup.repository.repositoryId);
    if (!session) return;
    let run: Record<string, unknown> | null = null;
    try {
      run = await startRun(context, receipt, String(session["sessionId"]), setup.recipe, {
        kind: "current-host-client",
        client: "electron",
      });
      if (run["state"] === "failed" && /executor|provider|electron/iu.test(JSON.stringify(run))) {
        unavailable(receipt, "current-host Electron client executor is not provisioned and ready");
      }
    } finally {
      await stopAndClose(context, receipt, run, String(session["sessionId"]));
    }
  });
}

async function isolatedHost(
  scenario: string,
  context: TestOrchestrationContext,
  action?: (
    receipt: SelfDevelopmentReceipt,
    run: Record<string, unknown>,
    attachedSessionId: string
  ) => Promise<void>,
  includeClient = false
) {
  return orchestrate(scenario, context, async (receipt) => {
    const setup = await repositoryAndRecipe(context, receipt, "isolated-host");
    if (!setup) return;
    const session = await openSemantic(context, receipt, setup.repository.repositoryId);
    if (!session) return;
    let run: Record<string, unknown> | null = null;
    try {
      run = await startRun(context, receipt, String(session["sessionId"]), setup.recipe, {
        kind: "isolated-host",
        includeClient,
      });
      const route = object(run["attachedHost"]);
      if (run["state"] !== "ready" || route?.["state"] !== "ready") {
        if (/executor|provider|electron/iu.test(JSON.stringify(run))) {
          unavailable(receipt, "isolated host/client executor is not provisioned and ready");
        }
        return;
      }
      const attachedSessionId = String(route["sessionId"]);
      const attached = await context.runner.attachDevelopmentHost(attachedSessionId);
      operation(receipt, "attachedHosts", "attachClient", attached);
      if (action) await action(receipt, run, attachedSessionId);
    } finally {
      await stopAndClose(context, receipt, run, String(session["sessionId"]));
    }
  });
}

async function dirtySemanticState(context: TestOrchestrationContext) {
  return orchestrate("self-development-dirty-semantic-state", context, async (receipt) => {
    const setup = await repositoryAndRecipe(context, receipt, "build-only");
    if (!setup) return;
    const editCommand = `system-test-dirty-${crypto.randomUUID()}`;
    const edited = await context.runner.createSelfDevelopmentDirtyMarker(
      setup.repository,
      editCommand
    );
    operation(receipt, "vcs", "edit", edited);
    let session: Record<string, unknown> | null = null;
    let run: Record<string, unknown> | null = null;
    try {
      session = await openSemantic(context, receipt, setup.repository.repositoryId);
      if (!session) return;
      run = await startRun(context, receipt, String(session["sessionId"]), setup.recipe, {
        kind: "build-only",
      });
    } finally {
      if (session) {
        await stopAndClose(context, receipt, run, String(session["sessionId"]));
      }
      const workingHead = object(edited)?.["workingHead"];
      if (workingHead) {
        const discarded = await context.runner.discardSelfDevelopmentDirtyMarker(
          setup.repository.contextId,
          workingHead,
          `system-test-dirty-discard-${crypto.randomUUID()}`
        );
        operation(receipt, "vcs", "discard", discarded);
      }
    }
  });
}

async function nativeCheckpoint(context: TestOrchestrationContext) {
  return orchestrate("self-development-native-checkpoint", context, async (receipt) => {
    const repository = await context.runner.resolveSelfDevelopmentRepository();
    operation(receipt, "vcs", "resolveRepository", repository);
    const tools = await context.runner.callSelfDevelopment<Record<string, unknown>[]>(
      "listNativeTools"
    );
    operation(receipt, "development", "listNativeTools", tools);
    const tool = tools.find(
      (candidate) => candidate["available"] === true && candidate["interactiveTerminal"] === true
    );
    if (!tool || typeof tool["toolId"] !== "string") {
      unavailable(
        receipt,
        `no reviewed interactive native executor is available: ${JSON.stringify(tools)}`
      );
      return;
    }
    const opened = await context.runner.callSelfDevelopment<Record<string, unknown>>(
      "openSession",
      {
        repositoryId: repository.repositoryId,
        mode: "native-tool",
        nativeTool: tool["toolId"],
        idempotencyKey: `system-test-native-open-${crypto.randomUUID()}`,
      }
    );
    operation(receipt, "development", "openSession", opened);
    const session = object(opened["session"]);
    if (opened["kind"] !== "opened" || !session) return;
    const sessionId = String(session["sessionId"]);
    try {
      await context.runner.callSelfDevelopment("writeNativeTerminal", {
        sessionId,
        writeId: `system-test-native-write-${crypto.randomUUID()}`,
        data:
          "Create a new file named .vibestudio-system-test/native-checkpoint.txt containing exactly native checkpoint probe, then stop and wait. Do not commit or publish it.\n",
      });
      operation(receipt, "development", "writeNativeTerminal", { sessionId, accepted: true });
      const deadline = Date.now() + Math.min(context.remainingTimeMs() ?? 120_000, 120_000);
      let inspected: Record<string, unknown> | null = null;
      while (Date.now() < deadline) {
        inspected = await context.runner.callSelfDevelopment("inspectNative", {
          sessionId,
          assessPendingChanges: true,
        });
        if (object(inspected?.["native"])?.["pendingChanges"] === "present") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      operation(receipt, "development", "inspectNative", inspected);
      if (object(inspected?.["native"])?.["pendingChanges"] !== "present") {
        throw new Error("Native tool did not produce the requested semantic change");
      }
      const checkpointed = await context.runner.callSelfDevelopment("checkpoint", {
        sessionId,
        idempotencyKey: `system-test-native-checkpoint-${crypto.randomUUID()}`,
      });
      operation(receipt, "development", "checkpoint", checkpointed);
    } finally {
      const stopped = await context.runner.callSelfDevelopment("stopNativeTool", {
        sessionId,
        idempotencyKey: `system-test-native-stop-${crypto.randomUUID()}`,
      });
      operation(receipt, "development", "stopNativeTool", stopped);
      const closed = await context.runner.callSelfDevelopment("closeSession", {
        sessionId,
        idempotencyKey: `system-test-native-close-${crypto.randomUUID()}`,
      });
      operation(receipt, "development", "closeSession", closed);
    }
  });
}

async function buildFailureRecovery(context: TestOrchestrationContext) {
  return orchestrate(
    "self-development-build-failure-recovery",
    context,
    async (receipt) => {
      const setup = await repositoryAndRecipe(context, receipt, "build-only");
      if (!setup) return;
      const session = await openSemantic(context, receipt, setup.repository.repositoryId);
      if (!session) return;
      const sessionId = String(session["sessionId"]);
      const runId = `system-test-development-recovery-${crypto.randomUUID()}`;
      let latest: Record<string, unknown> | null = null;
      try {
        const armed = await context.runner.callSelfDevelopment(
          "faultFailBuildAfterSnapshotRetained",
          {
            sessionId,
            runId,
            phase: "after-snapshot-retained",
          }
        );
        operation(
          receipt,
          "development",
          "faultFailBuildAfterSnapshotRetained",
          armed
        );
        const started = await context.runner.callSelfDevelopment("start", {
          sessionId,
          runId,
          recipeId: setup.recipe["recipeId"],
          target: { kind: "build-only" },
        });
        operation(receipt, "development", "start", started);
        latest = await waitForRun(context, receipt, runId, "injected build failure");
        if (latest["state"] !== "failed") {
          throw new Error("Injected retained-snapshot build did not fail");
        }
        const events = await context.runner.callSelfDevelopment("events", {
          runId,
          after: 0,
          limit: 200,
        });
        operation(receipt, "development", "events", events);
        const retried = await context.runner.callSelfDevelopment("retry", {
          runId,
          idempotencyKey: `system-test-development-retry-${crypto.randomUUID()}`,
        });
        operation(receipt, "development", "retry", retried);
        latest = await waitForRun(context, receipt, runId, "same-run retry");
      } finally {
        await stopAndClose(context, receipt, latest, sessionId);
      }
    }
  );
}

async function childEval(context: TestOrchestrationContext) {
  return isolatedHost(
    "self-development-child-eval",
    context,
    async (receipt, run, attachedSessionId) => {
      const runId = `system-test-child-eval-${crypto.randomUUID()}`;
      const scopeKey = `system-test-child-eval-${crypto.randomUUID()}`;
      const started = await context.runner.callAttachedDevelopmentHost<{ runId: string }>(
        attachedSessionId,
        "eval",
        "start",
        [
          {
            scope: { key: scopeKey, lifecycle: "finite" },
            runId,
            source: { kind: "inline", code: "return 42;" },
          },
        ]
      );
      operation(receipt, "attachedHosts", "eval.start", started);
      const deadline = Date.now() + Math.min(context.remainingTimeMs() ?? 30_000, 30_000);
      let terminal: Record<string, unknown> | null = null;
      while (Date.now() < deadline) {
        terminal = await context.runner.callAttachedDevelopmentHost(
          attachedSessionId,
          "eval",
          "get",
          [{ scopeKey, runId }]
        );
        if (terminal?.["status"] === "done" || terminal?.["status"] === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      operation(receipt, "attachedHosts", "eval.get", {
        developmentRunId: run["runId"],
        attachedHostSessionId: attachedSessionId,
        evalRunId: runId,
        evalSnapshot: terminal,
      });
    }
  );
}

async function childApproval(context: TestOrchestrationContext) {
  return isolatedHost(
    "self-development-child-approval",
    context,
    async (receipt, run, attachedSessionId) => {
      const before = await context.runner.listAttachedDevelopmentHostApprovalAudit(
        attachedSessionId,
        { limit: 100 }
      );
      operation(receipt, "attachedHosts", "listApprovalAudit.before", before);
      if (before.events.length !== 0) {
        throw new Error("A newly attached route already contains approval audit events");
      }
      const permissions = await context.runner.callAttachedDevelopmentHost(
        attachedSessionId,
        "permissions",
        "list",
        []
      );
      operation(receipt, "attachedHosts", "permissions.list", {
        developmentRunId: run["runId"],
        attachedHostSessionId: attachedSessionId,
        permissions,
      });
      const after = await context.runner.listAttachedDevelopmentHostApprovalAudit(
        attachedSessionId,
        { limit: 100 }
      );
      operation(receipt, "attachedHosts", "listApprovalAudit.after", after);
    }
  );
}

async function ownedCleanup(context: TestOrchestrationContext) {
  return isolatedHost("self-development-owned-cleanup", context, undefined, true);
}

const DEVELOPMENT_AUTHORITY = {
  authority: [
    {
      ruleId: "self-development-native-execution",
      capability: { kind: "exact" as const, key: "development.native.execute" },
      resource: { kind: "exact" as const, key: "development.native.execute" },
      tier: "gated" as const,
      decision: "once" as const,
    },
  ],
  userland: [],
};

const HARNESS_PROMPT =
  "Harness-orchestrated through ordinary typed Development, VCS, and attached-host APIs; validation uses captured RPC receipts.";
const SHARED_RESOURCE = ["self-development:host-runtime"];

export const selfDevelopmentTests: TestCase[] = [
  {
    name: "self-development-current-client",
    category: "self-development",
    description: "Build and attest an exact current-host Electron client",
    authorityPolicy: DEVELOPMENT_AUTHORITY,
    resources: SHARED_RESOURCE,
    prompt: HARNESS_PROMPT,
    orchestrate: currentClient,
    validate: validateCurrentClient,
  },
  {
    name: "self-development-isolated-host",
    category: "self-development",
    description: "Launch an exact isolated host and attach its ordinary route",
    authorityPolicy: DEVELOPMENT_AUTHORITY,
    resources: SHARED_RESOURCE,
    prompt: HARNESS_PROMPT,
    orchestrate: (context) => isolatedHost("self-development-isolated-host", context),
    validate: validateIsolatedHost,
  },
  {
    name: "self-development-dirty-semantic-state",
    category: "self-development",
    description: "Build the exact uncommitted semantic working application",
    authorityPolicy: DEVELOPMENT_AUTHORITY,
    resources: SHARED_RESOURCE,
    prompt: HARNESS_PROMPT,
    orchestrate: dirtySemanticState,
    validate: validateDirtySemanticState,
  },
  {
    name: "self-development-native-checkpoint",
    category: "self-development",
    description: "Import one explicit native-tool checkpoint into the development child",
    authorityPolicy: DEVELOPMENT_AUTHORITY,
    resources: SHARED_RESOURCE,
    prompt: HARNESS_PROMPT,
    orchestrate: nativeCheckpoint,
    validate: validateNativeCheckpoint,
  },
  {
    name: "self-development-build-failure-recovery",
    category: "self-development",
    description: "Retry one failed exact build from its recorded commit point",
    authorityPolicy: DEVELOPMENT_AUTHORITY,
    resources: SHARED_RESOURCE,
    prompt: HARNESS_PROMPT,
    orchestrate: buildFailureRecovery,
    validate: validateBuildFailureRecovery,
  },
  {
    name: "self-development-child-eval",
    category: "self-development",
    description: "Reach child eval through the ordinary attached typed route",
    authorityPolicy: DEVELOPMENT_AUTHORITY,
    resources: SHARED_RESOURCE,
    prompt: HARNESS_PROMPT,
    orchestrate: childEval,
    validate: validateChildEval,
  },
  {
    name: "self-development-child-approval",
    category: "self-development",
    description: "Bind one child request to an exact parent approval decision",
    authorityPolicy: {
      authority: [
        ...DEVELOPMENT_AUTHORITY.authority,
        {
          ruleId: "self-development-child-permissions-read",
          capability: { kind: "exact" as const, key: "permissions.read" },
          resource: { kind: "exact" as const, key: "permissions.read" },
          tier: "gated" as const,
          decision: "once" as const,
        },
      ],
      userland: [],
    },
    resources: SHARED_RESOURCE,
    prompt: HARNESS_PROMPT,
    orchestrate: childApproval,
    validate: validateChildApproval,
  },
  {
    name: "self-development-owned-cleanup",
    category: "self-development",
    description: "Stop and close every exact owned development effect",
    authorityPolicy: DEVELOPMENT_AUTHORITY,
    resources: SHARED_RESOURCE,
    prompt: HARNESS_PROMPT,
    orchestrate: ownedCleanup,
    validate: validateOwnedCleanup,
  },
];
