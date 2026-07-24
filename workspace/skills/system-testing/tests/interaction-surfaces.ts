import type { TestCase, TestExecutionResult, TestOrchestrationContext } from "../types.js";
import {
  completedToolNames,
  finalMessageHasAll,
  getToolCalls,
  noIncompleteInvocations,
} from "./_helpers.js";
import { z } from "zod";

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

const onboardingSnapshotFixture = [
  {
    id: "connection.ai-provider",
    state: "configured",
    summary: "Test model is ready.",
    scope: "workspace",
    tier: "direct",
    attention: "none",
    nextAction: "change",
    rawStage: "ready",
    observedAt: "2026-07-24T12:00:00.000Z",
  },
  {
    id: "connection.google-workspace",
    state: "connected-unverified",
    verification: "unverified",
    summary: "Connected; not checked live.",
    scope: "user-workspace",
    tier: "direct",
    attention: "none",
    nextAction: "check",
    rawStage: "connected",
    observedAt: "2026-07-24T12:00:00.000Z",
  },
  {
    id: "connection.device",
    state: "connected",
    summary: "This device is paired.",
    scope: "device",
    tier: "host-topology",
    attention: "none",
    nextAction: "change",
    rawStage: "paired",
    observedAt: "2026-07-24T12:00:00.000Z",
  },
] as const;

async function runOnboardingOpening(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const start = Date.now();
  const session = await context.runner.spawn({
    syntheticPanelUiTools: true,
    additionalSystemPrompt: `

Exercise the shipped first-run onboarding contract. Read skills/onboarding/SKILL.md. On the opening turn, use client_eval with inline TypeScript that statically imports composeOnboardingSnapshot from "@workspace-skills/onboarding" and returns await composeOnboardingSnapshot(). Render the returned array through inline_ui using skills/onboarding/SetupHub.tsx as the file path and snapshot as its prop, then clear the preparing action bar. Never use server-side eval to compose onboarding state.`,
    methods: {
      client_eval: {
        description:
          "Execute TypeScript in the synthetic panel which initiated this turn. Static workspace imports resolve in that client context.",
        parameters: z
          .object({
            code: z.string(),
            syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
          })
          .strict(),
        execute: async () => onboardingSnapshotFixture,
      },
    },
  });
  let sendError: unknown;
  try {
    await context.sendAndWait(
      session,
      "I just opened this workspace for the first time. Show the setup overview, then finish with ONBOARDING_OPENING_OK.",
      "onboarding opening"
    );
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
  return execution;
}

async function runOnboardingStableIdRoute(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const start = Date.now();
  const session = await context.runner.spawn({
    additionalSystemPrompt: `

Onboarding choices arrive as readable text plus a structured interaction object. For kind onboarding-capability, use client_eval with inline TypeScript that statically imports executeOnboardingSelection from "@workspace-skills/onboarding" and calls it with the complete structured interaction. Never infer the target from visible prose and never use server-side eval. Finish the turn with ONBOARDING_ROUTE_OK after the route completes.`,
    methods: {
      client_eval: {
        description:
          "Execute TypeScript in the synthetic panel which initiated this turn. Static workspace imports resolve in that client context.",
        parameters: z
          .object({
            code: z.string(),
            syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
          })
          .strict(),
        execute: async (args: unknown) => ({
          handled: true,
          received: args,
        }),
      },
    },
  });
  let sendError: unknown;
  try {
    const remainingTimeMs = context.remainingTimeMs();
    const wait = session.waitForIdle(
      remainingTimeMs === undefined ? undefined : { timeoutMs: remainingTimeMs }
    );
    await session.send("Use the selected setup action.", {
      metadata: {
        interaction: {
          source: "onboarding-setup-hub",
          kind: "onboarding-capability",
          action: "setup",
          targetId: "connection.github",
        },
      },
    });
    await wait;
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
  return execution;
}

export const interactionSurfaceTests: TestCase[] = [
  {
    name: "onboarding-opening-overview",
    description: "Compose and publish the checked-in setup overview inside the inviting panel",
    category: "interaction-surfaces",
    prompt:
      "I just opened this workspace for the first time. Show the setup overview, then finish with ONBOARDING_OPENING_OK.",
    orchestrate: runOnboardingOpening,
    validate: (result) => {
      const tools = requireCompletedTools(result, ["client_eval", "inline_ui", "load_action_bar"]);
      if (!tools.passed) return tools;
      if (completedNamedToolCalls(result, "eval").length > 0) {
        return {
          passed: false,
          reason: "Opening onboarding used server-side eval instead of inviting-panel client_eval",
        };
      }
      const snapshotCall = completedNamedToolCalls(result, "client_eval")[0];
      const code = snapshotCall?.arguments?.["code"];
      if (
        typeof code !== "string" ||
        !code.includes("@workspace-skills/onboarding") ||
        !code.includes("composeOnboardingSnapshot")
      ) {
        return {
          passed: false,
          reason:
            "Opening onboarding did not statically import and call the snapshot composer in client_eval",
        };
      }
      if (code.includes("verifyCapabilityId")) {
        return {
          passed: false,
          reason: "Opening onboarding requested live verification instead of the cheap snapshot",
        };
      }
      const inlineCall = completedNamedToolCalls(result, "inline_ui").find(
        (call) => call.arguments?.["path"] === "skills/onboarding/SetupHub.tsx"
      );
      const snapshotProp = inlineCall?.arguments?.["props"];
      if (
        !snapshotProp ||
        typeof snapshotProp !== "object" ||
        !Array.isArray((snapshotProp as Record<string, unknown>)["snapshot"])
      ) {
        return {
          passed: false,
          reason: "SetupHub.tsx was not rendered with the composed snapshot prop",
        };
      }
      const clears = completedNamedToolCalls(result, "load_action_bar").filter(
        (call) => call.arguments?.["clear"] === true
      );
      if (clears.length === 0) {
        return {
          passed: false,
          reason: "Opening onboarding did not clear the preparing action bar",
        };
      }
      return finalMessageHasAll(result, ["ONBOARDING_OPENING_OK"]);
    },
  },
  {
    name: "onboarding-stable-id-routing",
    description: "Route an onboarding selection from structured interaction metadata",
    category: "interaction-surfaces",
    prompt: "Use the selected setup action and finish with ONBOARDING_ROUTE_OK.",
    orchestrate: runOnboardingStableIdRoute,
    validate: (result) => {
      const tools = requireCompletedTools(result, ["client_eval"]);
      if (!tools.passed) return tools;
      if (completedNamedToolCalls(result, "eval").length > 0) {
        return {
          passed: false,
          reason: "Onboarding routing used server-side eval instead of inviting-panel client_eval",
        };
      }
      const route = completedNamedToolCalls(result, "client_eval")[0];
      const code = route?.arguments?.["code"];
      if (
        typeof code !== "string" ||
        !code.includes("@workspace-skills/onboarding") ||
        !code.includes("executeOnboardingSelection") ||
        !code.includes("connection.github") ||
        !code.includes("setup")
      ) {
        return {
          passed: false,
          reason: `Expected stable GitHub setup through client_eval; received ${JSON.stringify(
            route?.arguments ?? null
          )}`,
        };
      }
      return finalMessageHasAll(result, ["ONBOARDING_ROUTE_OK"]);
    },
  },
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
      const tools = requireCompletedTools(result, ["load_action_bar"]);
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
    name: "set-title",
    description: "Set the conversation title through the supported surface",
    category: "interaction-surfaces",
    prompt:
      "Give this conversation a short descriptive title through the supported titling surface, then confirm it took effect. Finish with SET_TITLE_OK and title:<the-title>.",
    validate: (result) => {
      const base = finalMessageHasAll(result, ["SET_TITLE_OK", "title:"]);
      if (!base.passed) return base;
      const pending = noIncompleteInvocations(result);
      if (!pending.passed) return pending;
      const completed = completedToolNames(result);
      if (!completed.has("set_title") && !completed.has("eval")) {
        return {
          passed: false,
          reason: `Expected a completed set_title or eval tool call; completed tools: ${[...completed].join(", ") || "(none)"}`,
        };
      }
      return { passed: true };
    },
  },
  {
    name: "custom-message-update-clear",
    description: "Update a published custom message in place and clear its renderer",
    category: "interaction-surfaces",
    prompt:
      "Publish a small typed custom chat message, then update that same message in place at least once so viewers see the new state, and finally clean up the message type registration you created. Finish with CUSTOM_MESSAGE_UPDATE_OK and cleared, or CUSTOM_MESSAGE_UPDATE_UNAVAILABLE if this context does not support custom messages.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["CUSTOM_MESSAGE_UPDATE_OK", "cleared"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return finalMessageHasAll(result, ["CUSTOM_MESSAGE_UPDATE_UNAVAILABLE"]);
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
