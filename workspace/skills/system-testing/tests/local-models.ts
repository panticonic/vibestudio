import {
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
  type TestOrchestrationContext,
} from "../types.js";
import type { HeadlessSession } from "@workspace/agentic-session";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
} from "./_helpers.js";

const FIXTURE_HEADING = /\bsystem-test-local-model-download-and-task-[a-z0-9]{8}\b/iu;
const BUNDLED_LOCAL_MODEL = "local:lfm2.5-2.6b";
const LOCAL_MODEL_RUNTIME_AUTHORITY = {
  ruleId: "run-bundled-local-model",
  capability: { kind: "exact" as const, key: "internal-model-runtime.use" },
  resource: { kind: "exact" as const, key: "local-models" },
  tier: "gated" as const,
  decision: "once" as const,
};
const LOCAL_SKILL_PROMPT = "What is the safe way to inspect this workspace server's recent logs?";
const LOCAL_MODEL_SETUP_PROMPT =
  "Please prepare the bundled local model for a subsequent task and report its exact model reference.";

interface CompletedLocalModelTask {
  model: string;
  report: string;
  runId: string;
  taskChannelId: string | null;
}

function localModelRef(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = (value as Record<string, unknown>)["model"];
  return typeof model === "string" && model.startsWith("local:") ? model : null;
}

function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) strings(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const child of Object.values(value as Record<string, unknown>)) strings(child, found);
  return found;
}

function lifecycleInspectionFailure(result: TestExecutionResult): string | null {
  const code = successfulEvalCode(result);
  if (
    !/extensions\.invoke[\s\S]*["']status["']/u.test(code) ||
    !/extensions\.invoke[\s\S]*["']listModels["']/u.test(code)
  ) {
    return "The trajectory did not inspect the bundled local-model lifecycle";
  }
  return null;
}

function completedLocalModelTasks(result: TestExecutionResult): CompletedLocalModelTask[] {
  const localLaunches = getToolCalls(result).flatMap((call) => {
    if (
      call.name !== "spawn_subagent" ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      return [];
    }
    const argumentConfig = call.arguments?.["config"];
    const model = localModelRef(argumentConfig) ?? localModelRef(call.subagent?.launchConfig);
    return model ? [{ runId: call.id, model }] : [];
  });
  return localLaunches.flatMap((launch) => {
    const task = result.messages.find(
      (message) =>
        message.task?.id === launch.runId &&
        message.task.execution.status === "complete" &&
        message.task.execution.terminalOutcome === "success" &&
        message.task.execution.isError !== true &&
        localModelRef(message.task.subagent?.launchConfig) === launch.model
    )?.task;
    if (!task) return [];
    return [
      {
        ...launch,
        report: strings(task.execution.result).join("\n"),
        taskChannelId: task.subagent?.taskChannelId ?? null,
      },
    ];
  });
}

function requireLocalModelTask(result: TestExecutionResult) {
  const lifecycleFailure = lifecycleInspectionFailure(result);
  if (lifecycleFailure) return { passed: false, reason: lifecycleFailure };
  const completed = completedLocalModelTasks(result).flatMap((task) => {
    const heading = task.report.match(FIXTURE_HEADING)?.[0];
    return heading ? [{ heading }] : [];
  });
  if (completed.length === 0) {
    return {
      passed: false,
      reason:
        "The local-model subagent did not complete successfully with the disposable README heading",
    };
  }
  const final = findLastAgentMessage(result);
  if (!completed.some(({ heading }) => final.toLowerCase().includes(heading.toLowerCase()))) {
    return {
      passed: false,
      reason: "The parent response did not report the heading observed by the local-model child",
    };
  }
  return noIncompleteInvocations(result);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeSession(
  session: HeadlessSession,
  label: string,
  cleanupErrors: string[]
): Promise<void> {
  try {
    await session.close();
  } catch (cause) {
    cleanupErrors.push(`${label} close: ${formatError(cause)}`);
  }
  cleanupErrors.push(
    ...session.snapshot().cleanupErrors.map((entry) => `${label} ${entry.phase}: ${entry.message}`)
  );
}

async function orchestrateLocalSkillUse(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const setupSession = await context.runner.spawn();
  let subjectSession: HeadlessSession | undefined;
  let setupClosed = false;
  let setupCompleted = false;
  let error: string | undefined;
  const cleanupErrors: string[] = [];

  try {
    await context.sendAndWait(
      setupSession,
      LOCAL_MODEL_SETUP_PROMPT,
      "prepare the bundled local model"
    );
    setupCompleted = true;
    await closeSession(setupSession, "setup session", cleanupErrors);
    setupClosed = true;

    subjectSession = await context.runner.forModelSubject(BUNDLED_LOCAL_MODEL).spawn();
    await context.sendAndWait(
      subjectSession,
      LOCAL_SKILL_PROMPT,
      "ask the local model for server-log guidance"
    );
  } catch (cause) {
    error = formatError(cause);
  }

  const resultSession = subjectSession ?? setupSession;
  const execution: TestExecutionResult = {
    messages: [...resultSession.messages],
    duration: Date.now() - startedAt,
    snapshot: resultSession.snapshot(),
    ...(error ? { error } : {}),
    diagnostics: {
      localModelSubject: {
        direct: Boolean(subjectSession),
        model: BUNDLED_LOCAL_MODEL,
        setupCompleted,
      },
    },
  };
  if (subjectSession) await closeSession(subjectSession, "subject session", cleanupErrors);
  if (!setupClosed) await closeSession(setupSession, "setup session", cleanupErrors);
  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = cleanupErrors;
    execution.error ??= `Headless cleanup failed: ${cleanupErrors.join("; ")}`;
  }
  return execution;
}

function records(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) records(child, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const record = value as Record<string, unknown>;
  found.push(record);
  for (const child of Object.values(record)) records(child, found);
  return found;
}

function requireLocalSkillUse(result: TestExecutionResult) {
  const subject = result.diagnostics?.["localModelSubject"] as Record<string, unknown> | undefined;
  const executedLocally = records(result.modelExecutionEvidence).some(
    (record) =>
      record["ref"] === BUNDLED_LOCAL_MODEL ||
      (record["provider"] === "local" && record["model"] === "lfm2.5-2.6b")
  );
  if (
    subject?.["direct"] !== true ||
    subject["setupCompleted"] !== true ||
    subject["model"] !== BUNDLED_LOCAL_MODEL ||
    !executedLocally
  ) {
    return {
      passed: false,
      reason: "The bundled local model was not the direct, successfully prepared test subject",
    };
  }
  const loadedSkill = getToolCalls(result).some(
    (call) =>
      call.name === "read" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      strings(call.arguments).some((value) => /skills\/server-logs\/SKILL\.md\b/u.test(value))
  );
  if (!loadedSkill) {
    return {
      passed: false,
      reason: "The local model did not successfully load the server-logs skill",
    };
  }
  const final = findLastAgentMessage(result);
  if (!/server|log/iu.test(final) || !/bounded|limit|tail|query|stats/iu.test(final)) {
    return {
      passed: false,
      reason: "The local model did not explain a bounded server-log inspection workflow",
    };
  }
  return noIncompleteInvocations(result);
}

export const localModelTests: TestCase[] = [
  {
    name: "local-model-download-and-task",
    description: "Prepare the bundled local model and use it for a real workspace task",
    category: "local-models",
    timeoutMs: 30 * 60_000,
    resources: ["profile:local-models"],
    workspaceRepoFixture: CONTENT_WORKSPACE_REPO_FIXTURE,
    authorityPolicy: {
      authority: [LOCAL_MODEL_RUNTIME_AUTHORITY],
    },
    prompt:
      "Please use the bundled local model—not your current one—to read the disposable project's README and tell me its heading.",
    validation: "agent-evidence",
    validate: requireLocalModelTask,
  },
  {
    name: "local-model-skill-guided-server-log-summary",
    description: "Use the bundled local model to discover and follow a relevant skill",
    category: "local-models",
    timeoutMs: 30 * 60_000,
    resources: ["profile:local-models"],
    authorityPolicy: {
      authority: [LOCAL_MODEL_RUNTIME_AUTHORITY],
    },
    prompt: LOCAL_SKILL_PROMPT,
    orchestrate: orchestrateLocalSkillUse,
    validation: "agent-evidence",
    validate: requireLocalSkillUse,
  },
];
