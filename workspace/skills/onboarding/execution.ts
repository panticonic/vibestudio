import { callMain, openPanel } from "@workspace/runtime";
import {
  PanelOperationError,
  type PanelRuntimeFailure,
} from "@vibestudio/shared/panel/observation";
import {
  resolveOnboardingSelection,
  type OnboardingInteraction,
  type ResolvedOnboardingSelection,
} from "./routing";

export interface OnboardingExecutionDependencies {
  openWorkspacePanel: (source: string) => Promise<{
    id: string;
    readiness?: "ready" | "unconfirmed";
  }>;
  openShellSurface: (target: "connection-settings" | "workspace-chooser") => Promise<void>;
}

export interface OnboardingExecutionResult {
  handled: boolean;
  target: ResolvedOnboardingSelection["target"];
  panelId?: string;
  readiness?: "ready" | "unconfirmed";
  failure?: PanelRuntimeFailure;
  ownerSkillPath?: string;
}

const defaultDependencies: OnboardingExecutionDependencies = {
  openWorkspacePanel: async (source) => {
    const panel = await openPanel(source, { focus: true });
    return { id: panel.id, readiness: "ready" as const };
  },
  openShellSurface: (target) => callMain<void>("app.openShellSurface", target),
};

async function openNavigationPanel(
  source: string,
  target: ResolvedOnboardingSelection["target"],
  dependencies: OnboardingExecutionDependencies
): Promise<OnboardingExecutionResult> {
  try {
    const panel = await dependencies.openWorkspacePanel(source);
    return {
      handled: true,
      target,
      panelId: panel.id,
      readiness: panel.readiness ?? "ready",
    };
  } catch (error) {
    if (error instanceof PanelOperationError && error.failure.provenance.panelId) {
      return {
        handled: true,
        target,
        panelId: error.failure.provenance.panelId,
        readiness: "unconfirmed",
        failure: error.failure,
      };
    }
    throw error;
  }
}

/**
 * Execute only routes owned by the inviting panel/client. Owner-skill,
 * model-settings, and conversational routes are returned to the agent so their
 * existing domain workflows remain authoritative.
 */
export async function executeOnboardingSelection(
  interaction: OnboardingInteraction,
  dependencies: OnboardingExecutionDependencies = defaultDependencies
): Promise<OnboardingExecutionResult> {
  const route = resolveOnboardingSelection(interaction);
  if (route.target.via === "about-page") {
    return openNavigationPanel(`about/${route.target.page}`, route.target, dependencies);
  }
  if (route.target.via === "panel") {
    return openNavigationPanel(route.target.path, route.target, dependencies);
  }
  if (route.target.via === "shell-navigation") {
    await dependencies.openShellSurface(route.target.target);
    return { handled: true, target: route.target };
  }
  return {
    handled: false,
    target: route.target,
    ...(route.ownerSkillPath ? { ownerSkillPath: route.ownerSkillPath } : {}),
  };
}
