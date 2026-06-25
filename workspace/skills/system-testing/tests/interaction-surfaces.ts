import type { TestCase, TestExecutionResult, TestOrchestrationContext } from "../types.js";
import {
  completedToolNames,
  finalMessageHasAll,
  getToolCalls,
  noIncompleteInvocations,
} from "./_helpers.js";

function requireCompletedTools(result: Parameters<typeof completedToolNames>[0], names: string[]) {
  const completed = completedToolNames(result);
  const missing = names.filter((name) => !completed.has(name));
  if (missing.length > 0) {
    return {
      passed: false,
      reason: `Missing completed tool calls for ${missing.join(", ")}. Completed: ${
        [...completed].join(", ") || "(none)"
      }`,
    };
  }
  return noIncompleteInvocations(result);
}

function completedNamedToolCalls(result: TestExecutionResult, name: string) {
  return getToolCalls(result).filter(
    (call) =>
      call.name === name && call.execution?.status === "complete" && !call.execution?.isError
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWithSyntheticPanelUi(
  context: TestOrchestrationContext,
  prompt: string,
  phase: string
): Promise<TestExecutionResult> {
  const start = Date.now();
  const session = await context.runner.spawn({ syntheticPanelUiTools: true });
  let sendError: unknown;

  try {
    await context.sendAndWait(session, prompt, phase);
  } catch (error) {
    sendError = error;
  }

  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - start,
    snapshot: session.snapshot(),
    ...(sendError ? { error: formatError(sendError) } : {}),
  };

  try {
    await session.close();
  } catch (error) {
    execution.cleanupErrors = [...(execution.cleanupErrors ?? []), `close: ${formatError(error)}`];
  }

  const cleanupErrors = session
    .snapshot()
    .cleanupErrors.map((error) => `${error.phase}: ${error.message}`);
  if (cleanupErrors.length > 0) {
    execution.cleanupErrors = [...(execution.cleanupErrors ?? []), ...cleanupErrors];
    execution.error ??= `Headless cleanup failed: ${cleanupErrors.join("; ")}`;
  }

  return execution;
}

export const interactionSurfaceTests: TestCase[] = [
  {
    name: "mdx-action-button-message",
    description: "Send a clickable follow-up action",
    category: "interaction-surfaces",
    prompt: "Send a clickable follow-up action in the message. Include MDX_ACTION_OK.",
    validate: (result) => finalMessageHasAll(result, ["MDX_ACTION_OK", "ActionButton"]),
  },
  {
    name: "inline-ui-transcript-event",
    description: "Publish an inline UI transcript event from a headless session",
    category: "interaction-surfaces",
    prompt: "Exercise inline UI output. Finish with INLINE_UI_TRANSCRIPT_OK.",
    orchestrate: (context) =>
      runWithSyntheticPanelUi(
        context,
        "Exercise inline UI output. Finish with INLINE_UI_TRANSCRIPT_OK.",
        "inline UI"
      ),
    validate: (result) => {
      const tools = requireCompletedTools(result, ["inline_ui"]);
      if (!tools.passed) return tools;
      if (!result.messages.some((message) => message.contentType === "inline_ui")) {
        return {
          passed: false,
          reason: "inline_ui completed but no typed inline_ui transcript message was observed",
        };
      }
      return finalMessageHasAll(result, ["INLINE_UI_TRANSCRIPT_OK"]);
    },
  },
  {
    name: "load-action-bar-transcript-event",
    description: "Publish and clear action-bar transcript events from a headless session",
    category: "interaction-surfaces",
    prompt:
      "Exercise loading and clearing an action bar. Finish with ACTION_BAR_TRANSCRIPT_OK and ACTION_BAR_CLEAR_OK.",
    orchestrate: (context) =>
      runWithSyntheticPanelUi(
        context,
        "Exercise loading and clearing an action bar. Finish with ACTION_BAR_TRANSCRIPT_OK and ACTION_BAR_CLEAR_OK.",
        "action bar"
      ),
    validate: (result) => {
      const tools = requireCompletedTools(result, ["eval", "load_action_bar"]);
      if (!tools.passed) return tools;
      const actionBarCalls = completedNamedToolCalls(result, "load_action_bar");
      if (
        !actionBarCalls.some((call) => {
          const toolPath = call.arguments?.["path"];
          return typeof toolPath === "string" && toolPath.length > 0;
        })
      ) {
        return {
          passed: false,
          reason: "load_action_bar completed but no load call with a path was observed",
        };
      }
      if (!actionBarCalls.some((call) => call.arguments?.["clear"] === true)) {
        return {
          passed: false,
          reason: "load_action_bar completed but no clear:true call was observed",
        };
      }
      return finalMessageHasAll(result, ["ACTION_BAR_TRANSCRIPT_OK", "ACTION_BAR_CLEAR_OK"]);
    },
  },
  {
    name: "custom-message-publish",
    description: "Publish a custom chat message",
    category: "interaction-surfaces",
    prompt:
      "Publish a custom chat message if this context supports it. Finish with CUSTOM_MESSAGE_OK or CUSTOM_MESSAGE_UNAVAILABLE.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["CUSTOM_MESSAGE_OK"]);
      if (ok.passed) return ok;
      return finalMessageHasAll(result, ["CUSTOM_MESSAGE_UNAVAILABLE"]);
    },
  },
];
