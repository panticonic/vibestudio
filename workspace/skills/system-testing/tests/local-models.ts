import {
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
} from "./_helpers.js";

const FIXTURE_HEADING = /\bsystem-test-local-model-download-and-task-[a-z0-9]{8}\b/iu;
const LOCAL_MODEL_RUNTIME_AUTHORITY = {
  ruleId: "run-bundled-local-model",
  capability: { kind: "exact" as const, key: "internal-model-runtime.use" },
  resource: { kind: "exact" as const, key: "local-models" },
  tier: "gated" as const,
  decision: "once" as const,
};
interface CompletedLocalModelTask {
  model: string;
  report: string;
  runId: string;
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
];
