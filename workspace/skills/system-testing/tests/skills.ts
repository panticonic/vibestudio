import type { HeadlessSession } from "@workspace/agentic-session";
import type { TestCase, TestExecutionResult, TestOrchestrationContext } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForStalledChildTool(
  session: HeadlessSession,
  timeoutMs: number
): Promise<{ invocationId: string; tool: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const spawn = [...session.snapshot().invocations]
      .reverse()
      .find((invocation) => invocation.name === "spawn_subagent");
    const progress = spawn?.progress?.find(
      (entry) => entry.kind === "tool-started" || entry.kind === "tool-progress"
    );
    if (spawn && progress) {
      return { invocationId: spawn.id, tool: progress.tool ?? null };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "Headless diagnostic fixture did not expose a child tool invocation before the setup deadline"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function orchestrateHeadlessDiagnosis(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const session = await context.runner.spawn();
  let error: string | undefined;
  let fixture: { invocationId: string; tool: string | null } | undefined;

  try {
    await context.sendAndWait(
      session,
      `Set up a controlled diagnostic target. Spawn one fresh Pi subagent labelled "stalled headless fixture". Give that child this task exactly:

"Start one eval tool whose code awaits a promise that never resolves. This is an intentional stalled-session fixture; do not perform any other work and do not send a final message."

The child must be a real subagent in your runtime tree, not a hypothetical example. Once it is launched, finish this setup turn with FIXTURE_READY.`,
      "create a real stalled child fixture"
    );
    const remainingTimeMs = context.remainingTimeMs();
    fixture = await waitForStalledChildTool(
      session,
      remainingTimeMs === undefined
        ? 60_000
        : Math.max(1, Math.min(60_000, Math.floor(remainingTimeMs / 4)))
    );
    await context.sendAndWait(
      session,
      "Diagnose a headless agent that used a tool but produced no final message. Finish with SKILL_HEADLESS_OK and bounded-diagnostics.",
      "diagnose the stalled child"
    );
  } catch (err) {
    error = formatError(err);
  }

  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    ...(error ? { error } : {}),
    diagnostics: {
      orchestrated: true,
      fixture: {
        kind: "real-subagent-with-in-flight-tool",
        invocationId: fixture?.invocationId ?? null,
        tool: fixture?.tool ?? null,
      },
    },
  };

  try {
    await session.close();
  } catch (err) {
    const message = `close: ${formatError(err)}`;
    execution.cleanupErrors = [...(execution.cleanupErrors ?? []), message];
    execution.error ??= `Headless cleanup failed: ${message}`;
  }
  const cleanupErrors = session
    .snapshot()
    .cleanupErrors.map((entry) => `${entry.phase}: ${entry.message}`);
  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = [...(execution.cleanupErrors ?? []), ...cleanupErrors];
    execution.error ??= `Headless cleanup failed: ${cleanupErrors.join("; ")}`;
  }
  return execution;
}

export const skillTests: TestCase[] = [
  {
    name: "load-sandbox",
    description: "Apply the sandbox skill to choose an execution surface",
    category: "skills",
    prompt:
      "Choose how to handle a one-off state inspection. Finish with SKILL_SANDBOX_OK and chosen-surface.",
    validate: (result) => checked(result, ["SKILL_SANDBOX_OK", "chosen-surface"]),
  },
  {
    name: "load-workspace-dev",
    description: "Apply the workspace-dev skill to choose a project workflow",
    category: "skills",
    prompt:
      "Choose a workflow for a requested panel change. Finish with SKILL_WORKSPACE_DEV_OK and workflow-choice.",
    validate: (result) => checked(result, ["SKILL_WORKSPACE_DEV_OK", "workflow-choice"]),
  },
  {
    name: "load-api-integrations",
    description: "Apply the API integrations skill to handle missing credentials",
    category: "skills",
    prompt:
      "Handle a missing credential for an API request. Finish with SKILL_API_OK and no-secret-paste.",
    validate: (result) => checked(result, ["SKILL_API_OK", "no-secret-paste"]),
  },
  {
    name: "load-headless-sessions",
    description: "Apply the headless-sessions skill to diagnose a stalled agent",
    category: "skills",
    prompt:
      "Diagnose a headless agent that used a tool but produced no final message. Finish with SKILL_HEADLESS_OK and bounded-diagnostics.",
    orchestrate: orchestrateHeadlessDiagnosis,
    // The fixture deliberately leaves one child invocation in flight. Validate
    // the diagnostic agent's final response here; the suite's independent
    // unexpected-tool-failure accounting still rejects any unintended errors.
    validate: (result) => finalMessageHasAll(result, ["SKILL_HEADLESS_OK", "bounded-diagnostics"]),
  },
];
