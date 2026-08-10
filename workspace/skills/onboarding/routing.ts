import {
  onboardingCatalog,
  type OnboardingCapabilityDefinition,
  type SetupAction,
  type SetupActionTarget,
} from "./catalog";
import type { OnboardingTemplateSelection } from "./templates";

export const ONBOARDING_INTERACTION_KIND = "onboarding-capability";
export const ONBOARDING_INTERACTION_SOURCE = "onboarding-setup-hub";

export interface OnboardingInteraction {
  source: typeof ONBOARDING_INTERACTION_SOURCE;
  kind: typeof ONBOARDING_INTERACTION_KIND;
  action: SetupAction;
  targetId: string;
}

export interface ResolvedOnboardingSelection {
  capability: OnboardingCapabilityDefinition;
  action: SetupAction;
  target: SetupActionTarget;
  ownerSkillPath?: string;
}

export interface OnboardingTemplateInteraction {
  source: typeof ONBOARDING_INTERACTION_SOURCE;
  kind: "onboarding-template";
  action: "add";
  targetId: string;
  catalogId: string;
  registryCommit: string;
  registrySnapshot: string;
}

export interface ResolvedOnboardingTemplateSelection {
  ownerSkillPath: "skills/templates/SKILL.md";
  selection: OnboardingTemplateSelection;
}

export function onboardingInteraction(
  targetId: string,
  action: SetupAction
): OnboardingInteraction {
  return {
    source: ONBOARDING_INTERACTION_SOURCE,
    kind: ONBOARDING_INTERACTION_KIND,
    action,
    targetId,
  };
}

export function onboardingTemplateInteraction(
  selection: OnboardingTemplateSelection
): OnboardingTemplateInteraction {
  return {
    source: ONBOARDING_INTERACTION_SOURCE,
    kind: "onboarding-template",
    action: "add",
    targetId: `template.${selection.catalogId}`,
    ...selection,
  };
}

export function resolveOnboardingTemplateSelection(
  interaction: unknown
): ResolvedOnboardingTemplateSelection {
  if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) {
    throw new Error("Onboarding template selection metadata is missing.");
  }
  const value = interaction as Record<string, unknown>;
  if (
    value["source"] !== ONBOARDING_INTERACTION_SOURCE ||
    value["kind"] !== "onboarding-template" ||
    value["action"] !== "add" ||
    typeof value["targetId"] !== "string" ||
    typeof value["catalogId"] !== "string" ||
    typeof value["registryCommit"] !== "string" ||
    typeof value["registrySnapshot"] !== "string" ||
    value["targetId"] !== `template.${value["catalogId"]}`
  ) {
    throw new Error("Onboarding template selection metadata is invalid.");
  }
  return {
    ownerSkillPath: "skills/templates/SKILL.md",
    selection: {
      catalogId: value["catalogId"],
      registryCommit: value["registryCommit"],
      registrySnapshot: value["registrySnapshot"],
    },
  };
}

export function resolveOnboardingSelection(
  interaction: unknown,
  catalog: readonly OnboardingCapabilityDefinition[] = onboardingCatalog
): ResolvedOnboardingSelection {
  if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) {
    throw new Error("Onboarding selection metadata is missing.");
  }
  const value = interaction as Record<string, unknown>;
  if (
    value["source"] !== ONBOARDING_INTERACTION_SOURCE ||
    value["kind"] !== ONBOARDING_INTERACTION_KIND ||
    typeof value["targetId"] !== "string" ||
    typeof value["action"] !== "string"
  ) {
    throw new Error("Onboarding selection metadata is invalid.");
  }
  const capability = catalog.find((entry) => entry.id === value["targetId"]);
  if (!capability) {
    throw new Error(`Unknown or retired onboarding capability: ${value["targetId"]}`);
  }
  const action = value["action"] as SetupAction;
  const target = capability.actions?.[action];
  if (!target) {
    throw new Error(`${capability.id} does not offer the ${action} action.`);
  }
  return {
    capability,
    action,
    target,
    ...(capability.ownerSkillPath ? { ownerSkillPath: capability.ownerSkillPath } : {}),
  };
}
