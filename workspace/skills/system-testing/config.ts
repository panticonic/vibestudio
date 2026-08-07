/**
 * System tests intentionally use one pinned fast primary model so results are
 * comparable across CLI sessions, server defaults, panels, and CI hosts. A
 * single metered fallback keeps quota exhaustion from turning into a harness
 * failure while preserving one explicit, inspectable route.
 */
export const SYSTEM_TEST_AGENT_MODEL = "openai-codex:gpt-5.3-codex-spark";
export const SYSTEM_TEST_USAGE_LIMIT_FALLBACK_MODEL = "openai-codex:gpt-5.6-luna";
export const SYSTEM_TEST_USAGE_LIMIT_FALLBACK_THINKING_LEVEL = "low" as const;
export const SYSTEM_TEST_USAGE_LIMIT_FAILURE = "usage_limit_terminal" as const;

export type SystemTestThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Finite case budget so one wedged turn cannot hold an unattended suite forever. */
export const DEFAULT_SYSTEM_TEST_TIMEOUT_MS = 10 * 60_000;

/**
 * The complete model route for one system-test run.
 *
 * Keep this policy shared by the runner and doctor so readiness checks cannot
 * drift from the models a run may actually invoke. Explicit model overrides
 * remain single-model diagnostic runs.
 */
export function systemTestModelRoute(
  primaryModel = SYSTEM_TEST_AGENT_MODEL,
  enableUsageLimitFallback = true
): {
  primaryModel: string;
  fallbackModel: string | null;
  fallbackThinkingLevel: typeof SYSTEM_TEST_USAGE_LIMIT_FALLBACK_THINKING_LEVEL | null;
  fallbackOn: readonly [typeof SYSTEM_TEST_USAGE_LIMIT_FAILURE] | null;
  fallbackScope: "all-turns" | null;
} {
  if (enableUsageLimitFallback) {
    return {
      primaryModel,
      fallbackModel: SYSTEM_TEST_USAGE_LIMIT_FALLBACK_MODEL,
      fallbackThinkingLevel: SYSTEM_TEST_USAGE_LIMIT_FALLBACK_THINKING_LEVEL,
      fallbackOn: [SYSTEM_TEST_USAGE_LIMIT_FAILURE],
      fallbackScope: "all-turns",
    };
  }
  return {
    primaryModel,
    fallbackModel: null,
    fallbackThinkingLevel: null,
    fallbackOn: null,
    fallbackScope: null,
  };
}
