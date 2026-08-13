type DoctorCheck = {
  name?: unknown;
  ok?: unknown;
  detail?: unknown;
  data?: unknown;
};

function lastJsonRecord(output: string): Record<string, unknown> | null {
  for (const line of output.trim().split(/\r?\n/u).reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Earlier output can contain ordinary log lines beginning with `{`.
    }
  }
  return null;
}

function checks(result: Record<string, unknown> | null): DoctorCheck[] {
  return Array.isArray(result?.["checks"]) ? (result["checks"] as DoctorCheck[]) : [];
}

/**
 * Turn a captured doctor subprocess failure into one bounded, useful message.
 * JSON-mode commands write their actual result to stdout while Node warnings
 * use stderr; treating stderr as the sole diagnostic hides the failed check.
 */
export function systemTestPreparationFailureDetail(output: string, diagnostics: string): string {
  const result = lastJsonRecord(output);
  const failedChecks = checks(result).filter((check) => check.ok === false);
  const primary =
    failedChecks.length > 0
      ? failedChecks
          .map((check) => {
            const name = typeof check.name === "string" ? check.name : "doctor";
            const detail = typeof check.detail === "string" ? check.detail : "check failed";
            return `${name}: ${detail}`;
          })
          .join("; ")
      : typeof result?.["error"] === "string"
        ? result["error"]
        : output.trim();
  const stderr = diagnostics.trim();
  if (primary && stderr) return `${primary}\nSubprocess stderr:\n${stderr}`;
  return primary || stderr || "doctor exited without a diagnostic";
}

/** Validate the successful preparation receipt, including exact workspace. */
export function assertSystemTestPreparationResult(
  output: string,
  expectedWorkspaceId: string
): void {
  const result = lastJsonRecord(output);
  if (!result || result["ok"] !== true) {
    throw new Error("system-test startup preparation returned no successful doctor result");
  }
  const server = checks(result).find((check) => check.name === "server");
  const data =
    server?.data && typeof server.data === "object" && !Array.isArray(server.data)
      ? (server.data as Record<string, unknown>)
      : null;
  if (data?.["workspaceId"] !== expectedWorkspaceId) {
    throw new Error(
      `system-test startup preparation reached workspace ${String(
        data?.["workspaceId"] ?? "unknown"
      )}; expected ${expectedWorkspaceId}`
    );
  }
}
