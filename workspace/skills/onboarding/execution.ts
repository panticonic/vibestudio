import { callMain, openPanel } from "@vibestudio/runtime";
import {
  resolveOnboardingSelection,
  resolveTemplateSelection,
  type OnboardingInteraction,
  type ResolvedOnboardingSelection,
  type TemplateInteraction,
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

export interface TemplateExecutionResult {
  handled: false;
  target: { via: "template-composer" };
  interaction: TemplateInteraction;
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

/**
 * Template actions intentionally remain composer-owned. This gives the agent a
 * validated structured request to pass to the userland extension's
 * inspect/add/pull methods, rather than letting client UI resolve a URL or
 * bypass the approval card.
 */
export function executeTemplateSelection(interaction: TemplateInteraction): TemplateExecutionResult {
  const route = resolveTemplateSelection(interaction);
  return { handled: false, target: route.target, interaction: route.interaction };
}
