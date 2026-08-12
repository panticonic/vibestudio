import {
  CONTENT_WORKSPACE_REPO_FIXTURE,
  type TestCase,
  type TestExecutionResult,
} from "../types.js";
import { getToolCalls, noIncompleteInvocations, successfulEvalCode } from "./_helpers.js";

function requireLocalModelTask(result: TestExecutionResult) {
  const code = successfulEvalCode(result);
  if (
    !/extensions\.invoke[\s\S]*["']status["']/u.test(code) ||
    !/extensions\.invoke[\s\S]*["']listModels["']/u.test(code)
  ) {
    return {
      passed: false,
      reason: "The trajectory did not inspect the bundled local-model lifecycle",
    };
  }
  const localChild = getToolCalls(result).some((call) => {
    if (
      call.name !== "spawn_subagent" ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      return false;
    }
    const launch = JSON.stringify({ arguments: call.arguments, subagent: call.subagent });
    return /"model"\s*:\s*"local:[^"]+"/u.test(launch);
  });
  if (!localChild) {
    return {
      passed: false,
      reason: "No completed subagent launch carried an exact local model reference",
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
      authority: [
        {
          ruleId: "run-bundled-local-model",
          capability: { kind: "exact", key: "internal-model-runtime.use" },
          resource: { kind: "exact", key: "local-models" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    prompt:
      "Please use the bundled local model—not your current one—to read the disposable project's README and tell me its heading.",
    validation: "agent-evidence",
    validate: requireLocalModelTask,
  },
];
