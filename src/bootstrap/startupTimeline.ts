import type {
  StartupConnectionProgress,
  StartupConnectionPhaseId,
} from "../startupConnectionProgress.js";
import type { HostLaunchProgress } from "@vibestudio/service-schemas/clients/hostLaunchClient";
type BootstrapPhaseState = "pending" | "active" | "complete" | "blocked" | "failed" | "skipped";

export interface BootstrapTimelinePhase {
  id: StartupConnectionPhaseId | HostLaunchProgress["phase"];
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
  currentState: "active" | "failed" | "complete" = "active",
  launchProgress?: readonly HostLaunchProgress[]
): BootstrapTimelinePhase[] {
  const labels: Record<HostLaunchProgress["phase"], string> = {
    "resolve-target": "Find desktop app",
    "start-units": "Start required services",
    "prepare-app": "Prepare desktop app",
  };
  return [
    ...connectionTimeline(progress, launchProgress ? "complete" : currentState),
    ...(launchProgress ?? []).map(({ phase, ...step }) => ({
      id: phase,
      label: labels[phase],
      ...step,
    })),
  ];
}
