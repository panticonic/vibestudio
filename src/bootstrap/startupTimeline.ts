import type {
  StartupConnectionProgress,
  StartupConnectionPhaseId,
} from "../startupConnectionProgress.js";
type BootstrapPhaseState = "pending" | "active" | "complete" | "blocked" | "failed" | "skipped";

export interface BootstrapTimelinePhase {
  id:
    | StartupConnectionPhaseId
    | "review-trust"
    | "start-units"
    | "build-app"
    | "activate-target"
    | "connected";
  label: string;
  state: BootstrapPhaseState;
  detail?: string;
}

const GENERIC_CONNECTION_PHASE: BootstrapTimelinePhase = {
  id: "connect-workspace",
  label: "Connect to workspace",
  state: "active",
};

export function connectionTimeline(
  progress: StartupConnectionProgress | null | undefined,
  currentState: "active" | "failed" | "complete" = "active"
): BootstrapTimelinePhase[] {
  if (!progress) return [{ ...GENERIC_CONNECTION_PHASE, state: currentState }];
  const currentIndex = progress.phases.findIndex((phase) => phase.id === progress.currentPhase);
  if (currentIndex < 0) return [{ ...GENERIC_CONNECTION_PHASE, state: currentState }];

  return progress.phases.map((phase, index) => ({
    ...phase,
    state:
      currentState === "complete"
        ? "complete"
        : index < currentIndex
          ? "complete"
          : index === currentIndex
            ? currentState
            : "pending",
  }));
}

export function startupTimeline(
  progress: StartupConnectionProgress | null | undefined,
  currentState: "active" | "failed" | "complete" = "active"
): BootstrapTimelinePhase[] {
  return [
    ...connectionTimeline(progress, currentState),
    { id: "review-trust", label: "Review trust", state: "pending" },
    { id: "start-units", label: "Start privileged units", state: "pending" },
    { id: "build-app", label: "Build desktop app", state: "pending" },
    { id: "activate-target", label: "Activate desktop", state: "pending" },
    { id: "connected", label: "Connected", state: "pending" },
  ];
}
