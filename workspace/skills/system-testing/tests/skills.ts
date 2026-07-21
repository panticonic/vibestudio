import type { HeadlessSession } from "@workspace/agentic-session";
import type { TestCase, TestExecutionResult, TestOrchestrationContext } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function skillChoiceChecked(
  result: Parameters<typeof noIncompleteInvocations>[0],
  skillName: string,
  finalClaim: RegExp
) {
  const loaded = getToolCalls(result).some(
    (call) =>
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      JSON.stringify(call.arguments ?? {})
        .toLowerCase()
        .includes(`/skills/${skillName.toLowerCase()}/`)
  );
  if (!loaded) return { passed: false, reason: `No completed read loaded the ${skillName} skill` };
  if (!finalClaim.test(findLastAgentMessage(result))) {
    return {
      passed: false,
      reason: `Final response did not explain the ${skillName} workflow choice`,
    };
  }
  return noIncompleteInvocations(result);
}

const MISSING_API_CREDENTIAL_ID = "credential:system-test-missing";
const MISSING_API_URL = "https://system-test-missing.invalid/resource";

function apiIntegrationChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const final = findLastAgentMessage(result);
  if (
    !/(credential|authentication)/iu.test(final) ||
    !/(missing|unavailable|not configured|not found)/iu.test(final) ||
    !/(without|did not|didn't|no)\b[^.\n]*(secret|credential data|prompt|authoriz)/iu.test(final)
  ) {
    return {
      passed: false,
      reason: "Final response did not semantically report the safe missing-credential outcome",
    };
  }

  const evalCalls = getToolCalls(result).filter((call) => call.name === "eval");
  const code = successfulEvalCode(result);
  if (
    evalCalls.length !== 1 ||
    !code.includes("credentials.fetch") ||
    !code.includes(MISSING_API_CREDENTIAL_ID) ||
    !code.includes(MISSING_API_URL)
  ) {
    return {
      passed: false,
      reason: "Expected one successful host-mediated fetch with the reserved missing credential",
    };
  }
  const allEvalCode = evalCalls
    .map((call) => (typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : ""))
    .join("\n");
  if (
    /credentials\.(?:listStoredCredentials|inspectStoredCredentials|resolveCredential|forAudience|store|connect|configureClient|requestCredentialInput|revokeCredential|deleteClientConfig)|openExternal/u.test(
      allEvalCode
    )
  ) {
    return {
      passed: false,
      reason: "Missing-credential API probe inspected, mutated, or requested credential state",
    };
  }

  const values = successfulEvalReturnValues(result);
  if (
    values.length !== 1 ||
    !values[0] ||
    typeof values[0] !== "object" ||
    Array.isArray(values[0]) ||
    Object.keys(values[0]).join(",") !== "missing" ||
    (values[0] as Record<string, unknown>)["missing"] !== true
  ) {
    return {
      passed: false,
      reason: "Missing-credential API eval must return exactly { missing: true }",
    };
  }
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
      "Set up a controlled diagnostic target by spawning one real Pi subagent labelled 'stalled headless fixture'. Ask it to begin an intentionally non-terminating eval and do no other work, then acknowledge once that child is running.",
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
      "Diagnose why the child agent has not produced a final response. Keep the investigation bounded and report only evidence you can observe.",
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
      "I need a one-off, read-only state inspection. Which execution surface should we use, and why?",
    validate: (result) =>
      skillChoiceChecked(result, "sandbox", /(sandbox|eval|execution surface|read-only)/iu),
  },
  {
    name: "load-workspace-dev",
    description: "Apply the workspace-dev skill to choose a project workflow",
    category: "skills",
    prompt:
      "I want to change a workspace panel. Which development workflow fits this request, and why?",
    validate: (result) =>
      skillChoiceChecked(result, "workspace-dev", /(workspace|panel|development|workflow)/iu),
  },
  {
    name: "load-api-integrations",
    description: "Apply the API integrations skill to handle missing credentials",
    category: "skills",
    prompt: `Try the deliberately unconfigured test API at ${MISSING_API_URL} using the reserved test credential ${MISSING_API_CREDENTIAL_ID}. Explain the safe outcome without inspecting, changing, requesting, or exposing credential data.`,
    validate: apiIntegrationChecked,
  },
  {
    name: "load-headless-sessions",
    description: "Apply the headless-sessions skill to diagnose a stalled agent",
    category: "skills",
    prompt:
      "Diagnose why a headless agent used a tool but never produced a final response. Keep the investigation bounded and explain the observed state.",
    orchestrate: orchestrateHeadlessDiagnosis,
    // The fixture deliberately leaves one child invocation in flight. Validate
    // the diagnostic agent's final response here; the suite's independent
    // unexpected-tool-failure accounting still rejects any unintended errors.
    validate: (result) => {
      const fixture = result.diagnostics?.["fixture"] as Record<string, unknown> | undefined;
      const final = findLastAgentMessage(result);
      return fixture?.["kind"] === "real-subagent-with-in-flight-tool" &&
        typeof fixture["invocationId"] === "string" &&
        /(in[- ]flight|pending|running|stalled)/iu.test(final) &&
        /(bounded|limit|recent|one child)/iu.test(final)
        ? { passed: true }
        : {
            passed: false,
            reason:
              "Diagnosis lacked the real in-flight child evidence or a bounded semantic conclusion",
          };
    },
  },
];
