/**
 * System tests intentionally use one pinned fast agent model so results are
 * comparable across CLI sessions, server defaults, panels, and CI hosts.
 * Callers may still override it explicitly with `--model` for model-specific
 * investigations.
 */
export const SYSTEM_TEST_AGENT_MODEL = "openai-codex:gpt-5.4-mini";

/**
 * The complete model route for one system-test run.
 *
 * System tests never silently switch models. Keep this policy shared by the
 * runner and doctor so readiness checks cannot drift from the model a run will
 * actually invoke.
 */
export function systemTestModelRoute(
  primaryModel = SYSTEM_TEST_AGENT_MODEL
): {
  primaryModel: string;
  fallbackModel: null;
  fallbackThinkingLevel: null;
  fallbackOn: null;
} {
  return {
    primaryModel,
    fallbackModel: null,
    fallbackThinkingLevel: null,
    fallbackOn: null,
  };
}
