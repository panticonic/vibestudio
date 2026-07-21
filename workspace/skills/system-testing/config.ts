/**
 * System tests intentionally use one pinned fast agent model so results are
 * comparable across CLI sessions, server defaults, panels, and CI hosts.
 * Callers may still override it explicitly with `--model` for model-specific
 * investigations.
 */
export const SYSTEM_TEST_AGENT_MODEL = "openai-codex:gpt-5.3-codex-spark";

/** Activated only after the primary emits the concrete terminal usage-limit code. */
export const SYSTEM_TEST_FALLBACK_MODEL = "openai-codex:gpt-5.6-luna";
export const SYSTEM_TEST_FALLBACK_THINKING_LEVEL = "minimal" as const;
export const SYSTEM_TEST_FALLBACK_FAILURE_CODE = "usage_limit_terminal" as const;

/**
 * The complete model route for one system-test run.
 *
 * Explicit model investigations intentionally have no implicit fallback. Keep
 * this policy shared by the runner and doctor so readiness checks cannot drift
 * from the models a run can actually invoke.
 */
export function systemTestModelRoute(
  primaryModel = SYSTEM_TEST_AGENT_MODEL,
  options: { allowUsageLimitFallback?: boolean } = {}
): {
  primaryModel: string;
  fallbackModel: string | null;
  fallbackThinkingLevel: typeof SYSTEM_TEST_FALLBACK_THINKING_LEVEL | null;
  fallbackOn: typeof SYSTEM_TEST_FALLBACK_FAILURE_CODE | null;
} {
  const usesDefaultRoute = options.allowUsageLimitFallback ?? true;
  return {
    primaryModel,
    fallbackModel: usesDefaultRoute ? SYSTEM_TEST_FALLBACK_MODEL : null,
    fallbackThinkingLevel: usesDefaultRoute ? SYSTEM_TEST_FALLBACK_THINKING_LEVEL : null,
    fallbackOn: usesDefaultRoute ? SYSTEM_TEST_FALLBACK_FAILURE_CODE : null,
  };
}
