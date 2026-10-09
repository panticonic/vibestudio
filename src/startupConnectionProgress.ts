const STARTUP_CONNECTION_PHASE_IDS = [
  "start-local-server",
  "connect-server-and-workspace",
  "check-credential-storage",
  "redeem-pairing-link",
  "resolve-workspace",
  "connect-workspace",
  "prepare-workspace-session",
] as const;

export type StartupConnectionPhaseId = (typeof STARTUP_CONNECTION_PHASE_IDS)[number];

export interface StartupConnectionPhase {
  id: StartupConnectionPhaseId;
  label: string;
}

export interface StartupConnectionProgress {
  phases: readonly StartupConnectionPhase[];
  currentPhase: StartupConnectionPhaseId;
}

export const LOCAL_STARTUP_CONNECTION_PHASES = [
  { id: "start-local-server", label: "Starting Vibestudio" },
  { id: "connect-workspace", label: "Connecting to your workspace" },
  { id: "prepare-workspace-session", label: "Getting your workspace ready" },
] as const satisfies readonly StartupConnectionPhase[];

export const RETURNING_REMOTE_STARTUP_CONNECTION_PHASES = [
  { id: "connect-server-and-workspace", label: "Connecting to your server" },
  { id: "prepare-workspace-session", label: "Getting your workspace ready" },
] as const satisfies readonly StartupConnectionPhase[];

export const FRESH_REMOTE_STARTUP_CONNECTION_PHASES = [
  { id: "check-credential-storage", label: "Checking secure storage on this device" },
  { id: "redeem-pairing-link", label: "Pairing with your server" },
  { id: "resolve-workspace", label: "Finding your workspace" },
  { id: "connect-workspace", label: "Connecting to your workspace" },
  { id: "prepare-workspace-session", label: "Getting your workspace ready" },
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
  return (STARTUP_CONNECTION_PHASE_IDS as readonly unknown[]).includes(value);
}
