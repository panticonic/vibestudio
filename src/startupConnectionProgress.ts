export type StartupConnectionPhaseId =
  | "start-local-server"
  | "connect-server-and-workspace"
  | "redeem-pairing-link"
  | "resolve-workspace"
  | "connect-workspace"
  | "prepare-workspace-session";

export interface StartupConnectionPhase {
  id: StartupConnectionPhaseId;
  label: string;
}

export interface StartupConnectionProgress {
  phases: readonly StartupConnectionPhase[];
  currentPhase: StartupConnectionPhaseId;
}

export const LOCAL_STARTUP_CONNECTION_PHASES = [
  { id: "start-local-server", label: "Start local workspace server" },
  { id: "connect-workspace", label: "Connect to workspace" },
  { id: "prepare-workspace-session", label: "Prepare workspace session" },
] as const satisfies readonly StartupConnectionPhase[];

export const RETURNING_REMOTE_STARTUP_CONNECTION_PHASES = [
  { id: "connect-server-and-workspace", label: "Connect to server and workspace" },
  { id: "prepare-workspace-session", label: "Prepare workspace session" },
] as const satisfies readonly StartupConnectionPhase[];

export const FRESH_REMOTE_STARTUP_CONNECTION_PHASES = [
  { id: "redeem-pairing-link", label: "Redeem pairing link" },
  { id: "resolve-workspace", label: "Resolve workspace" },
  { id: "connect-workspace", label: "Connect to workspace" },
  { id: "prepare-workspace-session", label: "Prepare workspace session" },
] as const satisfies readonly StartupConnectionPhase[];

export function startupConnectionProgress(
  phases: readonly StartupConnectionPhase[],
  currentPhase: StartupConnectionPhaseId
): StartupConnectionProgress {
  if (!phases.some((phase) => phase.id === currentPhase)) {
    throw new Error(`Startup connection phase "${currentPhase}" is not in the active plan`);
  }
  return { phases, currentPhase };
}

export function isStartupConnectionProgress(value: unknown): value is StartupConnectionProgress {
  if (!isRecord(value) || !Array.isArray(value["phases"])) return false;
  const currentPhase = value["currentPhase"];
  if (!isStartupConnectionPhaseId(currentPhase)) return false;
  const phases = value["phases"];
  if (
    phases.length === 0 ||
    !phases.every(
      (phase) =>
        isRecord(phase) &&
        isStartupConnectionPhaseId(phase["id"]) &&
        typeof phase["label"] === "string" &&
        phase["label"].length > 0
    )
  ) {
    return false;
  }
  return phases.some((phase) => phase["id"] === currentPhase);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStartupConnectionPhaseId(value: unknown): value is StartupConnectionPhaseId {
  return (
    value === "start-local-server" ||
    value === "connect-server-and-workspace" ||
    value === "redeem-pairing-link" ||
    value === "resolve-workspace" ||
    value === "connect-workspace" ||
    value === "prepare-workspace-session"
  );
}
