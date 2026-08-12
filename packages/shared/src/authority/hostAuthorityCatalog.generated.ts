// Generated from live host service schemas by scripts/generate-host-authority-catalog.mjs.
// Do not edit: authority belongs on the MethodSchema declaration.

import type { CapabilityPresentation } from "../authorityPresentation.js";
import type { HostResidencyPolicy, MethodTierPolicy } from "../serviceAuthority.js";

export interface GeneratedHostAuthorityMethod {
  tier: MethodTierPolicy & HostResidencyPolicy;
  capability: string | null;
  presentation: CapabilityPresentation | null;
}

export const HOST_AUTHORITY_METHODS = {
  "account.getProfile": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "account.read",
      rationale:
        "P-discovery: ordinary workspace participant rendering; principal and workspace admission still apply",
    },
    capability: null,
    presentation: null,
  },
  "account.isMember": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "account.control",
      rationale:
        "P-discovery: ordinary workspace membership rendering; principal and workspace admission still apply",
    },
    capability: null,
    presentation: null,
  },
  "account.listWorkspaceMembers": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "account.read",
      rationale:
        "P-discovery: ordinary workspace participant rendering; principal and workspace admission still apply",
    },
    capability: null,
    presentation: null,
  },
  "account.resolveProfiles": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "account.read",
      rationale:
        "P-discovery: ordinary workspace participant rendering; principal and workspace admission still apply",
    },
    capability: null,
    presentation: null,
  },
  "adblock.addCustomList": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Add a custom ad-blocking list",
      action: "add a custom ad-blocking list",
      description: "Allows {requesterKind} to add a custom ad-blocking list.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "adblock.addToWhitelist": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "adblock.getConfig": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "adblock.getPanelUrl": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "adblock.getStats": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "adblock.getStatsForPanel": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "adblock.isActive": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "adblock.isEnabledForPanel": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "adblock.rebuildEngine": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Refresh ad blocking",
      action: "refresh ad blocking",
      description: "Allows {requesterKind} to refresh ad blocking.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "adblock.removeCustomList": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.retire",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Remove a custom ad-blocking list",
      action: "remove a custom ad-blocking list",
      description: "Allows {requesterKind} to remove a custom ad-blocking list.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "adblock.removeFromWhitelist": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.retire",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Resume blocking ads on a website",
      action: "resume blocking ads on a website",
      description: "Allows {requesterKind} to resume blocking ads on a website.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "adblock.resetStats": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Clear ad-blocking statistics",
      action: "clear ad-blocking statistics",
      description: "Allows {requesterKind} to clear ad-blocking statistics.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "adblock.resetStatsForPanel": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Clear a panel's ad-blocking statistics",
      action: "clear a panel's ad-blocking statistics",
      description: "Allows {requesterKind} to clear a panel's ad-blocking statistics.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "adblock.setEnabled": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Turn ad blocking on or off",
      action: "turn ad blocking on or off",
      description: "Allows {requesterKind} to turn ad blocking on or off.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "adblock.setEnabledForPanel": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Change ad blocking for a panel",
      action: "change ad blocking for a panel",
      description: "Allows {requesterKind} to change ad blocking for a panel.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "adblock.setListEnabled": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "adblock.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "adblock.manage",
    presentation: {
      title: "Turn an ad-blocking list on or off",
      action: "turn an ad-blocking list on or off",
      description: "Allows {requesterKind} to turn an ad-blocking list on or off.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "app.applyUpdate": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "app.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "application.update",
    presentation: {
      title: "Install an application update",
      action: "install an application update",
      description: "Allows {requesterKind} to install an application update.",
      group: "host",
      authorityCategory: {
        domain: "computer",
        verb: "act",
      },
    },
  },
  "app.clearBuildCache": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "app.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.build-cache.manage",
    presentation: {
      title: "Clear cached build files",
      action: "clear cached build files",
      description: "Allows {requesterKind} to clear cached build files.",
      group: "host",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "app.getInfo": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "app.getShellPages": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "app.getSystemTheme": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "app.listPendingUpdates": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "app.openDevTools": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.create",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "app.openExternal": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "app.create",
      rationale:
        "G1: external-system effect or listening surface; §2 default {code, session} family",
    },
    capability: "external.open",
    presentation: {
      title: "Open a link in another application",
      action: "open a link in another application",
      description: "Allows {requesterKind} to open a link in another application.",
      group: "host",
      authorityCategory: {
        domain: "sharing",
        verb: "act",
      },
    },
  },
  "app.openShellSurface": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.create",
      rationale:
        "Open bias: opens bounded first-party shell chrome without changing the managed state; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "app.openWorkspacePath": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.create",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "app.setThemeMode": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "app.mutate",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "attachedHosts.attachClient": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "attachedHosts.transport",
      rationale:
        "Opaque attached-host transport; authority is enforced by exact signed session envelopes.",
    },
    capability: null,
    presentation: null,
  },
  "attachedHosts.bootstrapConfirm": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "attachedHosts.identity",
      rationale:
        "Mutually signed exact-generation bootstrap establishes an authenticated host identity.",
    },
    capability: null,
    presentation: null,
  },
  "attachedHosts.bootstrapExchange": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "attachedHosts.identity",
      rationale:
        "Mutually signed exact-generation bootstrap establishes an authenticated host identity.",
    },
    capability: null,
    presentation: null,
  },
  "attachedHosts.close": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "attachedHosts.control",
      rationale: "Closes one exact authenticated transport route and its pending work.",
    },
    capability: null,
    presentation: null,
  },
  "attachedHosts.invoke": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "attachedHosts.transport",
      rationale:
        "Opaque attached-host transport; authority is enforced by exact signed session envelopes.",
    },
    capability: null,
    presentation: null,
  },
  "attachedHosts.invokeAttached": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "attachedHosts.transport",
      rationale:
        "Opaque attached-host transport; authority is enforced by exact signed session envelopes.",
    },
    capability: null,
    presentation: null,
  },
  "attachedHosts.listApprovalAudit": {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "attachedHosts.audit",
      rationale: "Bounded immutable approval receipts expose transport audit state.",
    },
    capability: null,
    presentation: null,
  },
  "attachedHosts.presentApproval": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "attachedHosts.approval",
      rationale: "The canonical parent approval queue settles a child-signed authority challenge.",
    },
    capability: null,
    presentation: null,
  },
  "audit.query": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "observability",
      family: "audit.read",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "security.audit.read",
    presentation: {
      title: "View the security activity log",
      action: "view the security activity log",
      description: "Allows {requesterKind} to view the security activity log.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "see",
      },
    },
  },
  "auth.getConnectionInfo": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "auth.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "auth.grantConnection": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "auth.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "connections.approve",
    presentation: {
      title: "Allow a new client connection",
      action: "allow a new client connection",
      description: "Allows {requesterKind} to allow a new client connection.",
      group: "accounts",
      authorityCategory: {
        domain: "computer",
        verb: "manage",
      },
    },
  },
  "auth.mintAgentCredential": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "auth.control",
      rationale:
        "Delegating a caller-owned live session to an external agent is the credential-bearing consequence of the reviewed subagents.create operation; the handler independently binds the credential to that exact owned session and the authenticated agent acts on behalf of its owning user.",
    },
    capability: "subagents.create",
    presentation: {
      title: "Launch an external subagent",
      action: "launch an external subagent",
      description:
        "Allows {requesterKind} to launch an external subagent that can act on your behalf in this workspace.",
      group: "automation",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "auth.revokeAgentCredential": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "auth.retire",
      rationale:
        "Revoking an exact caller-owned agent credential only removes authority and is required lifecycle cleanup; the handler rejects foreign session ownership.",
    },
    capability: null,
    presentation: null,
  },
  "authority.awaitDecision": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "authority.control",
      rationale:
        "An acquisition owner may wait on its existing human-decision lifecycle; the wait grants nothing",
    },
    capability: null,
    presentation: null,
  },
  "authority.preflight": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "authority.control",
      rationale:
        "Pure authority inspection; it neither prompts, mints, consumes, nor invokes a handler",
    },
    capability: null,
    presentation: null,
  },
  "autofill.confirmFormFill": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "autofill.control",
      rationale:
        "Stores personal form-fill values only after an explicit post-submission browser prompt.",
    },
    capability: "browser-form-fill.manage",
    presentation: {
      title: "Save form-fill values",
      action: "save personal form-fill values",
      description:
        "Allows {requesterKind} to save the personal form values shown in a browser submission prompt.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
  },
  "autofill.confirmSave": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "autofill.control",
      rationale: "Stores or suppresses a credential only after an explicit browser save prompt.",
    },
    capability: "browser-passwords.manage",
    presentation: {
      title: "Save this password choice",
      action: "save this password choice",
      description:
        "Allows {requesterKind} to save a password or remember that password saving is disabled for this site.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "blobstore.delete": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "protected-write",
      family: "blobstore.retire",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.storage.delete",
    presentation: {
      title: "Delete stored workspace data",
      action: "delete stored workspace data",
      description: "Allows {requesterKind} to delete stored workspace data.",
      group: "files",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
  },
  "blobstore.diffTrees": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "blobstore.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.getBase64": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.getRange": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.getRangeBytes": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.getText": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.getTree": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.grep": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "blobstore.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.has": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.list": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.listTree": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.materializeTree": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "protected-write",
      family: "blobstore.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.storage.materialize",
    presentation: {
      title: "Restore a stored folder tree",
      action: "restore a stored folder tree",
      description: "Allows {requesterKind} to restore a stored folder tree.",
      group: "files",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
  },
  "blobstore.putBase64": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "blobstore.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.putText": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "blobstore.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.putTree": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "blobstore.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.readFileAtTree": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "blobstore.stat": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "blobstore.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "browserEnvironment.cancelDownload": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.retire",
      rationale:
        "Host control proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    capability: "service:browserEnvironment.cancelDownload",
    presentation: {
      title: "Cancel browser downloads",
      action: "cancel browser downloads",
      description: "Allows {requesterKind} to cancel active browser downloads.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "browserEnvironment.cancelImportRead": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.retire",
      rationale: "Cancels a streamed browser-profile import read; gated by authority principals.",
    },
    capability: "service:browserEnvironment.cancelImportRead",
    presentation: {
      title: "Cancel browser data reading",
      action: "cancel browser data reading",
      description: "Allows {requesterKind} to cancel an active browser data import read.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "browserEnvironment.flushCookieProjection": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host maintenance proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    capability: "service:browserEnvironment.flushCookieProjection",
    presentation: {
      title: "Synchronize website cookies",
      action: "synchronize website cookies",
      description: "Allows {requesterKind} to reconcile website cookies with the browser host.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "browserEnvironment.getCookieProjectionDiagnostics": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Host diagnostics proceed directly; installed code requires the method's gated browser-environment capability.",
    },
    capability: "service:browserEnvironment.getCookieProjectionDiagnostics",
    presentation: {
      title: "View cookie synchronization diagnostics",
      action: "view cookie synchronization diagnostics",
      description: "Allows {requesterKind} to inspect website cookie synchronization status.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "browserEnvironment.getImportHost": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Host/code read of the browser-import host descriptor; per-method authority principals gate callers.",
    },
    capability: "service:browserEnvironment.getImportHost",
    presentation: {
      title: "Access browser import details",
      action: "access browser import details",
      description: "Allows {requesterKind} to inspect the available browser import provider.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "browserEnvironment.listDownloads": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Host reads proceed directly; installed code requires the method's gated browser-environment capability.",
    },
    capability: "service:browserEnvironment.listDownloads",
    presentation: {
      title: "View browser downloads",
      action: "view browser downloads",
      description: "Allows {requesterKind} to view current and recent browser downloads.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "browserEnvironment.listImportOpenTabs": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Reads open tabs from an external browser profile for import; gated by authority principals.",
    },
    capability: "service:browserEnvironment.listImportOpenTabs",
    presentation: {
      title: "View browser tabs available to import",
      action: "view browser tabs available to import",
      description: "Allows {requesterKind} to view browser tabs available for import.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "browserEnvironment.listImportSources": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Enumerates importable external browser profiles; read-only discovery gated by authority principals.",
    },
    capability: "service:browserEnvironment.listImportSources",
    presentation: {
      title: "Find browser profiles to import",
      action: "find browser profiles to import",
      description: "Allows {requesterKind} to find browser profiles available for import.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "browserEnvironment.nextImportFrame": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale: "Continues a streamed browser-profile import read; gated by authority principals.",
    },
    capability: "service:browserEnvironment.nextImportFrame",
    presentation: {
      title: "Continue reading browser data",
      action: "continue reading browser data for import",
      description: "Allows {requesterKind} to continue a browser data import read.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "browserEnvironment.openDownload": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.create",
      rationale:
        "Host open proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    capability: "service:browserEnvironment.openDownload",
    presentation: {
      title: "Open downloaded files",
      action: "open downloaded files",
      description: "Allows {requesterKind} to open downloaded files on this computer.",
      group: "network",
      authorityCategory: {
        domain: "computer",
        verb: "act",
      },
    },
  },
  "browserEnvironment.pauseDownload": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host control proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    capability: "service:browserEnvironment.pauseDownload",
    presentation: {
      title: "Pause browser downloads",
      action: "pause browser downloads",
      description: "Allows {requesterKind} to pause active browser downloads.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "browserEnvironment.previewImportSource": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Read-only preview of an external browser profile import; gated by authority principals.",
    },
    capability: "service:browserEnvironment.previewImportSource",
    presentation: {
      title: "Preview browser data for import",
      action: "preview browser data for import",
      description: "Allows {requesterKind} to preview browser data available for import.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "browserEnvironment.resumeDownload": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host control proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    capability: "service:browserEnvironment.resumeDownload",
    presentation: {
      title: "Resume browser downloads",
      action: "resume browser downloads",
      description: "Allows {requesterKind} to resume paused browser downloads.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "manage",
      },
    },
  },
  "browserEnvironment.revealDownload": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host reveal proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    capability: "service:browserEnvironment.revealDownload",
    presentation: {
      title: "Show downloaded files",
      action: "show downloaded files on this computer",
      description: "Allows {requesterKind} to reveal downloaded files in the file manager.",
      group: "network",
      authorityCategory: {
        domain: "computer",
        verb: "act",
      },
    },
  },
  "browserEnvironment.startImportRead": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.create",
      rationale:
        "Starts a streamed read of an external browser profile for import; gated by authority principals.",
    },
    capability: "service:browserEnvironment.startImportRead",
    presentation: {
      title: "Read browser data for import",
      action: "read browser data for import",
      description: "Allows {requesterKind} to read browser data selected for import.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "browserPermissions.request": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "browserPermissions.control",
      rationale:
        "Verified-user browser permission prompt flow; the decision is stored as a user grant and code callers remain excluded.",
    },
    capability: null,
    presentation: null,
  },
  "browserPermissions.revoke": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "browserPermissions.retire",
      rationale:
        "Verified-user revocation of that user's exact-origin browser grants, driven by explicit shell UI.",
    },
    capability: null,
    presentation: null,
  },
  "browserPermissions.snapshot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "browserPermissions.control",
      rationale:
        "Verified-user read of that user's exact-origin browser grants; code and anonymous callers remain excluded.",
    },
    capability: null,
    presentation: null,
  },
  "build.gc": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "build.control",
      rationale:
        "G5: read-only host infrastructure diagnostics; §2 durable code identity or host approval plumbing",
    },
    capability: "workspace.build-cache.manage",
    presentation: {
      title: "Inspect build cache retention",
      action: "inspect build cache retention",
      description:
        "Allows {requesterKind} to inspect retained and unreferenced build files without removing them.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "build.getAboutPages": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only discovery of workspace-local launcher metadata",
    },
    capability: null,
    presentation: null,
  },
  "build.getBuild": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Workspace-local compilation into an immutable cache; no publication, install, or external acquisition",
    },
    capability: null,
    presentation: null,
  },
  "build.getBuildMetadata": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only inspection of an immutable local build record",
    },
    capability: null,
    presentation: null,
  },
  "build.getBuildNpm": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "G5: external package acquisition is gated; installed code and explicitly approved eval sessions share the reviewed code family",
    },
    capability: "workspace.dependencies.inspect",
    presentation: {
      title: "Inspect installed packages for an app, panel, worker, or extension",
      action: "inspect installed packages for an app, panel, worker, or extension",
      description:
        "Allows {requesterKind} to inspect installed packages for an app, panel, worker, or extension.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "build.getBuildReport": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Workspace-local compilation and diagnostics; no publication, install, or external acquisition",
    },
    capability: null,
    presentation: null,
  },
  "build.getEffectiveVersion": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only discovery of a content-derived local unit identity",
    },
    capability: null,
    presentation: null,
  },
  "build.getPanelMetadata": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only discovery of workspace-local panel metadata",
    },
    capability: null,
    presentation: null,
  },
  "build.getPerformanceProfile": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Bounded timing and size projection over the canonical workspace-local build path and immutable artifact cache.",
    },
    capability: null,
    presentation: null,
  },
  "build.hasUnit": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only lookup in the caller-visible workspace graph",
    },
    capability: null,
    presentation: null,
  },
  "build.inspectBuildProvenance": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only inspection of caller-visible local build provenance",
    },
    capability: null,
    presentation: null,
  },
  "build.inspectExecution": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Read-only diagnosis of an immutable execution identity, its owners, and reconstructibility",
    },
    capability: null,
    presentation: null,
  },
  "build.listRecentBuildEvents": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only diagnostics for workspace-local build activity",
    },
    capability: null,
    presentation: null,
  },
  "build.listSkills": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only discovery of caller-visible workspace skill packages",
    },
    capability: null,
    presentation: null,
  },
  "build.listUnits": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Read-only projection of declared workspace sources, immutable build identity, and reviewed authority",
    },
    capability: null,
    presentation: null,
  },
  "build.recompute": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "build.control",
      rationale:
        "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
    },
    capability: "workspace.build-cache.manage",
    presentation: {
      title: "Rebuild workspace apps, panels, workers, and extensions",
      action: "rebuild workspace apps, panels, workers, and extensions",
      description:
        "Allows {requesterKind} to rebuild workspace apps, panels, workers, and extensions.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "connectedClientTransport.invoke": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "connectedClientTransport.control",
      rationale:
        "Carries one authenticated RPC frame to an exact live client endpoint on the caller's account; endpoint policy remains at the receiving client.",
    },
    capability: "connected-client.transport",
    presentation: {
      title: "Use a connected client",
      action: "send an authenticated request to a connected client",
      description:
        "Allows {requesterKind} to communicate with an exact connected client on the current account.",
      group: "runtime",
      authorityCategory: {
        domain: "computer",
        verb: "manage",
      },
    },
  },
  "connectedClientTransport.list": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "connectedClientTransport.read",
      rationale:
        "Enumerates only live transport endpoints bound to the authenticated caller's account.",
    },
    capability: "connected-client.transport",
    presentation: {
      title: "Use a connected client",
      action: "send an authenticated request to a connected client",
      description:
        "Allows {requesterKind} to communicate with an exact connected client on the current account.",
      group: "runtime",
      authorityCategory: {
        domain: "computer",
        verb: "manage",
      },
    },
  },
  "contentTrust.addPolicy": {
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.control",
      rationale:
        "A future-content trust policy changes the authority meaning of content that has not yet been observed",
    },
    capability: "content.trust.policy.manage",
    presentation: {
      title: "Always trust matching outside content",
      action: "always trust matching outside content",
      description: "Allows {requesterKind} to always trust matching outside content.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "contentTrust.list": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.read",
      rationale: "Human governance read; sessions cannot inspect the workspace trust ledger",
    },
    capability: null,
    presentation: null,
  },
  "contentTrust.revoke": {
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.retire",
      rationale:
        "Revocation changes which external content may enter future internal-context sessions",
    },
    capability: "content.trust.policy.manage",
    presentation: {
      title: "Remove a content-trust decision",
      action: "remove a content-trust decision",
      description: "Allows {requesterKind} to remove a content-trust decision.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "contentTrust.status": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.control",
      rationale: "Human governance read of the one-way context-integrity cutover",
    },
    capability: null,
    presentation: null,
  },
  "contentTrust.vouch": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.control",
      rationale: "An exact content-addressed vouch changes future context classification",
    },
    capability: "content.trust.vouch",
    presentation: {
      title: "Trust this exact outside content",
      action: "trust this exact outside content",
      description: "Allows {requesterKind} to trust this exact outside content.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "contextIntegrity.explain": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "contextIntegrity.control",
      rationale:
        "A session may inspect bounded verified lineage for its own monotone ingestion latch",
    },
    capability: null,
    presentation: null,
  },
  "contextIntegrity.fact": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "contextIntegrity.control",
      rationale: "A session may inspect its own monotone ingestion latch",
    },
    capability: null,
    presentation: null,
  },
  "contextIntegrity.ingest": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "contextIntegrity.control",
      rationale:
        "A session may only tighten its own context classification through a registered chokepoint",
    },
    capability: null,
    presentation: null,
  },
  "corsApproval.authorize": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "corsApproval.control",
      rationale:
        "The transport is open to declared code; its exact target origin is a prepared gated network.response.read leaf",
    },
    capability: "network.response.read",
    presentation: {
      title: "Let workspace apps read website responses",
      action: "let workspace apps read website responses",
      description: "Allows {requesterKind} to let workspace apps read website responses.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "credentials.audit": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "credentials.audit.read",
    presentation: {
      title: "View connected-account activity",
      action: "view connected-account activity",
      description: "Allows {requesterKind} to view connected-account activity.",
      group: "credentials",
      authorityCategory: {
        domain: "safety",
        verb: "see",
      },
    },
  },
  "credentials.cancelOAuth": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "credentials.retire",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "accounts.connect",
    presentation: {
      title: "Cancel account sign-in",
      action: "cancel account sign-in",
      description: "Allows {requesterKind} to cancel account sign-in.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.completeCapture": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "accounts.connect",
    presentation: {
      title: "Save submitted account details",
      action: "save submitted account details",
      description: "Allows {requesterKind} to save submitted account details.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.configureClient": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale:
        "The method is itself a host-owned protected-input prompt; only the user's explicit form submission stores configuration",
    },
    capability: "account-providers.configure",
    presentation: {
      title: "Configure an account provider",
      action: "configure an account provider",
      description: "Allows {requesterKind} to configure an account provider.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.connect": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "credentials.create",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "accounts.connect",
    presentation: {
      title: "Connect an account",
      action: "connect an account",
      description: "Allows {requesterKind} to connect an account.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.deleteClientConfig": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "secret",
      family: "credentials.retire",
      rationale:
        "C1: destroys credential or client secret material; §2 default {code, session} family",
    },
    capability: "account-providers.delete",
    presentation: {
      title: "Delete account-provider settings",
      action: "delete account-provider settings",
      description: "Allows {requesterKind} to delete account-provider settings.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.forwardOAuthCallback": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "accounts.connect",
    presentation: {
      title: "Complete account sign-in",
      action: "complete account sign-in",
      description: "Allows {requesterKind} to complete account sign-in.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.getClientConfigStatus": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.read",
      rationale:
        "P-discovery: secret-free provider setup status used by onboarding; the config trust-scope check still applies",
    },
    capability: null,
    presentation: null,
  },
  "credentials.inspectStoredCredentials": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "credentials.read",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "credentials.audit.read",
    presentation: {
      title: "View which connected accounts are stored",
      action: "view which connected accounts are stored",
      description: "Allows {requesterKind} to view which connected accounts are stored.",
      group: "credentials",
      authorityCategory: {
        domain: "safety",
        verb: "see",
      },
    },
  },
  "credentials.listStoredCredentials": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.read",
      rationale:
        "Secret-free lifecycle projection used by the open model-availability catalog; credential inspection and use remain gated",
    },
    capability: null,
    presentation: null,
  },
  "credentials.proxyFetch": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale:
        "The transport exposes no response before the egress proxy authorizes exactly one concrete credential-use or network.response.read effect",
    },
    capability: null,
    presentation: null,
  },
  "credentials.proxyGitHttp": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale:
        "The transport exposes no Git response before the egress proxy authorizes anonymous network access or one concrete credential and remote",
    },
    capability: null,
    presentation: null,
  },
  "credentials.requestCredentialInput": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale:
        "The method is itself a host-owned protected-input prompt; only the user's explicit form submission stores a credential",
    },
    capability: "accounts.connect",
    presentation: {
      title: "Ask for account details",
      action: "ask for account details",
      description: "Allows {requesterKind} to ask for account details.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.resolveCredential": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.read",
      rationale:
        "Credential mediation exposes no credential before the handler authorizes the exact matched credential and use context",
    },
    capability: null,
    presentation: null,
  },
  "credentials.revokeCredential": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "secret",
      family: "credentials.retire",
      rationale:
        "C1: destroys credential or client secret material; §2 default {code, session} family",
    },
    capability: "accounts.disconnect",
    presentation: {
      title: "Disconnect an account",
      action: "disconnect an account",
      description: "Allows {requesterKind} to disconnect an account.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.storeCredential": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "accounts.connect",
    presentation: {
      title: "Save a connected account",
      action: "save a connected account",
      description: "Allows {requesterKind} to save a connected account.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
  },
  "credentials.summarizeStoredCredentials": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.control",
      rationale:
        "Bounded count/state aggregate contains no per-credential fields; detailed inspection and credential use remain gated",
    },
    capability: null,
    presentation: null,
  },
  "desktopEvents.watch": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "desktopEvents.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.attest": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Opaque nonce acknowledgement by an ordinarily paired child; caller identity and execution facts are host-derived",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.bindIsolatedManager": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Exact-generation binding of the already paired isolated management device before any client invite exists",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.claim": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Exact selected desktop reads only its addressed bounded launch manifest and opaque pairing invite",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.consumeAttestation": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Bound isolated management device consumes one opaque nonce receipt without credential or artifact disclosure",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.exited": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Selected desktop reduces effects by reporting exact owned-process exit and private-root cleanup",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.fail": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.control",
      rationale:
        "Selected desktop terminates one pending launch with a bounded diagnostic and no widened authority",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.launched": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.create",
      rationale:
        "Selected desktop reports an exact owned-process receipt; readiness still requires independent paired-child attestation",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.readArtifact": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.read",
      rationale:
        "Exact selected desktop reads one integrity-bound artifact chunk from its addressed pending launch",
    },
    capability: null,
    presentation: null,
  },
  "developmentClientExecutor.register": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "developmentClientExecutor.create",
      rationale:
        "Authenticated desktop refreshes an in-memory reviewed-executor lease bound to its verified runtime and user",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.beginBuild": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale: "Executes one previously attested exact build closure in its proven private root",
    },
    capability: "development.native.execute",
    presentation: {
      title: "Build exact workspace source",
      action: "build exact workspace source",
      description:
        "Allows {requesterKind} to install frozen dependencies and execute one reviewed build closure.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "developmentNative.checkpointTool": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Freezes and snapshots the exact already-owned native tool session",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.describeHost": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.discovery",
      rationale: "Reports the platform coordinate required to select a reviewed native recipe",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.describeTool": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.discovery",
      rationale: "Reports availability of one sealed native tool driver on this host",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.inspectBuild": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale: "Reads bounded status and output from one exact native build handle",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.inspectTool": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Reads ownership and process state for one exact native session handle",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.keepTool": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Acknowledges repair state without expanding the exact native session effects",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.listClientExecutors": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.discovery",
      rationale: "Returns explicit executor coordinates without launching native code",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.openTool": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Materializes and launches one exact sealed tool in a host-owned private root",
    },
    capability: "development.native.execute",
    presentation: {
      title: "Launch a native development tool",
      action: "launch a native development tool",
      description:
        "Allows {requesterKind} to run one reviewed tool in an exact private source tree.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "developmentNative.prepareBuild": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale:
        "Attests the exact host toolchain and semantic source plan without executing project code",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.readTerminal": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.terminal",
      rationale: "Reads bounded output from one exact host-owned terminal session",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.recoverTool": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Reconciles marker and process ownership for one exact native session handle",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.resizeTerminal": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.terminal",
      rationale: "Resizes one exact host-owned terminal session",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.retireBuild": {
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale: "Removes only the execution root proven by one exact retained run record",
    },
    capability: "development.native.build.retire",
    presentation: {
      title: "Retire a development build",
      action: "retire a development build",
      description:
        "Allows {requesterKind} to remove the private execution root proven by one exact run.",
      group: "runtime",
      authorityCategory: {
        domain: "computer",
        verb: "manage",
      },
    },
  },
  "developmentNative.retireTool": {
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale:
        "Retires only the private root and process proven by one exact native session handle",
    },
    capability: "development.native.session.retire",
    presentation: {
      title: "Retire a native development tool",
      action: "retire a native development tool",
      description:
        "Allows {requesterKind} to remove the proven process and private tree for one exact tool.",
      group: "runtime",
      authorityCategory: {
        domain: "computer",
        verb: "manage",
      },
    },
  },
  "developmentNative.stopBuild": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "development-native.build",
      rationale: "Stops only the process group owned by one exact build handle",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.stopTool": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.tool",
      rationale: "Stops only the process group proven by one exact native session handle",
    },
    capability: null,
    presentation: null,
  },
  "developmentNative.writeTerminal": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "native-effect",
      family: "development-native.terminal",
      rationale: "Writes bounded input to one exact host-owned terminal session",
    },
    capability: null,
    presentation: null,
  },
  "docs.describe": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "docs.control",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "docs.describeService": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "docs.control",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "docs.getSchema": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "docs.read",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "docs.listServices": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "docs.read",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "docs.listSurfaces": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "docs.read",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "docs.search": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "docs.control",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "durableWork.inspect": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "durableWork.read",
      rationale:
        "Payload-free bounded scheduler health and timing diagnostics; no work content or mutation is exposed",
    },
    capability: null,
    presentation: null,
  },
  "eval.cancel": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.retire",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "eval.deleteScopeValue": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.retire",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "eval.dispose": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.control",
      rationale:
        "Owned-resource release: the host admits disposal only when this caller declared the isolated EvalDO finite at its immutable first activation",
    },
    capability: null,
    presentation: null,
  },
  "eval.events": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.control",
      rationale: "Owner-scoped bounded read of durable eval lifecycle events",
    },
    capability: null,
    presentation: null,
  },
  "eval.get": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "eval.readScopeTextPage": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "eval.reset": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.control",
      rationale:
        "C3: irreversible destruction outside VCS protection; §2 default {code, session} family",
    },
    capability: "code-runner.reset",
    presentation: {
      title: "Reset the code runner",
      action: "reset the code runner",
      description: "Allows {requesterKind} to reset the code runner.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "eval.start": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "eval.create",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "evalEventIngress.publish": {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "evalEventIngress.mutate",
      rationale:
        "Host-internal observability ingress; exact EvalDO/run/owner session binding is re-derived by the receiver",
    },
    capability: null,
    presentation: null,
  },
  "evalExecutionRoots.retain": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "evalExecutionRoots.control",
      rationale:
        "Host-internal execution-retention ingress; exact EvalDO/run/session binding and immutable artifact identity are re-derived and verified",
    },
    capability: null,
    presentation: null,
  },
  "events.watch": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "events.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "extensions.emit": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    capability: null,
    presentation: null,
  },
  "extensions.fetchRequestBodyChunk": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    capability: null,
    presentation: null,
  },
  "extensions.fetchRequestBodyClose": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    capability: null,
    presentation: null,
  },
  "extensions.invoke": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Invocation is limited to an installed, approved extension and preserves the admitted caller and execution-session context; the extension's own sensitive operations remain authority-checked",
    },
    capability: null,
    presentation: null,
  },
  "extensions.invokeProvider": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Provider routing preserves the admitted caller and execution-session context; the selected provider's operation remains independently authority-checked",
    },
    capability: null,
    presentation: null,
  },
  "extensions.invokeStream": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Streaming invocation has the same installed-extension boundary and caller propagation as unary invocation",
    },
    capability: null,
    presentation: null,
  },
  "extensions.streamingMethods": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    capability: null,
    presentation: null,
  },
  "externalOpen.openExternal": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "externalOpen.create",
      rationale:
        "The transport is open; code callers receive one prepared gated external.open leaf scoped to the destination",
    },
    capability: "external.open",
    presentation: {
      title: "Open links in other applications",
      action: "open links in other applications",
      description: "Allows {requesterKind} to open links in other applications.",
      group: "network",
      authorityCategory: {
        domain: "sharing",
        verb: "act",
      },
    },
  },
  "fs.access": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.appendFile": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.chmod": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.copyFile": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.ensureMaterialized": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.exists": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.glob": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.grep": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.handleClose": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.handleRead": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.handleStat": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.handleWrite": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.lstat": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.mkdir": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.mktemp": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.open": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.create",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.readBytes": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.readdir": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.readFile": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.readlink": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.readText": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.realpath": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.rename": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.rm": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.rmdir": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.stat": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.symlink": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.truncate": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.unlink": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.utimes": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "fs.writeFile": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "fs.mutate",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "gateway.fetch": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "gateway.control",
      rationale:
        "G1: external-system effect or listening surface; §2 default {code, session} family",
    },
    capability: "workspace.gateway.access",
    presentation: {
      title: "Access a workspace gateway address",
      action: "access a workspace gateway address",
      description: "Allows {requesterKind} to access a workspace gateway address.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
  },
  "governance.list": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "governance.read",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "governance.read",
    presentation: {
      title: "View workspace governance settings",
      action: "view workspace governance settings",
      description: "Allows {requesterKind} to view workspace governance settings.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "see",
      },
    },
  },
  "hostLifecycle.shutdown": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "hostLifecycle.control",
      rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
    },
    capability: "application.shutdown",
    presentation: {
      title: "Shut down the workspace host",
      action: "shut down the workspace host",
      description: "Allows {requesterKind} to shut down the workspace host.",
      group: "host",
      authorityCategory: {
        domain: "computer",
        verb: "act",
      },
    },
  },
  "hostPerformance.snapshot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "hostPerformance.read",
      rationale:
        "Bounded read-only host and workerd resource counters; no process control or host filesystem access.",
    },
    capability: null,
    presentation: null,
  },
  "hubControl.addWorkspaceMember": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.members.manage",
    presentation: {
      title: "Add a workspace member",
      action: "add a workspace member",
      description: "Allows {requesterKind} to add a workspace member.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "hubControl.createWorkspace": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.create",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspaces.create",
    presentation: {
      title: "Create a workspace",
      action: "create a workspace",
      description: "Allows {requesterKind} to create a workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "hubControl.deleteWorkspace": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "identity",
      family: "hubControl.retire",
      rationale:
        "C3: irreversible destruction outside VCS protection; §2 default {code, session} family",
    },
    capability: "workspaces.delete",
    presentation: {
      title: "Delete a workspace",
      action: "delete a workspace",
      description: "Allows {requesterKind} to delete a workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "hubControl.ensureEphemeralWorkspace": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspaces.create",
    presentation: {
      title: "Prepare a temporary workspace",
      action: "prepare a temporary workspace",
      description: "Allows {requesterKind} to prepare a temporary workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "hubControl.getProfile": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "account.profile.read",
    presentation: {
      title: "View an account profile",
      action: "view an account profile",
      description: "Allows {requesterKind} to view an account profile.",
      group: "accounts",
      authorityCategory: {
        domain: "accounts",
        verb: "see",
      },
    },
  },
  "hubControl.inviteUser": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.members.manage",
    presentation: {
      title: "Invite someone to the workspace",
      action: "invite someone to the workspace",
      description: "Allows {requesterKind} to invite someone to the workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "hubControl.listDevices": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "devices.read",
    presentation: {
      title: "View connected devices",
      action: "view connected devices",
      description: "Allows {requesterKind} to view connected devices.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
  },
  "hubControl.listUserPresence": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "presence.read",
    presentation: {
      title: "View who is currently active",
      action: "view who is currently active",
      description: "Allows {requesterKind} to view who is currently active.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
  },
  "hubControl.listWorkspaceMembers": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.members.read",
    presentation: {
      title: "View workspace members",
      action: "view workspace members",
      description: "Allows {requesterKind} to view workspace members.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
  },
  "hubControl.listWorkspaces": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspaces.read",
    presentation: {
      title: "View available workspaces",
      action: "view available workspaces",
      description: "Allows {requesterKind} to view available workspaces.",
      group: "accounts",
      authorityCategory: {
        domain: "files",
        verb: "see",
      },
    },
  },
  "hubControl.pairDevice": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "devices.pair",
    presentation: {
      title: "Pair a device",
      action: "pair a device",
      description: "Allows {requesterKind} to pair a device.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "hubControl.removeWorkspaceMember": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "identity",
      family: "hubControl.retire",
      rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
    },
    capability: "workspace.members.remove",
    presentation: {
      title: "Remove a workspace member",
      action: "remove a workspace member",
      description: "Allows {requesterKind} to remove a workspace member.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "hubControl.revokeDevice": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "identity",
      family: "hubControl.retire",
      rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
    },
    capability: "devices.revoke",
    presentation: {
      title: "Disconnect a device",
      action: "disconnect a device",
      description: "Allows {requesterKind} to disconnect a device.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "hubControl.revokeUser": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "identity",
      family: "hubControl.retire",
      rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
    },
    capability: "users.revoke",
    presentation: {
      title: "Revoke a user's access",
      action: "revoke a user's access",
      description: "Allows {requesterKind} to revoke a user's access.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "hubControl.routeWorkspace": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspaces.open",
    presentation: {
      title: "Connect to a workspace",
      action: "connect to a workspace",
      description: "Allows {requesterKind} to connect to a workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
  },
  "hubControl.setRole": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.members.manage",
    presentation: {
      title: "Change a workspace member's role",
      action: "change a workspace member's role",
      description: "Allows {requesterKind} to change a workspace member's role.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "hubControl.updateProfile": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "account.profile.update",
    presentation: {
      title: "Change an account profile",
      action: "change an account profile",
      description: "Allows {requesterKind} to change an account profile.",
      group: "accounts",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
  },
  "menu.showContext": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "menu.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "menu.showHamburger": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "menu.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "menu.showPanelContext": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "menu.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "mirror.objects": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "mirror.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "mirror.targets": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "mirror.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "notification.dismiss": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "notification.reportAction": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "notification.show": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "notification.signalUserInbox": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "notification.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "panelCdp.consoleHistory": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale: "Returns a bounded observation from the exact authenticated native CDP provider",
    },
    capability: null,
    presentation: null,
  },
  "panelCdp.getCdpEndpoint": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Mints one short-lived authenticated endpoint for the exact already-authorized native CDP target",
    },
    capability: "panel.inspect",
    presentation: {
      title: "Inspect a panel with developer tools",
      action: "inspect a panel with developer tools",
      description: "Allows {requesterKind} to inspect a panel with developer tools.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
  },
  "panelCdp.hostProvider.close": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Closes the exact authenticated CDP provider stream and only reduces transport authority",
    },
    capability: "panel.inspect",
    presentation: {
      title: "Stop inspecting a panel",
      action: "stop inspecting a panel",
      description: "Allows {requesterKind} to stop inspecting a panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
  },
  "panelCdp.hostProvider.open": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale: "Opens one authenticated provider stream for an already-minted exact CDP session",
    },
    capability: "panel.inspect",
    presentation: {
      title: "Inspect a panel",
      action: "inspect a panel",
      description: "Allows {requesterKind} to inspect a panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
  },
  "panelCdp.hostProvider.send": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Relays one frame inside the exact authenticated CDP provider session without product policy",
    },
    capability: "panel.inspect",
    presentation: {
      title: "Control an inspected panel",
      action: "control an inspected panel",
      description: "Allows {requesterKind} to control an inspected panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
  },
  "panelCdp.screenshot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Force-paints and captures the exact native view selected by receiver-bound target authority",
    },
    capability: null,
    presentation: null,
  },
  "panelCdp.stop": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Stops loading in the exact native webContents selected by the receiver-bound target",
    },
    capability: null,
    presentation: null,
  },
  "panelLog.append": {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "panelLog.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.acquire": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.awaitAttempt": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Waits on one exact panel boot lifecycle without acquiring authority",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.awaitSlot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Waits on the canonical panel observation stream without acquiring authority",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.ensureSlot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "Assigns a presentation lease only for the exact runtime entity already committed by the builtin topology owner",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.getAttempt": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Resolves opaque attempt references without acquiring authority",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.getSnapshot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.observeSlot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.read",
      rationale:
        "Bounded observation of the active presentation lease and its host-reported boot state",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.registerClient": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.create",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.release": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.reportOwnView": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "A panel principal publishes its own bootstrap transition only while its authenticated connection owns the exact active lease.",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.reportView": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "P-panels: a lease-owning host reports the current panel boot state; ownership is verified server-side and no authority is widened.",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.takeOver": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.takeOverSlot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "Transfers presentation to the caller's already-attested host lease without changing panel product state",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.unloadSlot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale:
        "Releases presentation resources without changing builtin-owned panel topology or product state",
    },
    capability: null,
    presentation: null,
  },
  "panelRuntime.unregisterClient": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "panelRuntime.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "permissions.list": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "permissions.read",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "permissions.read",
    presentation: {
      title: "View saved site permissions",
      action: "view saved site permissions",
      description: "Allows {requesterKind} to view saved site permissions.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "permissions.listAgentProfiles": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "permissions.read",
      rationale: "G4: privacy or saved authority-map read; §2 default {code, session} family",
    },
    capability: "permissions.read",
    presentation: {
      title: "View saved agent choices",
      action: "view saved agent choices",
      description: "Allows {requesterKind} to view saved choices for agents.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "permissions.revoke": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "permissions.retire",
      rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
    },
    capability: "permissions.revoke",
    presentation: {
      title: "Remove a saved site permission",
      action: "remove a saved site permission",
      description: "Allows {requesterKind} to remove a saved site permission.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "permissions.safetyStatus": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "permissions.control",
      rationale: "G4: privacy or live authority-map read; §2 default {code, session} family",
    },
    capability: "permissions.read",
    presentation: {
      title: "View workspace authority safety status",
      action: "view workspace authority safety status",
      description:
        "Allows {requesterKind} to view whether workspace authority is locked and how much agent work it affects.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "permissions.setWorkspaceAuthorityLock": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "permissions.mutate",
      rationale:
        "C2: suspends or restores protected authority workspace-wide; §2 default {code, session} family",
    },
    capability: "permissions.revoke",
    presentation: {
      title: "Change the workspace authority lock",
      action: "change the workspace authority lock",
      description:
        "Allows {requesterKind} to stop or restore protected authority across the workspace.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "permissions.updateAgentProfile": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "permissions.mutate",
      rationale:
        "C2: restores or removes lasting authority choices; §2 default {code, session} family",
    },
    capability: "permissions.revoke",
    presentation: {
      title: "Change saved agent choices",
      action: "change saved agent choices",
      description: "Allows {requesterKind} to restore or remove saved choices for agents.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "presence.getPanelActiveOwner": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "presence.read",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "panel.presence.read",
    presentation: {
      title: "View who is using a panel",
      action: "view who is using a panel",
      description: "Allows {requesterKind} to view who is using a panel.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
  },
  "presence.markPanelActive": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "presence.control",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "panel.presence.update",
    presentation: {
      title: "Mark a panel as active",
      action: "mark a panel as active",
      description: "Allows {requesterKind} to mark a panel as active.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "act",
      },
    },
  },
  "presence.markPanelsOwned": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "presence.control",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "panel.presence.update",
    presentation: {
      title: "Claim ownership of panels",
      action: "claim ownership of panels",
      description: "Allows {requesterKind} to claim ownership of panels.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "act",
      },
    },
  },
  "push.listRegistrations": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "transport",
      family: "push.read",
      rationale: "G4/G5: push-token inventory is private approval plumbing; §3 push precedent",
    },
    capability: "push.manage",
    presentation: {
      title: "View devices registered for notifications",
      action: "view devices registered for notifications",
      description: "Allows {requesterKind} to view devices registered for notifications.",
      group: "notifications",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "push.register": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "transport",
      family: "push.create",
      rationale: "G5: push registration is device and approval plumbing; §3 push precedent",
    },
    capability: "push.manage",
    presentation: {
      title: "Enable notifications on a device",
      action: "enable notifications on a device",
      description: "Allows {requesterKind} to enable notifications on a device.",
      group: "notifications",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "push.send": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "transport",
      family: "push.control",
      rationale: "G1/G5: external push delivery is host approval plumbing; §3 push precedent",
    },
    capability: "push.send",
    presentation: {
      title: "Send a notification",
      action: "send a notification",
      description: "Allows {requesterKind} to send a notification.",
      group: "notifications",
      authorityCategory: {
        domain: "sharing",
        verb: "act",
      },
    },
  },
  "push.unregister": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "transport",
      family: "push.control",
      rationale:
        "G5: push registration lifecycle is device and approval plumbing; §3 push precedent",
    },
    capability: "push.manage",
    presentation: {
      title: "Disable notifications on a device",
      action: "disable notifications on a device",
      description: "Allows {requesterKind} to disable notifications on a device.",
      group: "notifications",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "remoteCred.clear": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "secret",
      family: "remoteCred.control",
      rationale:
        "C1: destroys credential or client secret material; §2 default {code, session} family",
    },
    capability: "remote-client.clear",
    presentation: {
      title: "Clear a remote connection",
      action: "clear a remote connection",
      description: "Allows {requesterKind} to clear a remote connection.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "remoteCred.getCurrent": {
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "remoteCred.read",
      rationale:
        "Open bias: returns secret-free connection status to authorized chrome; no C1-C4 or G1-G5 rule applies",
    },
    capability: "remote-client.read",
    presentation: {
      title: "View the current remote connection",
      action: "view the current remote connection",
      description: "Allows {requesterKind} to view the current remote connection.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
  },
  "remoteCred.pair": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "remoteCred.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "remote-client.connect",
    presentation: {
      title: "Pair a remote connection",
      action: "pair a remote connection",
      description: "Allows {requesterKind} to pair a remote connection.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "remoteCred.reconnectNow": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "remoteCred.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "remote-client.connect",
    presentation: {
      title: "Reconnect now",
      action: "reconnect now",
      description: "Allows {requesterKind} to reconnect now.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "remoteCred.relaunch": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "remoteCred.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    capability: "remote-client.connect",
    presentation: {
      title: "Restart the remote connection",
      action: "restart the remote connection",
      description: "Allows {requesterKind} to restart the remote connection.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
  },
  "reviewedClosure.activate": {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "reviewedClosure.lifecycle",
      rationale:
        "Kernel verifies and activates an exact compiled authority closure and atomically mints its standing grants.",
    },
    capability: null,
    presentation: null,
  },
  "reviewedClosure.bindSession": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "reviewedClosure.session",
      rationale:
        "Kernel binds an execution session to one active digest-bound closure for hot-path enforcement.",
    },
    capability: "reviewed-closure.bind-session",
    presentation: null,
  },
  "reviewedClosure.finishSession": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "reviewedClosure.session",
      rationale: "Kernel closes the exact reviewed-closure session binding.",
    },
    capability: null,
    presentation: null,
  },
  "reviewedClosure.retire": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "reviewedClosure.lifecycle",
      rationale: "Kernel retirement permanently revokes the closure and its standing grants.",
    },
    capability: "reviewed-closure.retire",
    presentation: {
      title: "Retire reviewed automation",
      action: "retire reviewed automation",
      description: "Allows {requesterKind} to retire reviewed automation.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "reviewedClosure.suspend": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "reviewedClosure.lifecycle",
      rationale: "Kernel suspension closes session admission and revokes standing allows.",
    },
    capability: "reviewed-closure.suspend",
    presentation: {
      title: "Pause reviewed automation",
      action: "pause reviewed automation",
      description: "Allows {requesterKind} to pause reviewed automation.",
      group: "runtime",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "runtime.activateReservedEntity": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.control",
      rationale:
        "Generic execution plumbing activates a sealed image only for the principal that owns its durable reservation",
    },
    capability: null,
    presentation: null,
  },
  "runtime.cloneContext": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "context.clone",
    presentation: {
      title: "Copy another task's workspace",
      action: "copy another task's workspace",
      description: "Allows {requesterKind} to copy another task's workspace.",
      group: "runtime",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
  },
  "runtime.createContext": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.create",
      rationale:
        "Fresh context creation is caller scratch; a prepared context.boundary leaf gates reuse of live foreign state",
    },
    capability: null,
    presentation: null,
  },
  "runtime.createEntity": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.create",
      rationale:
        "Caller-owned entity/context creation is task scratch; an existing foreign context is independently gated by the prepared context.boundary leaf",
    },
    capability: null,
    presentation: null,
  },
  "runtime.createSubagentContext": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.create",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "subagents.create",
    presentation: {
      title: "Create a workspace for a subagent",
      action: "create a workspace for a subagent",
      description: "Allows {requesterKind} to create a workspace for a subagent.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "runtime.destroyContext": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.retire",
      rationale:
        "Caller-owned scratch teardown is lifecycle cleanup; a critical prepared context.boundary leaf protects foreign or unowned state",
    },
    capability: null,
    presentation: null,
  },
  "runtime.dropSemanticContext": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "supervision",
      family: "runtime.context-ownership",
      rationale:
        "Drops one exact semantic-only context and its lifecycle edge after the caller presents its durable coordinate",
    },
    capability: "context.semantic.drop",
    presentation: {
      title: "Delete a semantic workspace",
      action: "delete a semantic workspace",
      description:
        "Allows {requesterKind} to permanently remove one exact owned semantic workspace.",
      group: "runtime",
      authorityCategory: {
        domain: "files",
        verb: "manage",
      },
    },
  },
  "runtime.faultAbortAgentVessel": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.test-fault",
      rationale:
        "Hidden system-test transport admitted only through a sealed code-bearing session; the host additionally verifies the blessed harness incarnation and exact target entity.",
    },
    capability: null,
    presentation: null,
  },
  "runtime.forkSemanticContext": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "runtime.context-ownership",
      rationale:
        "Creates one exact semantic-only child and records its generic lifecycle ownership without cloning entities or Durable Object state",
    },
    capability: "context.semantic.fork",
    presentation: {
      title: "Fork a semantic workspace",
      action: "fork a semantic workspace",
      description: "Allows {requesterKind} to create one exact owned semantic child workspace.",
      group: "runtime",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
  },
  "runtime.listContexts": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.read",
      rationale:
        "Read-only discovery of semantic context ids exposes no context content or mutation authority; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "runtime.listEntities": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "runtime.listOwnedContexts": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "runtime.recordContextEdge": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "context.relationships.record",
    presentation: {
      title: "Link related task workspaces",
      action: "link related task workspaces",
      description: "Allows {requesterKind} to link related task workspaces.",
      group: "runtime",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
  },
  "runtime.recoverExecution": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "runtime.recovery",
      rationale:
        "Exact recovery is restricted by the receiver to interactive trusted chrome; expected-digest matching prevents stale actions",
    },
    capability: "runtime.execution.recover",
    presentation: {
      title: "Recover a runtime execution",
      action: "recover a runtime execution",
      description:
        "Allows {requesterKind} to restore an exact retained execution or explicitly replace one unavailable incarnation.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "runtime.reserveEntity": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "runtime.reservation",
      rationale:
        "Generic lifecycle plumbing reserves a caller-owned non-executable identity before an owning subsystem commits its durable reference",
    },
    capability: null,
    presentation: null,
  },
  "runtime.resolveContext": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "runtime.context-resolution",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "runtime.retireEntity": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.retire",
      rationale:
        "Retiring self/child scratch is lifecycle cleanup; a critical prepared context.boundary leaf protects foreign entities",
    },
    capability: null,
    presentation: null,
  },
  "runtime.setTitle": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "supervision",
      family: "runtime.mutate",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    capability: null,
    presentation: null,
  },
  "runtime.supervision.activate": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "runtime.supervision",
      rationale:
        "Generic activation of one exact admitted release through its owning executable-unit driver.",
    },
    capability: "runtime.supervision.manage",
    presentation: {
      title: "Start an executable release",
      action: "start an executable release",
      description: "Allows {requesterKind} to start one exact executable release.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "runtime.supervision.appendLog": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "observability",
      family: "runtime.supervision-observability",
      rationale:
        "Caller-derived structured log ingress for an already admitted executable entity; the caller cannot select another target.",
    },
    capability: null,
    presentation: null,
  },
  "runtime.supervision.describe": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "runtime.supervision",
      rationale: "Read-only description of one exact driver-owned executable entity.",
    },
    capability: null,
    presentation: null,
  },
  "runtime.supervision.health": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "runtime.supervision",
      rationale: "Bounded health and diagnostic read from one exact executable-unit driver.",
    },
    capability: null,
    presentation: null,
  },
  "runtime.supervision.list": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "runtime.supervision",
      rationale:
        "Bounded operational projection over registered executable-unit drivers; it performs no lifecycle mutation.",
    },
    capability: null,
    presentation: null,
  },
  "runtime.supervision.logs": {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "runtime.supervision-observability",
      rationale: "Bounded retained-log read from one exact executable-unit driver.",
    },
    capability: null,
    presentation: null,
  },
  "runtime.supervision.prepare": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "untrusted-execution",
      family: "runtime.release-preparation",
      rationale:
        "Materializes one immutable release selector through the owning driver without selecting or launching it.",
    },
    capability: "runtime.supervision.manage",
    presentation: {
      title: "Prepare an executable release",
      action: "prepare an executable release",
      description: "Allows {requesterKind} to prepare one exact executable release.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "runtime.supervision.reportHealth": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "observability",
      family: "runtime.supervision-observability",
      rationale:
        "Caller-derived health report for an already admitted executable entity; the caller cannot select another target.",
    },
    capability: null,
    presentation: null,
  },
  "runtime.supervision.reportReady": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "runtime.supervision-handshake",
      rationale:
        "Caller-derived activation handshake for an already admitted executable entity; the caller cannot select another target.",
    },
    capability: null,
    presentation: null,
  },
  "runtime.supervision.restart": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "runtime.supervision",
      rationale:
        "Restarts one exact driver-owned execution without changing its durable product state.",
    },
    capability: "runtime.supervision.manage",
    presentation: {
      title: "Restart a workspace component",
      action: "restart a workspace component",
      description: "Allows {requesterKind} to restart one exact workspace component.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "runtime.supervision.retire": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "runtime.supervision",
      rationale: "Retires one exact driver-owned execution and its owned native resources.",
    },
    capability: "runtime.supervision.manage",
    presentation: {
      title: "Stop a workspace component",
      action: "stop a workspace component",
      description: "Allows {requesterKind} to stop one exact workspace component.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "runtime.supervision.rollback": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "runtime.supervision-release",
      rationale:
        "Rollback is addressed by release identity and delegated only to a driver exposing the release facet.",
    },
    capability: "runtime.supervision.manage",
    presentation: {
      title: "Restore an executable release",
      action: "restore an executable release",
      description: "Allows {requesterKind} to restore one exact executable release.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "runtime.supervision.versions": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "runtime.supervision-release",
      rationale: "Read-only release history addressed by exact release identity.",
    },
    capability: null,
    presentation: null,
  },
  "serverLog.query": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "observability",
      family: "serverLog.read",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "server-logs.read",
    presentation: {
      title: "View server logs",
      action: "view server logs",
      description: "Allows {requesterKind} to view server logs.",
      group: "host",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
  },
  "serverLog.stats": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "observability",
      family: "serverLog.control",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "server-logs.read",
    presentation: {
      title: "View server log statistics",
      action: "view server log statistics",
      description: "Allows {requesterKind} to view server log statistics.",
      group: "host",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
  },
  "serverLog.tail": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "observability",
      family: "serverLog.control",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    capability: "server-logs.read",
    presentation: {
      title: "Follow new server log entries",
      action: "follow new server log entries",
      description: "Allows {requesterKind} to follow new server log entries.",
      group: "host",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
  },
  "shellApproval.getWorkspaceCreationReviewState": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.read leaf",
    },
    capability: "approvals.read",
    presentation: {
      title: "View requests awaiting your decision",
      action: "view requests awaiting your decision",
      description: "Allows {requesterKind} to view requests awaiting your decision.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "shellApproval.listPending": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.read leaf",
    },
    capability: "approvals.read",
    presentation: {
      title: "View requests awaiting your decision",
      action: "view requests awaiting your decision",
      description: "Allows {requesterKind} to view requests awaiting your decision.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "shellApproval.resolve": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.decide leaf",
    },
    capability: "approvals.decide",
    presentation: {
      title: "Respond to a workspace request",
      action: "respond to a workspace request",
      description: "Allows {requesterKind} to respond to a workspace request.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "shellApproval.resolveBootstrap": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.decide leaf",
    },
    capability: "approvals.decide",
    presentation: {
      title: "Approve initial workspace access",
      action: "approve initial workspace access",
      description: "Allows {requesterKind} to approve initial workspace access.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "shellApproval.resolveInstallReview": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.decide leaf",
    },
    capability: "approvals.decide",
    presentation: {
      title: "Add or update parts of this workspace",
      action: "add or update parts of this workspace",
      description: "Allows {requesterKind} to answer a queued review of arriving parts.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "shellApproval.resolveMissionReview": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.read",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared approvals.decide leaf",
    },
    capability: "approvals.decide",
    presentation: {
      title: "Respond to an automation plan",
      action: "respond to an automation plan",
      description: "Allows {requesterKind} to respond to a queued automation plan.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
  },
  "shellApproval.submitClientConfig": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared protected-input.submit leaf",
    },
    capability: "protected-input.submit",
    presentation: {
      title: "Submit account-provider settings",
      action: "submit account-provider settings",
      description: "Allows {requesterKind} to submit account-provider settings.",
      group: "approvals",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
  },
  "shellApproval.submitCredentialInput": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared protected-input.submit leaf",
    },
    capability: "protected-input.submit",
    presentation: {
      title: "Submit account details",
      action: "submit account details",
      description: "Allows {requesterKind} to submit account details.",
      group: "approvals",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
  },
  "shellApproval.submitSecretInput": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "shellApproval.control",
      rationale:
        "The transport is open; non-chrome presenters receive one prepared protected-input.submit leaf",
    },
    capability: "protected-input.submit",
    presentation: {
      title: "Submit a protected value",
      action: "submit a protected value",
      description: "Allows {requesterKind} to submit a protected value.",
      group: "approvals",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
  },
  "shellPresence.heartbeat": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "shellPresence.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.blame": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.commit": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.mutate",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.compare": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.copy": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.discard": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.edit": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.mutate",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.finalizeExternalDelta": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.history": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.importSnapshot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.inspect": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.read-protected",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.listDirectory": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.listFiles": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.merge": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.move": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.neighbors": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.push": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.mutate",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.readFile": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.readMemory": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.registerExternalDelta": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.create",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.resolveRepository": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.revert": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.status": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "vcs.read-transport",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "vcs.supersedeExternalDelta": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "vcs.control",
      rationale:
        "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.bindNativePanelSlot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.browserForceReload": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.browserGoBack": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.browserGoForward": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.browserNavigate": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.browserReload": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.browserStop": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.clearNativeBrowserSiteData": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "Clears Electron session storage for an origin that is still displayed by the selected browser panel.",
    },
    capability: null,
    presentation: null,
  },
  "view.clearNativePanelSlot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.createPanel": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "Shell-owned panel creation commits and presents the durable slot promptly; native readiness follows through the panel presentation lifecycle",
    },
    capability: null,
    presentation: null,
  },
  "view.ensurePanelLoaded": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "Materializes a resident panel on the caller's native host without changing shell layout focus",
    },
    capability: null,
    presentation: null,
  },
  "view.expandPanelIds": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.local-panel-state",
      rationale: "Expands exact nodes in this client's local panel presentation state",
    },
    capability: null,
    presentation: null,
  },
  "view.findInPage": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: in-page find UI on the focused panel; core mutually inspectable workspace UX.",
    },
    capability: null,
    presentation: null,
  },
  "view.focusPanel": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "Focus and placement are device-local native presentation effects on the caller's panel host",
    },
    capability: null,
    presentation: null,
  },
  "view.forwardMouseClick": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.getBrowserPageIdentity": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "Reads the exact URL, origin, and native document title from an Electron browser webContents.",
    },
    capability: null,
    presentation: null,
  },
  "view.getChromeState": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.getCollapsedPanelIds": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.local-panel-state",
      rationale: "Reads collapsed nodes from this client's local panel presentation state",
    },
    capability: null,
    presentation: null,
  },
  "view.getFocusedPanelId": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.local-panel-state",
      rationale: "Reads the selected panel from the exact client-local native view registry",
    },
    capability: null,
    presentation: null,
  },
  "view.getLocalPresentation": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale: "Trusted panel chrome reads Electron's canonical local presentation state",
    },
    capability: null,
    presentation: null,
  },
  "view.getPanelLayout": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.getPresentation": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: read-only Electron-local presentation state for trusted panel-hosting chrome",
    },
    capability: null,
    presentation: null,
  },
  "view.getPresentations": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: batched read-only Electron-local presentation state for trusted panel-hosting chrome",
    },
    capability: null,
    presentation: null,
  },
  "view.getThemeConfig": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.hideContentOverlay": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.hideNativeShellOverlay": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.listPinnedPanelIds": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.read",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.markBrowserNavigationIntent": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.openPanelDevTools": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.native-panel",
      rationale: "Opens Electron DevTools for the exact native panel webContents",
    },
    capability: null,
    presentation: null,
  },
  "view.printBrowserPage": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: shell print action on the focused browser panel; core mutually inspectable workspace UX.",
    },
    capability: null,
    presentation: null,
  },
  "view.saveBrowserPagePdf": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: shell save-as-PDF action on the focused browser panel; core mutually inspectable workspace UX.",
    },
    capability: null,
    presentation: null,
  },
  "view.savePanelLayout": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.setBounds": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.setFocusedPanelId": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.local-panel-state",
      rationale:
        "Records the exact shell layout focus without acquiring a lease or emitting a navigation intent",
    },
    capability: null,
    presentation: null,
  },
  "view.setHostedShellReady": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.setNativeBrowserZoom": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.mutate",
      rationale:
        "Applies an already-selected zoom factor to the exact Electron browser webContents.",
    },
    capability: null,
    presentation: null,
  },
  "view.setPanelCollapsed": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.local-panel-state",
      rationale: "Persists one collapsed-node choice in this client's local presentation state",
    },
    capability: null,
    presentation: null,
  },
  "view.setShellOverlay": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.setThemeCss": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.setVisible": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.showContentOverlay": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.showNativeShellOverlay": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.stopBrowserMedia": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: stops media in the focused browser panel; core mutually inspectable workspace UX.",
    },
    capability: null,
    presentation: null,
  },
  "view.stopFindInPage": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: dismisses the in-page find session; core mutually inspectable workspace UX.",
    },
    capability: null,
    presentation: null,
  },
  "view.togglePin": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.control",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.updateContentOverlay": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.updateNativePanelSlot": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.updateNativeShellOverlay": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "view.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.updateTheme": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "view.updateThemeConfig": {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "panel.mutate",
      rationale:
        "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "webhookIngress.createSubscription": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "webhookIngress.create",
      rationale:
        "G1: external-system effect or listening surface; §2 default {code, session} family",
    },
    capability: "webhooks.manage",
    presentation: {
      title: "Accept incoming web requests",
      action: "accept incoming web requests",
      description: "Allows {requesterKind} to accept incoming web requests.",
      group: "network",
      authorityCategory: {
        domain: "sharing",
        verb: "manage",
      },
    },
  },
  "webhookIngress.listSubscriptions": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "webhookIngress.read",
      rationale:
        "G1: external-system effect or listening surface; §2 default {code, session} family",
    },
    capability: "webhooks.manage",
    presentation: {
      title: "View incoming web connections",
      action: "view incoming web connections",
      description: "Allows {requesterKind} to view incoming web connections.",
      group: "network",
      authorityCategory: {
        domain: "sharing",
        verb: "manage",
      },
    },
  },
  "webhookIngress.revokeSubscription": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "webhookIngress.retire",
      rationale:
        "G1: external-system effect or listening surface; §2 default {code, session} family",
    },
    capability: "webhooks.manage",
    presentation: {
      title: "Stop accepting an incoming web connection",
      action: "stop accepting an incoming web connection",
      description: "Allows {requesterKind} to stop accepting an incoming web connection.",
      group: "network",
      authorityCategory: {
        domain: "sharing",
        verb: "manage",
      },
    },
  },
  "webhookIngress.rotateSecret": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "webhookIngress.control",
      rationale:
        "G1: external-system effect or listening surface; §2 default {code, session} family",
    },
    capability: "webhooks.manage",
    presentation: {
      title: "Replace an incoming web connection's secret",
      action: "replace an incoming web connection's secret",
      description: "Allows {requesterKind} to replace an incoming web connection's secret.",
      group: "network",
      authorityCategory: {
        domain: "sharing",
        verb: "manage",
      },
    },
  },
  "workerdInspector.getEndpoint": {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "workerdInspector.read",
      rationale:
        "The transport is open; non-chrome code receives one prepared gated runtime.inspect leaf",
    },
    capability: "runtime.inspect",
    presentation: {
      title: "Inspect workspace runtimes",
      action: "inspect workspace runtimes",
      description: "Allows {requesterKind} to inspect workspace runtimes.",
      group: "runtime",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
  },
  "workerdInspector.listTargets": {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "workerdInspector.read",
      rationale: "Read-only discovery of inspectable processes; attaching remains gated",
    },
    capability: null,
    presentation: null,
  },
  "workerLog.write": {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "observability",
      family: "workerLog.mutate",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    capability: null,
    presentation: null,
  },
  "workers.listServices": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workers.listSources": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workers.listStorageBackups": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale: "Backup metadata for one exact target is recovery discovery",
    },
    capability: null,
    presentation: null,
  },
  "workers.resetStorage": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.storage-maintenance",
      rationale:
        "Exact-target durable storage replacement is destructive and individually reviewed",
    },
    capability: "workers.storage.reset",
    presentation: {
      title: "Replace Durable Object storage",
      action: "replace Durable Object storage",
      description: "Back up and replace the persisted storage of one exact Durable Object target.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "workers.resolveDurableObject": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale:
        "P-discovery: agent sessions must resolve only the structurally exposed durable targets in their mission envelope",
    },
    capability: null,
    presentation: null,
  },
  "workers.resolveService": {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale:
        "P-discovery: agent sessions must resolve only the structurally exposed services in their mission envelope",
    },
    capability: null,
    presentation: null,
  },
  "workers.restoreStorageBackup": {
    tier: {
      tier: "critical",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.storage-maintenance",
      rationale:
        "Exact-target durable storage replacement is destructive and individually reviewed",
    },
    capability: "workers.storage.reset",
    presentation: {
      title: "Replace Durable Object storage",
      action: "replace Durable Object storage",
      description: "Back up and replace the persisted storage of one exact Durable Object target.",
      group: "runtime",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "workspace-state.alarmClear": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.supervision",
      rationale:
        "Runtime-intrinsic self-alarm cleanup is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.alarmSet": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.supervision",
      rationale:
        "Runtime-intrinsic self-alarm scheduling is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.entity.resolve": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The reserved or active entity incarnation is an input to runtime attestation and caller identity",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.entity.resolveActive": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The active entity incarnation is an input to runtime attestation and caller identity",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.heartbeatRegister": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "The durable heartbeat row schedules and supervises a reviewed recurring runtime",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.heartbeatRemove": {
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "Removing the durable heartbeat row retires a reviewed recurring runtime schedule",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.lifecycleLeaseClear": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.supervision",
      rationale:
        "Runtime-intrinsic self-lease cleanup is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.lifecycleLeaseUpsert": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.supervision",
      rationale:
        "Runtime-intrinsic self-lease tracking is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.panel.incrementAccess": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.panel.index": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.panel.rebuildIndex": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.panel.search": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "Workspace-member panel-index read; no C1-C4 or G1-G5 rule applies",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.panel.sourceUsage": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace-state.lifecycle",
      rationale: "Workspace-member aggregate panel usage read; no C1-C4 or G1-G5 rule applies",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.panel.updateTitle": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "workspace-state.builtin-rpc",
      rationale:
        "Exact typed proxy to the builtin topology owner for one slot-bound presentation update",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.panelTree.detail": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Exact durable slot/history/entity join used to attest the active panel identity and context",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.panelTree.page": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Bounded durable parent/child and ownership projection from the builtin slot identity authority",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.panelTree.path": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Bounded durable ancestry projection used to preserve the exact slot ownership and context boundary",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.panelTree.rootGroups": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Bounded durable ownership census over the builtin slot topology used to select an exact account forest",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.panelTree.rootsForCaller": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Bounded durable root projection scoped by the server-verified subject instead of a caller-supplied owner id",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.panelTree.search": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace-state.builtin-rpc",
      rationale:
        "Exact typed proxy to the builtin topology owner for one bounded indexed presentation query",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.slot.close": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Closing a subtree retires its stable ownership and ancestry identities atomically",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.slot.closeCleanupAck": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.cleanup",
      rationale: "Acknowledgement advances the durable runtime cleanup supervisor queue",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.slot.closeCleanupPage": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace-state.cleanup",
      rationale: "Bounded durable retirement work is consumed by the runtime cleanup supervisor",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.slot.closeOwnedRoots": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Account revocation atomically closes only roots carrying the revoked durable owner identity",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.slot.commitPreparedNavigation": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The prepared commit atomically changes the slot-to-entity/context identity consumed by access enforcement",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.slot.create": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Creating a stable slot records the ownership and ancestry identity used by panel access enforcement",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.slot.get": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The stable slot-to-entity/context binding is an input to caller ancestry and context-boundary enforcement",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.slot.historyEntry": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The exact stored destination context is an input to context-boundary enforcement before history selection",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.slot.historyRelative": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace-state.builtin-rpc",
      rationale:
        "Exact typed proxy to the builtin topology owner for one bounded adjacent-history read",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.slot.move": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "Reparenting changes stable panel ancestry and owning-user identity consumed by access enforcement",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace-state.slot.resolveByEntity": {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "workspace-state.identity",
      rationale:
        "The entity-to-slot binding determines runtime ancestry and the context-boundary target",
    },
    capability: "workspace.runtime-state.inspect",
    presentation: {
      title: "Inspect running workspace services",
      action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
      description: "Read the current structure and status of running workspace services",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
  },
  "workspace-state.slot.updateCurrentStateArgs": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "workspace-state.builtin-rpc",
      rationale:
        "Exact typed proxy to the builtin topology owner for one receiver-validated current-entry update",
    },
    capability: "workspace.runtime-state.manage",
    presentation: {
      title: "Manage running workspace services",
      action: "manage apps, panels, background tasks, and scheduled work that's currently running",
      description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace.applyPreparedConfig": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.mutate",
      rationale:
        "The transport is open; code callers receive one prepared gated leaf bound to the exact config mutation digest.",
    },
    capability: "workspace.config.apply",
    presentation: {
      title: "Apply workspace configuration",
      action: "apply workspace configuration",
      description: "Allows {requesterKind} to apply an exact reviewed workspace configuration.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace.ensureContextFolder": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "workspace.context-materialization",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "context.materialize",
    presentation: {
      title: "Prepare a task workspace folder",
      action: "prepare a task workspace folder",
      description: "Allows {requesterKind} to prepare a task workspace folder.",
      group: "workspace",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
  },
  "workspace.findUnitForPath": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.getActive": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.getAgentsMd": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.getConfig": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.getInfo": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.heartbeats.list": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspace.heartbeat-supervision",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.heartbeats.pause": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace.heartbeat-supervision",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "automations.control",
    presentation: {
      title: "Pause recurring workspace tasks",
      action: "pause recurring workspace tasks",
      description: "Allows {requesterKind} to pause recurring workspace tasks.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "workspace.heartbeats.resume": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace.heartbeat-supervision",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "automations.control",
    presentation: {
      title: "Resume recurring workspace tasks",
      action: "resume recurring workspace tasks",
      description: "Allows {requesterKind} to resume recurring workspace tasks.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "workspace.heartbeats.runNow": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "workspace.heartbeat-supervision",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "automations.control",
    presentation: {
      title: "Run recurring workspace tasks now",
      action: "run recurring workspace tasks now",
      description: "Allows {requesterKind} to run recurring workspace tasks now.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
  },
  "workspace.listSkills": {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "workspace.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.readSkill": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.semantic-read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.recurring.list": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.semantic-read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.setConfigField": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "protected-write",
      family: "workspace.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.configure",
    presentation: {
      title: "Change workspace settings",
      action: "change workspace settings",
      description: "Allows {requesterKind} to change workspace settings.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace.setInitPanels": {
    tier: {
      tier: "gated",
      session: "family",
      residency: "protected-write",
      family: "workspace.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    capability: "workspace.configure",
    presentation: {
      title: "Change startup panels",
      action: "change startup panels",
      description: "Allows {requesterKind} to change startup panels.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "manage",
      },
    },
  },
  "workspace.sourceTree": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspace.validateConfig": {
    tier: {
      tier: "open",
      session: "family",
      residency: "protected-write",
      family: "workspace.control",
      rationale:
        "Pure validation of caller-supplied candidate configuration has no workspace effect; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
  "workspacePresence.list": {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "workspacePresence.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    capability: null,
    presentation: null,
  },
} as const satisfies Record<string, GeneratedHostAuthorityMethod>;

export const HOST_METHOD_MANIFEST_DEPENDENCIES = {
  "browserEnvironment.cancelDownload": ["service:browserEnvironment.cancelDownload"],
  "browserEnvironment.cancelImportRead": ["service:browserEnvironment.cancelImportRead"],
  "browserEnvironment.flushCookieProjection": ["service:browserEnvironment.flushCookieProjection"],
  "browserEnvironment.getCookieProjectionDiagnostics": [
    "service:browserEnvironment.getCookieProjectionDiagnostics",
  ],
  "browserEnvironment.getImportHost": ["service:browserEnvironment.getImportHost"],
  "browserEnvironment.listDownloads": ["service:browserEnvironment.listDownloads"],
  "browserEnvironment.listImportOpenTabs": ["service:browserEnvironment.listImportOpenTabs"],
  "browserEnvironment.listImportSources": ["service:browserEnvironment.listImportSources"],
  "browserEnvironment.nextImportFrame": ["service:browserEnvironment.nextImportFrame"],
  "browserEnvironment.openDownload": ["service:browserEnvironment.openDownload"],
  "browserEnvironment.pauseDownload": ["service:browserEnvironment.pauseDownload"],
  "browserEnvironment.previewImportSource": ["service:browserEnvironment.previewImportSource"],
  "browserEnvironment.resumeDownload": ["service:browserEnvironment.resumeDownload"],
  "browserEnvironment.revealDownload": ["service:browserEnvironment.revealDownload"],
  "browserEnvironment.startImportRead": ["service:browserEnvironment.startImportRead"],
  "corsApproval.authorize": ["network.response.read"],
  "credentials.deleteClientConfig": ["account-providers.delete"],
  "credentials.proxyFetch": ["credential.use"],
  "credentials.proxyGitHttp": ["credential.use"],
  "credentials.resolveCredential": ["credential.use"],
  "externalOpen.openExternal": ["external.open"],
  "panelCdp.consoleHistory": ["context.boundary"],
  "panelCdp.getCdpEndpoint": ["context.boundary"],
  "panelCdp.screenshot": ["context.boundary"],
  "panelCdp.stop": ["context.boundary"],
  "reviewedClosure.activate": ["reviewed-closure.activate"],
  "runtime.cloneContext": ["context.boundary"],
  "runtime.createContext": ["context.boundary"],
  "runtime.createEntity": ["context.boundary"],
  "runtime.createSubagentContext": ["context.boundary"],
  "runtime.destroyContext": ["context.boundary"],
  "runtime.reserveEntity": ["context.boundary"],
  "runtime.retireEntity": ["context.boundary"],
  "shellApproval.getWorkspaceCreationReviewState": ["approvals.read"],
  "shellApproval.listPending": ["approvals.read"],
  "shellApproval.resolve": ["approvals.decide"],
  "shellApproval.resolveBootstrap": ["approvals.decide"],
  "shellApproval.resolveInstallReview": ["approvals.decide"],
  "shellApproval.resolveMissionReview": ["approvals.decide"],
  "shellApproval.submitClientConfig": ["protected-input.submit"],
  "shellApproval.submitCredentialInput": ["protected-input.submit"],
  "shellApproval.submitSecretInput": ["protected-input.submit"],
  "workerdInspector.getEndpoint": ["runtime.inspect"],
  "workspace-state.panel.updateTitle": ["context.boundary"],
  "workspace-state.slot.close": ["context.boundary"],
  "workspace-state.slot.commitPreparedNavigation": ["context.boundary"],
  "workspace-state.slot.create": ["context.boundary"],
  "workspace-state.slot.move": ["context.boundary"],
  "workspace-state.slot.updateCurrentStateArgs": ["context.boundary"],
  "workspace.applyPreparedConfig": ["workspace.config.apply"],
} as const satisfies Record<string, readonly string[]>;

export const HOST_CAPABILITY_CATEGORIES = {
  "account-providers.configure": {
    domain: "accounts",
    verb: "manage",
  },
  "account-providers.delete": {
    domain: "accounts",
    verb: "manage",
  },
  "account.profile.read": {
    domain: "accounts",
    verb: "see",
  },
  "account.profile.update": {
    domain: "accounts",
    verb: "act",
  },
  "accounts.connect": {
    domain: "accounts",
    verb: "manage",
  },
  "accounts.disconnect": {
    domain: "accounts",
    verb: "manage",
  },
  "adblock.manage": {
    domain: "web",
    verb: "manage",
  },
  "application.shutdown": {
    domain: "computer",
    verb: "act",
  },
  "application.update": {
    domain: "computer",
    verb: "act",
  },
  "approvals.decide": {
    domain: "safety",
    verb: "manage",
  },
  "approvals.read": {
    domain: "safety",
    verb: "manage",
  },
  "automations.control": {
    domain: "automation",
    verb: "act",
  },
  "browser-form-fill.manage": {
    domain: "accounts",
    verb: "act",
  },
  "browser-passwords.manage": {
    domain: "accounts",
    verb: "manage",
  },
  "code-runner.reset": {
    domain: "automation",
    verb: "act",
  },
  "connected-client.transport": {
    domain: "computer",
    verb: "manage",
  },
  "connections.approve": {
    domain: "computer",
    verb: "manage",
  },
  "content.trust.policy.manage": {
    domain: "safety",
    verb: "manage",
  },
  "content.trust.vouch": {
    domain: "safety",
    verb: "manage",
  },
  "context.clone": {
    domain: "files",
    verb: "act",
  },
  "context.materialize": {
    domain: "files",
    verb: "act",
  },
  "context.relationships.record": {
    domain: "files",
    verb: "act",
  },
  "context.semantic.drop": {
    domain: "files",
    verb: "manage",
  },
  "context.semantic.fork": {
    domain: "files",
    verb: "act",
  },
  "credentials.audit.read": {
    domain: "safety",
    verb: "see",
  },
  "development.native.build.retire": {
    domain: "computer",
    verb: "manage",
  },
  "development.native.execute": {
    domain: "automation",
    verb: "act",
  },
  "development.native.session.retire": {
    domain: "computer",
    verb: "manage",
  },
  "devices.pair": {
    domain: "people",
    verb: "manage",
  },
  "devices.read": {
    domain: "people",
    verb: "see",
  },
  "devices.revoke": {
    domain: "people",
    verb: "manage",
  },
  "external.open": {
    domain: "sharing",
    verb: "act",
  },
  "governance.read": {
    domain: "safety",
    verb: "see",
  },
  "network.response.read": {
    domain: "web",
    verb: "see",
  },
  "panel.inspect": {
    domain: "computer",
    verb: "see",
  },
  "panel.presence.read": {
    domain: "people",
    verb: "see",
  },
  "panel.presence.update": {
    domain: "people",
    verb: "act",
  },
  "permissions.read": {
    domain: "safety",
    verb: "manage",
  },
  "permissions.revoke": {
    domain: "safety",
    verb: "manage",
  },
  "presence.read": {
    domain: "people",
    verb: "see",
  },
  "protected-input.submit": {
    domain: "accounts",
    verb: "act",
  },
  "push.manage": {
    domain: "people",
    verb: "manage",
  },
  "push.send": {
    domain: "sharing",
    verb: "act",
  },
  "remote-client.clear": {
    domain: "people",
    verb: "manage",
  },
  "remote-client.connect": {
    domain: "people",
    verb: "manage",
  },
  "remote-client.read": {
    domain: "people",
    verb: "see",
  },
  "reviewed-closure.retire": {
    domain: "safety",
    verb: "manage",
  },
  "reviewed-closure.suspend": {
    domain: "safety",
    verb: "manage",
  },
  "runtime.execution.recover": {
    domain: "automation",
    verb: "manage",
  },
  "runtime.inspect": {
    domain: "computer",
    verb: "see",
  },
  "runtime.supervision.manage": {
    domain: "automation",
    verb: "manage",
  },
  "security.audit.read": {
    domain: "safety",
    verb: "see",
  },
  "server-logs.read": {
    domain: "computer",
    verb: "see",
  },
  "service:browserEnvironment.cancelDownload": {
    domain: "web",
    verb: "manage",
  },
  "service:browserEnvironment.cancelImportRead": {
    domain: "web",
    verb: "manage",
  },
  "service:browserEnvironment.flushCookieProjection": {
    domain: "web",
    verb: "manage",
  },
  "service:browserEnvironment.getCookieProjectionDiagnostics": {
    domain: "web",
    verb: "see",
  },
  "service:browserEnvironment.getImportHost": {
    domain: "web",
    verb: "see",
  },
  "service:browserEnvironment.listDownloads": {
    domain: "web",
    verb: "see",
  },
  "service:browserEnvironment.listImportOpenTabs": {
    domain: "web",
    verb: "see",
  },
  "service:browserEnvironment.listImportSources": {
    domain: "web",
    verb: "see",
  },
  "service:browserEnvironment.nextImportFrame": {
    domain: "web",
    verb: "see",
  },
  "service:browserEnvironment.openDownload": {
    domain: "computer",
    verb: "act",
  },
  "service:browserEnvironment.pauseDownload": {
    domain: "web",
    verb: "manage",
  },
  "service:browserEnvironment.previewImportSource": {
    domain: "web",
    verb: "see",
  },
  "service:browserEnvironment.resumeDownload": {
    domain: "web",
    verb: "manage",
  },
  "service:browserEnvironment.revealDownload": {
    domain: "computer",
    verb: "act",
  },
  "service:browserEnvironment.startImportRead": {
    domain: "web",
    verb: "see",
  },
  "subagents.create": {
    domain: "automation",
    verb: "act",
  },
  "users.revoke": {
    domain: "people",
    verb: "manage",
  },
  "webhooks.manage": {
    domain: "sharing",
    verb: "manage",
  },
  "workers.storage.reset": {
    domain: "automation",
    verb: "act",
  },
  "workspace.build-cache.manage": {
    domain: "automation",
    verb: "act",
  },
  "workspace.config.apply": {
    domain: "automation",
    verb: "manage",
  },
  "workspace.configure": {
    domain: "automation",
    verb: "manage",
  },
  "workspace.dependencies.inspect": {
    domain: "automation",
    verb: "see",
  },
  "workspace.gateway.access": {
    domain: "web",
    verb: "see",
  },
  "workspace.members.manage": {
    domain: "people",
    verb: "manage",
  },
  "workspace.members.read": {
    domain: "people",
    verb: "see",
  },
  "workspace.members.remove": {
    domain: "people",
    verb: "manage",
  },
  "workspace.runtime-state.inspect": {
    domain: "automation",
    verb: "see",
  },
  "workspace.runtime-state.manage": {
    domain: "automation",
    verb: "manage",
  },
  "workspace.storage.delete": {
    domain: "files",
    verb: "act",
  },
  "workspace.storage.materialize": {
    domain: "files",
    verb: "act",
  },
  "workspaces.create": {
    domain: "automation",
    verb: "act",
  },
  "workspaces.delete": {
    domain: "automation",
    verb: "act",
  },
  "workspaces.open": {
    domain: "files",
    verb: "act",
  },
  "workspaces.read": {
    domain: "files",
    verb: "see",
  },
} as const satisfies Record<string, NonNullable<CapabilityPresentation["authorityCategory"]>>;

export const HOST_SEMANTIC_PRESENTATIONS = {
  "account-providers.configure": {
    title: "Configure an account provider",
    action: "configure an account provider",
    description: "Allows {requesterKind} to configure an account provider.",
    group: "credentials",
    authorityCategory: {
      domain: "accounts",
      verb: "manage",
    },
  },
  "account-providers.delete": {
    title: "Delete account-provider settings",
    action: "delete account-provider settings",
    description: "Allows {requesterKind} to delete account-provider settings.",
    group: "credentials",
    authorityCategory: {
      domain: "accounts",
      verb: "manage",
    },
  },
  "account.profile.read": {
    title: "View an account profile",
    action: "view an account profile",
    description: "Allows {requesterKind} to view an account profile.",
    group: "accounts",
    authorityCategory: {
      domain: "accounts",
      verb: "see",
    },
  },
  "account.profile.update": {
    title: "Change an account profile",
    action: "change an account profile",
    description: "Allows {requesterKind} to change an account profile.",
    group: "accounts",
    authorityCategory: {
      domain: "accounts",
      verb: "act",
    },
  },
  "accounts.connect": {
    title: "Cancel account sign-in",
    action: "cancel account sign-in",
    description: "Allows {requesterKind} to cancel account sign-in.",
    group: "credentials",
    authorityCategory: {
      domain: "accounts",
      verb: "manage",
    },
  },
  "accounts.disconnect": {
    title: "Disconnect an account",
    action: "disconnect an account",
    description: "Allows {requesterKind} to disconnect an account.",
    group: "credentials",
    authorityCategory: {
      domain: "accounts",
      verb: "manage",
    },
  },
  "adblock.manage": {
    title: "Add a custom ad-blocking list",
    action: "add a custom ad-blocking list",
    description: "Allows {requesterKind} to add a custom ad-blocking list.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "manage",
    },
  },
  "application.shutdown": {
    title: "Shut down the workspace host",
    action: "shut down the workspace host",
    description: "Allows {requesterKind} to shut down the workspace host.",
    group: "host",
    authorityCategory: {
      domain: "computer",
      verb: "act",
    },
  },
  "application.update": {
    title: "Install an application update",
    action: "install an application update",
    description: "Allows {requesterKind} to install an application update.",
    group: "host",
    authorityCategory: {
      domain: "computer",
      verb: "act",
    },
  },
  "approvals.decide": {
    title: "Respond to a workspace request",
    action: "respond to a workspace request",
    description: "Allows {requesterKind} to respond to a workspace request.",
    group: "approvals",
    authorityCategory: {
      domain: "safety",
      verb: "manage",
    },
  },
  "approvals.read": {
    title: "View requests awaiting your decision",
    action: "view requests awaiting your decision",
    description: "Allows {requesterKind} to view requests awaiting your decision.",
    group: "approvals",
    authorityCategory: {
      domain: "safety",
      verb: "manage",
    },
  },
  "automations.control": {
    title: "Pause recurring workspace tasks",
    action: "pause recurring workspace tasks",
    description: "Allows {requesterKind} to pause recurring workspace tasks.",
    group: "workspace",
    authorityCategory: {
      domain: "automation",
      verb: "act",
    },
  },
  "browser-form-fill.manage": {
    title: "Save form-fill values",
    action: "save personal form-fill values",
    description:
      "Allows {requesterKind} to save the personal form values shown in a browser submission prompt.",
    group: "credentials",
    authorityCategory: {
      domain: "accounts",
      verb: "act",
    },
  },
  "browser-passwords.manage": {
    title: "Save this password choice",
    action: "save this password choice",
    description:
      "Allows {requesterKind} to save a password or remember that password saving is disabled for this site.",
    group: "credentials",
    authorityCategory: {
      domain: "accounts",
      verb: "manage",
    },
  },
  "code-runner.reset": {
    title: "Reset the code runner",
    action: "reset the code runner",
    description: "Allows {requesterKind} to reset the code runner.",
    group: "runtime",
    authorityCategory: {
      domain: "automation",
      verb: "act",
    },
  },
  "connected-client.transport": {
    title: "Use a connected client",
    action: "send an authenticated request to a connected client",
    description:
      "Allows {requesterKind} to communicate with an exact connected client on the current account.",
    group: "runtime",
    authorityCategory: {
      domain: "computer",
      verb: "manage",
    },
  },
  "connections.approve": {
    title: "Allow a new client connection",
    action: "allow a new client connection",
    description: "Allows {requesterKind} to allow a new client connection.",
    group: "accounts",
    authorityCategory: {
      domain: "computer",
      verb: "manage",
    },
  },
  "content.trust.policy.manage": {
    title: "Always trust matching outside content",
    action: "always trust matching outside content",
    description: "Allows {requesterKind} to always trust matching outside content.",
    group: "approvals",
    authorityCategory: {
      domain: "safety",
      verb: "manage",
    },
  },
  "content.trust.vouch": {
    title: "Trust this exact outside content",
    action: "trust this exact outside content",
    description: "Allows {requesterKind} to trust this exact outside content.",
    group: "approvals",
    authorityCategory: {
      domain: "safety",
      verb: "manage",
    },
  },
  "context.clone": {
    title: "Copy another task's workspace",
    action: "copy another task's workspace",
    description: "Allows {requesterKind} to copy another task's workspace.",
    group: "runtime",
    authorityCategory: {
      domain: "files",
      verb: "act",
    },
  },
  "context.materialize": {
    title: "Prepare a task workspace folder",
    action: "prepare a task workspace folder",
    description: "Allows {requesterKind} to prepare a task workspace folder.",
    group: "workspace",
    authorityCategory: {
      domain: "files",
      verb: "act",
    },
  },
  "context.relationships.record": {
    title: "Link related task workspaces",
    action: "link related task workspaces",
    description: "Allows {requesterKind} to link related task workspaces.",
    group: "runtime",
    authorityCategory: {
      domain: "files",
      verb: "act",
    },
  },
  "context.semantic.drop": {
    title: "Delete a semantic workspace",
    action: "delete a semantic workspace",
    description: "Allows {requesterKind} to permanently remove one exact owned semantic workspace.",
    group: "runtime",
    authorityCategory: {
      domain: "files",
      verb: "manage",
    },
  },
  "context.semantic.fork": {
    title: "Fork a semantic workspace",
    action: "fork a semantic workspace",
    description: "Allows {requesterKind} to create one exact owned semantic child workspace.",
    group: "runtime",
    authorityCategory: {
      domain: "files",
      verb: "act",
    },
  },
  "credentials.audit.read": {
    title: "View connected-account activity",
    action: "view connected-account activity",
    description: "Allows {requesterKind} to view connected-account activity.",
    group: "credentials",
    authorityCategory: {
      domain: "safety",
      verb: "see",
    },
  },
  "development.native.build.retire": {
    title: "Retire a development build",
    action: "retire a development build",
    description:
      "Allows {requesterKind} to remove the private execution root proven by one exact run.",
    group: "runtime",
    authorityCategory: {
      domain: "computer",
      verb: "manage",
    },
  },
  "development.native.execute": {
    title: "Build exact workspace source",
    action: "build exact workspace source",
    description:
      "Allows {requesterKind} to install frozen dependencies and execute one reviewed build closure.",
    group: "runtime",
    authorityCategory: {
      domain: "automation",
      verb: "act",
    },
  },
  "development.native.session.retire": {
    title: "Retire a native development tool",
    action: "retire a native development tool",
    description:
      "Allows {requesterKind} to remove the proven process and private tree for one exact tool.",
    group: "runtime",
    authorityCategory: {
      domain: "computer",
      verb: "manage",
    },
  },
  "devices.pair": {
    title: "Pair a device",
    action: "pair a device",
    description: "Allows {requesterKind} to pair a device.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "manage",
    },
  },
  "devices.read": {
    title: "View connected devices",
    action: "view connected devices",
    description: "Allows {requesterKind} to view connected devices.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "see",
    },
  },
  "devices.revoke": {
    title: "Disconnect a device",
    action: "disconnect a device",
    description: "Allows {requesterKind} to disconnect a device.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "manage",
    },
  },
  "external.open": {
    title: "Open links in other applications",
    action: "open links in other applications",
    description: "Allows {requesterKind} to open links in other applications.",
    group: "network",
    authorityCategory: {
      domain: "sharing",
      verb: "act",
    },
  },
  "governance.read": {
    title: "View workspace governance settings",
    action: "view workspace governance settings",
    description: "Allows {requesterKind} to view workspace governance settings.",
    group: "approvals",
    authorityCategory: {
      domain: "safety",
      verb: "see",
    },
  },
  "network.response.read": {
    title: "Let workspace apps read website responses",
    action: "let workspace apps read website responses",
    description: "Allows {requesterKind} to let workspace apps read website responses.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "panel.inspect": {
    title: "Inspect a panel with developer tools",
    action: "inspect a panel with developer tools",
    description: "Allows {requesterKind} to inspect a panel with developer tools.",
    group: "panels",
    authorityCategory: {
      domain: "computer",
      verb: "see",
    },
  },
  "panel.presence.read": {
    title: "View who is using a panel",
    action: "view who is using a panel",
    description: "Allows {requesterKind} to view who is using a panel.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "see",
    },
  },
  "panel.presence.update": {
    title: "Mark a panel as active",
    action: "mark a panel as active",
    description: "Allows {requesterKind} to mark a panel as active.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "act",
    },
  },
  "permissions.read": {
    title: "View saved site permissions",
    action: "view saved site permissions",
    description: "Allows {requesterKind} to view saved site permissions.",
    group: "approvals",
    authorityCategory: {
      domain: "safety",
      verb: "manage",
    },
  },
  "permissions.revoke": {
    title: "Remove a saved site permission",
    action: "remove a saved site permission",
    description: "Allows {requesterKind} to remove a saved site permission.",
    group: "approvals",
    authorityCategory: {
      domain: "safety",
      verb: "manage",
    },
  },
  "presence.read": {
    title: "View who is currently active",
    action: "view who is currently active",
    description: "Allows {requesterKind} to view who is currently active.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "see",
    },
  },
  "protected-input.submit": {
    title: "Submit account-provider settings",
    action: "submit account-provider settings",
    description: "Allows {requesterKind} to submit account-provider settings.",
    group: "approvals",
    authorityCategory: {
      domain: "accounts",
      verb: "act",
    },
  },
  "push.manage": {
    title: "View devices registered for notifications",
    action: "view devices registered for notifications",
    description: "Allows {requesterKind} to view devices registered for notifications.",
    group: "notifications",
    authorityCategory: {
      domain: "people",
      verb: "manage",
    },
  },
  "push.send": {
    title: "Send a notification",
    action: "send a notification",
    description: "Allows {requesterKind} to send a notification.",
    group: "notifications",
    authorityCategory: {
      domain: "sharing",
      verb: "act",
    },
  },
  "remote-client.clear": {
    title: "Clear a remote connection",
    action: "clear a remote connection",
    description: "Allows {requesterKind} to clear a remote connection.",
    group: "credentials",
    authorityCategory: {
      domain: "people",
      verb: "manage",
    },
  },
  "remote-client.connect": {
    title: "Pair a remote connection",
    action: "pair a remote connection",
    description: "Allows {requesterKind} to pair a remote connection.",
    group: "credentials",
    authorityCategory: {
      domain: "people",
      verb: "manage",
    },
  },
  "remote-client.read": {
    title: "View the current remote connection",
    action: "view the current remote connection",
    description: "Allows {requesterKind} to view the current remote connection.",
    group: "credentials",
    authorityCategory: {
      domain: "people",
      verb: "see",
    },
  },
  "reviewed-closure.retire": {
    title: "Retire reviewed automation",
    action: "retire reviewed automation",
    description: "Allows {requesterKind} to retire reviewed automation.",
    group: "runtime",
    authorityCategory: {
      domain: "safety",
      verb: "manage",
    },
  },
  "reviewed-closure.suspend": {
    title: "Pause reviewed automation",
    action: "pause reviewed automation",
    description: "Allows {requesterKind} to pause reviewed automation.",
    group: "runtime",
    authorityCategory: {
      domain: "safety",
      verb: "manage",
    },
  },
  "runtime.execution.recover": {
    title: "Recover a runtime execution",
    action: "recover a runtime execution",
    description:
      "Allows {requesterKind} to restore an exact retained execution or explicitly replace one unavailable incarnation.",
    group: "runtime",
    authorityCategory: {
      domain: "automation",
      verb: "manage",
    },
  },
  "runtime.inspect": {
    title: "Inspect workspace runtimes",
    action: "inspect workspace runtimes",
    description: "Allows {requesterKind} to inspect workspace runtimes.",
    group: "runtime",
    authorityCategory: {
      domain: "computer",
      verb: "see",
    },
  },
  "runtime.supervision.manage": {
    title: "Start an executable release",
    action: "start an executable release",
    description: "Allows {requesterKind} to start one exact executable release.",
    group: "runtime",
    authorityCategory: {
      domain: "automation",
      verb: "manage",
    },
  },
  "security.audit.read": {
    title: "View the security activity log",
    action: "view the security activity log",
    description: "Allows {requesterKind} to view the security activity log.",
    group: "approvals",
    authorityCategory: {
      domain: "safety",
      verb: "see",
    },
  },
  "server-logs.read": {
    title: "View server logs",
    action: "view server logs",
    description: "Allows {requesterKind} to view server logs.",
    group: "host",
    authorityCategory: {
      domain: "computer",
      verb: "see",
    },
  },
  "service:browserEnvironment.cancelDownload": {
    title: "Cancel browser downloads",
    action: "cancel browser downloads",
    description: "Allows {requesterKind} to cancel active browser downloads.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "manage",
    },
  },
  "service:browserEnvironment.cancelImportRead": {
    title: "Cancel browser data reading",
    action: "cancel browser data reading",
    description: "Allows {requesterKind} to cancel an active browser data import read.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "manage",
    },
  },
  "service:browserEnvironment.flushCookieProjection": {
    title: "Synchronize website cookies",
    action: "synchronize website cookies",
    description: "Allows {requesterKind} to reconcile website cookies with the browser host.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "manage",
    },
  },
  "service:browserEnvironment.getCookieProjectionDiagnostics": {
    title: "View cookie synchronization diagnostics",
    action: "view cookie synchronization diagnostics",
    description: "Allows {requesterKind} to inspect website cookie synchronization status.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "service:browserEnvironment.getImportHost": {
    title: "Access browser import details",
    action: "access browser import details",
    description: "Allows {requesterKind} to inspect the available browser import provider.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "service:browserEnvironment.listDownloads": {
    title: "View browser downloads",
    action: "view browser downloads",
    description: "Allows {requesterKind} to view current and recent browser downloads.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "service:browserEnvironment.listImportOpenTabs": {
    title: "View browser tabs available to import",
    action: "view browser tabs available to import",
    description: "Allows {requesterKind} to view browser tabs available for import.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "service:browserEnvironment.listImportSources": {
    title: "Find browser profiles to import",
    action: "find browser profiles to import",
    description: "Allows {requesterKind} to find browser profiles available for import.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "service:browserEnvironment.nextImportFrame": {
    title: "Continue reading browser data",
    action: "continue reading browser data for import",
    description: "Allows {requesterKind} to continue a browser data import read.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "service:browserEnvironment.openDownload": {
    title: "Open downloaded files",
    action: "open downloaded files",
    description: "Allows {requesterKind} to open downloaded files on this computer.",
    group: "network",
    authorityCategory: {
      domain: "computer",
      verb: "act",
    },
  },
  "service:browserEnvironment.pauseDownload": {
    title: "Pause browser downloads",
    action: "pause browser downloads",
    description: "Allows {requesterKind} to pause active browser downloads.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "manage",
    },
  },
  "service:browserEnvironment.previewImportSource": {
    title: "Preview browser data for import",
    action: "preview browser data for import",
    description: "Allows {requesterKind} to preview browser data available for import.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "service:browserEnvironment.resumeDownload": {
    title: "Resume browser downloads",
    action: "resume browser downloads",
    description: "Allows {requesterKind} to resume paused browser downloads.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "manage",
    },
  },
  "service:browserEnvironment.revealDownload": {
    title: "Show downloaded files",
    action: "show downloaded files on this computer",
    description: "Allows {requesterKind} to reveal downloaded files in the file manager.",
    group: "network",
    authorityCategory: {
      domain: "computer",
      verb: "act",
    },
  },
  "service:browserEnvironment.startImportRead": {
    title: "Read browser data for import",
    action: "read browser data for import",
    description: "Allows {requesterKind} to read browser data selected for import.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "subagents.create": {
    title: "Launch an external subagent",
    action: "launch an external subagent",
    description:
      "Allows {requesterKind} to launch an external subagent that can act on your behalf in this workspace.",
    group: "automation",
    authorityCategory: {
      domain: "automation",
      verb: "act",
    },
  },
  "users.revoke": {
    title: "Revoke a user's access",
    action: "revoke a user's access",
    description: "Allows {requesterKind} to revoke a user's access.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "manage",
    },
  },
  "webhooks.manage": {
    title: "Accept incoming web requests",
    action: "accept incoming web requests",
    description: "Allows {requesterKind} to accept incoming web requests.",
    group: "network",
    authorityCategory: {
      domain: "sharing",
      verb: "manage",
    },
  },
  "workers.storage.reset": {
    title: "Replace Durable Object storage",
    action: "replace Durable Object storage",
    description: "Back up and replace the persisted storage of one exact Durable Object target.",
    group: "runtime",
    authorityCategory: {
      domain: "automation",
      verb: "act",
    },
  },
  "workspace.build-cache.manage": {
    title: "Inspect build cache retention",
    action: "inspect build cache retention",
    description:
      "Allows {requesterKind} to inspect retained and unreferenced build files without removing them.",
    group: "workspace",
    authorityCategory: {
      domain: "automation",
      verb: "act",
    },
  },
  "workspace.config.apply": {
    title: "Apply workspace configuration",
    action: "apply workspace configuration",
    description: "Allows {requesterKind} to apply an exact reviewed workspace configuration.",
    group: "workspace",
    authorityCategory: {
      domain: "automation",
      verb: "manage",
    },
  },
  "workspace.configure": {
    title: "Change workspace settings",
    action: "change workspace settings",
    description: "Allows {requesterKind} to change workspace settings.",
    group: "workspace",
    authorityCategory: {
      domain: "automation",
      verb: "manage",
    },
  },
  "workspace.dependencies.inspect": {
    title: "Inspect installed packages for an app, panel, worker, or extension",
    action: "inspect installed packages for an app, panel, worker, or extension",
    description:
      "Allows {requesterKind} to inspect installed packages for an app, panel, worker, or extension.",
    group: "workspace",
    authorityCategory: {
      domain: "automation",
      verb: "see",
    },
  },
  "workspace.gateway.access": {
    title: "Access a workspace gateway address",
    action: "access a workspace gateway address",
    description: "Allows {requesterKind} to access a workspace gateway address.",
    group: "network",
    authorityCategory: {
      domain: "web",
      verb: "see",
    },
  },
  "workspace.members.manage": {
    title: "Add a workspace member",
    action: "add a workspace member",
    description: "Allows {requesterKind} to add a workspace member.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "manage",
    },
  },
  "workspace.members.read": {
    title: "View workspace members",
    action: "view workspace members",
    description: "Allows {requesterKind} to view workspace members.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "see",
    },
  },
  "workspace.members.remove": {
    title: "Remove a workspace member",
    action: "remove a workspace member",
    description: "Allows {requesterKind} to remove a workspace member.",
    group: "accounts",
    authorityCategory: {
      domain: "people",
      verb: "manage",
    },
  },
  "workspace.runtime-state.inspect": {
    title: "Inspect running workspace services",
    action: "inspect apps, panels, background tasks, and scheduled work that's currently running",
    description: "Read the current structure and status of running workspace services",
    group: "workspace",
    authorityCategory: {
      domain: "automation",
      verb: "see",
    },
  },
  "workspace.runtime-state.manage": {
    title: "Manage running workspace services",
    action: "manage apps, panels, background tasks, and scheduled work that's currently running",
    description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
    group: "workspace",
    authorityCategory: {
      domain: "automation",
      verb: "manage",
    },
  },
  "workspace.storage.delete": {
    title: "Delete stored workspace data",
    action: "delete stored workspace data",
    description: "Allows {requesterKind} to delete stored workspace data.",
    group: "files",
    authorityCategory: {
      domain: "files",
      verb: "act",
    },
  },
  "workspace.storage.materialize": {
    title: "Restore a stored folder tree",
    action: "restore a stored folder tree",
    description: "Allows {requesterKind} to restore a stored folder tree.",
    group: "files",
    authorityCategory: {
      domain: "files",
      verb: "act",
    },
  },
  "workspaces.create": {
    title: "Create a workspace",
    action: "create a workspace",
    description: "Allows {requesterKind} to create a workspace.",
    group: "accounts",
    authorityCategory: {
      domain: "automation",
      verb: "act",
    },
  },
  "workspaces.delete": {
    title: "Delete a workspace",
    action: "delete a workspace",
    description: "Allows {requesterKind} to delete a workspace.",
    group: "accounts",
    authorityCategory: {
      domain: "automation",
      verb: "act",
    },
  },
  "workspaces.open": {
    title: "Connect to a workspace",
    action: "connect to a workspace",
    description: "Allows {requesterKind} to connect to a workspace.",
    group: "accounts",
    authorityCategory: {
      domain: "files",
      verb: "act",
    },
  },
  "workspaces.read": {
    title: "View available workspaces",
    action: "view available workspaces",
    description: "Allows {requesterKind} to view available workspaces.",
    group: "accounts",
    authorityCategory: {
      domain: "files",
      verb: "see",
    },
  },
} as const satisfies Record<string, CapabilityPresentation>;

export function generatedHostMethodAuthority(method: string): GeneratedHostAuthorityMethod | null {
  return Object.prototype.hasOwnProperty.call(HOST_AUTHORITY_METHODS, method)
    ? HOST_AUTHORITY_METHODS[method as keyof typeof HOST_AUTHORITY_METHODS]
    : null;
}

export function generatedHostCapabilityCategory(
  capability: string
): NonNullable<CapabilityPresentation["authorityCategory"]> | null {
  return Object.prototype.hasOwnProperty.call(HOST_CAPABILITY_CATEGORIES, capability)
    ? HOST_CAPABILITY_CATEGORIES[capability as keyof typeof HOST_CAPABILITY_CATEGORIES]
    : null;
}

export function generatedHostCapabilityPresentation(
  capability: string
): CapabilityPresentation | null {
  return Object.prototype.hasOwnProperty.call(HOST_SEMANTIC_PRESENTATIONS, capability)
    ? HOST_SEMANTIC_PRESENTATIONS[capability as keyof typeof HOST_SEMANTIC_PRESENTATIONS]
    : null;
}

export function generatedHostCapabilityMethods(capability: string): readonly string[] {
  return Object.entries(HOST_AUTHORITY_METHODS)
    .filter(([, row]) => row.capability === capability)
    .map(([method]) => method);
}
