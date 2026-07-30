import {
  capabilityById,
  type OnboardingCapabilityDefinition,
  type SetupAction,
  type SetupActionTarget,
} from "./catalog";

export const ONBOARDING_INTERACTION_KIND = "onboarding-capability";
export const ONBOARDING_INTERACTION_SOURCE = "onboarding-setup-hub";
export const TEMPLATE_INTERACTION_SOURCE = "onboarding-template-catalog";
export const TEMPLATE_ADD_INTERACTION_KIND = "template-add";
export const TEMPLATE_UPDATE_INTERACTION_KIND = "template-update";
export const TEMPLATE_BROWSE_INTERACTION_KIND = "template-browse";

export interface OnboardingInteraction {
  source: typeof ONBOARDING_INTERACTION_SOURCE;
  kind: typeof ONBOARDING_INTERACTION_KIND;
  action: SetupAction;
  targetId: string;
}

export interface TemplateCatalogInteraction {
  source: typeof TEMPLATE_INTERACTION_SOURCE;
  kind: typeof TEMPLATE_ADD_INTERACTION_KIND;
  targetId: string;
  catalogId: string;
  registryCommit: string;
  registrySnapshot: string;
}

export interface TemplateUrlInteraction {
  source: typeof TEMPLATE_INTERACTION_SOURCE;
  kind: typeof TEMPLATE_ADD_INTERACTION_KIND;
  targetId: "url";
  url: string;
}

export interface TemplateUpdateInteraction {
  source: typeof TEMPLATE_INTERACTION_SOURCE;
  kind: typeof TEMPLATE_UPDATE_INTERACTION_KIND;
  targetId: string;
}

export interface TemplateBrowseInteraction {
  source: typeof TEMPLATE_INTERACTION_SOURCE;
  kind: typeof TEMPLATE_BROWSE_INTERACTION_KIND;
  targetId: "catalog";
}

export type TemplateInteraction =
  | TemplateCatalogInteraction
  | TemplateUrlInteraction
  | TemplateUpdateInteraction
  | TemplateBrowseInteraction;

export interface ResolvedOnboardingSelection {
  capability: OnboardingCapabilityDefinition;
  action: SetupAction;
  target: SetupActionTarget;
  ownerSkillPath?: string;
}

export interface ResolvedTemplateSelection {
  target: { via: "template-composer" };
  interaction: TemplateInteraction;
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

export function templateCatalogInteraction(
  catalogId: string,
  registryCommit: string,
  registrySnapshot: string
): TemplateCatalogInteraction {
  return {
    source: TEMPLATE_INTERACTION_SOURCE,
    kind: TEMPLATE_ADD_INTERACTION_KIND,
    targetId: catalogId,
    catalogId,
    registryCommit,
    registrySnapshot,
  };
}

export function templateUrlInteraction(url: string): TemplateUrlInteraction {
  return {
    source: TEMPLATE_INTERACTION_SOURCE,
    kind: TEMPLATE_ADD_INTERACTION_KIND,
    targetId: "url",
    url,
  };
}

export function templateUpdateInteraction(alias: string): TemplateUpdateInteraction {
  return {
    source: TEMPLATE_INTERACTION_SOURCE,
    kind: TEMPLATE_UPDATE_INTERACTION_KIND,
    targetId: alias,
  };
}

export function templateBrowseInteraction(): TemplateBrowseInteraction {
  return {
    source: TEMPLATE_INTERACTION_SOURCE,
    kind: TEMPLATE_BROWSE_INTERACTION_KIND,
    targetId: "catalog",
  };
}

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validates catalog messages without routing from visible prose. The returned
 * value deliberately has no service side effect; onboarding hands it to the
 * templates method family, which owns resolution and approval.
 */
export function resolveTemplateSelection(interaction: unknown): ResolvedTemplateSelection {
  if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) {
    throw new Error("Template selection metadata is missing.");
  }
  const value = interaction as Record<string, unknown>;
  if (value["source"] !== TEMPLATE_INTERACTION_SOURCE || typeof value["kind"] !== "string") {
    throw new Error("Template selection metadata is invalid.");
  }
  if (value["kind"] === TEMPLATE_ADD_INTERACTION_KIND) {
    if (
      typeof value["catalogId"] === "string" &&
      value["catalogId"].trim() &&
      value["targetId"] === value["catalogId"] &&
      typeof value["registryCommit"] === "string" &&
      /^[0-9a-f]{40}$/u.test(value["registryCommit"]) &&
      typeof value["registrySnapshot"] === "string" &&
      /^v1-sha256:[0-9a-f]{64}$/u.test(value["registrySnapshot"])
    ) {
      return {
        target: { via: "template-composer" },
        interaction: templateCatalogInteraction(
          value["catalogId"],
          value["registryCommit"],
          value["registrySnapshot"]
        ),
      };
    }
    if (value["targetId"] === "url" && validHttpUrl(value["url"])) {
      return {
        target: { via: "template-composer" },
        interaction: templateUrlInteraction(value["url"]),
      };
    }
    throw new Error("Template add selection is invalid.");
  }
  if (
    value["kind"] === TEMPLATE_UPDATE_INTERACTION_KIND &&
    typeof value["targetId"] === "string" &&
    value["targetId"].trim()
  ) {
    return {
      target: { via: "template-composer" },
      interaction: templateUpdateInteraction(value["targetId"]),
    };
  }
  if (value["kind"] === TEMPLATE_BROWSE_INTERACTION_KIND && value["targetId"] === "catalog") {
    return { target: { via: "template-composer" }, interaction: templateBrowseInteraction() };
  }
  throw new Error("Template selection metadata is invalid.");
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
