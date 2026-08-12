import {
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
  type TestOrchestrationContext,
} from "../types.js";
import type { ValidationTrajectoryEvent } from "../runner.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
} from "./_helpers.js";
import { SERVER_LOG_READ_AUTHORITY } from "./server-logs.js";

const FIXTURE_HEADING = /\bsystem-test-local-model-download-and-task-[a-z0-9]{8}\b/iu;
const LOCAL_MODEL_RUNTIME_AUTHORITY = {
  ruleId: "run-bundled-local-model",
  capability: { kind: "exact" as const, key: "internal-model-runtime.use" },
  resource: { kind: "exact" as const, key: "local-models" },
  tier: "gated" as const,
  decision: "once" as const,
};
const LOCAL_SKILL_PROMPT =
  "Please have the bundled local model check whether the workspace server has logged any recent warnings, then summarize what it finds.";

interface CompletedLocalModelTask {
  model: string;
  report: string;
  runId: string;
  taskChannelId: string | null;
}

interface LocalSkillTrajectoryEvidence {
  eventCount: number;
  model: string | null;
  serverLogInspectionSeq: number | null;
  serverLogSkillReadSeq: number | null;
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

function successfulInvocationStarts(
  events: readonly ValidationTrajectoryEvent[]
): ValidationTrajectoryEvent[] {
  const completed = new Set(
    events.flatMap((event) => {
      const invocationId = event.causality?.invocationId;
      return event.kind === "invocation.completed" && invocationId ? [invocationId] : [];
    })
  );
  return events.filter(
    (event) =>
      event.kind === "invocation.started" &&
      Boolean(event.causality?.invocationId && completed.has(event.causality.invocationId))
  );
}

export function summarizeLocalSkillTrajectory(
  events: readonly ValidationTrajectoryEvent[],
  task: CompletedLocalModelTask
): LocalSkillTrajectoryEvidence {
  const completedStarts = successfulInvocationStarts(events);
  const serverLogSkillRead = completedStarts.find((event) => {
    const payload = event.payload as { name?: unknown; request?: unknown };
    return (
      payload.name === "read" &&
      strings(payload.request).some((value) => /skills\/server-logs\/SKILL\.md\b/u.test(value))
    );
  });
  const serverLogInspection = completedStarts.find((event) => {
    const payload = event.payload as { name?: unknown; request?: unknown };
    return (
      payload.name === "eval" &&
      strings(payload.request).some((value) =>
        /services\.serverLog\.(?:query|stats|tail)\b/u.test(value)
      )
    );
  });
  return {
    eventCount: events.length,
    model: task.model,
    serverLogInspectionSeq: serverLogInspection?.seq ?? null,
    serverLogSkillReadSeq: serverLogSkillRead?.seq ?? null,
    taskChannelId: task.taskChannelId,
  };
}

function emptyLocalSkillEvidence(): LocalSkillTrajectoryEvidence {
  return {
    eventCount: 0,
    model: null,
    serverLogInspectionSeq: null,
    serverLogSkillReadSeq: null,
    taskChannelId: null,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function orchestrateLocalSkillUse(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const session = await context.runner.spawn();
  let error: string | undefined;
  let evidence = emptyLocalSkillEvidence();

  try {
    await context.sendAndWait(
      session,
      LOCAL_SKILL_PROMPT,
      "delegate a server-log check to the bundled local model"
    );
    const partial = {
      messages: [...session.messages],
      duration: Date.now() - startedAt,
    } as TestExecutionResult;
    const task = completedLocalModelTasks(partial).at(-1);
    if (task?.taskChannelId) {
      const events = await context.runner.readChannelTrajectoryForValidation(
        task.taskChannelId,
        500
      );
      evidence = summarizeLocalSkillTrajectory(events, task);
    } else if (task) {
      evidence = { ...emptyLocalSkillEvidence(), model: task.model };
    }
  } catch (cause) {
    error = formatError(cause);
  }

  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    ...(error ? { error } : {}),
    diagnostics: { localSkillTrajectory: evidence },
  };
  try {
    await session.close();
  } catch (cause) {
    execution.cleanupErrors = [`close: ${formatError(cause)}`];
  }
  const cleanupErrors = session
    .snapshot()
    .cleanupErrors.map((entry) => `${entry.phase}: ${entry.message}`);
  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = [...(execution.cleanupErrors ?? []), ...cleanupErrors];
  }
  if (execution.cleanupErrors?.length) {
    execution.error ??= `Headless cleanup failed: ${execution.cleanupErrors.join("; ")}`;
  }
  return execution;
}

function requireLocalSkillUse(result: TestExecutionResult) {
  const lifecycleFailure = lifecycleInspectionFailure(result);
  if (lifecycleFailure) return { passed: false, reason: lifecycleFailure };
  const tasks = completedLocalModelTasks(result);
  if (tasks.length === 0) {
    return {
      passed: false,
      reason: "No local-model child completed the delegated server-log task",
    };
  }
  const evidence = result.diagnostics?.["localSkillTrajectory"] as
    | Partial<LocalSkillTrajectoryEvidence>
    | undefined;
  if (
    !evidence ||
    !evidence.taskChannelId ||
    !evidence.model?.startsWith("local:") ||
    !Number.isInteger(evidence.serverLogSkillReadSeq) ||
    !Number.isInteger(evidence.serverLogInspectionSeq) ||
    Number(evidence.serverLogSkillReadSeq) >= Number(evidence.serverLogInspectionSeq)
  ) {
    return {
      passed: false,
      reason:
        "The local child did not successfully load the server-logs skill before inspecting the server-log service",
    };
  }
  const final = findLastAgentMessage(result);
  if (!/server|log/iu.test(final) || !/warn|no warning/iu.test(final)) {
    return {
      passed: false,
      reason: "The parent response did not summarize the local child's warning inspection",
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
      authority: [LOCAL_MODEL_RUNTIME_AUTHORITY, ...SERVER_LOG_READ_AUTHORITY.authority],
    },
    prompt: LOCAL_SKILL_PROMPT,
    orchestrate: orchestrateLocalSkillUse,
    validation: "agent-evidence",
    validate: requireLocalSkillUse,
  },
];
