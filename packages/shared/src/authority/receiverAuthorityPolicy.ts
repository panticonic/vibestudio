import type { HostSemanticCapability } from "./hostCapabilityPresentations.js";
import { capabilityDomain } from "./capabilityDomains.js";

export interface ReceiverAuthorityPolicy {
  agentScope: "offer" | "never";
  irreversible: boolean;
  missionGrant: boolean;
  requiresSubstance: boolean;
  substanceKind: import("../approvals.js").OperationSubstance["kind"] | null;
}

const NETWORK_EGRESS = new Set<HostSemanticCapability>([
  "network.response.read",
  "workspace.gateway.access",
]);

const IRREVERSIBLE = new Set<HostSemanticCapability>([
  "application.shutdown",
  "browser-passwords.delete",
  "workspace.storage.delete",
  "workspaces.delete",
  "workspace.members.remove",
  "devices.revoke",
  "users.revoke",
  "account-providers.delete",
]);

const AGENT_SCOPE_OFFERABLE = new Set<HostSemanticCapability>([
  "adblock.manage",
  "external.open",
  "credential.use",
  "accounts.connect",
  "accounts.disconnect",
  "workspace.gateway.access",
  "workspace.dependencies.inspect",
  "workspace.dependencies.install",
  "git.remotes.manage",
  "git.project.import",
  "git.publish",
  "git.pull",
  "mobile.install",
  "panel.inspect",
  "push.send",
  "context.clone",
  "subagents.create",
  "context.relationships.record",
  "context.materialize",
  "automations.control",
  "workspace.configure",
  "workspace-units.publish",
  "workspace-units.manage",
  "automations.register",
  "workspace-panels.manage",
]);

const SHARING = new Set<HostSemanticCapability>([
  "external.open",
  "git.remotes.manage",
  "git.publish",
  "push.send",
  "webhooks.manage",
]);

export function receiverAuthorityPolicy(
  capability: string,
  dynamic?: {
    domain: string;
    substanceKind?: import("../approvals.js").OperationSubstance["kind"];
  }
): ReceiverAuthorityPolicy {
  if (capability.startsWith("workspace-service:")) {
    const requiresSubstance = dynamic?.domain === "sharing";
    return {
      agentScope: "offer",
      irreversible: false,
      missionGrant: true,
      requiresSubstance,
      substanceKind: dynamic?.substanceKind ?? null,
    };
  }
  const typed = capability as HostSemanticCapability;
  const irreversible = IRREVERSIBLE.has(typed);
  const agentScope = AGENT_SCOPE_OFFERABLE.has(typed) && !irreversible ? "offer" : "never";
  return {
    agentScope,
    irreversible,
    missionGrant: !irreversible,
    requiresSubstance: irreversible || SHARING.has(typed),
    substanceKind: irreversible
      ? "deletion"
      : typed === "git.publish"
        ? "change-set"
        : typed === "push.send"
          ? "send"
          : SHARING.has(typed)
            ? "custom"
            : null,
  };
}

export function standingAgentScopeEligible(input: {
  capability: string;
  tier: "open" | "gated" | "critical";
  policy: ReceiverAuthorityPolicy;
  domain?: string;
  priorInteractiveApprovals: number;
}): boolean {
  if (input.tier !== "gated" || input.policy.agentScope !== "offer" || input.policy.irreversible) {
    return false;
  }
  const domain = input.domain ?? capabilityDomain(input.capability)?.domain;
  const needsHistory =
    domain === "sharing" ||
    domain === "accounts" ||
    NETWORK_EGRESS.has(input.capability as HostSemanticCapability);
  return !needsHistory || input.priorInteractiveApprovals >= 2;
}
