export type StartupDependencyState = "waiting-for-consent" | "failed";

export interface StartupDependencyStatus {
  state: StartupDependencyState;
  message: string;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Startup dependencies may legitimately park while the user reviews the
 * extension/version that provides them. That is a lifecycle state, not a
 * failed import. Keep the classification in one place so logs and recovery UI
 * use the same language.
 */
export function classifyStartupDependency(error: unknown): StartupDependencyStatus {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (
    code === "ENOEXT" ||
    code === "ENOTREADY" ||
    /\b(pending|waiting|requires?)\b.*\b(approval|consent|review)\b/i.test(message) ||
    /\b(approval|consent|review)\b.*\b(pending|waiting|required)\b/i.test(message)
  ) {
    return {
      state: "waiting-for-consent",
      message: "Waiting for you to review the workspace dependency provider.",
    };
  }
  return { state: "failed", message };
}
