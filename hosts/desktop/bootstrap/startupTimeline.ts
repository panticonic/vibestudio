import type {
  StartupConnectionProgress,
  StartupConnectionPhaseId,
} from "../../../src/startupConnectionProgress.js";
import type { LaunchGateProgress } from "./launchGateModel.js";
type BootstrapPhaseState = "pending" | "active" | "complete" | "blocked" | "failed" | "skipped";

export interface BootstrapTimelinePhase {
  id: StartupConnectionPhaseId | LaunchGateProgress["phase"];
  label: string;
  state: BootstrapPhaseState;
  detail?: string;
}

const GENERIC_CONNECTION_PHASE: BootstrapTimelinePhase = {
  id: "connect-workspace",
  label: "Connecting to your workspace",
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
  launchProgress?: readonly LaunchGateProgress[]
): BootstrapTimelinePhase[] {
  const labels: Record<LaunchGateProgress["phase"], string> = {
    resolve: "Find the client",
    extensions: "Start required services",
    build: "Prepare the client",
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
