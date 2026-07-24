import { callMain, openPanel } from "@workspace/runtime";
import {
  resolveOnboardingSelection,
  type OnboardingInteraction,
  type ResolvedOnboardingSelection,
} from "./routing";

export interface OnboardingExecutionDependencies {
  openWorkspacePanel: (source: string) => Promise<unknown>;
  openShellSurface: (target: "connection-settings" | "workspace-chooser") => Promise<void>;
}

export interface OnboardingExecutionResult {
  handled: boolean;
  target: ResolvedOnboardingSelection["target"];
  ownerSkillPath?: string;
}

const defaultDependencies: OnboardingExecutionDependencies = {
  openWorkspacePanel: (source) => openPanel(source, { focus: true }),
  openShellSurface: (target) => callMain<void>("app.openShellSurface", target),
};

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
    await dependencies.openWorkspacePanel(`about/${route.target.page}`);
    return { handled: true, target: route.target };
  }
  if (route.target.via === "panel") {
    await dependencies.openWorkspacePanel(route.target.path);
    return { handled: true, target: route.target };
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
