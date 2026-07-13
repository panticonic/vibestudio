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
