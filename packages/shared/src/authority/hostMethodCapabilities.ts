import { METHOD_TIERS, type ReviewedHostMethod } from "./tierTable.js";

type PromptableHostMethod = {
  [Method in ReviewedHostMethod]: (typeof METHOD_TIERS)[Method]["tier"] extends "open"
    ? never
    : Method;
}[ReviewedHostMethod];

/** Open transport methods whose exact, state-derived effect is a separately
 * reviewed prepared leaf. Keeping this list explicit prevents an arbitrary open
 * method from acquiring manifest authority merely by appearing in a group. */
const PREPARED_EFFECT_METHODS = [
  "corsApproval.authorize",
  "externalOpen.openExternal",
  "workerdInspector.getEndpoint",
] as const satisfies readonly ReviewedHostMethod[];

type PreparedEffectMethod = (typeof PREPARED_EFFECT_METHODS)[number];
type CapabilityMappedHostMethod = PromptableHostMethod | PreparedEffectMethod;

/**
 * Manifest-facing effects for the static host surface. Grouping is deliberate:
 * wire methods implementing the same user intent share one stable capability.
 * Workspace-defined services do not enter this table; their live declaration
 * supplies `workspace-service:<name>` dynamically.
 */
const GROUPS = {
  "adblock.manage": [
    "adblock.addCustomList",
    "adblock.rebuildEngine",
    "adblock.removeCustomList",
    "adblock.removeFromWhitelist",
    "adblock.resetStats",
    "adblock.resetStatsForPanel",
    "adblock.setEnabled",
    "adblock.setEnabledForPanel",
    "adblock.setListEnabled",
  ],
  "application.update": ["app.applyUpdate"],
  "workspace.build-cache.manage": ["app.clearBuildCache", "build.gc", "build.recompute"],
  "external.open": ["app.openExternal", "externalOpen.openExternal"],
  "security.audit.read": ["audit.query"],
  "browser-passwords.read": ["autofill.listNeverSaveOrigins", "autofill.listSavedPasswords"],
  "browser-passwords.manage": ["autofill.confirmSave", "autofill.removeNeverSaveOrigin"],
  "browser-passwords.delete": ["autofill.deleteSavedPassword"],
  "connections.approve": ["auth.grantConnection"],
  "agent.credentials.manage": ["auth.mintAgentCredential", "auth.revokeAgentCredential"],
  "workspace.storage.delete": ["blobstore.delete"],
  "workspace.storage.materialize": ["blobstore.materializeTree"],
  "extensions.diagnose": ["build.doctorExtension"],
  "workspace.dependencies.inspect": ["build.getBuildNpm"],
  "network.response.read": ["corsApproval.authorize"],
  "content.trust.policy.manage": ["contentTrust.addPolicy", "contentTrust.revoke"],
  "content.trust.vouch": ["contentTrust.vouch"],
  "credentials.audit.read": ["credentials.audit", "credentials.inspectStoredCredentials"],
  "accounts.connect": [
    "credentials.cancelOAuth",
    "credentials.completeCapture",
    "credentials.connect",
    "credentials.forwardOAuthCallback",
    "credentials.requestCredentialInput",
    "credentials.storeCredential",
  ],
  "account-providers.configure": ["credentials.configureClient"],
  "account-providers.delete": ["credentials.deleteClientConfig"],
  "credential.use": [
    "credentials.proxyFetch",
    "credentials.proxyGitHttp",
    "credentials.resolveCredential",
  ],
  "accounts.disconnect": ["credentials.revokeCredential"],
  "code-runner.reset": ["eval.reset"],
  "extensions.reload": ["extensions.reload"],
  "workspace.gateway.access": ["gateway.fetch"],
  "workspace.dependencies.install": ["gitInterop.completeWorkspaceDependencies"],
  "git.remotes.manage": [
    "gitInterop.createDisposableRemote",
    "gitInterop.detachUpstream",
    "gitInterop.removeDisposableRemote",
    "gitInterop.removeSharedRemote",
    "gitInterop.removeUpstream",
    "gitInterop.setAutoPush",
    "gitInterop.setSharedRemote",
    "gitInterop.setUpstream",
  ],
  "git.project.import": ["gitInterop.importProject"],
  "git.publish": [
    "gitInterop.publishRepo",
    "gitInterop.publishToDisposableRemote",
    "gitInterop.pushDisposableRemote",
    "gitInterop.pushUpstream",
  ],
  "git.pull": ["gitInterop.pullUpstream"],
  "governance.read": ["governance.list"],
  "application.shutdown": ["hostLifecycle.shutdown"],
  "workspace.members.manage": [
    "hubControl.addWorkspaceMember",
    "hubControl.inviteUser",
    "hubControl.setRole",
  ],
  "workspaces.create": ["hubControl.createWorkspace", "hubControl.ensureEphemeralWorkspace"],
  "workspaces.delete": ["hubControl.deleteWorkspace"],
  "account.profile.read": ["hubControl.getProfile"],
  "devices.read": ["hubControl.listDevices"],
  "presence.read": ["hubControl.listUserPresence"],
  "workspace.members.read": ["hubControl.listWorkspaceMembers"],
  "workspaces.read": ["hubControl.listWorkspaces"],
  "devices.pair": ["hubControl.pairDevice"],
  "workspace.members.remove": ["hubControl.removeWorkspaceMember"],
  "devices.revoke": ["hubControl.revokeDevice"],
  "users.revoke": ["hubControl.revokeUser"],
  "workspaces.open": ["hubControl.routeWorkspace"],
  "account.profile.update": ["hubControl.updateProfile"],
  "missions.approve": ["mission.approve"],
  "missions.edit": ["mission.createDraft", "mission.edit"],
  "missions.run": ["mission.finishSession", "mission.startSession"],
  "missions.pause": ["mission.pause", "mission.resume"],
  "missions.retire": ["mission.retire"],
  "panel.inspect": [
    "panelCdp.getCdpEndpoint",
    "panelCdp.hostProvider.close",
    "panelCdp.hostProvider.open",
    "panelCdp.hostProvider.send",
  ],
  "permissions.read": ["permissions.list"],
  "permissions.revoke": ["permissions.revoke"],
  "mobile.devices.read": ["phoneProvisioning.devices", "phoneProvisioning.providers"],
  "mobile.install": ["phoneProvisioning.install"],
  "mobile.pair": ["phoneProvisioning.openPairing"],
  "panel.presence.read": ["presence.getPanelActiveOwner"],
  "panel.presence.update": ["presence.markPanelActive", "presence.markPanelsOwned"],
  "push.manage": ["push.listRegistrations", "push.register", "push.unregister"],
  "push.send": ["push.send"],
  "remote-client.clear": ["remoteCred.clear"],
  "remote-client.read": ["remoteCred.getCurrent"],
  "remote-client.connect": ["remoteCred.pair", "remoteCred.reconnectNow", "remoteCred.relaunch"],
  "context.clone": ["runtime.cloneContext"],
  "subagents.create": ["runtime.createSubagentContext"],
  "context.relationships.record": ["runtime.recordContextEdge"],
  "server-logs.read": ["serverLog.query", "serverLog.stats", "serverLog.tail"],
  "settings.read": ["settings.getData"],
  "approvals.block": ["shellApproval.blockCapability"],
  "approvals.read": ["shellApproval.listPending", "userlandApproval.list"],
  "approvals.decide": [
    "shellApproval.resolve",
    "shellApproval.resolveBootstrap",
    "shellApproval.resolveExternalAgent",
    "shellApproval.resolveExternalAgentByRequest",
    "shellApproval.resolveUserland",
    "userlandApproval.settleExternal",
  ],
  "protected-input.submit": [
    "shellApproval.submitClientConfig",
    "shellApproval.submitCredentialInput",
    "shellApproval.submitSecretInput",
  ],
  "user-approval.request": [
    "userlandApproval.request",
    "userlandApproval.requestAs",
    "userlandApproval.requestExternal",
    "userlandApproval.requestSecretInput",
    "userlandApproval.requestSecretInputAs",
  ],
  "user-approval.revoke": ["userlandApproval.revoke"],
  "webhooks.manage": [
    "webhookIngress.createSubscription",
    "webhookIngress.listSubscriptions",
    "webhookIngress.revokeSubscription",
    "webhookIngress.rotateSecret",
  ],
  "runtime.inspect": ["workerdInspector.getEndpoint"],
  "context.materialize": ["workspace.ensureContextFolder"],
  "automations.control": [
    "workspace.heartbeats.pause",
    "workspace.heartbeats.resume",
    "workspace.heartbeats.runNow",
  ],
  "workspace-host.manage": [
    "workspace.hostTargets.beginLaunch",
    "workspace.hostTargets.cancelLaunchSession",
    "workspace.hostTargets.clearSelection",
    "workspace.hostTargets.getLaunchSession",
    "workspace.hostTargets.getSelection",
    "workspace.hostTargets.launch",
    "workspace.hostTargets.list",
    "workspace.hostTargets.preparePinnedRef",
    "workspace.hostTargets.resolveLaunchSessionApproval",
    "workspace.hostTargets.setSelection",
    "workspace.hostTargets.versions",
  ],
  "workspace.configure": ["workspace.setConfigField", "workspace.setInitPanels"],
  "workspace-units.publish": ["workspace.units.bakeAppDist"],
  "workspace-units.manage": ["workspace.units.restart", "workspace.units.rollback"],
  "automations.register": ["workspace-state.heartbeatRegister", "workspace-state.heartbeatRemove"],
  "workspace-panels.manage": [
    "workspace-state.panel.incrementAccess",
    "workspace-state.panel.index",
    "workspace-state.panel.rebuildIndex",
    "workspace-state.panel.updateTitle",
    "workspace-state.slot.close",
    "workspace-state.slot.commitPreparedNavigation",
    "workspace-state.slot.create",
    "workspace-state.slot.move",
    "workspace-state.slot.setParent",
    "workspace-state.slot.setPosition",
    "workspace-state.slot.updateCurrentStateArgs",
  ],
} as const satisfies Record<string, readonly CapabilityMappedHostMethod[]>;

type AssignedMethod = (typeof GROUPS)[keyof typeof GROUPS][number];
type MissingMethod = Exclude<PromptableHostMethod, AssignedMethod>;
type ExtraMethod = Exclude<AssignedMethod, CapabilityMappedHostMethod>;
const COMPLETE: [MissingMethod, ExtraMethod] extends [never, never] ? true : never = true;
void COMPLETE;

const METHOD_CAPABILITIES = new Map<CapabilityMappedHostMethod, string>();
for (const [capability, methods] of Object.entries(GROUPS)) {
  for (const method of methods) {
    if (METHOD_CAPABILITIES.has(method)) {
      throw new Error(`Host method ${method} has more than one semantic capability`);
    }
    METHOD_CAPABILITIES.set(method, capability);
  }
}

export function hostMethodCapability(method: string): string | null {
  return METHOD_CAPABILITIES.get(method as CapabilityMappedHostMethod) ?? null;
}

export function hostCapabilityMethods(capability: string): readonly string[] {
  return GROUPS[capability as keyof typeof GROUPS] ?? [];
}

export type HostSemanticCapability = keyof typeof GROUPS;
