import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import type { ClientLaunchProgressPhase } from "@vibestudio/workspace-contracts/clients";

/**
 * What the launch gate shows while a client launch is not yet running.
 *
 * The gate is host UI that exists before any client does. The host owns the
 * launch (`clients.launch` through the shared launcher) and pushes each state
 * to the gate; the gate asks the host to relay the person's decision. Nothing
 * here is polled and nothing here is an RPC from the gate's renderer.
 */

export type LaunchGateStatus =
  | { status: "starting"; reason: string }
  | { status: "approval-required"; approvals: PendingUnitInstallReviewApproval[] }
  | { status: "preparing"; phase: ClientLaunchProgressPhase; reason: string }
  | { status: "ready"; title: string }
  | { status: "unavailable"; reason: string; declined?: true }
  /** The launch failed for a reason of the host or the connection, not the client's availability. */
  | { status: "failed"; reason: string };

export interface LaunchGateProgress {
  phase: ClientLaunchProgressPhase;
  state: "active" | "complete" | "blocked" | "failed";
  detail?: string;
}

export interface LaunchGateView {
  /** The client being launched, for the gate's copy. */
  title: string | null;
  launch: LaunchGateStatus;
  progress: LaunchGateProgress[];
}

const PHASES: readonly ClientLaunchProgressPhase[] = ["resolve", "extensions", "build"];

/** The steps a launch has taken, derived from where it now is. */
export function launchGateProgress(launch: LaunchGateStatus): LaunchGateProgress[] {
  const upTo = (
    phase: ClientLaunchProgressPhase,
    current: LaunchGateProgress["state"],
    detail?: string
  ) =>
    PHASES.slice(0, PHASES.indexOf(phase) + 1).map(
      (step): LaunchGateProgress =>
        step === phase
          ? { phase: step, state: current, ...(detail ? { detail } : {}) }
          : { phase: step, state: "complete" }
    );
  switch (launch.status) {
    case "starting":
      return [];
    case "preparing":
      return upTo(launch.phase, "active", launch.reason);
    case "approval-required":
      return upTo("build", "blocked");
    case "ready":
      return PHASES.map((phase) => ({ phase, state: "complete" }));
    case "unavailable":
      return [{ phase: "resolve", state: "failed", detail: launch.reason }];
    case "failed":
      return [];
  }
}

export function launchGateText(launch: LaunchGateStatus): string {
  switch (launch.status) {
    case "starting":
      return launch.reason;
    case "approval-required":
      return "Review the code that wants to run before Vibestudio starts.";
    case "preparing":
      return launch.reason;
    case "ready":
      return `${launch.title} is approved and launching.`;
    case "unavailable":
    case "failed":
      return launch.reason;
  }
}
