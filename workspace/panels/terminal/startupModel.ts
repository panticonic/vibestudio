export type StartupUnitStatus = {
  status?: string;
  pendingApproval?: unknown;
} | null;

export function terminalStartupPendingLabel(args: {
  pending: boolean;
  elapsedSeconds: number;
  shellUnit: StartupUnitStatus;
}): string | undefined {
  if (!args.pending) return undefined;
  const suffix = args.elapsedSeconds >= 1 ? ` ${args.elapsedSeconds}s` : "";
  if (isUnitApprovalPending(args.shellUnit)) return `Waiting for unit approval...${suffix}`;
  if (isExtensionPreparing(args.shellUnit)) {
    return args.elapsedSeconds >= 20
      ? `Still preparing terminal...${suffix}`
      : `Preparing terminal...${suffix}`;
  }
  if (args.elapsedSeconds >= 15) return `Still waiting for terminal approval...${suffix}`;
  if (args.elapsedSeconds >= 1) return `Waiting for terminal approval...${suffix}`;
  return "Starting terminal...";
}

export function terminalStartupDetail(args: {
  status: "idle" | "opening" | "waitingApproval" | "failed";
  elapsedSeconds: number;
  shellUnit: StartupUnitStatus;
  error: string | null;
}): { title: string; detail: string } {
  if (args.status === "failed") {
    return {
      title: "Terminal did not open",
      detail: args.error ?? "The shell request failed or was denied. You can try again.",
    };
  }
  if (args.status === "idle") {
    return {
      title: "Open terminal",
      detail: "Start a shell session in this workspace.",
    };
  }
  if (isUnitApprovalPending(args.shellUnit)) {
    return {
      title: "Approve shell unit",
      detail: "The terminal is waiting for the shell unit approval before it can start.",
    };
  }
  if (isExtensionPreparing(args.shellUnit)) {
    return {
      title: args.elapsedSeconds >= 20 ? "Still preparing terminal" : "Preparing terminal",
      detail: args.elapsedSeconds >= 20
        ? "The shell extension is still building or starting. The request is already in progress, so additional clicks will not start more terminals."
        : "Building or starting the shell extension. The first run can take around 20 seconds.",
    };
  }
  if (args.status === "waitingApproval") {
    return {
      title: args.elapsedSeconds >= 15 ? "Still waiting for terminal approval" : "Starting terminal session",
      detail: args.elapsedSeconds >= 15
        ? "The terminal request is still pending approval. Check the approval bar instead of opening another terminal."
        : "If an approval bar appears, allow the terminal session. The request is already in progress.",
    };
  }
  return {
    title: "Starting terminal",
    detail: "Opening the shell extension and creating the first session.",
  };
}

export function isUnitApprovalPending(shellUnit: StartupUnitStatus): boolean {
  return !!shellUnit?.pendingApproval || shellUnit?.status === "pending-approval";
}

export function isExtensionPreparing(shellUnit: StartupUnitStatus): boolean {
  return shellUnit?.status === "building" || shellUnit?.status === "available" || shellUnit?.status === "stopped";
}

const RETRYABLE_SHELL_STARTUP_CODES = new Set([
  "ENOEXT",
  "ENOTREADY",
  "TARGET_NOT_REACHABLE",
  "RECONNECT_GRACE_EXPIRED",
  "CONNECTION_LOST",
]);

/**
 * A declared native extension has a real activation window after workspace
 * approval. Calls made during that window are availability misses, not terminal
 * failures: the panel should remain in its single automatic-open flow and retry
 * once the extension transport is ready.
 */
export function isRetryableShellStartupError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (RETRYABLE_SHELL_STARTUP_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /extension (?:is )?(?:not installed|not running)|no active approved (?:build|execution artifact)|target (?:bridge )?not reachable|did not reconnect within grace window|connection .* closed before a response/i.test(
    message
  );
}
