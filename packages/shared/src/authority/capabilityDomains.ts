import type { HostSemanticCapability } from "./hostCapabilityPresentations.js";

export const AUTHORITY_DOMAINS = {
  files: {
    label: "Your files & work",
    description: "Documents, code, and project content in your workspace",
  },
  sharing: {
    label: "Publishing & sending",
    description: "Anything that leaves your workspace: publishing, sending, posting",
  },
  accounts: {
    label: "Accounts & sign-ins",
    description: "Connected accounts, passwords, and credentials",
  },
  web: {
    label: "The web",
    description: "Browsing data, websites, and downloads",
  },
  automation: {
    label: "Apps & automation",
    description: "Installing, running, and scheduling apps and agents",
  },
  people: {
    label: "People & devices",
    description: "Workspace members, presence, and paired devices",
  },
  computer: {
    label: "This computer",
    description: "The Vibestudio application and the machine it runs on",
  },
  safety: {
    label: "Safety controls",
    description: "Approvals, permissions, and audit — the controls themselves",
  },
} as const;

export const AUTHORITY_VERBS = {
  see: { label: "See" },
  act: { label: "Do" },
  manage: { label: "Manage" },
} as const;

export type AuthorityDomainId = keyof typeof AUTHORITY_DOMAINS;
export type AuthorityVerb = keyof typeof AUTHORITY_VERBS;
export interface CapabilityDomain {
  domain: AuthorityDomainId;
  verb: AuthorityVerb;
}

/**
 * The reviewed capability census. This is presentation-only security metadata:
 * grants never match on a domain or verb. A new promptable host capability does
 * not compile until its user-facing category has been reviewed here.
 */
export const CAPABILITY_DOMAINS = {
  "adblock.manage": { domain: "web", verb: "manage" },
  "application.update": { domain: "computer", verb: "act" },
  "browser-data.read": { domain: "web", verb: "see" },
  "browser-data.write": { domain: "web", verb: "act" },
  "browser-data.delete": { domain: "web", verb: "act" },
  "workspace.build-cache.manage": { domain: "automation", verb: "act" },
  "external.open": { domain: "sharing", verb: "act" },
  "security.audit.read": { domain: "safety", verb: "see" },
  "browser-passwords.read": { domain: "accounts", verb: "see" },
  "browser-passwords.manage": { domain: "accounts", verb: "manage" },
  "browser-passwords.delete": { domain: "accounts", verb: "act" },
  "browser-form-fill.manage": { domain: "accounts", verb: "act" },
  "connections.approve": { domain: "computer", verb: "manage" },
  "agent.credentials.manage": { domain: "accounts", verb: "manage" },
  "workspace.storage.delete": { domain: "files", verb: "act" },
  "workspace.storage.materialize": { domain: "files", verb: "act" },
  "extensions.diagnose": { domain: "computer", verb: "see" },
  "workspace.dependencies.inspect": { domain: "automation", verb: "see" },
  "network.response.read": { domain: "web", verb: "see" },
  "content.trust.policy.manage": { domain: "safety", verb: "manage" },
  "content.trust.vouch": { domain: "safety", verb: "manage" },
  "credentials.audit.read": { domain: "safety", verb: "see" },
  "accounts.connect": { domain: "accounts", verb: "manage" },
  "account-providers.configure": { domain: "accounts", verb: "manage" },
  "account-providers.delete": { domain: "accounts", verb: "manage" },
  "credential.use": { domain: "accounts", verb: "act" },
  "accounts.disconnect": { domain: "accounts", verb: "manage" },
  "code-runner.reset": { domain: "automation", verb: "act" },
  "runtime.code-execution.manage": { domain: "automation", verb: "manage" },
  "workspace.runtime-state.manage": { domain: "automation", verb: "manage" },
  "workspace.graph.delete": { domain: "files", verb: "act" },
  "extensions.reload": { domain: "computer", verb: "act" },
  "workspace.gateway.access": { domain: "web", verb: "see" },
  "workspace.dependencies.install": { domain: "automation", verb: "act" },
  "git.remotes.manage": { domain: "sharing", verb: "manage" },
  "git.project.import": { domain: "files", verb: "act" },
  "git.publish": { domain: "sharing", verb: "act" },
  "git.pull": { domain: "files", verb: "act" },
  "governance.read": { domain: "safety", verb: "see" },
  "application.shutdown": { domain: "computer", verb: "act" },
  "workspace.members.manage": { domain: "people", verb: "manage" },
  "channel.admin": { domain: "people", verb: "manage" },
  "channel.archive": { domain: "people", verb: "manage" },
  "workspaces.create": { domain: "automation", verb: "act" },
  "workspaces.delete": { domain: "automation", verb: "act" },
  "account.profile.read": { domain: "accounts", verb: "see" },
  "devices.read": { domain: "people", verb: "see" },
  "presence.read": { domain: "people", verb: "see" },
  "workspace.members.read": { domain: "people", verb: "see" },
  "workspaces.read": { domain: "files", verb: "see" },
  "devices.pair": { domain: "people", verb: "manage" },
  "workspace.members.remove": { domain: "people", verb: "manage" },
  "devices.revoke": { domain: "people", verb: "manage" },
  "users.revoke": { domain: "people", verb: "manage" },
  "workspaces.open": { domain: "files", verb: "act" },
  "account.profile.update": { domain: "accounts", verb: "act" },
  "missions.edit": { domain: "safety", verb: "manage" },
  "missions.run": { domain: "safety", verb: "manage" },
  "missions.pause": { domain: "safety", verb: "manage" },
  "missions.retire": { domain: "safety", verb: "manage" },
  "panel.inspect": { domain: "computer", verb: "see" },
  "panel.navigate": { domain: "automation", verb: "act" },
  "permissions.read": { domain: "safety", verb: "manage" },
  "permissions.revoke": { domain: "safety", verb: "manage" },
  "mobile.devices.read": { domain: "people", verb: "see" },
  "mobile.install": { domain: "people", verb: "act" },
  "mobile.pair": { domain: "people", verb: "manage" },
  "panel.presence.read": { domain: "people", verb: "see" },
  "panel.presence.update": { domain: "people", verb: "act" },
  "push.manage": { domain: "people", verb: "manage" },
  "push.send": { domain: "sharing", verb: "act" },
  "remote-client.clear": { domain: "people", verb: "manage" },
  "remote-client.read": { domain: "people", verb: "see" },
  "remote-client.connect": { domain: "people", verb: "manage" },
  "context.clone": { domain: "files", verb: "act" },
  "subagents.create": { domain: "automation", verb: "act" },
  "context.relationships.record": { domain: "files", verb: "act" },
  "server-logs.read": { domain: "computer", verb: "see" },
  "settings.read": { domain: "computer", verb: "see" },
  "approvals.read": { domain: "safety", verb: "manage" },
  "approvals.decide": { domain: "safety", verb: "manage" },
  "protected-input.submit": { domain: "accounts", verb: "act" },
  "user-approval.request": { domain: "safety", verb: "act" },
  "user-approval.revoke": { domain: "safety", verb: "manage" },
  "webhooks.manage": { domain: "sharing", verb: "manage" },
  "runtime.inspect": { domain: "computer", verb: "see" },
  "context.materialize": { domain: "files", verb: "act" },
  "workspace.files.read": { domain: "files", verb: "see" },
  "workspace.files.write": { domain: "files", verb: "act" },
  "workspace.history.write": { domain: "files", verb: "act" },
  "process.execute": { domain: "computer", verb: "act" },
  "network.fetch": { domain: "web", verb: "act" },
  "service:workers.resolveService": { domain: "automation", verb: "act" },
  "external-browser-open": { domain: "sharing", verb: "act" },
  "workspace-main-advance": { domain: "sharing", verb: "act" },
  "workspace-repo-delete": { domain: "files", verb: "act" },
  "workerd.inspector": { domain: "computer", verb: "see" },
  "automations.control": { domain: "automation", verb: "act" },
  "workspace-host.manage": { domain: "computer", verb: "manage" },
  "workspace.configure": { domain: "automation", verb: "manage" },
  "workspace-units.publish": { domain: "automation", verb: "act" },
  "workspace-units.manage": { domain: "automation", verb: "manage" },
  "automations.register": { domain: "automation", verb: "manage" },
  "workspace-panels.manage": { domain: "automation", verb: "manage" },
  "channel.members.remove": { domain: "people", verb: "manage" },
  clipboard: { domain: "computer", verb: "act" },
  "context.boundary": { domain: "files", verb: "act" },
  "incoming-pair-links": { domain: "people", verb: "act" },
  "internal-model-runtime.use": { domain: "automation", verb: "act" },
  keychain: { domain: "accounts", verb: "manage" },
  "native-menus": { domain: "computer", verb: "act" },
  notifications: { domain: "computer", verb: "act" },
  "open-external": { domain: "sharing", verb: "act" },
  "panel-hosting": { domain: "automation", verb: "manage" },
  "window-management": { domain: "computer", verb: "manage" },
} as const satisfies Record<HostSemanticCapability, CapabilityDomain> &
  Record<string, CapabilityDomain>;

export function capabilityDomain(capability: string): CapabilityDomain | null {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_DOMAINS, capability)
    ? CAPABILITY_DOMAINS[capability as keyof typeof CAPABILITY_DOMAINS]
    : null;
}

export function isSafetyCapability(capability: string): boolean {
  return capabilityDomain(capability)?.domain === "safety";
}
