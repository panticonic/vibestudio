/**
 * Clearance classification
 * (docs/template-install-unit-approval-ux-plan.md §6).
 *
 * Method tiers remain the authorization floor. On top of a `gated` request the
 * platform owns exactly one extra dimension: does accepting an install
 * pre-authorize this, or does it keep asking at concrete use?
 *
 *   open      — no manifest requirement, no grant, no prompt
 *   gated     — cleared at install, or contextual
 *   critical  — never a standing grant; fresh per-operation approval
 *
 * The default for a reviewed gated request is install clearance. Manifests are
 * broad by design (§1, §11), so a contextual default would convert one bad card
 * into a prompt on essentially every first use and spend the whole friction
 * budget on requests already reviewed at admission. What stays contextual is the
 * short list below — the surfaces where the concrete object of the request is
 * the whole point of asking.
 *
 * Unit authors do not decide this (U4). A receiver may declare a method critical
 * or restrict its principals; the platform may then make a request more
 * contextual than the receiver asked for, never less.
 */

import type { ResourceScope } from "@vibestudio/rpc";

export interface CapabilityClearancePolicy {
  clearance: "install" | "contextual";
  reusableScopes: readonly ("task" | "unit-version")[];
  presentation: "declared" | "concrete-use";
}

/**
 * §6.2 — requests that keep prompting at use regardless of declaration.
 *
 * Accounts & sign-ins, device access, and cross-user or protected data. Widened
 * external network reach is resource-scope dependent and handled below rather
 * than here, because reaching a unit's own declared origin is ordinary while
 * reaching any site at all is not.
 */
const CONTEXTUAL_KEYS: readonly string[] = [
  // Accounts & sign-ins — the prompt names the concrete account.
  "account-providers.",
  "accounts.connect",
  "accounts.disconnect",
  "credential.use",
  "credentials.audit.read",
  "keychain",
  "browser-passwords.",
  "browser-form-fill.manage",
  "protected-input.submit",

  // Device access — camera, microphone, location, clipboard, paired devices.
  "clipboard",
  "devices.pair",
  "devices.revoke",
  "incoming-pair-links",
  "mobile.provision",
  "connections.approve",
  "remote-client.connect",

  // Cross-user or protected data.
  "workspace.members.manage",
  "workspace.members.remove",
  "users.revoke",
  "channel.members.remove",
  "security.audit.read",
];

/**
 * Capabilities whose reach is bounded by the resource scope the unit declared.
 * A declared origin or domain is install-clearable; `network` — any site at
 * all — is the widened reach §6.2 keeps contextual.
 */
const SCOPE_WIDENED_EGRESS: readonly string[] = [
  "network.response.read",
  "workspace.gateway.access",
];

/**
 * Receiver-declared families the platform keeps contextual whatever tier their
 * provider chose. §6.3 reserves installing or updating executable code for a
 * fresh decision against a prepared effect; a userland provider may declare its
 * own template operations `gated`, and the platform reduces that to contextual
 * rather than pre-authorizing code installation at install time.
 */
const CONTEXTUAL_USERLAND_FAMILIES: readonly string[] = [
  "workspace.templates.add",
  "workspace.templates.update",
  "workspace.templates.remove",
  "workspace.templates.change",
];

function matches(key: string, capability: string): boolean {
  return key.endsWith(":") || key.endsWith(".")
    ? capability.startsWith(key)
    : capability === key || capability.startsWith(`${key}:`);
}

export function isContextualCapability(capability: string, resource?: ResourceScope): boolean {
  if (CONTEXTUAL_KEYS.some((key) => matches(key, capability))) return true;
  if (SCOPE_WIDENED_EGRESS.some((key) => matches(key, capability))) {
    // An unbounded reach is contextual; the unit's own declared origins are not.
    return !resource || resource.kind === "network" || resource.kind === "prefix";
  }
  return false;
}

/**
 * The clearance policy for one declared request.
 *
 * `reviewed` is false for a capability the platform has not classified — a new
 * userland capability shipped by a third-party template, anything not yet in the
 * reviewed catalog. Those default to contextual (§6.1), so a foreign template
 * cannot ship a capability that is both auto-granted and auto-hidden.
 */
/**
 * What the platform knows about a receiver-declared (`workspace-service:`)
 * capability, when the operation under review carries its definition.
 *
 * A capability whose provider is part of the same reviewed set is classified
 * rather than unknown: the user is accepting the receiver and its declaration in
 * the same decision. The declaration is a ceiling and a vocabulary, never a
 * license — the platform still reduces `admin` and `destructive` authority, and
 * the code-installation families above, to contextual (U4).
 */
export interface UserlandClearanceDeclaration {
  sensitivity: "read" | "write" | "admin" | "destructive";
  /** The local capability name, without the `workspace-service:` prefix. */
  localName: string;
}

export function capabilityClearancePolicy(input: {
  capability: string;
  resource: ResourceScope;
  tier: "gated" | "critical";
  reviewed: boolean;
  /** Receiver-declared reusable scopes, used as a ceiling for userland capabilities. */
  declaredReusableScopes?: readonly ("task" | "unit-version")[];
  /** Present when the operation under review carries the receiver's definition. */
  declaration?: UserlandClearanceDeclaration;
}): CapabilityClearancePolicy {
  if (input.tier === "critical") {
    return { clearance: "contextual", reusableScopes: [], presentation: "concrete-use" };
  }
  const contextual =
    !input.reviewed ||
    isContextualCapability(input.capability, input.resource) ||
    isContextualUserlandDeclaration(input.declaration);
  if (contextual) {
    // A contextual request may still offer "allow for this task" at the prompt,
    // but never a standing decision taken before the code ever ran.
    const ceiling = input.declaredReusableScopes ?? (["task"] as const);
    return {
      clearance: "contextual",
      reusableScopes: ceiling.filter((scope) => scope === "task"),
      presentation: "concrete-use",
    };
  }
  const ceiling = input.declaredReusableScopes ?? (["task", "unit-version"] as const);
  // An install review can only mint a durable grant bound to this exact unit
  // version. A provider that declares only task/once/session scopes has not
  // authorized that standing decision, so the row must remain contextual.
  if (!ceiling.includes("unit-version")) {
    return {
      clearance: "contextual",
      reusableScopes: ceiling.filter((scope) => scope === "task"),
      presentation: "concrete-use",
    };
  }
  return {
    clearance: "install",
    reusableScopes: ceiling,
    presentation: "declared",
  };
}

function isContextualUserlandDeclaration(
  declaration: UserlandClearanceDeclaration | undefined
): boolean {
  if (!declaration) return false;
  if (declaration.sensitivity === "admin" || declaration.sensitivity === "destructive") return true;
  return CONTEXTUAL_USERLAND_FAMILIES.some((family) => matches(family, declaration.localName));
}

/** When a request may be pre-authorized by accepting an install. */
export function isInstallClearable(input: {
  capability: string;
  resource: ResourceScope;
  tier: "gated" | "critical";
  reviewed: boolean;
  declaration?: UserlandClearanceDeclaration;
}): boolean {
  return capabilityClearancePolicy(input).clearance === "install";
}
