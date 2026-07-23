import type { MethodTierPolicy } from "../serviceAuthority.js";

/** Reviewed P2 fallback census for the static host service surface. */
export type MethodTierDecision = MethodTierPolicy;

export const METHOD_TIERS = {
  "account.getProfile": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: ordinary workspace participant rendering; principal and workspace admission still apply",
  },
  "account.isMember": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: ordinary workspace membership rendering; principal and workspace admission still apply",
  },
  "account.listWorkspaceMembers": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: ordinary workspace participant rendering; principal and workspace admission still apply",
  },
  "account.resolveProfiles": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: ordinary workspace participant rendering; principal and workspace admission still apply",
  },
  "adblock.addCustomList": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "adblock.addToWhitelist": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "adblock.getConfig": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "adblock.getPanelUrl": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "adblock.getStats": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "adblock.getStatsForPanel": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "adblock.isActive": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "adblock.isEnabledForPanel": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "adblock.rebuildEngine": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "adblock.removeCustomList": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "adblock.removeFromWhitelist": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "adblock.resetStats": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "adblock.resetStatsForPanel": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "adblock.setEnabled": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "adblock.setEnabledForPanel": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "adblock.setListEnabled": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "app.applyUpdate": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "app.clearBuildCache": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "app.getInfo": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "app.getShellPages": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "app.getSystemTheme": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "app.listPendingUpdates": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "app.openDevTools": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "app.openExternal": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "app.openWorkspacePath": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "app.setThemeMode": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "audit.query": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "autofill.confirmSave": {
    tier: "gated",
    session: "family",
    rationale: "Stores or suppresses a credential only after an explicit browser save prompt.",
  },
  "autofill.deleteSavedPassword": {
    tier: "critical",
    session: "family",
    rationale: "Permanently deletes a stored credential.",
  },
  "autofill.listNeverSaveOrigins": {
    tier: "gated",
    session: "family",
    rationale: "The user's password-save suppression list is private browser state.",
  },
  "autofill.listSavedPasswords": {
    tier: "gated",
    session: "family",
    rationale: "Saved account names and origins are private credential metadata.",
  },
  "autofill.removeNeverSaveOrigin": {
    tier: "gated",
    session: "family",
    rationale: "Changes persistent browser credential-prompt policy for an origin.",
  },
  "auth.getConnectionInfo": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "auth.grantConnection": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "auth.mintAgentCredential": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 durable code identity or host approval plumbing",
  },
  "auth.revokeAgentCredential": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 durable code identity or host approval plumbing",
  },
  "authority.awaitDecision": {
    tier: "open",
    session: "family",
    rationale:
      "An acquisition owner may wait on its existing human-decision lifecycle; the wait grants nothing",
  },
  "authority.preflight": {
    tier: "open",
    session: "family",
    rationale:
      "Pure authority inspection; it neither prompts, mints, consumes, nor invokes a handler",
  },
  "blobstore.delete": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "blobstore.diffTrees": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.getBase64": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.getRange": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.getRangeBytes": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.getText": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.getTree": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.grep": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.has": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.list": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.listTree": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.materializeTree": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "blobstore.putBase64": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.putText": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.putTree": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.readFileAtTree": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "blobstore.stat": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "build.doctorExtension": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "build.gc": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "build.getAboutPages": {
    tier: "open",
    session: "family",
    rationale: "Read-only discovery of workspace-local launcher metadata",
  },
  "build.getBuild": {
    tier: "open",
    session: "family",
    rationale:
      "Workspace-local compilation into an immutable cache; no publication, install, or external acquisition",
  },
  "build.getBuildMetadata": {
    tier: "open",
    session: "family",
    rationale: "Read-only inspection of an immutable local build record",
  },
  "build.getBuildNpm": {
    tier: "gated",
    session: "family",
    rationale:
      "G5: external package acquisition is gated; installed code and explicitly approved eval sessions share the reviewed code family",
  },
  "build.getBuildReport": {
    tier: "open",
    session: "family",
    rationale:
      "Workspace-local compilation and diagnostics; no publication, install, or external acquisition",
  },
  "build.getEffectiveVersion": {
    tier: "open",
    session: "family",
    rationale: "Read-only discovery of a content-derived local unit identity",
  },
  "build.getPanelMetadata": {
    tier: "open",
    session: "family",
    rationale: "Read-only discovery of workspace-local panel metadata",
  },
  "build.hasUnit": {
    tier: "open",
    session: "family",
    rationale: "Read-only lookup in the caller-visible workspace graph",
  },
  "build.inspectBuildProvenance": {
    tier: "open",
    session: "family",
    rationale: "Read-only inspection of caller-visible local build provenance",
  },
  "build.listRecentBuildEvents": {
    tier: "open",
    session: "family",
    rationale: "Read-only diagnostics for workspace-local build activity",
  },
  "build.listSkills": {
    tier: "open",
    session: "family",
    rationale: "Read-only discovery of caller-visible workspace skill packages",
  },
  "build.recompute": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "corsApproval.authorize": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "The transport is open to declared code; its exact target origin is a prepared gated network.response.read leaf",
  },
  "contentTrust.addPolicy": {
    tier: "critical",
    session: "codeOnly",
    rationale:
      "A future-content trust policy changes the authority meaning of content that has not yet been observed",
  },
  "contentTrust.list": {
    tier: "open",
    session: "codeOnly",
    rationale: "Human governance read; sessions cannot inspect the workspace trust ledger",
  },
  "contentTrust.revoke": {
    tier: "critical",
    session: "codeOnly",
    rationale:
      "Revocation changes which external content may enter future internal-context sessions",
  },
  "contentTrust.status": {
    tier: "open",
    session: "codeOnly",
    rationale: "Human governance read of the one-way context-integrity cutover",
  },
  "contentTrust.vouch": {
    tier: "gated",
    session: "codeOnly",
    rationale: "An exact content-addressed vouch changes future context classification",
  },
  "contextIntegrity.fact": {
    tier: "open",
    session: "family",
    rationale: "A session may inspect its own monotone ingestion latch",
  },
  "contextIntegrity.ingest": {
    tier: "open",
    session: "family",
    rationale:
      "A session may only tighten its own context classification through a registered chokepoint",
  },
  "credentials.audit": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.cancelOAuth": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.completeCapture": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.configureClient": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.connect": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.deleteClientConfig": {
    tier: "critical",
    session: "family",
    rationale:
      "C1: destroys credential or client secret material; §2 default {code, session} family",
  },
  "credentials.forwardOAuthCallback": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.getClientConfigStatus": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: secret-free provider setup status used by onboarding; the config trust-scope check still applies",
  },
  "credentials.inspectStoredCredentials": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.listStoredCredentials": {
    tier: "open",
    session: "family",
    rationale:
      "Secret-free lifecycle projection used by the open model-availability catalog; credential inspection and use remain gated",
  },
  "credentials.proxyFetch": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.proxyGitHttp": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.requestCredentialInput": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.resolveCredential": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "credentials.revokeCredential": {
    tier: "critical",
    session: "family",
    rationale:
      "C1: destroys credential or client secret material; §2 default {code, session} family",
  },
  "credentials.storeCredential": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "desktopEvents.watch": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "docs.describe": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: capability discovery and introspection; §2 default {code, session} family",
  },
  "docs.describeService": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: capability discovery and introspection; §2 default {code, session} family",
  },
  "docs.getSchema": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: capability discovery and introspection; §2 default {code, session} family",
  },
  "docs.listServices": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: capability discovery and introspection; §2 default {code, session} family",
  },
  "docs.listSurfaces": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: capability discovery and introspection; §2 default {code, session} family",
  },
  "docs.search": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: capability discovery and introspection; §2 default {code, session} family",
  },
  "eval.cancel": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "eval.deleteScopeValue": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "eval.getRun": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "eval.readScopeTextPage": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "eval.reset": {
    tier: "critical",
    session: "family",
    rationale:
      "C3: irreversible destruction outside VCS protection; §2 default {code, session} family",
  },
  "eval.run": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "eval.startRun": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "events.watch": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "extensions.emit": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.fetchRequestBodyChunk": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.fetchRequestBodyClose": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.health": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.invoke": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.invokeProvider": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.invokeStream": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.list": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.log": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.ready": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "extensions.reload": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 durable code identity or host approval plumbing",
  },
  "extensions.streamingMethods": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "externalOpen.openExternal": {
    tier: "open",
    session: "family",
    rationale:
      "The transport is open; code callers receive one prepared gated external.open leaf scoped to the destination",
  },
  "fs.access": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.appendFile": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.chmod": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.copyFile": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.ensureMaterialized": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.exists": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.glob": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.grep": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.handleClose": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.handleRead": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.handleStat": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.handleWrite": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.lstat": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.mkdir": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.mktemp": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.open": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.readFile": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.readdir": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.readlink": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.realpath": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.rename": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.rm": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.rmdir": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.stat": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.symlink": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.truncate": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.unlink": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.utimes": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "fs.writeFile": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "gateway.fetch": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.commitMapping": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "gitInterop.completeWorkspaceDependencies": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.createDisposableRemote": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.detachUpstream": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.importProject": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.inspectDisposableRemote": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "gitInterop.publishRepo": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.publishToDisposableRemote": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.pullUpstream": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.pushDisposableRemote": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.pushUpstream": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.removeDisposableRemote": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.removeSharedRemote": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.removeUpstream": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.setAutoPush": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.setSharedRemote": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.setUpstream": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "gitInterop.upstreamStatus": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "governance.list": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "hostLifecycle.shutdown": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "hubControl.addWorkspaceMember": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.createWorkspace": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.deleteWorkspace": {
    tier: "critical",
    session: "family",
    rationale:
      "C3: irreversible destruction outside VCS protection; §2 default {code, session} family",
  },
  "hubControl.ensureEphemeralWorkspace": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.getProfile": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.inviteUser": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.listDevices": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.listUserPresence": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.listWorkspaceMembers": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.listWorkspaces": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.pairDevice": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.removeWorkspaceMember": {
    tier: "critical",
    session: "family",
    rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
  },
  "hubControl.revokeDevice": {
    tier: "critical",
    session: "family",
    rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
  },
  "hubControl.revokeUser": {
    tier: "critical",
    session: "family",
    rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
  },
  "hubControl.routeWorkspace": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.setRole": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "hubControl.updateProfile": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "menu.showContext": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "menu.showHamburger": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "menu.showPanelContext": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "mirror.objects": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "mirror.targets": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "mission.approve": {
    tier: "critical",
    session: "codeOnly",
    rationale:
      "Mission approval charters unattended standing authority and always requires a fresh human confirmation",
  },
  "mission.createDraft": {
    tier: "gated",
    session: "codeOnly",
    rationale: "Mission authoring is a human governance surface; drafts remain inert",
  },
  "mission.edit": {
    tier: "gated",
    session: "codeOnly",
    rationale: "Mission charter edits lapse authority and are restricted to the governance surface",
  },
  "mission.finishSession": {
    tier: "gated",
    session: "codeOnly",
    rationale: "Host-only mission lifecycle closure",
  },
  "mission.get": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Human governance read; mission sessions cannot inspect or rewrite their own charter",
  },
  "mission.list": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Human governance read; mission sessions cannot inspect or rewrite their own charter",
  },
  "mission.pause": {
    tier: "gated",
    session: "codeOnly",
    rationale: "Pausing automation is a human governance action",
  },
  "mission.resume": {
    tier: "gated",
    session: "codeOnly",
    rationale: "Resuming automation is a human governance action",
  },
  "mission.retire": {
    tier: "critical",
    session: "codeOnly",
    rationale: "Retirement permanently ends the mission identity and revokes standing allows",
  },
  "mission.startSession": {
    tier: "gated",
    session: "codeOnly",
    rationale: "Host-only trigger handoff for an already approved closure",
  },
  "notification.dismiss": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "notification.reportAction": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "notification.show": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "notification.signalUserInbox": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "palette.list": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "palette.register": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "palette.run": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "palette.unregister": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "panel.ensureLoaded": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.forceReloadView": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.getAddressOptions": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.getBrowserAddressOptions": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.getChromeState": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.getFocusedPanelId": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.getThemeConfig": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.getTreeSnapshot": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.listPinnedPanelIds": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.markBrowserNavigationIntent": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.reloadView": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.takeOver": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.togglePin": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.updateTheme": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panel.updateThemeConfig": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelCdp.consoleHistory": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelCdp.getCdpEndpoint": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "panelCdp.goBack": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelCdp.goForward": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelCdp.hostProvider.close": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "panelCdp.hostProvider.open": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "panelCdp.hostProvider.send": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "panelCdp.navigate": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelCdp.reload": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelCdp.screenshot": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelCdp.stop": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelLog.append": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "panelRuntime.acquire": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "panelRuntime.getSnapshot": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "panelRuntime.registerClient": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "panelRuntime.release": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "panelRuntime.takeOver": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "panelRuntime.unregisterClient": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "panelTree.archive": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.archiveOwnedRoots": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.callAgent": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.close": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.create": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.ensureLoaded": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.expandIds": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.focus": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.getCollapsedIds": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.getFocusedPanelId": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.getRuntimeLease": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.getStateArgs": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.getTreeSnapshot": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.list": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.metadata": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.movePanel": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.navigate": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.navigateHistory": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.openDevTools": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.rebuildAndReload": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.rebuildPanel": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.reload": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.roots": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.setCollapsed": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.setStateArgs": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.snapshot": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.takeOver": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.unload": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "panelTree.updatePanelState": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "permissions.list": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "permissions.revoke": {
    tier: "critical",
    session: "family",
    rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
  },
  "phoneProvisioning.devices": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "phoneProvisioning.install": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "phoneProvisioning.openPairing": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "phoneProvisioning.providers": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "presence.getPanelActiveOwner": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "presence.markPanelActive": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "presence.markPanelsOwned": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "push.listRegistrations": {
    tier: "gated",
    session: "codeOnly",
    rationale: "G4/G5: push-token inventory is private approval plumbing; §3 push precedent",
  },
  "push.register": {
    tier: "gated",
    session: "codeOnly",
    rationale: "G5: push registration is device and approval plumbing; §3 push precedent",
  },
  "push.send": {
    tier: "gated",
    session: "codeOnly",
    rationale: "G1/G5: external push delivery is host approval plumbing; §3 push precedent",
  },
  "push.unregister": {
    tier: "gated",
    session: "codeOnly",
    rationale: "G5: push registration lifecycle is device and approval plumbing; §3 push precedent",
  },
  "remoteCred.clear": {
    tier: "critical",
    session: "family",
    rationale:
      "C1: destroys credential or client secret material; §2 default {code, session} family",
  },
  "remoteCred.getCurrent": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "remoteCred.pair": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "remoteCred.reconnectNow": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "remoteCred.relaunch": {
    tier: "gated",
    session: "family",
    rationale: "G2: credential mediation; §2 default {code, session} family",
  },
  "runtime.activatePanelEntity": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Host-only panel lifecycle plumbing activates an already reserved panel; the method declaration excludes userland callers",
  },
  "runtime.cloneContext": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "runtime.createContext": {
    tier: "open",
    session: "family",
    rationale:
      "Fresh context creation is caller scratch; a prepared context.boundary leaf gates reuse of live foreign state",
  },
  "runtime.createEntity": {
    tier: "open",
    session: "family",
    rationale:
      "Caller-owned entity/context creation is task scratch; an existing foreign context is independently gated by the prepared context.boundary leaf",
  },
  "runtime.createSubagentContext": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "runtime.destroyContext": {
    tier: "open",
    session: "family",
    rationale:
      "Caller-owned scratch teardown is lifecycle cleanup; a critical prepared context.boundary leaf protects foreign or unowned state",
  },
  "runtime.listEntities": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "runtime.listOwnedContexts": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "runtime.recordContextEdge": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "runtime.reservePanelEntity": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Host-only panel lifecycle plumbing reserves a non-executable identity; the method declaration excludes userland callers",
  },
  "runtime.resolveContext": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "runtime.retireEntity": {
    tier: "open",
    session: "family",
    rationale:
      "Retiring self/child scratch is lifecycle cleanup; a critical prepared context.boundary leaf protects foreign entities",
  },
  "runtime.setTitle": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "serverLog.query": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "serverLog.stats": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "serverLog.tail": {
    tier: "gated",
    session: "family",
    rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
  },
  "settings.getData": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "shellApproval.blockCapability": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.listPending": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.resolve": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.resolveBootstrap": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.resolveExternalAgent": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.resolveExternalAgentByRequest": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.resolveUserland": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.submitClientConfig": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.submitCredentialInput": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellApproval.submitSecretInput": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "shellPresence.heartbeat": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "userlandApproval.list": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "userlandApproval.request": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "userlandApproval.requestAs": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "userlandApproval.requestExternal": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "userlandApproval.requestSecretInput": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "userlandApproval.requestSecretInputAs": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "userlandApproval.revoke": {
    tier: "critical",
    session: "codeOnly",
    rationale:
      "C2: removes authority or identity membership; §2 durable code identity or host approval plumbing",
  },
  "userlandApproval.settleExternal": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "vcs.blame": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.commit": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.compare": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.copy": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.discard": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.edit": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.history": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.importSnapshot": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.inspect": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.integrate": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.listFiles": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.move": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.neighbors": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.push": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.readFile": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.resolveRepository": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.revert": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "vcs.status": {
    tier: "open",
    session: "family",
    rationale:
      "P-fs/VCS: workspace-local, version-protected operation; §2 default {code, session} family",
  },
  "view.bindNativePanelSlot": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.browserForceReload": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.browserGoBack": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.browserGoForward": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.browserNavigate": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.browserReload": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.browserStop": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.clearNativePanelSlot": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.forwardMouseClick": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.hideContentOverlay": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.hideNativeShellOverlay": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.setBounds": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.setHostedShellReady": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.setShellOverlay": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.setThemeCss": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.setVisible": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.showContentOverlay": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.showNativeShellOverlay": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.updateContentOverlay": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.updateNativePanelSlot": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "view.updateNativeShellOverlay": {
    tier: "open",
    session: "family",
    rationale:
      "P-panels: core mutually inspectable workspace UX; §2 default {code, session} family",
  },
  "webhookIngress.createSubscription": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "webhookIngress.listSubscriptions": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "webhookIngress.revokeSubscription": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "webhookIngress.rotateSecret": {
    tier: "gated",
    session: "family",
    rationale: "G1: external-system effect or listening surface; §2 default {code, session} family",
  },
  "workerLog.write": {
    tier: "open",
    session: "codeOnly",
    rationale:
      "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
  },
  "workerdInspector.getEndpoint": {
    tier: "open",
    session: "family",
    rationale:
      "The transport is open; non-chrome code receives one prepared gated runtime.inspect leaf",
  },
  "workerdInspector.listTargets": {
    tier: "open",
    session: "family",
    rationale: "Read-only discovery of inspectable processes; attaching remains gated",
  },
  "workers.listServices": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: capability discovery and introspection; §2 default {code, session} family",
  },
  "workers.listSources": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: capability discovery and introspection; §2 default {code, session} family",
  },
  "workers.resolveDurableObject": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: agent sessions must resolve only the structurally exposed durable targets in their mission envelope",
  },
  "workers.resolveService": {
    tier: "open",
    session: "family",
    rationale:
      "P-discovery: agent sessions must resolve only the structurally exposed services in their mission envelope",
  },
  "workspace.ensureContextFolder": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.findUnitForPath": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.getActive": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.getAgentsMd": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.getConfig": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.getInfo": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.heartbeats.list": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.heartbeats.pause": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.heartbeats.resume": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.heartbeats.runNow": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.beginLaunch": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.cancelLaunchSession": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.clearSelection": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.getLaunchSession": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.getSelection": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.launch": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.list": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.preparePinnedRef": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.resolveLaunchSessionApproval": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.setSelection": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.hostTargets.versions": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.listSkills": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.readSkill": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.recurring.list": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.setConfigField": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.setInitPanels": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.sourceTree": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.units.bakeAppDist": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.units.diagnostics": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.units.inspector": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.units.list": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.units.logs": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.units.restart": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.units.rollback": {
    tier: "gated",
    session: "family",
    rationale:
      "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
  },
  "workspace.units.versions": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
  "workspace.validateConfig": {
    tier: "open",
    session: "family",
    rationale:
      "Pure validation of caller-supplied candidate configuration has no workspace effect; §2 default {code, session} family",
  },
  "workspace-state.alarmClear": {
    tier: "open",
    session: "family",
    rationale:
      "Runtime-intrinsic self-alarm cleanup is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
  },
  "workspace-state.alarmSet": {
    tier: "open",
    session: "family",
    rationale:
      "Runtime-intrinsic self-alarm scheduling is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
  },
  "workspace-state.entity.resolveActive": {
    tier: "open",
    session: "family",
    rationale: "Workspace-member runtime metadata read; no C1-C4 or G1-G5 rule applies",
  },
  "workspace-state.entity.resolve": {
    tier: "open",
    session: "family",
    rationale:
      "Workspace-member runtime metadata read, including a preparing reservation; no C1-C4 or G1-G5 rule applies",
  },
  "workspace-state.heartbeatRegister": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "workspace-state.heartbeatRemove": {
    tier: "gated",
    session: "codeOnly",
    rationale:
      "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
  },
  "workspace-state.lifecycleLeaseClear": {
    tier: "open",
    session: "family",
    rationale:
      "Runtime-intrinsic self-lease cleanup is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
  },
  "workspace-state.lifecycleLeaseUpsert": {
    tier: "open",
    session: "family",
    rationale:
      "Runtime-intrinsic self-lease tracking is not discretionary authority; the receiver requires an exact DO lifecycle-key match or a host-originated call",
  },
  "workspace-state.panel.incrementAccess": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.panel.index": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.panel.rebuildIndex": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.panel.search": {
    tier: "open",
    session: "family",
    rationale: "Workspace-member panel-index read; no C1-C4 or G1-G5 rule applies",
  },
  "workspace-state.panel.updateTitle": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.slot.close": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.slot.commitPreparedNavigation": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.slot.create": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.slot.get": {
    tier: "open",
    session: "family",
    rationale: "Workspace-member slot-state read; no C1-C4 or G1-G5 rule applies",
  },
  "workspace-state.slot.history": {
    tier: "open",
    session: "family",
    rationale: "Workspace-member slot-history read; no C1-C4 or G1-G5 rule applies",
  },
  "workspace-state.slot.list": {
    tier: "open",
    session: "family",
    rationale: "Workspace-member slot-state read; no C1-C4 or G1-G5 rule applies",
  },
  "workspace-state.slot.move": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.slot.resolveByEntity": {
    tier: "open",
    session: "family",
    rationale: "Workspace-member entity-to-slot lookup; no C1-C4 or G1-G5 rule applies",
  },
  "workspace-state.slot.setParent": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.slot.setPosition": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspace-state.slot.updateCurrentStateArgs": {
    tier: "gated",
    session: "family",
    rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
  },
  "workspacePresence.list": {
    tier: "open",
    session: "family",
    rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
  },
} as const satisfies Record<string, MethodTierDecision>;

export type ReviewedHostMethod = keyof typeof METHOD_TIERS;

export function methodTier(method: string): MethodTierDecision | null {
  return Object.prototype.hasOwnProperty.call(METHOD_TIERS, method)
    ? METHOD_TIERS[method as ReviewedHostMethod]
    : null;
}
