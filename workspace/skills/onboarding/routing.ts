import {
  capabilityById,
  type OnboardingCapabilityDefinition,
  type SetupAction,
  type SetupActionTarget,
} from "./catalog";

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

export function resolveOnboardingSelection(interaction: unknown): ResolvedOnboardingSelection {
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
  const capability = capabilityById(value["targetId"]);
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
