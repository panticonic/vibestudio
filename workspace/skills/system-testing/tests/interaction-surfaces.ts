import type { TestCase } from "../types.js";
import { completedToolNames, finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function requireCompletedTools(result: Parameters<typeof completedToolNames>[0], names: string[]) {
  const completed = completedToolNames(result);
  const missing = names.filter((name) => !completed.has(name));
  if (missing.length > 0) {
    return {
      passed: false,
      reason: `Missing completed tool calls for ${missing.join(", ")}. Completed: ${[...completed].join(", ") || "(none)"}`,
    };
  }
  return noIncompleteInvocations(result);
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
    name: "inline-ui-render",
    description: "Render inline UI",
    category: "interaction-surfaces",
    prompt: "Render a tiny inline UI. Finish with INLINE_UI_RENDER_OK.",
    validate: (result) => {
      const tools = requireCompletedTools(result, ["inline_ui"]);
      if (!tools.passed) return tools;
      return finalMessageHasAll(result, ["INLINE_UI_RENDER_OK"]);
    },
  },
  {
    name: "load-action-bar-render",
    description: "Render and clear an action bar",
    category: "interaction-surfaces",
    prompt: "Render and then clear a tiny action bar. Finish with ACTION_BAR_RENDER_OK and ACTION_BAR_CLEAR_OK.",
    validate: (result) => {
      const tools = requireCompletedTools(result, ["eval", "load_action_bar"]);
      if (!tools.passed) return tools;
      return finalMessageHasAll(result, ["ACTION_BAR_RENDER_OK", "ACTION_BAR_CLEAR_OK"]);
    },
  },
  {
    name: "custom-message-publish",
    description: "Publish a custom chat message",
    category: "interaction-surfaces",
    prompt: "Publish a custom chat message if this context supports it. Finish with CUSTOM_MESSAGE_OK or CUSTOM_MESSAGE_UNAVAILABLE.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["CUSTOM_MESSAGE_OK"]);
      if (ok.passed) return ok;
      return finalMessageHasAll(result, ["CUSTOM_MESSAGE_UNAVAILABLE"]);
    },
  },
];
