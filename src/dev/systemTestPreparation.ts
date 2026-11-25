import {
  systemTestDoctorResultSchema,
  type SystemTestDoctorResult,
} from "@vibestudio/service-schemas/systemTestRunner";

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
): SystemTestDoctorResult & Record<string, unknown> {
  const result = lastJsonRecord(output);
  if (!result || result["ok"] !== true) {
    throw new Error("system-test startup preparation returned no successful doctor result");
  }
  const validated = systemTestDoctorResultSchema.parse({
    ok: result["ok"],
    checks: result["checks"],
  });
  if (validated.checks.some((check) => !check.ok))
    throw new Error("managed workspace preparation has failed readiness checks");
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
  const startupApprovals =
    result["startupApprovals"] &&
    typeof result["startupApprovals"] === "object" &&
    !Array.isArray(result["startupApprovals"])
      ? (result["startupApprovals"] as Record<string, unknown>)
      : null;
  const reviewStatus = startupApprovals?.["creationReviewStatus"];
  if (reviewStatus !== "resolved" && reviewStatus !== "not-required") {
    throw new Error("managed workspace preparation has no completed creation-review receipt");
  }
  return { ...result, ...validated };
}

/** A requested doctor can establish the barrier itself unless later work
 * changes what that same doctor must inspect (source adoption or devices). */
export function canUseRequestedStartupDoctor(options: {
  created: boolean;
  command: readonly string[];
  selfDevelopment: boolean;
  devices: readonly unknown[];
  recheck: boolean;
}): boolean {
  return (
    options.created &&
    options.command[0] === "doctor" &&
    !options.selfDevelopment &&
    options.devices.length === 0 &&
    !options.recheck
  );
}

/** Startup checks must inspect the same explicitly requested model. */
export function startupDoctorCommand(command: readonly string[]): string[] {
  if (command[0] === "doctor") {
    const result = command.filter((arg) => arg !== "--json");
    if (!result.includes("--approve-startup")) result.push("--approve-startup");
    result.push("--json");
    return result;
  }
  const result = ["doctor", "--approve-startup", "--json"];
  for (let i = 1; i < command.length && command[i] !== "--"; i++) {
    const arg = command[i];
    if (arg === undefined) continue;
    if (arg === "--model") {
      const model = command[++i];
      if (!model || model.startsWith("--")) throw new Error("--model requires a value");
      result.push("--model", model);
    } else if (arg.startsWith("--model=")) result.push(arg);
    else if (arg === "--native-reference") result.push(arg);
  }
  return result;
}
