#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { requireDevelopmentTemplateCheckouts } from "../src/dev/developmentTemplateConfig.cjs";
import { workflowReviewer } from "./review-live-workflow-teacher.mjs";

const sharedProgram = "skills/vibestudio-workflows/runWorkflow.nl";
const panelWorkflow = {
  family: "workspace-panel-repair",
  namespace: "vibestudio:panel-repair",
  group: "draft-navigation",
  failedChecks: ["preservesUnsavedDraft"],
  validator: { template: "system-testing", path: "skills/system-testing/panel-repair-oracle.ts" },
  program: "skills/workspace-dev/panel-repair/repairPanel.nl",
  root: "repairPanel",
  evidence: panelEvidence,
};
const integrationWorkflow = {
  family: "workspace-vcs-integration",
  namespace: "vibestudio:workspace-integration",
  group: "settings-conflict",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/vcs-integration-oracle.ts",
  },
  program: "skills/vibestudio-vcs/integration/integrateWorkspace.nl",
  root: "integrateWorkspace",
  evidence: integrationEvidence,
};
const unitRepairWorkflow = {
  family: "workspace-unit-repair",
  namespace: "vibestudio:unit-repair",
  group: "worker-label-normalizer",
  validator: { template: "system-testing", path: "skills/system-testing/unit-repair-oracle.ts" },
  program: "skills/workspace-dev/unit-repair/repairUnit.nl",
  root: "repairUnit",
  evidence: unitRepairEvidence,
};
const contentWorkflow = {
  family: "workspace-content-project",
  namespace: "vibestudio:content-project",
  group: "grounded-project-delivery",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/content-project-oracle.ts",
  },
  program: "skills/workspace-dev/content-project/deliverProject.nl",
  root: "deliverProject",
  requiresReview: true,
  evidence: contentProjectEvidence,
};
const ownedOperationsWorkflow = {
  family: "workspace-owned-operations",
  namespace: "vibestudio:owned-operations",
  group: "durable-worker-handoff",
  validator: { template: "base", path: "packages/natlang-services/src/ownedOperationsOracle.ts" },
  program: "skills/agents/operational-handoff/operate.nl",
  root: "operate",
  evidence: ownedOperationsEvidence,
};
const messagingWorkflow = {
  family: "workspace-local-messaging",
  namespace: "vibestudio:local-messaging",
  group: "scoped-addressed-delivery",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/local-messaging/verify-outcome.mjs",
  },
  root: "routeMessage",
  evidence: localMessagingEvidence,
};
const scratchHandoffWorkflow = {
  family: "workspace-scratch-handoff",
  namespace: "vibestudio:scratch-handoff",
  group: "workspace-filesystem-evidence",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/scratch-handoff-managed.ts",
  },
  root: "assembleHandoff",
  evidence: scratchHandoffEvidence,
};
const integrationHandoffWorkflow = {
  family: "workspace-integration-handoff",
  namespace: "vibestudio:integration-handoff",
  group: "integrated-filesystem-evidence",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/integration-handoff-managed.ts",
  },
  skills: ["integrateWorkspace", "assembleHandoff"],
  evidence: integrationHandoffEvidence,
};
const automationLifecycleWorkflow = {
  family: "workspace-automation-lifecycle",
  namespace: "vibestudio:automation-lifecycle",
  group: "missions-controller",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/automation-lifecycle-managed.ts",
  },
  root: "reconcileAutomation",
  evidence: automationLifecycleEvidence,
};
const publicationPreflightWorkflow = {
  family: "workspace-publication-preflight",
  namespace: "vibestudio:publication-preflight",
  group: "portable-public-package",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/publication-preflight-managed.ts",
  },
  root: "preflightPublication",
  evidence: publicationPreflightEvidence,
};
const pdfIntakeWorkflow = {
  family: "workspace-pdf-intake",
  namespace: "vibestudio:pdf-intake",
  group: "local-pdf-evidence",
  validator: { template: "system-testing", path: "skills/system-testing/pdf-intake-managed.ts" },
  root: "extractPdfEvidence",
  evidence: pdfIntakeEvidence,
};
const pdfHandoffWorkflow = {
  family: "workspace-pdf-handoff",
  namespace: "vibestudio:pdf-handoff",
  group: "verified-page-transfer",
  validator: { template: "system-testing", path: "skills/system-testing/pdf-handoff-managed.ts" },
  skills: ["extractPdfEvidence", "assembleHandoff"],
  evidence: pdfHandoffEvidence,
};
const panelHealthWorkflow = {
  family: "workspace-live-panel-health",
  namespace: "vibestudio:panel-health",
  group: "live-renderer-diagnostics-and-recovery",
  validator: { template: "system-testing", path: "skills/system-testing/panel-health-managed.ts" },
  root: "reviewPanelHealth",
  evidence: panelHealthEvidence,
};
const presentationWorkflow = {
  family: "workspace-presentation",
  namespace: "vibestudio:visualize",
  group: "component-selection-and-grounding",
  validator: { template: "system-testing", path: "skills/system-testing/presentation-managed.ts" },
  root: "preparePresentation",
  evidence: presentationEvidence,
};
const testkitCleanupWorkflow = {
  family: "workspace-testkit-cleanup",
  namespace: "vibestudio:session-test",
  group: "live-testkit-deferred-inventory",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/testkit-cleanup-managed.ts",
  },
  root: "reviewLiveCleanup",
  evidence: liveTestkitCleanupEvidence,
};
const sessionReplayWorkflow = {
  family: "workspace-headless-session-replay",
  namespace: "vibestudio:session-test",
  group: "headless-durable-retry",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/session-replay-managed.ts",
  },
  root: "reviewLiveReplay",
  evidence: liveSessionReplayEvidence,
};
const authoringWorkflow = {
  family: "workspace-natlang-authoring",
  namespace: "vibestudio:natlang-authoring",
  group: "workspace-compiler-contract-review",
  validator: { template: "system-testing", path: "skills/system-testing/authoring-managed.ts" },
  root: "reviewProgram",
  evidence: authoringEvidence,
};
const integrationReadinessWorkflow = {
  family: "workspace-live-integration-readiness",
  workspace: "examples",
  namespace: "vibestudio:api-integration",
  group: "host-audience-and-transport-binding",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/integration-readiness-managed.ts",
  },
  root: "reviewIntegration",
  evidence: integrationReadinessEvidence,
};
const terminalCheckWorkflow = {
  family: "workspace-live-terminal-checks",
  workspace: "examples",
  namespace: "vibestudio:terminal",
  group: "assigned-process-dependencies",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/terminal-check-managed.ts",
  },
  root: "runTerminalChecks",
  evidence: terminalCheckEvidence,
};
const clientAdmissionWorkflow = {
  family: "system-live-client-admission",
  namespace: "vibestudio:clientdev",
  group: "published-client-and-host-abi",
  validator: { template: "system", path: "skills/clientdev/managed-fixture.ts" },
  root: "reviewClientAdmission",
  evidence: clientAdmissionEvidence,
};
const publicationRevisionWorkflow = {
  family: "workspace-live-publication-revision",
  workspace: "system",
  namespace: "vibestudio:publication",
  group: "sealed-package-re-review",
  validator: { template: "system-testing", path: "skills/system-testing/publication-revision-managed.ts" },
  root: "reviewPublicationRevision",
  evidence: publicationRevisionEvidence,
};
const androidInstallWorkflow = {
  family: "system-live-android-development-install",
  workspace: "system",
  namespace: "vibestudio:mobile-system-testing",
  group: "assigned-android-development-install",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/android-install-managed.ts",
  },
  root: "runMobileScenario",
  evidence: androidInstallEvidence,
};

const androidAuditWorkflow = {
  family: "system-live-android-runtime-audit",
  workspace: "system",
  namespace: "vibestudio:mobile-debug",
  group: "android-target-and-application-evidence",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/android-audit-managed.ts",
  },
  root: "auditAndroidRuntime",
  evidence: androidAuditEvidence,
};

const deliveryHistoryWorkflow = {
  family: "workspace-live-delivery-history",
  workspace: "system",
  namespace: "vibestudio:conversation",
  group: "receipt-to-durable-consumer-history",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/delivery-history-managed.ts",
  },
  root: "reviewDeliveryHistory",
  evidence: deliveryHistoryEvidence,
};
const transcriptCursorWorkflow = {
  family: "workspace-live-transcript-cursor",
  workspace: "system",
  namespace: "vibestudio:session-test",
  group: "bounded-live-transcript-continuation",
  validator: { template: "system-testing", path: "skills/system-testing/transcript-cursor-managed.ts" },
  root: "resumeChannelTranscript",
  evidence: transcriptCursorEvidence,
};
const unitIdentityWorkflow = {
  family: "workspace-live-unit-identity",
  workspace: "system",
  namespace: "vibestudio:workspace-dev",
  group: "native-icon-catalog-and-working-state",
  validator: { template: "system-testing", path: "skills/system-testing/unit-identity-managed.ts" },
  root: "prepareUnitIdentity",
  evidence: unitIdentityEvidence,
};
const gmailComposeHistoryWorkflow = {
  family: "google-live-gmail-compose-history",
  workspace: "google-workspace",
  namespace: "vibestudio:gmail",
  group: "native-channel-compose-lineage",
  validator: { template: "system-testing", path: "skills/system-testing/gmail-compose-history-managed.ts" },
  root: "inspectComposeHistory",
  evidence: gmailComposeHistoryEvidence,
};
const explorerTextWorkflow = {
  family: "personal-live-explorer-text",
  workspace: "personal",
  namespace: "vibestudio:explorer",
  group: "native-text-storage-contract",
  validator: { template: "system-testing", path: "skills/system-testing/explorer-probe-managed.ts" },
  root: "probeWorkspaceText",
  evidence: explorerTextEvidence,
};
const tourRehearsalWorkflow = {
  family: "personal-live-tour-rehearsal",
  workspace: "personal",
  namespace: "vibestudio:tour",
  group: "authorized-presentation-and-restoration",
  validator: { template: "system-testing", path: "skills/system-testing/tour-rehearsal-managed.ts" },
  root: "rehearseTour",
  evidence: tourRehearsalEvidence,
};
const buildPerformanceWorkflow = {
  family: "system-live-build-performance",
  workspace: "system",
  namespace: "vibestudio:performance",
  group: "native-build-cache-and-panel-payload",
  validator: { template: "system-testing", path: "skills/system-testing/build-performance-managed.ts" },
  root: "reviewBuildPerformance",
  evidence: buildPerformanceEvidence,
};
const logCursorWorkflow = {
  family: "system-live-saved-log-cursor",
  workspace: "system",
  namespace: "vibestudio:server-logs",
  group: "bounded-resume-across-host-log-boots",
  validator: { template: "system-testing", path: "skills/system-testing/log-cursor-managed.ts" },
  root: "reviewLogCursor",
  evidence: logCursorEvidence,
};
const evalRecoveryWorkflow = {
  family: "workspace-live-eval-recovery",
  workspace: "examples",
  namespace: "vibestudio:sandbox",
  group: "native-journal-and-effect-readback",
  validator: { template: "system-testing", path: "skills/system-testing/eval-recovery-managed.ts" },
  root: "reviewEvalRecovery",
  evidence: evalRecoveryEvidence,
};
const pdfLayoutWorkflow = {
  family: "workspace-live-pdf-layout",
  workspace: "examples",
  namespace: "vibestudio:pdf-ingest",
  group: "embedded-fragments-and-reading-order",
  validator: { template: "system-testing", path: "skills/system-testing/pdf-layout-managed.ts" },
  root: "reviewPdfLayout",
  evidence: pdfLayoutEvidence,
};
const dictationWorkflow = {
  family: "workspace-live-offline-dictation",
  workspace: "examples",
  namespace: "vibestudio:offline-dictation",
  group: "capture-admission-and-local-worker-readiness",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/offline-dictation-managed.ts",
  },
  root: "reviewDictation",
  evidence: dictationEvidence,
};
const nativeSuiteWorkflow = {
  family: "workspace-live-declared-test-suite",
  workspace: "examples",
  namespace: "vibestudio:test-verification",
  group: "declared-runtime-and-assigned-verification",
  validator: { template: "system-testing", path: "skills/system-testing/native-suite-managed.ts" },
  root: "reviewTestSuite",
  evidence: nativeSuiteEvidence,
};
const gitBridgeReviewWorkflow = {
  family: "workspace-live-git-bridge-review",
  workspace: "examples",
  namespace: "vibestudio:git-bridge",
  group: "unconfigured-upstream-and-semantic-export-basis",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/git-bridge-review-managed.ts",
  },
  root: "reviewGitBridge",
  evidence: gitBridgeReviewEvidence,
};
const vcsDeliveryWorkflow = {
  family: "workspace-live-semantic-vcs-delivery",
  workspace: "examples",
  namespace: "vibestudio:semantic-vcs",
  group: "assigned-file-and-context-delivery",
  validator: { template: "system-testing", path: "skills/system-testing/vcs-delivery-managed.ts" },
  root: "reviewVcsDelivery",
  evidence: vcsDeliveryEvidence,
};
const webBriefWorkflow = {
  family: "workspace-live-public-web-brief",
  workspace: "examples",
  namespace: "vibestudio:web-research",
  group: "public-reserved-domain-sources",
  validator: { template: "system-testing", path: "skills/system-testing/web-brief-managed.ts" },
  root: "writeAssignedBrief",
  evidence: webBriefEvidence,
};
const architectureBoundaryWorkflow = {
  family: "workspace-live-architecture-boundary",
  workspace: "examples",
  namespace: "vibestudio:architecture",
  group: "provider-resolution-and-state-ownership",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/architecture-boundary-managed.ts",
  },
  root: "reviewArchitectureBoundary",
  evidence: architectureBoundaryEvidence,
};
const releaseReviewHandoffWorkflow = {
  family: "workspace-live-release-review-handoff",
  workspace: "examples",
  namespace: "vibestudio:release-review",
  group: "extension-authority-local-evidence-handoff",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/release-review-handoff-managed.ts",
  },
  evidence: releaseReviewHandoffEvidence,
};
const extensionReleaseWorkflow = {
  family: "workspace-live-extension-release",
  workspace: "examples",
  namespace: "vibestudio:extensiondev",
  group: "working-published-and-approved-extension",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/extension-release-managed.ts",
  },
  root: "reviewExtensionRelease",
  evidence: extensionReleaseEvidence,
};
const authorityReviewWorkflow = {
  family: "workspace-live-authority-review",
  workspace: "examples",
  namespace: "vibestudio:capabilities",
  group: "actual-preflight-exact-resource-ceiling",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/authority-review-managed.ts",
  },
  root: "reviewAuthority",
  evidence: authorityReviewEvidence,
};
const problemDraftWorkflow = {
  family: "workspace-live-problem-draft",
  workspace: "examples",
  namespace: "vibestudio:problem-reporting",
  group: "local-manual-draft-revision-and-narrative",
  validator: { template: "system-testing", path: "skills/system-testing/problem-draft-managed.ts" },
  root: "saveProblemDraft",
  evidence: problemDraftEvidence,
};
const agenticChangeWorkflow = {
  family: "workspace-live-agentic-change",
  workspace: "examples",
  namespace: "vibestudio:agentic-development",
  group: "exact-context-agentic-stack-verification",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/agentic-change-managed.ts",
  },
  root: "planAgenticChange",
  evidence: agenticChangeEvidence,
};
const gadReviewWorkflow = {
  family: "workspace-live-gad-review",
  workspace: "examples",
  namespace: "vibestudio:gad",
  group: "owned-channel-health-and-transcript",
  validator: { template: "system-testing", path: "skills/system-testing/gad-review-managed.ts" },
  root: "reviewChannel",
  evidence: gadReviewEvidence,
};
const phoneSetupWorkflow = {
  family: "system-live-phone-setup",
  namespace: "vibestudio:phone-setup",
  group: "phone-provider-discovery",
  validator: { template: "system-testing", path: "skills/system-testing/phone-setup-managed.ts" },
  root: "setUpPhone",
  evidence: phoneSetupEvidence,
};
const verifiedMemoryWorkflow = {
  family: "workspace-verified-memory",
  workspace: "personal",
  namespace: "vibestudio:memory",
  group: "verified-committed-source",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/verified-memory-managed.ts",
  },
  root: "recallDecision",
  evidence: verifiedMemoryEvidence,
};
const hostLogAuditWorkflow = {
  family: "system-live-host-log-audit",
  namespace: "vibestudio:system",
  group: "assigned-host-log-cursor-and-recovery",
  validator: { template: "system", path: "skills/system-investigation-live/live.ts" },
  root: "investigateSystem",
  evidence: hostLogAuditEvidence,
};
const localComparisonWorkflow = {
  family: "local-model-live-comparison",
  namespace: "vibestudio:local-model",
  group: "assigned-candidates-live-inventory",
  validator: { template: "system", path: "skills/local-model-task-bindings/live.ts" },
  root: "prepareLocalModel",
  evidence: localComparisonEvidence,
};
const provenanceHistoryWorkflow = {
  family: "workspace-live-provenance-history",
  namespace: "vibestudio:provenance",
  group: "owned-history-cause-cohort-counteractions",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/provenance-history-managed.ts",
  },
  root: "reviewProvenance",
  evidence: provenanceHistoryEvidence,
};
const runtimeProgramWorkflow = {
  family: "runtime-live-program-receipts",
  namespace: "vibestudio:runtime",
  group: "checked-program-compiler-execution",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/runtime-program-managed.ts",
  },
  root: "reviewRuntimeEvidence",
  evidence: runtimeProgramEvidence,
};
const incidentContinuationWorkflow = {
  family: "system-live-incident-continuation",
  namespace: "vibestudio:system",
  group: "incident-log-before-local-inventory",
  validator: { template: "system", path: "skills/system-investigation-live/continuation.ts" },
  root: "investigateSystem",
  skills: ["investigateSystem", "prepareLocalModel"],
  evidence: incidentContinuationEvidence,
};
const googleSetupWorkflow = {
  family: "google-live-setup-journey",
  workspace: "google-workspace",
  namespace: "vibestudio:google",
  group: "live-setup-owner-handoff",
  validator: { template: "google-workspace", path: "skills/google-drive/live-setup-journey.ts" },
  root: "guideGoogleWorkspace",
  evidence: googleSetupEvidence,
};
const newsWorkflow = {
  family: "news-live-ownership",
  workspace: "news",
  namespace: "vibestudio:news",
  group: "owned-reader-and-missions",
  validator: { template: "news", path: "packages/news-live-evidence/live.ts" },
  root: "reviewNews",
  evidence: newsEvidence,
};
const spectroliteWorkflow = {
  family: "spectrolite-live-vault",
  workspace: "spectrolite",
  namespace: "vibestudio:spectrolite",
  group: "canonical-vault-preview",
  validator: { template: "spectrolite", path: "skills/spectrolite-review-fixtures/live.ts" },
  root: "reviewSpectrolite",
  evidence: spectroliteEvidence,
};
const grimoireWorkflow = {
  family: "examples-live-grimoire",
  workspace: "examples",
  namespace: "vibestudio:examples",
  group: "grimoire-resident-care",
  validator: { template: "examples", path: "skills/examples-review-fixtures/live-garden.ts" },
  root: "reviewExample",
  evidence: grimoireEvidence,
};
const tendrilWorkflow = {
  family: "workspace-tendril-presentation",
  namespace: "vibestudio:tendrils",
  group: "live-tendril-handoff-board",
  validator: { template: "system-testing", path: "skills/system-testing/tendril-managed.ts" },
  root: "runTendril",
  evidence: tendrilEvidence,
};
const browserLibraryWorkflow = {
  family: "personal-live-browser-library",
  workspace: "personal",
  namespace: "vibestudio:personal:browser-library",
  group: "saved-reference-curation",
  validator: { template: "personal", path: "skills/browser-library-runtime/managed.ts" },
  root: "curateBrowserLibrary",
  evidence: browserLibraryEvidence,
};
const collectionWorkflow = {
  family: "personal-live-collection",
  workspace: "personal",
  namespace: "vibestudio:personal:collection",
  group: "panel-tree-organization",
  validator: { template: "personal", path: "skills/collection-conductor-runtime/managed.ts" },
  root: "organizeCollection",
  evidence: collectionEvidence,
};
const channelRosterWorkflow = {
  family: "workspace-live-channel-roster",
  namespace: "vibestudio:channel-roster",
  group: "cross-channel-membership-reconciliation",
  validator: {
    template: "system-testing",
    path: "skills/system-testing/channel-roster-managed.ts",
  },
  root: "runRosterPlan",
  evidence: channelRosterEvidence,
};
const missionPlanningWorkflow = {
  family: "personal-live-mission-planning",
  workspace: "personal",
  namespace: "vibestudio:personal:mission-planning",
  group: "revision-bound-project-reconciliation",
  validator: { template: "personal", path: "skills/mission-planning-runtime/managed.ts" },
  root: "reconcileMissionPlan",
  evidence: missionPlanningEvidence,
};
const browserHandoffWorkflow = {
  family: "personal-live-browser-handoff",
  workspace: "personal",
  namespace: "vibestudio:personal:browser-handoff",
  group: "verified-reference-to-panel",
  validator: { template: "personal", path: "skills/browser-handoff-runtime/index.ts" },
  root: "runWorkflow",
  skills: ["curateBrowserLibrary", "organizeCollection"],
  evidence: browserHandoffEvidence,
};
const terminalChecklistWorkflow = {
  family: "workspace-terminal-checklist",
  namespace: "vibestudio:terminal-apps",
  group: "durable-checklist-session",
  validator: { template: "system-testing", path: "skills/system-testing/checklist-managed.ts" },
  root: "verifyChecklist",
  evidence: terminalChecklistEvidence,
};
const onboardingWorkflow = {
  family: "workspace-onboarding",
  workspace: "personal",
  namespace: "vibestudio:onboarding",
  group: "installed-setup-owner-review",
  validator: { template: "system-testing", path: "skills/system-testing/onboarding-managed.ts" },
  root: "planSetup",
  evidence: onboardingEvidence,
};
const composedReleaseWorkflow = {
  ...ownedOperationsWorkflow,
  family: "workspace-release-dossier",
  program: undefined,
  skills: ["operate", "deliverProject"],
  validator: {
    template: "system-testing",
    path: "workers/system-test-runner/owned-operations-dependency.ts",
  },
  requiresReview: true,
  evidence: composedReleaseEvidence,
};
const originalCases = new Map([
  ["owned-operations-incident-payment-and-ledger", ownedOperationsWorkflow],
  ["owned-operations-release-audit-continuation", ownedOperationsWorkflow],
  ["content-project-release-runbook", contentWorkflow],
  ["content-project-role-onboarding", contentWorkflow],
  ["worker-label-repair-type-mismatch", unitRepairWorkflow],
  ["worker-label-repair-missing-helper", unitRepairWorkflow],
  ["panel-draft-unmount", panelWorkflow],
  ["panel-draft-stale-snapshot", panelWorkflow],
  ["workspace-integration-theme-locale", integrationWorkflow],
  ["workspace-integration-theme-locale-alias", integrationWorkflow],
]);

export async function loadLiveTeacherCases(checkouts) {
  const directory = path.join(checkouts["system-testing"], "skills/system-testing");
  const [
    { contentProjectWorlds },
    { ownedOperationsWorlds, ownedOperationsComposedWorlds },
    { workerRepairWorlds },
    { localMessagingWorlds },
    { panelRepairWorlds },
    { workspaceIntegrationWorlds },
    { managedScratchWorlds },
    { integrationHandoffWorlds },
    { managedAutomationWorlds },
    { managedPublicationWorlds },
    { managedPdfWorlds, managedPdfExpectation, managedPdfHandoffWorlds = [] },
    { managedPresentationWorlds },
    { managedPanelHealthWorlds },
    { managedAuthoringWorlds },
    { managedSessionReplayWorlds = [] },
    { managedTestkitCleanupWorlds = [] },
    { phoneSetupUnavailable },
    { managedClientAdmissionWorlds },
    { managedLogCursorWorlds },
    { buildPerformanceWorlds },
    { tourRehearsalWorlds },
    { explorerTextWorlds },
    { gmailComposeHistoryWorlds },
    { unitIdentityWorlds },
    { transcriptCursorWorlds },
    { deliveryHistoryWorlds },
    { androidAuditWorlds },
    { androidInstallWorlds },
    { publicationRevisionWorlds },
    { managedEvalRecoveryWorlds },
    { managedPdfLayoutWorlds },
    { managedDictationWorlds },
    { managedNativeSuiteWorlds },
    { managedGitBridgeReviewWorlds },
    { deliveryRepository, managedVcsDeliveryWorlds },
    { managedWebBriefWorlds },
    { managedArchitectureBoundaryWorlds },
    { managedReleaseReviewHandoffWorlds, releaseReviewHandoffWork },
    { managedExtensionReleaseWorlds },
    { managedAuthorityReviewWorlds },
    { managedProblemDraftWorlds },
    { managedAgenticChangeWorlds },
    { managedGadReviewWorlds },
    { managedTerminalCheckWorlds },
    { managedIntegrationReadinessWorlds },
    { managedMemoryWorlds },
    { managedSetupWorlds },
    { managedChecklistWorlds },
    { managedTendrilWorlds },
    { managedCollectionWorlds },
    { managedBrowserLibraryWorlds, origin: browserLibraryOrigin },
    { managedBrowserHandoffWorlds },
    { managedMissionPlanningWorlds },
    { managedChannelRosterWorlds },
    { managedGrimoireWorlds },
    { managedSpectroliteWorlds },
    { managedNewsWorlds },
    { managedGoogleSetupWorlds },
    { localModelComparisonWorlds },
    { managedLogAuditWorlds },
    { incidentContinuationWorlds },
    { managedRuntimeProgramWorlds },
    { managedProvenanceHistoryWorlds },
  ] = await Promise.all(
    [
      "content-project-worlds.ts",
      "owned-operations-worlds.ts",
      "unit-repair-worlds.ts",
      "local-messaging/worlds.ts",
      "panel-repair-world.ts",
      "vcs-integration-worlds.ts",
      "scratch-handoff-worlds.ts",
      "integration-handoff-worlds.ts",
      "automation-lifecycle-worlds.ts",
      "publication-preflight-worlds.ts",
      "pdf-intake-worlds.ts",
      "presentation-worlds.ts",
      "panel-health-worlds.ts",
      "authoring-worlds.ts",
      "session-replay-worlds.ts",
      "testkit-cleanup-worlds.ts",
      "phone-setup-world.ts",
      "client-admission-worlds.ts",
      "log-cursor-worlds.ts",
      "build-performance-worlds.ts",
      "tour-rehearsal-worlds.ts",
      "explorer-probe-worlds.ts",
      "gmail-compose-history-worlds.ts",
      "unit-identity-worlds.ts",
      "transcript-cursor-worlds.ts",
      "delivery-history-worlds.ts",
      "android-audit-worlds.ts",
      "android-install-worlds.ts",
      "publication-revision-worlds.ts",
      "eval-recovery-worlds.ts",
      "pdf-layout-worlds.ts",
      "offline-dictation-worlds.ts",
      "native-suite-worlds.ts",
      "git-bridge-review-worlds.ts",
      "vcs-delivery-worlds.ts",
      "web-brief-worlds.ts",
      "architecture-boundary-worlds.ts",
      "release-review-handoff-worlds.ts",
      "extension-release-worlds.ts",
      "authority-review-worlds.ts",
      "problem-draft-worlds.ts",
      "agentic-change-worlds.ts",
      "gad-review-worlds.ts",
      "terminal-check-worlds.ts",
      "integration-readiness-worlds.ts",
      "verified-memory-worlds.ts",
      "onboarding-worlds.ts",
      "checklist-worlds.ts",
      "tendril-worlds.ts",
      "collection-worlds.ts",
      "browser-library-worlds.ts",
      "browser-handoff-worlds.ts",
      "mission-planning-worlds.ts",
      "channel-roster-worlds.ts",
      "grimoire-worlds.ts",
      "spectrolite-worlds.ts",
      "news-worlds.ts",
      "google-setup-worlds.ts",
      "local-model-comparison-worlds.ts",
      "log-audit-worlds.ts",
      "incident-continuation-worlds.ts",
      "runtime-program-worlds.ts",
      "provenance-history-worlds.ts",
    ].map(async (file) => {
      const imported = await import(pathToFileURL(path.join(directory, file)).href);
      return imported.default ?? imported;
    })
  );
  const cases = new Map(originalCases);
  for (const assignment of managedIntegrationReadinessWorlds) {
    cases.set(`integration-readiness-live-${assignment.id}`, {
      ...integrationReadinessWorkflow,
      assignment,
    });
  }
  for (const assignment of managedTerminalCheckWorlds) {
    cases.set(`terminal-check-live-${assignment.id}`, { ...terminalCheckWorkflow, assignment });
  }
  for (const assignment of managedClientAdmissionWorlds) {
    cases.set(`client-admission-live-${assignment.id}`, { ...clientAdmissionWorkflow, assignment });
  }
  for (const assignment of publicationRevisionWorlds) {
    cases.set(`publication-revision-live-${assignment.id}`, { ...publicationRevisionWorkflow, assignment });
  }
  for (const assignment of androidInstallWorlds) {
    cases.set(`android-install-live-${assignment.id}`, { ...androidInstallWorkflow, assignment });
  }
  for (const assignment of androidAuditWorlds) {
    cases.set(`android-audit-live-${assignment.id}`, { ...androidAuditWorkflow, assignment });
  }
  for (const assignment of deliveryHistoryWorlds) {
    cases.set(`delivery-history-live-${assignment.id}`, { ...deliveryHistoryWorkflow, assignment });
  }
  for (const assignment of transcriptCursorWorlds) {
    cases.set(`transcript-cursor-live-${assignment.id}`, { ...transcriptCursorWorkflow, assignment });
  }
  for (const assignment of unitIdentityWorlds) {
    cases.set(`unit-identity-live-${assignment.id}`, { ...unitIdentityWorkflow, assignment });
  }
  for (const assignment of gmailComposeHistoryWorlds) {
    cases.set(`gmail-compose-history-live-${assignment.id}`, { ...gmailComposeHistoryWorkflow, assignment });
  }
  for (const assignment of explorerTextWorlds) {
    cases.set(`explorer-text-live-${assignment.id}`, { ...explorerTextWorkflow, assignment });
  }
  for (const assignment of tourRehearsalWorlds) {
    cases.set(`tour-rehearsal-live-${assignment.id}`, { ...tourRehearsalWorkflow, assignment });
  }
  for (const assignment of buildPerformanceWorlds) {
    cases.set(`build-performance-live-${assignment.id}`, { ...buildPerformanceWorkflow, assignment });
  }
  for (const assignment of managedLogCursorWorlds) {
    cases.set(`log-cursor-live-${assignment.id}`, { ...logCursorWorkflow, assignment });
  }
  for (const assignment of managedEvalRecoveryWorlds) {
    cases.set(`eval-recovery-live-${assignment.id}`, { ...evalRecoveryWorkflow, assignment });
  }
  for (const assignment of managedPdfLayoutWorlds) {
    cases.set(`pdf-layout-live-${assignment.id}`, { ...pdfLayoutWorkflow, assignment });
  }
  for (const assignment of managedDictationWorlds) {
    cases.set(`offline-dictation-live-${assignment.id}`, { ...dictationWorkflow, assignment });
  }
  for (const assignment of managedNativeSuiteWorlds) {
    cases.set(`native-suite-live-${assignment.id}`, { ...nativeSuiteWorkflow, assignment });
  }
  for (const assignment of managedGitBridgeReviewWorlds) {
    cases.set(`git-bridge-review-live-${assignment.id}`, {
      ...gitBridgeReviewWorkflow,
      assignment,
    });
  }
  for (const assignment of managedVcsDeliveryWorlds) {
    cases.set(`vcs-delivery-live-${assignment.id}`, {
      ...vcsDeliveryWorkflow,
      assignment: { ...assignment, repository: deliveryRepository },
    });
  }
  for (const assignment of managedWebBriefWorlds) {
    cases.set(`web-brief-live-${assignment.id}`, { ...webBriefWorkflow, assignment });
  }
  for (const assignment of managedArchitectureBoundaryWorlds) {
    cases.set(`architecture-boundary-live-${assignment.id}`, {
      ...architectureBoundaryWorkflow,
      assignment,
    });
  }
  for (const assignment of managedReleaseReviewHandoffWorlds) {
    const extension = managedExtensionReleaseWorlds.find(({ id }) => id === assignment.extension);
    const authority = managedAuthorityReviewWorlds.find(({ id }) => id === assignment.authority);
    if (!extension || !authority)
      throw new Error("Unknown release review handoff source assignment");
    cases.set(`release-review-handoff-live-${assignment.id}`, {
      ...releaseReviewHandoffWorkflow,
      assignment,
      work: releaseReviewHandoffWork,
      skills: releaseReviewHandoffWork.map(({ operation }) => operation),
      sourceGroups: [
        releaseReviewHandoffWorkflow,
        extensionReleaseWorkflow,
        authorityReviewWorkflow,
        scratchHandoffWorkflow,
      ].flatMap(workflowSourceGroups),
      extension,
      authority,
    });
  }
  for (const assignment of managedExtensionReleaseWorlds) {
    cases.set(`extension-release-live-${assignment.id}`, {
      ...extensionReleaseWorkflow,
      assignment,
    });
  }
  for (const assignment of managedAuthorityReviewWorlds) {
    cases.set(`authority-review-live-${assignment.id}`, { ...authorityReviewWorkflow, assignment });
  }
  for (const assignment of managedProblemDraftWorlds) {
    cases.set(`problem-draft-live-${assignment.id}`, { ...problemDraftWorkflow, assignment });
  }
  for (const assignment of managedAgenticChangeWorlds) {
    cases.set(`agentic-change-live-${assignment.id}`, { ...agenticChangeWorkflow, assignment });
  }
  for (const assignment of managedGadReviewWorlds) {
    cases.set(`gad-review-live-${assignment.id}`, { ...gadReviewWorkflow, assignment });
  }
  if (phoneSetupUnavailable) {
    const { id, goal, platform } = phoneSetupUnavailable;
    cases.set(id, { ...phoneSetupWorkflow, goal, platform });
  }
  for (const { id, checks, constraint } of managedProvenanceHistoryWorlds) {
    cases.set(`provenance-history-live-${id}`, {
      ...provenanceHistoryWorkflow,
      caseId: id,
      checks,
      constraint,
    });
  }
  for (const { id, goal, expected, files, execution } of managedRuntimeProgramWorlds) {
    const digest = (tree) =>
      hash(
        JSON.stringify(Object.entries(tree).sort(([left], [right]) => left.localeCompare(right)))
      );
    const original = digest(files);
    const current =
      execution?.kind === "stale"
        ? digest({ ...files, "main.ts": execution.replacement })
        : original;
    cases.set(`runtime-program-live-${id}`, {
      ...runtimeProgramWorkflow,
      caseId: id,
      goal,
      expected,
      original,
      current,
      execution,
    });
  }
  for (const { id, windows, lines } of managedLogAuditWorlds) {
    cases.set(`host-log-audit-live-${id}`, {
      ...hostLogAuditWorkflow,
      caseId: id,
      windows,
      seedCount: lines.length,
    });
  }
  for (const { id, request } of localModelComparisonWorlds) {
    cases.set(`local-model-compare-live-${id}`, {
      ...localComparisonWorkflow,
      caseId: id,
      request,
    });
  }
  for (const { id, log, models } of incidentContinuationWorlds) {
    const logWorkflow = cases.get(`host-log-audit-live-${log}`);
    const modelWorkflow = cases.get(`local-model-compare-live-${models}`);
    if (!logWorkflow || !modelWorkflow)
      throw new Error(`Unknown incident continuation source for ${id}`);
    cases.set(`incident-continuation-live-${id}`, {
      ...incidentContinuationWorkflow,
      caseId: id,
      logWorkflow,
      modelWorkflow,
      sourceGroups: [incidentContinuationWorkflow, logWorkflow, modelWorkflow].flatMap(
        workflowSourceGroups
      ),
    });
  }
  for (const { id, checks, codes } of managedGoogleSetupWorlds) {
    cases.set(`google-setup-live-${id}`, { ...googleSetupWorkflow, caseId: id, checks, codes });
  }
  for (const { id, checks, expected, repair } of managedNewsWorlds) {
    cases.set(`news-live-${id}`, { ...newsWorkflow, caseId: id, checks, expected, repair });
  }
  for (const {
    id,
    path: documentPath,
    checks,
    expected,
    requiredText,
    heading,
    previewText,
    draft,
    follow,
  } of managedSpectroliteWorlds) {
    cases.set(`spectrolite-live-${id}`, {
      ...spectroliteWorkflow,
      caseId: id,
      documentPath,
      checks,
      expected,
      requiredText,
      heading,
      previewText,
      draft: draft && {
        committedTitle: draft.committedTitle,
        staleText: draft.staleText,
        visibleText: draft.visibleText,
      },
      expectedNavigation: (follow ?? []).map(({ path: from, target, destination: to }) => ({
        from,
        target,
        to,
      })),
    });
  }
  for (const { id, expected, actions } of managedGrimoireWorlds) {
    cases.set(`grimoire-live-${id}`, {
      ...grimoireWorkflow,
      caseId: id,
      expectedDecisions: expected,
      expectedActions: actions.map((action) => action.toLowerCase()),
    });
  }
  for (const { id, request, expected } of managedBrowserLibraryWorlds) {
    cases.set(`browser-library-live-${id}`, {
      ...browserLibraryWorkflow,
      caseId: id,
      request,
      expected,
      origin: browserLibraryOrigin,
    });
  }
  for (const { id, request, expected } of managedCollectionWorlds) {
    cases.set(`collection-live-${id}`, {
      ...collectionWorkflow,
      caseId: id,
      request,
      expected,
    });
  }
  for (const world of managedChannelRosterWorlds) {
    cases.set(`channel-roster-live-${world.id}`, {
      ...channelRosterWorkflow,
      caseId: world.id,
      assignment: world,
    });
  }
  for (const { id, request, expected } of managedMissionPlanningWorlds) {
    cases.set(`mission-planning-live-${id}`, {
      ...missionPlanningWorkflow,
      caseId: id,
      request,
      expected,
    });
  }
  for (const assignment of managedBrowserHandoffWorlds) {
    const library = cases.get(`browser-library-live-${assignment.library}`);
    if (!library) throw new Error(`Unknown assigned library ${assignment.library}`);
    cases.set(`browser-handoff-live-${assignment.id}`, {
      ...browserHandoffWorkflow,
      caseId: assignment.id,
      assignment,
      library,
      sourceGroups: [browserHandoffWorkflow, browserLibraryWorkflow, collectionWorkflow].flatMap(
        workflowSourceGroups
      ),
    });
  }
  for (const { id, request } of managedTendrilWorlds) {
    cases.set(`tendril-live-${id}`, { ...tendrilWorkflow, caseId: id, request });
  }
  for (const { id, request, expected, keys } of managedChecklistWorlds) {
    cases.set(`terminal-checklist-live-${id}`, {
      ...terminalChecklistWorkflow,
      caseId: id,
      expectedContinuation: request.continuation,
      expectedScreens: expected,
      ...("target" in request && { expectedKeys: keys }),
    });
  }
  for (const { id, expected } of managedSetupWorlds) {
    cases.set(`onboarding-live-${id}`, {
      ...onboardingWorkflow,
      caseId: id,
      expectedStatus: expected.status,
      expectedRoute: expected.route,
    });
  }
  for (const { id, expected, comparison } of managedMemoryWorlds) {
    cases.set(`verified-memory-live-${id}`, {
      ...verifiedMemoryWorkflow,
      caseId: id,
      expectedStatus: comparison?.status ?? expected.status,
      ...(comparison && {
        root: "compareDecisionRevisions",
        evidence: verifiedMemoryComparisonEvidence,
        beforeStatus: comparison.expected.status,
        afterStatus: expected.status,
      }),
    });
  }
  for (const assignment of managedTestkitCleanupWorlds) {
    cases.set(`testkit-cleanup-live-${assignment.id}`, { ...testkitCleanupWorkflow, assignment });
  }
  for (const assignment of managedSessionReplayWorlds) {
    cases.set(`session-replay-live-${assignment.id}`, { ...sessionReplayWorkflow, assignment });
  }
  for (const { id, request, expected, candidate, baseline } of managedAuthoringWorlds) {
    const trackedScopes =
      candidate?.["natlang.json"] &&
      (expected.status === "ready" || expected.status === "changes-required")
        ? [candidate, ...(baseline ? [baseline] : [])].map((tree) => ({
            scopes: JSON.parse(tree["natlang.json"] ?? "{}").serviceScopes ?? {},
            revision: hash(
              JSON.stringify(
                Object.keys(tree)
                  .sort()
                  .map((path) => [path, tree[path]])
              )
            ),
          }))
        : undefined;
    cases.set(`authoring-live-${id}`, {
      ...authoringWorkflow,
      caseId: id,
      comparedBaseline: request.compare,
      expectedStatus: expected.status,
      ...(trackedScopes && { trackedScopes, expectedMarkers: expected.markers }),
    });
  }
  for (const world of managedPanelHealthWorlds) {
    cases.set(`panel-health-live-${world.id}`, {
      ...panelHealthWorkflow,
      caseId: world.id,
      assignment: world,
    });
  }
  for (const { id, expected } of managedPresentationWorlds) {
    cases.set(`presentation-live-${id}`, {
      ...presentationWorkflow,
      caseId: id,
      renderedIds: expected.filter((view) => Object.hasOwn(view, "labels")).map(({ id }) => id),
      interactions: expected.flatMap(({ id, interaction }) =>
        interaction ? [{ id, ...interaction }] : []
      ),
    });
  }
  for (const world of managedPdfWorlds) {
    cases.set(`pdf-intake-live-${world.id}`, {
      ...pdfIntakeWorkflow,
      caseId: world.id,
      pages: world.pages,
      fault: world.fault ?? null,
      ...managedPdfExpectation(world),
    });
  }
  for (const { pdf } of managedPdfHandoffWorlds) {
    const world = managedPdfWorlds.find(({ id }) => id === pdf);
    if (!world) throw new Error(`Unknown PDF intake for handoff ${pdf}`);
    cases.set(`pdf-handoff-live-${pdf}`, {
      ...pdfHandoffWorkflow,
      caseId: pdf,
      expectedHandoff: world.claims.some(({ evidence }) => !evidence.length)
        ? "unanswered"
        : "staged",
      fault: world.fault ?? null,
      pages: world.pages,
      ...managedPdfExpectation(world),
      sourceGroups: [pdfHandoffWorkflow, pdfIntakeWorkflow, scratchHandoffWorkflow].flatMap(
        workflowSourceGroups
      ),
    });
  }
  for (const { id, expectedBlockers, expectedVisual } of managedPublicationWorlds) {
    cases.set(`publication-preflight-live-${id}`, {
      ...publicationPreflightWorkflow,
      caseId: id,
      expectedBlockers,
      expectedVisual,
    });
  }
  for (const { id, status, problem } of managedAutomationWorlds) {
    cases.set(`automation-lifecycle-live-${id}`, {
      ...automationLifecycleWorkflow,
      caseId: id,
      expectedStatus: status,
      problem: problem ?? null,
    });
  }
  for (const { id, integration, questions } of integrationHandoffWorlds) {
    const assignedIntegration = workspaceIntegrationWorlds.find(({ id }) => id === integration);
    if (!assignedIntegration)
      throw new Error(`Unknown integration for handoff ${id}: ${integration}`);
    const unanswered = questions.filter((question) => question.unanswered).map(({ text }) => text);
    cases.set(`integration-handoff-${id}`, {
      ...integrationHandoffWorkflow,
      caseId: id,
      expectedPaths: assignedIntegration.files?.map(({ path }) => path) ?? ["settings.json"],
      expectedStatus: unanswered.length ? "unanswered" : "staged",
      unanswered,
      sourceGroups: [
        ...workflowSourceGroups(integrationHandoffWorkflow),
        ...workflowSourceGroups(integrationWorkflow),
        ...workflowSourceGroups(scratchHandoffWorkflow),
        `${integrationWorkflow.namespace}:${integration}`,
      ],
    });
  }
  for (const { id, group, status } of managedScratchWorlds) {
    cases.set(`scratch-handoff-live-${id}`, {
      ...scratchHandoffWorkflow,
      caseId: id,
      expectedStatus: status,
      sourceGroups: [
        `${scratchHandoffWorkflow.namespace}:${scratchHandoffWorkflow.group}`,
        `${scratchHandoffWorkflow.namespace}:${group}`,
      ],
    });
  }
  for (const { id, sourceGroup, files } of workspaceIntegrationWorlds) {
    cases.set(`workspace-integration-${id}`, {
      ...integrationWorkflow,
      expectedPaths: files?.map(({ path }) => path) ?? ["settings.json"],
      sourceGroups: [...new Set([sourceGroup, integrationWorkflow.group])].map(
        (group) => `${integrationWorkflow.namespace}:${group}`
      ),
    });
  }
  for (const { id, sourceGroup, failedChecks } of panelRepairWorlds) {
    cases.set(id, {
      ...panelWorkflow,
      failedChecks,
      sourceGroups: [...new Set([sourceGroup, panelWorkflow.group])].map(
        (group) => `${panelWorkflow.namespace}:${group}`
      ),
    });
  }
  for (const { id, sourceGroup } of contentProjectWorlds) {
    const scenario = `content-project-${id}`;
    if (cases.has(scenario)) continue;
    const group = sourceGroup.split("/").at(-1);
    const relatedOriginal = contentProjectWorlds.some(
      (world) =>
        world.sourceGroup === sourceGroup && originalCases.has(`content-project-${world.id}`)
    );
    cases.set(scenario, {
      ...contentWorkflow,
      group,
      sourceGroups: [
        `${contentWorkflow.namespace}:${group}`,
        ...(relatedOriginal ? [`${contentWorkflow.namespace}:${contentWorkflow.group}`] : []),
      ],
    });
  }
  for (const { id, sourceGroup } of ownedOperationsWorlds) {
    const scenario = `owned-operations-${id}`;
    if (cases.has(scenario)) continue;
    cases.set(scenario, {
      ...ownedOperationsWorkflow,
      group: sourceGroup.slice(ownedOperationsWorkflow.namespace.length + 1),
    });
  }
  for (const { id, sourceGroup } of ownedOperationsComposedWorlds) {
    cases.set(`owned-operations-${id}`, {
      ...composedReleaseWorkflow,
      sourceGroups: [
        sourceGroup,
        ...workflowSourceGroups(ownedOperationsWorkflow),
        ...workflowSourceGroups(contentWorkflow),
      ],
    });
  }
  for (const { id } of workerRepairWorlds) {
    cases.set(`worker-repair-${id}`, { ...unitRepairWorkflow, group: id });
  }
  for (const { id } of localMessagingWorlds) {
    cases.set(`messaging-${id}`, messagingWorkflow);
  }
  return cases;
}

export function workflowSourceGroups(workflow) {
  return workflow.sourceGroups ?? [`${workflow.namespace}:${workflow.group}`];
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  const bytes = await readFile(file);
  return JSON.parse(file.endsWith(".gz") ? gunzipSync(bytes) : bytes);
}

function panelEvidence(execution, exercise, _name, { failedChecks }) {
  const diagnostics = execution.diagnostics;
  const baseline = diagnostics.panelDraftBaseline;
  const browser = diagnostics.panelDraftVerification;
  const workspace = diagnostics.workspaceRepoFixture;
  const revisions = diagnostics.panelRepairWorkspace;
  const baselineChecks = baseline?.checks ?? {};
  const candidateChecks = browser?.checks ?? {};
  const before = Object.keys(baselineChecks);
  const after = Object.keys(candidateChecks);
  const failures = before.filter((check) => baselineChecks[check] === false);
  requireEvidence(
    browser?.passed === true &&
      failedChecks.length > 0 &&
      failures.length === failedChecks.length &&
      failures.every((check) => failedChecks.includes(check)) &&
      before.length === after.length &&
      before.every(
        (check) => typeof baselineChecks[check] === "boolean" && candidateChecks[check] === true
      ),
    "The retained browser evidence must reproduce the assigned failures before repair and pass every paired check afterward"
  );
  requireEvidence(
    workspace?.kind === "draft-repair-panel" &&
      workspace.contextId === execution.provenance?.contextId &&
      typeof workspace.taskBaseEventId === "string" &&
      typeof workspace.repoPath === "string",
    "The verified run must bind the seeded workspace context"
  );
  requireEvidence(
    exercise.report?.status === "verified" &&
      revisions?.before &&
      revisions?.after &&
      exercise.report.revision === JSON.stringify(revisions.after) &&
      JSON.stringify(revisions.before) !== JSON.stringify(revisions.after),
    "Missing actual authored Natlang repair report for the changed workspace revision"
  );
  return {
    world: { context_id: workspace.contextId, seed_revision: workspace.taskBaseEventId },
    checks: browser.checks,
    evidence: {
      workspace: { fixture: workspace, revisions, verifiedRevision: exercise.report.revision },
      cdp: { baseline, candidate: browser },
    },
  };
}

function integrationEvidence(execution, exercise, _name, { expectedPaths }) {
  const observed = execution.diagnostics.workspaceIntegrationWorld;
  const verification = execution.diagnostics.workspaceIntegrationVerification;
  requireEvidence(
    observed?.kind === "vcs-integration" &&
      observed.contextId === execution.provenance?.contextId &&
      observed.commonSeedEvent?.kind === "event" &&
      typeof observed.commonSeedEvent.eventId === "string" &&
      observed.source?.kind === "event" &&
      typeof observed.source.eventId === "string" &&
      observed.before &&
      observed.after &&
      JSON.stringify(observed.before) !== JSON.stringify(observed.after) &&
      exercise.report?.status === "integrated" &&
      exercise.report.head === JSON.stringify(observed.after) &&
      verification?.passed === true &&
      verification.reasons?.length === 0 &&
      JSON.stringify(verification.head) === JSON.stringify(observed.after) &&
      verification.evidence?.length > 0,
    "Missing verified integration evidence bound to the seeded conflict and exact resulting workspace revision"
  );
  if (expectedPaths) {
    const verified = verification.verificationPaths;
    const assigned = observed.privateOracle?.files;
    requireEvidence(
      verified?.length === expectedPaths.length &&
        assigned?.length === expectedPaths.length &&
        expectedPaths.every(
          (path) =>
            verified.includes(path) &&
            assigned.some(
              (file) => file.path === path && file.fileId && file.sourceChangeIds?.length
            )
        ),
      "The managed integration oracle must verify every assigned file and retain its exact source history"
    );
  }
  return {
    world: {
      context_id: observed.contextId,
      seed_revision: observed.commonSeedEvent.eventId,
      source_revision: observed.source.eventId,
    },
    checks: { independentlyVerifiedWorkspaceIntegration: true },
    evidence: { workspace: { fixture: observed, verification } },
  };
}

function unitRepairEvidence(execution, exercise) {
  const fixture = execution.diagnostics.unitRepairWorld;
  const verification = execution.diagnostics.unitRepairVerification;
  const final = verification?.evidence;
  const receipt = final?.tests?.receipt;
  const checks = verification?.checks;
  const protectedSource = final?.protectedSource;
  requireEvidence(
    fixture?.contextId === execution.provenance?.contextId &&
      typeof fixture?.unit === "string" &&
      fixture?.baseline?.some((diagnostic) => diagnostic.severity === "error") &&
      typeof fixture?.before === "string" &&
      typeof fixture?.after === "string" &&
      fixture.before !== fixture.after &&
      exercise.report?.status === "verified" &&
      exercise.report.revision === fixture.after &&
      final?.revision === fixture.after &&
      final.build?.status === "ok" &&
      verification?.passed === true &&
      checks?.changedRevision === true &&
      checks?.sourceBuild === true &&
      checks?.originalManifestAndTests === true &&
      protectedSource?.before?.length === 2 &&
      JSON.stringify(protectedSource.before) === JSON.stringify(protectedSource.after) &&
      checks?.originalWorkerdSuite === true &&
      final.tests?.status === "passed" &&
      final.tests?.report?.total === 5 &&
      receipt?.protocol === "unit-verification-receipt.v1" &&
      receipt?.operation === "test" &&
      receipt?.contextId === fixture.contextId &&
      receipt?.target === fixture.unit &&
      receipt?.stateHash === final.build.stateHash &&
      receipt?.runtime === "workerd" &&
      receipt?.artifactKey &&
      receipt?.executionDigest,
    "Missing independent compiler and original workerd test evidence at the repaired revision"
  );
  return {
    world: { context_id: fixture.contextId, seed_revision: fixture.before },
    checks,
    evidence: { workspace: { fixture, verification } },
  };
}

function ownedOperationsEvidence(execution, exercise, scenario) {
  const fixture = execution.diagnostics.ownedOperationsWorld;
  const verification = execution.diagnostics.ownedOperationsVerification;
  const audit = execution.diagnostics.ownedOperationsAudit;
  const cleanup = execution.diagnostics.ownedOperationsCleanupErrors;
  requireEvidence(
    fixture?.kind === "owned-operations" &&
      fixture.contextId === execution.provenance?.contextId &&
      typeof fixture.caseId === "string" &&
      scenario === `owned-operations-${fixture.caseId}` &&
      exercise.report?.kind === fixture.request?.kind &&
      verification?.passed === true &&
      verification.checks?.reportedHandles === true &&
      verification.checks?.reportedCleanup === true &&
      verification.checks?.programRequestedCleanup === true &&
      verification.checks?.actualNoOwnedWorkersRemain === true &&
      verification.checks?.actualNoOwnedContextsRemain === true &&
      Object.values(verification.checks).every((value) => value === true) &&
      cleanup?.length === 0 &&
      audit?.opened?.length > 0 &&
      audit?.snapshots?.length > 0 &&
      audit.remainingEntityIds?.length === 0 &&
      audit.remainingContextIds?.length === 0,
    "Missing independently verified worker persistence and teardown in the owned context"
  );
  return {
    world: { context_id: fixture.contextId, case_id: fixture.caseId },
    checks: verification.checks,
    evidence: { workspace: { fixture, verification, audit, cleanup } },
  };
}

function pdfIntakeEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedPdf;
  const verification = fixture?.verification;
  const report = exercise.report;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.expectedStatus === workflow.expectedStatus &&
      report?.status === workflow.expectedStatus &&
      [
        "sourceUnchanged",
        "workspaceHeadUnchanged",
        "localExtraction",
        "exactCitations",
        "disposition",
      ].every((name) => verification.checks?.[name] === true) &&
      /^[a-f0-9]{64}$/u.test(verification.digest) &&
      report.digest === verification.digest &&
      isDeepStrictEqual(verification.requestedPages, workflow.pages) &&
      isDeepStrictEqual(verification.fault, workflow.fault) &&
      isDeepStrictEqual(verification.attemptedBatches, workflow.attemptedBatches) &&
      isDeepStrictEqual(verification.readPages, workflow.readPages) &&
      isDeepStrictEqual(verification.remaining, workflow.remaining) &&
      isDeepStrictEqual(report.readPages, workflow.readPages) &&
      isDeepStrictEqual(report.remaining, workflow.remaining) &&
      typeof verification.seedRevision === "string",
    "The PDF decision must match the owned source bytes, exact page scope, and a verified local extraction"
  );
  return {
    world: { context_id: fixture.contextId, seed_revision: verification.seedRevision },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function pdfHandoffEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedPdfHandoff;
  const verification = fixture?.verification;
  const pdf = verification?.pdf;
  const scratch = verification?.scratch;
  const results = exercise.report?.results;
  const intake = results?.[0]?.report;
  const handoff = results?.[1]?.report;
  const artifact = scratch?.artifact;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.passed === true &&
      ["exactPdf", "exactHandoff", "verifiedTransfer"].every(
        (key) => verification.checks?.[key] === true
      ) &&
      pdf?.passed === true &&
      scratch?.passed === true &&
      pdf.caseId === workflow.caseId &&
      pdf.expectedStatus === workflow.expectedStatus &&
      intake?.status === workflow.expectedStatus &&
      /^[a-f0-9]{64}$/u.test(pdf.digest) &&
      intake.digest === pdf.digest &&
      isDeepStrictEqual(pdf.requestedPages, workflow.pages) &&
      isDeepStrictEqual(pdf.fault, workflow.fault) &&
      isDeepStrictEqual(pdf.attemptedBatches, workflow.attemptedBatches) &&
      isDeepStrictEqual(intake.readPages, workflow.readPages) &&
      isDeepStrictEqual(intake.remaining, workflow.remaining) &&
      isDeepStrictEqual(
        verification.sourceDigests?.map(({ id }) => id),
        workflow.readPages.map((page) => `page-${page}`)
      ) &&
      verification.sourceDigests.every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256)) &&
      results.length === 2 &&
      handoff?.status === workflow.expectedHandoff &&
      scratch.expectedStatus === workflow.expectedHandoff &&
      (workflow.expectedHandoff === "unanswered"
        ? artifact === null && handoff.artifact === null
        : artifact &&
          artifact.path === handoff.artifact?.path &&
          artifact.bytes === handoff.artifact?.bytes &&
          /^[a-f0-9]{64}$/u.test(artifact.sha256)),
    "The scratch artifact must match the verified PDF prefix and the observed handoff disposition"
  );
  return {
    world: { context_id: fixture.contextId, seed_revision: pdf.seedRevision },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function panelHealthEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedPanelHealth;
  const verification = fixture?.verification;
  const observations = verification?.observations;
  const [first, later] = Array.isArray(observations) ? observations : [];
  const { assignment } = workflow;
  const report = exercise.report;
  const observed = (observation, frame) => {
    if (
      !observation ||
      typeof observation.id !== "string" ||
      !observation.id ||
      observation.panelId !== verification.panelId ||
      observation.phase !== "ready" ||
      typeof observation.attemptId !== "string" ||
      !observation.attemptId ||
      typeof observation.buildKey !== "string" ||
      !observation.buildKey ||
      observation.dropped !== 0 ||
      !Number.isSafeInteger(observation.consoleThrough) ||
      !Array.isArray(observation.markers) ||
      !Array.isArray(observation.diagnostics)
    )
      return false;
    const expected = new Map(
      frame.markers
        .filter(([id]) => assignment.markers.some(([marked]) => marked === id))
        .map(([id, ...values]) => [id, values])
    );
    const ownedLogs = observation.diagnostics.filter(({ message }) =>
      message?.startsWith("panel-health: ")
    );
    return (
      observation.markers.length === expected.size &&
      new Set(observation.markers.map(({ id }) => id)).size === expected.size &&
      observation.markers.every(({ id, values }) => isDeepStrictEqual(values, expected.get(id))) &&
      isDeepStrictEqual(
        ownedLogs.map(({ level, message }) => ({ level, message })),
        frame.logs
      ) &&
      observation.diagnostics.every(
        (row, index, rows) =>
          Number.isSafeInteger(row.sequence) &&
          row.sequence > (rows[index - 1]?.sequence ?? 0) &&
          row.sequence <= observation.consoleThrough &&
          (row.level !== "error" ||
            frame.logs.some((log) => log.level === "error" && log.message === row.message))
      )
    );
  };
  function assessment(observation, expected) {
    const blockers = (expected.markers ?? []).map((id) => "marker/" + id);
    for (const message of expected.errors ?? []) {
      const row = observation.diagnostics.find(
        (item) => item.level === "error" && item.message === message
      );
      if (!row) return null;
      blockers.push("console/" + row.sequence);
    }
    if (expected.identity) blockers.push("observation-mismatch");
    return { state: expected.state, blockers, evidence: [observation.id] };
  }
  const newEvidence =
    first &&
    later &&
    (later.consoleThrough > first.consoleThrough ||
      later.attemptId !== first.attemptId ||
      later.buildKey !== first.buildKey ||
      !isDeepStrictEqual(later.markers, first.markers));
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      fixture.caseId === workflow.caseId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === fixture.caseId &&
      typeof verification.panelId === "string" &&
      verification.passed === true &&
      ["exactOps", "initial", "followUp", "ownedPanel", "report", "protectedHeadUnchanged"].every(
        (key) => verification.checks?.[key] === true
      ) &&
      Array.isArray(observations) &&
      observations.length === (assignment.later ? 2 : 1) &&
      observed(first, assignment.initial) &&
      (!assignment.later ||
        (observed(later, assignment.later) &&
          first.id !== later.id &&
          later.consoleThrough >= first.consoleThrough &&
          later.diagnostics.every((row) => row.sequence > first.consoleThrough) &&
          Boolean(newEvidence) !== Boolean(assignment.expected.later.identity))) &&
      isDeepStrictEqual(report, {
        initial: assessment(first, assignment.expected.initial),
        later: later ? assessment(later, assignment.expected.later) : null,
        outcome: assignment.expected.outcome,
      }),
    "Panel health must bind its findings to live DOM, retained diagnostic sequences and new evidence"
  );
  const children = (parent, name) =>
    parent
      ? exercise.calls.filter(
          ({ record }) =>
            record.parent_call_id === parent.callId &&
            record.definition?.name === name &&
            record.outcome === "done"
        )
      : [];
  const root = exercise.calls.find(({ callId }) => callId === exercise.rootCallIds[0]);
  const skill = children(root, workflow.root)[0];
  const starts = children(skill, "assessObservation");
  const follow = children(skill, "checkHealthChange");
  const assessed = [...starts, ...follow.flatMap((call) => children(call, "assessObservation"))];
  requireEvidence(
    starts.length === 1 &&
      follow.length === Number(Boolean(later)) &&
      follow.every((call) => children(call, "checkObservationIdentity").length === 1) &&
      assessed.length === (later && !assignment.expected.later.identity ? 2 : 1) &&
      assessed.every(
        (call) =>
          children(call, "checkMarkers").length === 1 &&
          children(call, "checkDiagnostics").length === 1
      ),
    "Panel health capture must include live marker, diagnostic and recovery checks"
  );
  return {
    world: {
      context_id: fixture.contextId,
      panel_id: verification.panelId,
      panel_attempt: (later ?? first).attemptId,
    },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function presentationEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedPresentation;
  const verification = fixture?.verification;
  const ready = exercise.report?.views?.filter((view) => view.status === "ready");
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      fixture.caseId === workflow.caseId &&
      verification?.passed === true &&
      typeof verification.panelAttempt === "string" &&
      typeof verification.buildKey === "string" &&
      [
        "ownedPanel",
        "exactViewOrder",
        "browserRenderedCatalog",
        "visibleLabels",
        "exactReport",
        "protectedHeadUnchanged",
      ].every((name) => verification.checks?.[name] === true) &&
      JSON.stringify(verification.rendered?.ids) === JSON.stringify(workflow.renderedIds) &&
      JSON.stringify(ready?.map(({ id }) => id)) === JSON.stringify(workflow.renderedIds) &&
      ready.every(({ rendered }) => typeof rendered?.mdx === "string") &&
      JSON.stringify(ready.map(({ rendered }) => hash(rendered.mdx))) ===
        JSON.stringify(verification.mdxDigests),
    "The grounded presentation must match its managed browser readback and exact MDX"
  );
  if (workflow.interactions?.length) {
    requireEvidence(
      verification.checks?.interactiveReadback === true &&
        isDeepStrictEqual(verification.rendered?.interactions, workflow.interactions),
      "The presentation must demonstrate its assigned controls in the live browser"
    );
  }
  return {
    world: { context_id: fixture.contextId, panel_attempt: verification.panelAttempt },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function liveTestkitCleanupEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedTestkitCleanup;
  const { verification, contextId } = fixture ?? {};
  const { assignment } = workflow;
  const evidence = verification?.evidence;
  const report = exercise.report;
  const receipt = `${contextId}:testkit-cleanup`;
  const { acquired, release, remaining } = evidence ?? {};
  requireEvidence(
    typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      verification?.caseId === assignment.id &&
      verification.passed === true &&
      verification.checks?.exactRead === true &&
      verification.checks?.protectedUnchanged === true &&
      verification.checks?.joinedReport === true &&
      evidence?.protectedUnchanged === true &&
      evidence.receipt === receipt &&
      evidence.outcome === assignment.expected.outcome &&
      Array.isArray(acquired) &&
      acquired.length === assignment.plan.length &&
      acquired.every(
        (resource, index) =>
          resource?.kind === assignment.plan[index].kind &&
          typeof resource.id === "string" &&
          resource.id.length
      ) &&
      new Set(acquired.map(({ id }) => id)).size === acquired.length &&
      release?.kind === "testkit" &&
      release.receipt === `${receipt}:deferred`,
    "The live Testkit review must bind the owned suite and its acquired resources"
  );
  const { expected } = assignment;
  const slots = new Map(assignment.plan.map(({ slot }, index) => [slot, acquired[index]]));
  const registered = assignment.plan
    .filter(({ cleanup }) => cleanup !== "unregistered")
    .map(({ slot }) => slots.get(slot));
  const failed = new Set(expected.failed.map((slot) => slots.get(slot).id));
  const cleanupOrder = [...registered].reverse().map((resource) => ({
    ...resource,
    acknowledgement: failed.has(resource.id) ? "failed" : "released",
  }));
  requireEvidence(
    isDeepStrictEqual(release.resources, registered) &&
      isDeepStrictEqual(release.released, cleanupOrder) &&
      isDeepStrictEqual(
        remaining,
        expected.remaining.map((slot) => slots.get(slot))
      ) &&
      Array.isArray(evidence.logs) &&
      evidence.logs.filter((line) => typeof line === "string" && line.startsWith("cleanup failed:"))
        .length === failed.size &&
      (expected.outcome === "passed"
        ? evidence.error === null
        : expected.outcome === "timeout"
          ? evidence.error?.includes("timed out")
          : evidence.error?.startsWith("Assigned fixture failure")) &&
      isDeepStrictEqual(report, {
        receipt,
        testOutcome: evidence.outcome,
        release: {
          decision: failed.size ? "revise" : "confirmed",
          finding: expected.release,
          evidenceIds: [release.receipt],
        },
        inventory: expected.inventory,
        remainingIds: remaining.map(({ id }) => id),
      }),
    "The live Testkit report must match the terminal outcome, release acknowledgements and remaining inventory"
  );
  const child = (parent, name) =>
    parent &&
    exercise.calls.find(
      ({ record }) =>
        record.parent_call_id === parent &&
        record.definition?.name === name &&
        record.outcome === "done"
    )?.callId;
  const review = child(exercise.rootCallIds[0], "reviewLiveCleanup");
  const inventory = child(review, "inspectInventory");
  requireEvidence(
    child(review, "readCleanup") &&
      child(review, "readOutcome") &&
      child(review, "checkTestkitRelease") &&
      inventory &&
      (!remaining.length || child(inventory, "matchRegistrations")),
    "The live Testkit review must capture its outcome, release and nested inventory checks"
  );
  return {
    world: { context_id: contextId, cleanup_receipt: receipt },
    checks: { ...verification.checks, observedDeferredInventory: true },
    evidence: { workspace: { fixture } },
  };
}

function liveSessionReplayEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedSessionReplay;
  const { verification, contextId } = fixture ?? {};
  const { assignment } = workflow;
  const evidence = verification?.evidence;
  const findings = exercise.report?.findings;
  requireEvidence(
    typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      verification?.caseId === assignment.id &&
      verification.passed === true &&
      verification.checks?.exactReadOrder === true &&
      verification.checks?.reportMatchesReplay === true &&
      Array.isArray(evidence) &&
      evidence.length === assignment.steps.length &&
      Array.isArray(findings) &&
      findings.length === evidence.length,
    "The live session replay must bind the assigned fixture and report"
  );
  const originalChannel = evidence[0]?.originalChannel;
  const lanes = new Map();
  const submitted = new Map();
  let alternateChannel;
  const validRows = (rows) =>
    Array.isArray(rows) &&
    rows.every(
      (row) =>
        typeof row?.id === "string" &&
        row.id.length > 0 &&
        typeof row.senderId === "string" &&
        row.senderId.length > 0 &&
        typeof row.text === "string"
    ) &&
    new Set(rows.map(({ id }) => id)).size === rows.length;
  const matches = evidence.every((checkpoint, index) => {
    const { receipt, original, retry, replayChannel, originBefore, before, after } = checkpoint;
    const step = assignment.steps[index];
    const foreign = step.action.startsWith("other-channel");
    const attempted = step.action !== "inspect" && step.action !== "other-channel";
    if (
      receipt !== `${contextId}:replay:${index + 1}` ||
      typeof originalChannel !== "string" ||
      !originalChannel ||
      checkpoint.originalChannel !== originalChannel ||
      typeof replayChannel !== "string" ||
      !replayChannel ||
      (replayChannel !== originalChannel) !== foreign ||
      (foreign && alternateChannel && replayChannel !== alternateChannel) ||
      ![originBefore, before, after].every(validRows)
    )
      return false;
    if (foreign) alternateChannel = replayChannel;
    if (!lanes.has(originalChannel)) {
      if (
        !isDeepStrictEqual(
          originBefore.map(({ text }) => text),
          assignment.messages
        )
      )
        return false;
      lanes.set(originalChannel, originBefore);
    }
    if (!lanes.has(replayChannel)) {
      if (before.length !== 1 || before[0].text !== assignment.messages[0]) return false;
      lanes.set(replayChannel, before);
    }
    const originalRow = originBefore[step.original];
    if (
      !isDeepStrictEqual(originBefore, lanes.get(originalChannel)) ||
      !isDeepStrictEqual(before, lanes.get(replayChannel)) ||
      !originalRow ||
      original?.messageId !== originalRow.id ||
      original.text !== originalRow.text ||
      original.key !== `source-${step.original}` ||
      Boolean(retry) !== attempted
    )
      return false;
    let expectedLength = before.length;
    if (attempted) {
      const key = step.action === "append" ? `additional-${index}` : original.key;
      const text = step.text ?? original.text;
      if (retry.key !== key || retry.text !== text || typeof retry.messageId !== "string")
        return false;
      const coordinate = replayChannel + "/" + key;
      const prior =
        !foreign && key === original.key ? original.messageId : submitted.get(coordinate);
      if (prior) {
        if (retry.messageId !== prior) return false;
      } else {
        const extra = after.at(-1);
        if (
          before.some(({ id }) => id === retry.messageId) ||
          extra?.id !== retry.messageId ||
          extra.text !== text ||
          extra.senderId !== originalRow.senderId
        )
          return false;
        expectedLength += 1;
        submitted.set(coordinate, retry.messageId);
      }
    }
    lanes.set(replayChannel, after);
    return (
      after.length === expectedLength &&
      isDeepStrictEqual(after.slice(0, before.length), before) &&
      isDeepStrictEqual(findings[index], {
        receipt,
        disposition: step.expected,
        originalId: original.messageId,
        retryId: retry?.messageId ?? null,
        retainedIds: after.map(({ id }) => id),
      })
    );
  });
  requireEvidence(
    matches,
    "The live session report must match the accepted retry and preserved transcripts"
  );

  const children = (parent, name) =>
    exercise.calls.filter(
      ({ record }) =>
        record.parent_call_id === parent &&
        record.definition?.name === name &&
        record.outcome === "done"
    );
  const review = children(exercise.rootCallIds[0], "reviewLiveReplay")[0];
  const inspections = children(review?.callId, "inspectCheckpoint");
  const inspectionBranch = (call, index) => {
    const action = assignment.steps[index].action;
    if (children(call.callId, "matchesChannel").length !== 1) return false;
    if (action.startsWith("other-channel")) return true;
    const [retry] = children(call.callId, "classifyRetry");
    return (
      children(call.callId, "preservesReplay").length === 1 &&
      retry &&
      (action === "inspect" || children(retry.callId, "matchAcceptedIdentity").length === 1)
    );
  };
  requireEvidence(
    review &&
      children(review.callId, "readCheckpoint").length === evidence.length &&
      inspections.length === evidence.length &&
      inspections
        .sort(
          (left, right) => Date.parse(left.record.started_at) - Date.parse(right.record.started_at)
        )
        .every(inspectionBranch),
    "The live session review must record each replay inspection and its nested decision calls"
  );
  return {
    world: { context_id: contextId, owning_channel: originalChannel },
    checks: { ...verification.checks, acceptedReplaySequence: true },
    evidence: { workspace: { fixture } },
  };
}

function authoringEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedAuthoring;
  const verification = fixture?.verification;
  const report = exercise.report;
  const revision = /^[a-f0-9]{64}$/u;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.status === workflow.expectedStatus &&
      report?.status === workflow.expectedStatus &&
      revision.test(verification.candidateRevision) &&
      report.candidateRevision === verification.candidateRevision &&
      report.baselineRevision === verification.baselineRevision &&
      (workflow.comparedBaseline
        ? revision.test(verification.baselineRevision)
        : verification.baselineRevision === null) &&
      [
        "sourceUnchanged",
        "workspaceHeadUnchanged",
        "exactInspections",
        "intendedWorld",
        "joinedFindings",
      ].every((name) => verification.checks?.[name] === true),
    "The authoring review must match the assigned compiler snapshots and exact source revisions"
  );
  if (workflow.trackedScopes) {
    const readbacks = verification.scopeReadbacks;
    const findings = report?.findings;
    const foundMarkers = Array.isArray(findings)
      ? findings.map(({ code, subject }) => `${code}:${subject}`).sort()
      : null;
    const child = (parentId, name) =>
      parentId &&
      exercise.calls.find(
        ({ record }) =>
          record.parent_call_id === parentId &&
          record.definition?.name === name &&
          record.outcome === "done"
      )?.callId;
    const root = child(exercise.rootCallIds[0], "reviewProgram");
    const inspection = child(root, "inspectRevisions");
    const contract = child(root, "reviewContract");
    const authority = child(contract, "checkAuthority");
    requireEvidence(
      Array.isArray(readbacks) &&
        readbacks.length === workflow.trackedScopes.length &&
        readbacks.every(
          ({ role, revision: digest, scopes }, index) =>
            role === (index === 0 ? "candidate" : "baseline") &&
            digest ===
              (index === 0 ? verification.candidateRevision : verification.baselineRevision) &&
            digest === workflow.trackedScopes[index].revision &&
            isDeepStrictEqual(scopes, workflow.trackedScopes[index].scopes)
        ) &&
        isDeepStrictEqual(
          foundMarkers,
          workflow.expectedMarkers.map(({ code, subject }) => `${code}:${subject}`).sort()
        ) &&
        child(inspection, "readAssignedProgram") &&
        child(authority, "checkServices") &&
        child(authority, "compareSelectors"),
      "The authority review must match the compiled scopes and nested selector checks"
    );
  }
  return {
    world: {
      context_id: fixture.contextId,
      candidate_revision: verification.candidateRevision,
      baseline_revision: verification.baselineRevision,
    },
    checks: {
      ...verification.checks,
      ...(workflow.trackedScopes ? { reviewedCompilerScopes: true } : {}),
    },
    evidence: { workspace: { fixture } },
  };
}

function verifiedMemoryEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedMemory;
  const verification = fixture?.verification;
  const report = exercise.report;
  const citation = verification?.citation;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      typeof verification.eventId === "string" &&
      verification.status === workflow.expectedStatus &&
      report?.status === workflow.expectedStatus &&
      report.leadId === verification.leadId &&
      verification.leadId === (report.status === "no-lead" ? null : verification.eventId) &&
      ["protectedMainUnchanged", "actualRecall", "observedWorld", "joinedSource"].every(
        (name) => verification.checks?.[name] === true
      ) &&
      (report.status === "verified"
        ? citation?.eventId === verification.eventId &&
          ["eventId", "path", "contentHash", "quote", "line"].every(
            (name) => report.citation?.[name] === citation[name]
          )
        : citation === null && report.citation === null),
    "The Personal memory report must match its recalled event and exact committed source"
  );
  return {
    world: { context_id: fixture.contextId, selected_event: verification.eventId },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function verifiedMemoryComparisonEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedMemory;
  const verification = fixture?.verification;
  const endpoints = verification?.endpoints;
  const rootId = exercise.rootCallIds[0];
  const children = (parent) =>
    exercise.calls.filter(
      ({ record }) => record?.parent_call_id === parent && record.outcome === "done"
    );
  const comparison = children(rootId).find(
    ({ record }) => record.definition?.name === "compareDecisionRevisions"
  );
  const nested = comparison ? children(comparison.callId) : [];
  const anchored = (endpoint, eventId, status) =>
    endpoint?.status === status &&
    endpoint.leadId === (status === "no-lead" ? null : eventId) &&
    (status === "verified" ? endpoint.citation?.eventId === eventId : endpoint.citation === null);
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.status === workflow.expectedStatus &&
      exercise.report?.status === workflow.expectedStatus &&
      endpoints &&
      typeof endpoints.beforeEventId === "string" &&
      typeof endpoints.afterEventId === "string" &&
      endpoints.beforeEventId !== endpoints.afterEventId &&
      endpoints.afterEventId === verification.eventId &&
      anchored(endpoints.before, endpoints.beforeEventId, workflow.beforeStatus) &&
      anchored(endpoints.after, endpoints.afterEventId, workflow.afterStatus) &&
      isDeepStrictEqual(exercise.report.before, endpoints.before) &&
      isDeepStrictEqual(exercise.report.after, endpoints.after) &&
      nested.filter(({ record }) => record.definition?.name === "recallDecision").length === 2 &&
      nested.some(({ record }) => record.definition?.name === "classifyComparison") &&
      ["protectedMainUnchanged", "actualRecall", "observedWorld", "joinedSource"].every(
        (name) => verification.checks?.[name] === true
      ),
    "The comparison must retain both nested recalls and their exact committed source revisions"
  );
  return {
    world: {
      context_id: fixture.contextId,
      before_event: endpoints.beforeEventId,
      after_event: endpoints.afterEventId,
    },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function provenanceHistoryEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedProvenanceHistory;
  const verification = fixture?.verification;
  const report = exercise.report;
  const readbacks = verification?.readbacks;
  const assigned = workflow.constraint;
  function matchesConstraint() {
    if (!assigned) return report.constraint === undefined && verification.constraint === undefined;
    const child = (parent, name) =>
      exercise.calls.find(
        ({ record }) =>
          parent &&
          record?.parent_call_id === parent &&
          record.definition?.name === name &&
          record.outcome === "done"
      )?.callId;
    const skill = child(exercise.rootCallIds[0], "reviewProvenance");
    const history = child(skill, "reviewLiveHistory");
    const proposal = child(history, "assessProposedProperty");
    const judgment = child(proposal, "weighConstraint");
    if (!judgment || !child(judgment, "compareProperty") || !child(judgment, "judgeConstraint"))
      return false;
    if (
      verification.property !== assigned.proposedProperty ||
      report.constraint?.status !== assigned.status ||
      verification.constraint?.status !== assigned.status
    )
      return false;
    const records = readbacks.flatMap(({ receipt }) => receipt.records);
    const match = records.find((record) => {
      if (assigned.evidence === "retry-counteraction")
        return (
          record.group === "counteractions" &&
          /300 seconds/iu.test(record.detail ?? "") &&
          /staging cut the link/iu.test(record.intent ?? "")
        );
      if (assigned.evidence === "policy")
        return /Cap the retry backoff at 30 seconds/iu.test(record.intent ?? "");
      if (assigned.evidence === "cache")
        return /Cache the upstream feed for 900 seconds/iu.test(record.intent ?? "");
      return false;
    });
    if (assigned.evidence !== "none" && !match) return false;
    const ids = JSON.stringify(match ? [match.ref] : []);
    return (
      JSON.stringify(report.constraint.evidence) === ids &&
      JSON.stringify(verification.constraint.evidence) === ids
    );
  }
  const sources = new Map();
  const sameCheck = (left, right) =>
    left?.path === right.path && left.walk === right.walk && left.scope === right.scope;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.checks?.unchanged === true &&
      verification.checks?.exactReads === true &&
      verification.checks?.history === true &&
      verification.checks?.report === true &&
      verification.checks?.constraint === true &&
      typeof verification.repoPath === "string" &&
      verification.repoPath.startsWith("projects/") &&
      typeof verification.repositoryId === "string" &&
      verification.repositoryId.length > 0 &&
      verification.workingHead?.kind === "event" &&
      report?.kind === "live-history" &&
      Array.isArray(report.findings) &&
      Array.isArray(readbacks) &&
      report.findings.length === workflow.checks.length &&
      readbacks.length === workflow.checks.length &&
      workflow.checks.every((check, index) => {
        const read = readbacks[index];
        const entry = report.findings[index];
        const receipt = read?.receipt;
        if (!sameCheck(entry?.check, check) || !sameCheck(receipt?.check, check)) return false;
        const walk = read.walk;
        if (check.path === "src/retired-ingress.ts") {
          return (
            walk === null &&
            read.fileId === null &&
            receipt.exists === false &&
            receipt.records.length === 0 &&
            entry.status === "coordinate-absent" &&
            entry.evidence?.length === 0
          );
        }
        if (
          !walk ||
          receipt.exists !== true ||
          walk.walk !== check.walk ||
          walk.subject?.kind !== "file" ||
          walk.subject.fileId !== read.fileId ||
          walk.subject.repositoryId !== verification.repositoryId ||
          JSON.stringify(walk.subject.state) !== JSON.stringify(verification.workingHead) ||
          (check.walk === "cohort" && walk.scope !== check.scope) ||
          walk.entries.length !== receipt.records.length
        )
          return false;
        const limited = Boolean(
          walk.nextCursor ||
          walk.omitted.length ||
          walk.entries.some((row) => row.boundary === "outside-visibility")
        );
        const status = limited ? "limited" : walk.entries.length ? "recorded" : "none-visible";
        return (
          receipt.limited === limited &&
          entry.status === status &&
          walk.entries.every((row, item) => {
            const recorded = receipt.records[item];
            const key = JSON.stringify(row.node);
            if (!sources.has(key)) sources.set(key, `source:${sources.size + 1}`);
            return (
              recorded?.ref === `history:${index + 1}:${item + 1}` &&
              recorded.label === row.label &&
              recorded.source === sources.get(key) &&
              recorded.group === (row.group ?? null) &&
              recorded.detail === (row.detail ?? null) &&
              recorded.intent === (row.intent?.text ?? null)
            );
          }) &&
          JSON.stringify(entry.evidence) === JSON.stringify(receipt.records.map((row) => row.ref))
        );
      }) &&
      matchesConstraint(),
    "Provenance history must cite the exact repository, walk scope, and recorded coordinates"
  );
  return {
    world: {
      context_id: fixture.contextId,
      repository_id: verification.repositoryId,
      head: verification.workingHead,
    },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function runtimeProgramEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedRuntimeProgram;
  const verification = fixture?.verification;
  const observed = verification?.observed;
  const request = observed?.request;
  const receipt = observed?.receipt;
  const report = exercise.report;
  const step = workflow.execution;
  const basis = request?.execution?.id ?? request?.path;
  const failedCompile = ["repair-result-contract", "resolve-import", "read-diagnostic"].includes(
    workflow.expected
  );
  const diagnostic =
    {
      "repair-result-contract": "result-type",
      "resolve-import": "missing-import",
      "read-diagnostic": "other",
    }[workflow.expected] ?? null;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      observed?.contextId === fixture.contextId &&
      observed.caseId === workflow.caseId &&
      observed.expected === workflow.expected &&
      verification.passed === true &&
      verification.checks?.observation === true &&
      verification.checks?.verdict === true &&
      verification.checks?.basis === true &&
      verification.checks?.source === true &&
      request?.kind === "program" &&
      request.goal === workflow.goal &&
      typeof request.path === "string" &&
      request.path.endsWith("/main.ts") &&
      request.call === null &&
      request.userRequestedRetry === false &&
      request.compiler === (failedCompile ? "failed" : "passed") &&
      request.diagnostic === diagnostic &&
      receipt?.signature === !failedCompile &&
      receipt.original === workflow.original &&
      receipt.current === workflow.current &&
      typeof receipt.evalRunId === "string" &&
      receipt.evalRunId.length > 0 &&
      receipt.evalRunId !== exercise.evalRunId &&
      (step
        ? request.execution?.id === receipt.evalRunId &&
          request.execution?.state === (step.kind === "check" ? "verified" : step.kind) &&
          JSON.stringify(request.execution) === JSON.stringify(receipt.execution) &&
          (step.kind === "failure"
            ? typeof receipt.thrown === "string" && receipt.thrown.includes(step.message)
            : receipt.thrown === null &&
              (step.kind === "unchecked" ||
                JSON.stringify(receipt.returned) === JSON.stringify(step.output)))
        : request.execution === undefined && receipt.execution === null) &&
      report?.kind === "program" &&
      report.next === workflow.expected &&
      report.basis === basis,
    "Runtime review must cite the original owned compiler or execution receipt"
  );
  return {
    world: {
      context_id: fixture.contextId,
      program_path: request.path,
      execution_run_id: receipt.evalRunId,
    },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function incidentContinuationEvidence(execution, exercise, scenario, workflow) {
  const fixture = execution.diagnostics.managedIncidentContinuation;
  const verification = fixture?.verification;
  const report = exercise.report;
  const results = report?.results;
  const windowCount = workflow.logWorkflow.windows.length;
  const refCount = workflow.modelWorkflow.request.alternatives.length + 1;
  const journal = verification?.journal;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.checks?.reportOrder === true &&
      verification.checks?.readOrder === true &&
      verification.checks?.log === true &&
      verification.checks?.models === true &&
      Array.isArray(results) &&
      results.length === 2 &&
      Array.isArray(report.remaining) &&
      report.remaining.length === 0 &&
      results[0]?.kind === "domain" &&
      results[0].domain === "system" &&
      results[0].operation === "investigateSystem" &&
      results[1]?.kind === "domain" &&
      results[1].domain === "localModel" &&
      results[1].operation === "prepareLocalModel" &&
      Array.isArray(journal) &&
      journal.length === windowCount + refCount &&
      journal.every((entry, index) =>
        index < windowCount
          ? entry?.kind === "host-log" && entry.index === index
          : entry?.kind === "local-model" && entry.index === index - windowCount
      ),
    "Incident continuation requires the complete host log review before the assigned local inventory"
  );
  const log = hostLogAuditEvidence(
    execution,
    { report: results[0].report },
    scenario,
    workflow.logWorkflow
  );
  const models = localComparisonEvidence(
    execution,
    { report: results[1].report },
    scenario,
    workflow.modelWorkflow
  );
  return {
    world: { ...log.world, assigned_models: models.world.assigned_models },
    checks: verification.checks,
    evidence: {
      workspace: {
        fixture,
        log: log.evidence.workspace.fixture,
        localModels: models.evidence.workspace.fixture,
      },
    },
  };
}

function hostLogAuditEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedLogAudit;
  const verification = fixture?.verification;
  const report = exercise.report;
  const seed = verification?.seed;
  const observed = verification?.observed;
  const windows = workflow.windows;
  const sameFinding = (finding, code, ids) =>
    finding?.code === code && JSON.stringify(finding.evidenceIds) === JSON.stringify(ids);
  const status = ["blocked", "attention", "inconclusive", "ready"].find((candidate) =>
    windows.some((window) => window.status === candidate)
  );
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.checks?.exactWindows === true &&
      verification.checks?.summary === true &&
      verification.checks?.reports === true &&
      seed?.marker?.startsWith("natlang-host-log-") &&
      typeof seed.workspaceId === "string" &&
      typeof seed.boot === "string" &&
      seed.boot.length > 0 &&
      Number.isSafeInteger(seed.start) &&
      Array.isArray(seed.steps) &&
      seed.steps.length === workflow.seedCount &&
      seed.steps.every(
        (seq, index) => Number.isSafeInteger(seq) && seq > (seed.steps[index - 1] ?? seed.start)
      ) &&
      report?.status === status &&
      Array.isArray(report.findings) &&
      Array.isArray(report.windows) &&
      Array.isArray(observed) &&
      report.findings.length === windows.length &&
      report.windows.length === windows.length &&
      observed.length === windows.length &&
      windows.every((window, index) => {
        const read = observed[index];
        const result = report.windows[index];
        const sinceSeq = window.cursor === null ? seed.start : seed.steps[window.cursor];
        const expectedIds = window.oldBoot
          ? [seed.boot]
          : window.evidence.map((step) => `${seed.boot}:${seed.steps[step]}`);
        const records =
          window.tag === "WorkerdManager" ? seed.steps.filter((seq) => seq > sinceSeq) : [];
        return (
          read?.boot === seed.boot &&
          read.input?.kind === "server-log-incident" &&
          read.input?.sinceSeq === sinceSeq &&
          read.input?.tag === window.tag &&
          (window.oldBoot
            ? read.input?.expectedBoot === "retired-workspace-log-boot"
            : read.input?.expectedBoot === seed.boot) &&
          JSON.stringify(read.records) === JSON.stringify(records) &&
          result?.status === window.status &&
          result.findings?.length === 1 &&
          sameFinding(result.findings[0], window.code, expectedIds) &&
          sameFinding(report.findings[index], window.code, expectedIds)
        );
      }),
    "Host log findings must cite the assigned boot, cursor, and recorded sequences"
  );
  return {
    world: {
      context_id: fixture.contextId,
      server_boot_id: seed.boot,
      workspace_id: seed.workspaceId,
    },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function matchesValue(ref, value) {
  if (!ref?.complete || value === undefined) return false;
  const bytes = JSON.stringify(value);
  return ref.bytes === Buffer.byteLength(bytes) && ref.hash === hash(bytes);
}

function integrationReadinessEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedIntegrationReadiness;
  const { contextId, request, plan, observations } = fixture ?? {};
  const report = exercise.report;
  const { id, goal, status, destinations } = workflow.assignment;
  const descriptors = destinations.map(({ id, purpose, use, required }) => ({
    id,
    purpose,
    use,
    required,
  }));
  const expected = destinations.map(({ id, state }) => ({
    id,
    receipt: request?.operationId + ":binding:" + id,
    state,
    canRefresh: state === "active" ? false : null,
  }));
  const reviews = expected.map((observation) => ({
    observation,
    disposition: observation.state === "active" ? "ready" : "setup-needed",
  }));
  requireEvidence(
    typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      fixture.caseId === id &&
      fixture.passed === true &&
      ["plan", "bindings", "report"].every((name) => fixture.checks?.[name] === true) &&
      request?.goal === goal &&
      /^[a-f0-9-]{36}$/u.test(request.operationId) &&
      isDeepStrictEqual(plan, {
        receipt: request.operationId + ":integration",
        destinations: descriptors,
      }) &&
      isDeepStrictEqual(observations, expected) &&
      report?.planReceipt === plan.receipt &&
      isDeepStrictEqual(report.held, []) &&
      isDeepStrictEqual(report.destinations, reviews) &&
      report.status === status &&
      (typeof report.guidance === "string"
        ? report.guidance.trim().length > 0
        : status === "ready" && report.guidance === null),
    "Integration readiness must use the assigned host lookups and secret-free binding statuses"
  );

  const calls = exercise.calls.map(({ record }) => record);
  const children = (parentId, name) =>
    calls.filter(
      (record) =>
        record.parent_call_id === parentId &&
        record.definition.name === name &&
        record.outcome === "done"
    );
  const [review] = children(exercise.rootCallIds[0], "reviewIntegration");
  const [readPlan] = children(review?.call_id, "readIntegrationPlan");
  const [summary] = children(review?.call_id, "summarizeCoverage");
  const audienceReviews = children(review?.call_id, "reviewAudience");
  const lookup = (call, service, method, args, output) => {
    const [effect] = call?.effects ?? [];
    return (
      call?.effects?.length === 1 &&
      effect?.service === service &&
      effect.method === method &&
      !effect.error &&
      matchesValue(effect.args, args) &&
      matchesValue(effect.result, output) &&
      matchesValue(call.output, output)
    );
  };
  const reads = [readPlan];
  requireEvidence(
    calls.length === 4 + 3 * reviews.length &&
      audienceReviews.length === reviews.length &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      lookup(readPlan, "integrationPlanRead", "observe", [request.operationId], plan) &&
      reviews.every((result) => {
        const { id } = result.observation;
        const matched = audienceReviews.find((call) =>
          matchesValue(call.inputs?.destinationId, id)
        );
        const [resolved] = children(matched?.call_id, "resolveBinding");
        const [interpreted] = children(matched?.call_id, "interpretBinding");
        reads.push(resolved);
        return (
          matchesValue(matched?.inputs?.planReceipt, plan.receipt) &&
          matchesValue(matched.output, result) &&
          lookup(
            resolved,
            "integrationCredentialLookup",
            "resolve",
            [plan.receipt, id],
            result.observation
          ) &&
          matchesValue(interpreted?.inputs?.observation, result.observation) &&
          matchesValue(interpreted.output, result.disposition)
        );
      }) &&
      matchesValue(summary?.inputs?.goal, goal) &&
      matchesValue(summary.inputs?.destinations, plan.destinations) &&
      matchesValue(summary.inputs?.reviews, report.destinations) &&
      matchesValue(summary.output, { status: report.status, guidance: report.guidance }) &&
      calls.every((record) => record.effects?.length === (reads.includes(record) ? 1 : 0)),
    "Integration readiness must record both scoped host lookups and the required coverage decision"
  );
  return {
    world: { context_id: contextId, destinations: descriptors.map(({ id }) => id) },
    checks: { ...fixture.checks, exactCoverageTree: true },
    evidence: { workspace: { fixture } },
  };
}

function terminalCheckEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedTerminalChecks;
  const { contextId, request, plan, results } = fixture ?? {};
  const report = exercise.report;
  const { id, goal, checks } = workflow.assignment;
  const expectedPlan = checks.map(({ id, purpose, prerequisites, intent }) => ({
    id,
    purpose,
    prerequisites,
    mode: intent.kind,
  }));
  const expectedEffects = new Map(
    checks.filter((check) => check.expected).map((check) => [check.id, check])
  );
  const held = checks.filter((check) => !check.expected).map(({ id }) => id);
  requireEvidence(
    typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      fixture.caseId === id &&
      fixture.passed === true &&
      ["plan", "processes", "report"].every((name) => fixture.checks?.[name] === true) &&
      request?.goal === goal &&
      /^[a-f0-9-]{36}$/u.test(request.operationId) &&
      plan?.receipt === request.operationId + ":plan" &&
      isDeepStrictEqual(plan.checks, expectedPlan) &&
      report?.assignmentReceipt === plan.receipt &&
      isDeepStrictEqual(report.held, held) &&
      Array.isArray(results) &&
      results.length === expectedEffects.size &&
      Array.isArray(report.outcomes) &&
      report.outcomes.length === results.length,
    "Terminal checks must use the exact assigned process plan and held dependencies"
  );
  const passed = new Set();
  requireEvidence(
    results.every((result, index) => {
      const check = expectedEffects.get(result?.id);
      const expected = check?.expected;
      if (!expected || !check.prerequisites.every((id) => passed.has(id))) return false;
      expectedEffects.delete(result.id);
      if (expected.status === "passed") passed.add(result.id);
      return (
        result.receipt === request.operationId + ":check:" + result.id &&
        result.status === "complete" &&
        result.exitCode === expected.exitCode &&
        result.stdout === expected.stdout &&
        result.stderr === "" &&
        result.timedOut === false &&
        result.truncated === (expected.status === "output-truncated") &&
        report.outcomes[index]?.status === expected.status &&
        isDeepStrictEqual(report.outcomes[index].result, result)
      );
    }),
    "Terminal checks must preserve the bounded live results and gate dependent effects"
  );
  const calls = exercise.calls.map(({ record }) => record);
  const review = calls.find(
    (record) =>
      record.parent_call_id === exercise.rootCallIds[0] &&
      record.definition.name === "runTerminalChecks" &&
      record.outcome === "done"
  );
  const children = (name) =>
    review
      ? calls.filter(
          (record) =>
            record.parent_call_id === review.call_id &&
            record.definition.name === name &&
            record.outcome === "done"
        )
      : [];
  const [initial] = children("readAssignedChecks");
  const choices = children("selectNextCheck");
  const executions = children("performCheck");
  const classifications = children("classifyResult");
  const effect = (call, service, method, args, value) => {
    const [effect] = call?.effects ?? [];
    return (
      call?.effects?.length === 1 &&
      effect?.service === service &&
      effect.method === method &&
      !effect.error &&
      matchesValue(effect.args, args) &&
      matchesValue(effect.result, value) &&
      matchesValue(call.output, value)
    );
  };
  const chose = (index, choice) =>
    choices.some(
      (call) =>
        matchesValue(call.inputs?.goal, goal) &&
        matchesValue(call.inputs?.checks, plan.checks) &&
        matchesValue(call.inputs?.outcomes, report.outcomes.slice(0, index)) &&
        matchesValue(call.output, choice)
    );
  requireEvidence(
    matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      calls.length === 4 + 3 * results.length &&
      children("readAssignedChecks").length === 1 &&
      choices.length === results.length + 1 &&
      executions.length === results.length &&
      classifications.length === results.length &&
      effect(initial, "terminalCheckRead", "observe", [request.operationId], plan) &&
      results.every(
        (result, index) =>
          chose(index, result.id) &&
          executions.some((call) =>
            effect(call, "terminalCheckRun", "execute", [plan.receipt, result.id], result)
          ) &&
          classifications.some(
            (call) =>
              matchesValue(call.inputs?.result, result) &&
              matchesValue(call.output, report.outcomes[index].status)
          )
      ) &&
      chose(results.length, null) &&
      calls.every(
        (record) =>
          record.effects?.length === (record === initial || executions.includes(record) ? 1 : 0)
      ),
    "Terminal checks must record every selection, exact execution and result classification"
  );
  return {
    world: { context_id: contextId, process_checks: checks.map(({ id }) => id) },
    checks: { ...fixture.checks, exactExecutionTree: true },
    evidence: { workspace: { fixture } },
  };
}

function clientAdmissionEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedClientAdmission;
  const { caseId, contextId, request, observation, checks } = fixture ?? {};
  const { id, goal, source, host, runtime, publishedAbi, workingAbi, abi } = workflow.assignment;
  const report = exercise.report;
  const calls = exercise.calls.map(({ record }) => record);
  const child = (parent, name) =>
    parent &&
    calls.find((call) => call.parent_call_id === parent.call_id && call.definition.name === name);
  const root = calls.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const review = child(root, "reviewClientAdmission");
  const inspection = child(review, "inspectSource");
  const read = child(inspection, "readClient");
  const hostReview = child(review, "reviewHost");
  const abiCheck = child(hostReview, "checkAbi");
  const capsCheck = child(hostReview, "checkCapabilities");
  const next = child(review, "chooseNext");
  const [effect] = read?.effects ?? [];
  const changed = publishedAbi !== workingAbi;
  requireEvidence(
    caseId === id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      fixture.passed === true &&
      ["source", "host", "catalog", "unchanged", "report"].every((key) => checks?.[key] === true) &&
      request?.goal === goal &&
      typeof request.operationId === "string" &&
      observation?.operationId === request.operationId &&
      observation.contextId === contextId &&
      observation.source === source &&
      observation.working?.runtime === runtime &&
      observation.published?.runtime === runtime &&
      observation.working.abi === workingAbi &&
      observation.published.abi === publishedAbi &&
      typeof observation.working.hash === "string" &&
      typeof observation.published.hash === "string" &&
      (changed
        ? observation.working.hash !== observation.published.hash &&
          observation.workingRevision !== observation.mainRevision
        : observation.working.hash === observation.published.hash) &&
      observation.host?.kind === host &&
      observation.trusted === true &&
      observation.catalog?.source === source &&
      ["available", "building", "ready", "approval-required", "error"].includes(
        observation.catalog.status
      ) &&
      Array.isArray(observation.working.required) &&
      Array.isArray(observation.working.optional) &&
      Array.isArray(observation.host.capabilities) &&
      calls.flatMap(({ effects }) => effects ?? []).length === 1 &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      matchesValue(read?.output, observation) &&
      effect?.service === "clientAdmissionRead" &&
      effect.method === "observe" &&
      !effect.error &&
      matchesValue(effect.args, [request.operationId]) &&
      matchesValue(effect.result, observation) &&
      isDeepStrictEqual(report?.source?.observation, observation) &&
      report.source.disposition === (changed ? "working-change" : "published-contract"),
    "Client admission must preserve the exact working and published manifests, host contract and build catalog"
  );
  const installedAbi = observation.host.runtimes?.[runtime];
  const observedAbi = installedAbi
    ? installedAbi === workingAbi
      ? "compatible"
      : "wrong-abi"
    : "wrong-runtime";
  const { working, catalog } = observation;
  const supported = new Set(observation.host.capabilities);
  const missingRequired = working.required.filter((capability) => !supported.has(capability));
  const deniedOptional = working.optional.filter((capability) => !supported.has(capability));
  const capabilities = { missingRequired, deniedOptional, untrustedRequired: [] };
  const decision =
    abi === "wrong-runtime"
      ? "match-runtime"
      : abi === "wrong-abi"
        ? "resolve-abi"
        : missingRequired.length
          ? "resolve-required-capabilities"
          : changed
            ? "review-candidate"
            : {
                available: "await-build",
                building: "await-build",
                ready: "reviewed-ready",
                "approval-required": "await-approval",
                error: "inspect-build",
              }[catalog.status];
  requireEvidence(
    observedAbi === abi &&
      report.host?.abi === abi &&
      isDeepStrictEqual(report.host.capabilities, capabilities) &&
      report.decision === decision &&
      matchesValue(inspection?.inputs?.operationId, request.operationId) &&
      matchesValue(inspection.output, report.source) &&
      matchesValue(hostReview?.inputs?.observation, observation) &&
      matchesValue(hostReview.output, report.host) &&
      matchesValue(abiCheck?.inputs?.observation, observation) &&
      matchesValue(abiCheck.output, abi) &&
      matchesValue(capsCheck?.inputs?.observation, observation) &&
      matchesValue(capsCheck.output, report.host.capabilities) &&
      matchesValue(next?.inputs?.source, report.source) &&
      matchesValue(next.inputs.host, report.host) &&
      matchesValue(next.output, decision),
    "Client admission needs the exact host compatibility and capability decisions"
  );
  return {
    world: { context_id: contextId, source, host, abi: workingAbi },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function publicationRevisionEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.publicationRevision;
  const { contextId, caseId, source, request, observed, editApplicationId, checks } = fixture ?? {};
  const { assignment } = workflow;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) => parent && records.find(
    (record) => record.parent_call_id === parent.call_id && record.definition.name === name
  );
  const review = child(root, "reviewPublicationRevision");
  const target = child(review, "matchPublicationTarget");
  const impact = child(review, "assessRevisionChange");
  const critical = child(impact, "checkCriticalPaths");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const effect = review?.effects?.[0];
  const validSite = (site) => typeof site?.sourceHash === "string" && !!site.sourceHash &&
    /^sha256:[0-9a-f]{64}$/u.test(site.artifactDigest) &&
    Array.isArray(site.files) && site.files.length > 0 && site.files.length <= 64 &&
    new Set(site.files.map(({ path }) => path)).size === site.files.length &&
    site.files.some(({ path }) => path === site.entry) &&
    site.files.every(({ path, digest, bytes }) =>
      typeof path === "string" && path.length > 0 && /^[0-9a-f]{64}$/u.test(digest) &&
      Number.isSafeInteger(bytes) && bytes >= 0);
  const reviewedIntent = { provider: "vercel", destination: "managed-review/departures", environment: "preview" };
  const candidateIntent = { ...reviewedIntent, environment: assignment.environment };
  requireEvidence(
    fixture?.passed === true &&
      ["package", "target", "decision", "protection"].every((key) => checks?.[key] === true) &&
      caseId === assignment.id && typeof contextId === "string" &&
      contextId === execution.provenance?.contextId && /^panels\/[^/]+$/u.test(source ?? "") &&
      observed?.source === source && request?.goal === assignment.goal &&
      typeof request.operationId === "string" && request.operationId.length > 0 &&
      validSite(observed.reviewed) && validSite(observed.candidate) &&
      isDeepStrictEqual(observed.reviewed.intent, reviewedIntent) &&
      isDeepStrictEqual(observed.candidate.intent, candidateIntent) &&
      isDeepStrictEqual(report?.comparison, observed) &&
      matchesValue(review?.inputs?.request, request) && matchesValue(review.output, report) &&
      effects.length === 1 && effect?.service === "publicationRevision" && effect.method === "compare" &&
      !effect.error && matchesValue(effect.args, [request.operationId]) && matchesValue(effect.result, observed),
    "Publication revision requires an exact pair of sealed website packages and destinations"
  );
  const original = new Map(observed.reviewed.files.map((file) => [file.path, file]));
  const candidate = new Map(observed.candidate.files.map((file) => [file.path, file]));
  const changes = {
    added: observed.candidate.files.filter(({ path }) => !original.has(path)),
    removed: observed.reviewed.files.filter(({ path }) => !candidate.has(path)),
    modified: observed.candidate.files.flatMap((file) => {
      const before = original.get(file.path);
      return before && (before.digest !== file.digest || before.bytes !== file.bytes)
        ? [{ before, after: file }] : [];
    }),
  };
  const paths = [
    ...changes.added.map(({ path }) => path),
    ...changes.removed.map(({ path }) => path),
    ...changes.modified.map(({ after }) => after.path),
  ].sort();
  const expectedImpact = {
    affectedPaths: paths,
    entryChanged: observed.reviewed.entry !== observed.candidate.entry ||
      paths.includes(observed.reviewed.entry) || paths.includes(observed.candidate.entry),
    htmlChanged: paths.includes("index.html"),
    manifestChanged: paths.includes("vibestudio-build.json"),
  };
  const expectedTarget = assignment.environment === "preview" ? "same-target" : "different-target";
  requireEvidence(
    isDeepStrictEqual(observed.change, changes) && isDeepStrictEqual(report.impact, expectedImpact) &&
      report.match === expectedTarget && report.decision === assignment.decision &&
      typeof report.reason === "string" && report.reason.trim() &&
      matchesValue(target?.inputs?.reviewed, reviewedIntent) &&
      matchesValue(target?.inputs?.candidate, candidateIntent) && matchesValue(target.output, expectedTarget) &&
      matchesValue(impact?.inputs?.comparison, observed) && matchesValue(impact.output, report.impact) &&
      matchesValue(critical?.inputs?.paths, paths) && matchesValue(critical.output, report.impact) &&
      (assignment.edit
        ? typeof editApplicationId === "string" && !!editApplicationId &&
          observed.reviewed.sourceHash !== observed.candidate.sourceHash &&
          observed.reviewed.artifactDigest !== observed.candidate.artifactDigest &&
          expectedImpact.entryChanged && expectedImpact.manifestChanged
        : editApplicationId === null && paths.length === 0 &&
          observed.reviewed.sourceHash === observed.candidate.sourceHash &&
          observed.reviewed.artifactDigest === observed.candidate.artifactDigest),
    "Publication revision requires the exact changed public files and review decision"
  );
  return {
    world: { context_id: contextId, source, artifact_digest: observed.candidate.artifactDigest },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function androidInstallEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.androidInstall;
  const {
    caseId,
    contextId,
    request,
    owned,
    inventory,
    install,
    readback,
    before,
    after,
    checks,
  } = fixture ?? {};
  const { assignment } = workflow;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(
    ({ call_id }) => call_id === exercise.rootCallIds[0],
  );
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) =>
        record.parent_call_id === parent.call_id &&
        record.definition.name === name,
    );
  const scenario = child(root, "runMobileScenario");
  const setup = child(scenario, "reviewSetup");
  const discovery = child(setup, "readInventory");
  const select = child(setup, "selectTarget");
  const develop = child(scenario, "exerciseDevelopment");
  const deploy = child(develop, "installApp");
  const app = child(develop, "readInstalledApp");
  const explain = child(scenario, "explainBlocker");
  const shouldInstall = assignment.mode === "install";
  const foreground = assignment.mode !== "foreground-hold";
  const missing = owned === "emulator-5554" ? "emulator-5556" : "emulator-5554";
  const target = assignment.mode === "target-hold" ? missing : owned;
  const blocker = foreground ? "no-device" : "foreground-required";
  const expectedDevice = shouldInstall
    ? { status: "ready", deviceId: owned }
    : { status: "blocked", blocker };
  const effectMatches = (record, service, method, args, result) =>
    record?.effects?.length === 1 &&
    record.effects[0].service === service &&
    record.effects[0].method === method &&
    !record.effects[0].error &&
    matchesValue(record.effects[0].args, args) &&
    matchesValue(record.effects[0].result, result);
  const appAbsent = (snapshot) =>
    snapshot?.installed === false &&
    snapshot.bundleActive === false &&
    snapshot.rendering === false &&
    snapshot.screenshotCaptured === false &&
    snapshot.screenshotBytes === 0;
  const ready = (observed) =>
    observed?.installed === true &&
    observed.bundleActive === true &&
    observed.rendering === true &&
    Number.isSafeInteger(observed.screenshotBytes) &&
    observed.screenshotBytes > 0 &&
    observed.issues?.length === 0;

  requireEvidence(
    fixture?.passed === true &&
      ["inventory", "execution", "device", "report"].every(
        (key) => checks?.[key] === true,
      ) &&
      caseId === assignment.id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      /^emulator-[1-9][0-9]+$/u.test(owned ?? "") &&
      request?.goal === assignment.goal &&
      typeof request.workspace === "string" &&
      !!request.workspace &&
      request.deviceId === target &&
      request.scenario === "development" &&
      request.authority === "execute" &&
      request.reset === false &&
      appAbsent(before) &&
      isDeepStrictEqual(inventory, {
        workspace: request.workspace,
        provider: null,
        foreground,
        tooling: true,
        devices: shouldInstall ? [{ id: owned, state: "ready" }] : [],
      }) &&
      matchesValue(scenario?.inputs?.request, request) &&
      matchesValue(scenario.output, report) &&
      matchesValue(setup?.inputs?.request, request) &&
      matchesValue(setup.output, expectedDevice) &&
      matchesValue(discovery?.output, inventory) &&
      effectMatches(discovery, "mobileInventory", "read", [], inventory) &&
      (foreground
        ? matchesValue(select?.inputs?.devices, inventory.devices) &&
          matchesValue(select.inputs?.requested, target) &&
          matchesValue(select.output, expectedDevice)
        : !select) &&
      records.flatMap(({ effects }) => effects ?? []).length ===
        (shouldInstall ? 3 : 1),
    "Android installation needs the exact workspace, inventory and assigned-device decision",
  );
  const packageName = "app.vibestudio.mobile.internal";
  requireEvidence(
    shouldInstall
      ? isDeepStrictEqual(install, {
          deviceId: owned,
          packageName,
          reset: false,
        }) &&
          readback?.deviceId === owned &&
          readback.packageName === packageName &&
          ready(readback) &&
          ready(after) &&
          after.screenshotCaptured === true &&
          isDeepStrictEqual(report, {
            status: "development-ready",
            deviceId: owned,
            receipt: install,
            readback,
          }) &&
          matchesValue(develop?.inputs?.deviceId, owned) &&
          matchesValue(develop.output, report) &&
          matchesValue(deploy?.inputs?.deviceId, owned) &&
          matchesValue(deploy.output, install) &&
          effectMatches(
            deploy,
            "mobileDevelopment",
            "install",
            [owned],
            install,
          ) &&
          matchesValue(app?.inputs?.deviceId, owned) &&
          matchesValue(app.inputs?.packageName, packageName) &&
          matchesValue(app.output, readback) &&
          effectMatches(
            app,
            "mobileApp",
            "verify",
            [owned, packageName],
            readback,
          ) &&
          !explain
      : install === null &&
          readback === null &&
          isDeepStrictEqual(after, before) &&
          report.status === "blocked" &&
          report.blocker === blocker &&
          report.deviceId === target &&
          typeof report.next === "string" &&
          !!report.next.trim() &&
          !develop &&
          matchesValue(explain?.inputs?.deviceId, target) &&
          matchesValue(explain.inputs?.blocker, blocker) &&
          matchesValue(explain.output, report),
    "Android installation needs one native install and readback, or a verified hold without effects",
  );
  return {
    world: {
      context_id: contextId,
      workspace_id: request.workspace,
      device_id: target,
    },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function androidAuditEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.androidAudit;
  const { caseId, contextId, request, owned, observed, application, checks } =
    fixture ?? {};
  const { assignment } = workflow;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(
    ({ call_id }) => call_id === exercise.rootCallIds[0],
  );
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) =>
        record.parent_call_id === parent.call_id &&
        record.definition.name === name,
    );
  const audit = child(root, "auditAndroidRuntime");
  const targetReview = child(audit, "reviewTarget");
  const runtimeReview = child(audit, "reviewRuntime");
  const imageReview = child(runtimeReview, "assessImage");
  const foreign = assignment.mode === "foreign";
  const inspectApplication = assignment.mode === "application";
  const target = foreign ? "emulator-0" : owned;
  const verdict = foreign ? "target-absent" : "target-ready";
  const effectMatches = (effect, method, result) =>
    effect?.service === "androidRuntimeAudit" &&
    effect.method === method &&
    !effect.error &&
    matchesValue(effect.args, [request.operationId]) &&
    matchesValue(effect.result, result);

  requireEvidence(
    fixture?.passed === true &&
      ["target", "lineage", "application", "report"].every(
        (key) => checks?.[key] === true,
      ) &&
      caseId === assignment.id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      /^emulator-[1-9][0-9]+$/u.test(owned ?? "") &&
      request?.goal === assignment.goal &&
      typeof request.operationId === "string" &&
      !!request.operationId &&
      request.target === target &&
      request.intent ===
        (assignment.mode === "target" ? "device" : "application") &&
      isDeepStrictEqual(observed, {
        target,
        state: foreign ? null : "device",
      }) &&
      isDeepStrictEqual(report?.targetObservation, observed) &&
      report.targetReview === verdict &&
      matchesValue(audit?.inputs?.request, request) &&
      matchesValue(audit.output, report) &&
      matchesValue(targetReview?.inputs?.observation, observed) &&
      matchesValue(targetReview.output, verdict) &&
      audit.effects?.length === 1 &&
      effectMatches(audit.effects[0], "observeTarget", observed) &&
      records.flatMap(({ effects }) => effects ?? []).length ===
        (inspectApplication ? 2 : 1),
    "Android audit needs a native observation and decision for the assigned emulator",
  );

  requireEvidence(
    inspectApplication
      ? application?.target === owned &&
          application.packageName === "app.vibestudio.mobile.internal" &&
          application.installed === false &&
          application.processObserved === false &&
          application.screenshotCaptured === false &&
          application.screenshotBytes === 0 &&
          Array.isArray(application.issues) &&
          application.issues.some(
            (issue) => typeof issue === "string" && !!issue,
          ) &&
          isDeepStrictEqual(report.runtime, {
            observation: application,
            status: "app-absent",
            image: "unavailable",
          }) &&
          matchesValue(
            runtimeReview?.inputs?.operationId,
            request.operationId,
          ) &&
          matchesValue(runtimeReview.output, report.runtime) &&
          runtimeReview.effects?.length === 1 &&
          effectMatches(
            runtimeReview.effects[0],
            "observeApplication",
            application,
          ) &&
          matchesValue(imageReview?.inputs?.observation, application) &&
          matchesValue(imageReview.output, "unavailable")
      : application === null && report.runtime === null && !runtimeReview,
    "Android audit needs the exact package and image evidence or an explicit stop after target review",
  );
  return {
    world: { context_id: contextId, target },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function deliveryHistoryEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.deliveryHistory;
  const { contextId, caseId, request, observed, canonical, retryId, decoyId, checks } =
    fixture ?? {};
  const { assignment } = workflow;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const review = child(root, "reviewDeliveryHistory");
  const origin = child(review, "checkOrigin");
  const match = child(origin, "matchReceipt");
  const comparison = child(review, "compareConsumer");
  const effect = review?.effects?.[0];
  const foreign = assignment.mode === "foreign";
  const originVerdict = foreign ? "foreign-channel" : "matched";
  const consumerVerdict = foreign ? "unreviewed" : "matched";
  const receipt = observed?.receipt;

  requireEvidence(
    fixture?.passed === true &&
      ["scope", "nativeDelivery", "retained", "verdict"].every((key) => checks?.[key] === true) &&
      caseId === assignment.id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      request?.goal === assignment.goal &&
      typeof request.operationId === "string" &&
      !!request.operationId &&
      [
        observed?.channelId,
        receipt?.channelId,
        receipt?.senderId,
        receipt?.messageId,
        canonical?.envelopeId,
      ].every((value) => typeof value === "string" && !!value) &&
      Number.isSafeInteger(canonical.sequence) &&
      canonical.sequence > 0 &&
      canonical.text === assignment.text &&
      canonical.senderId === receipt.senderId &&
      (assignment.mode === "retry" ? retryId === receipt.messageId : retryId === null) &&
      (foreign
        ? observed.channelId !== receipt.channelId &&
          canonical.messageId === decoyId &&
          typeof decoyId === "string" &&
          !!decoyId &&
          decoyId !== receipt.messageId &&
          isDeepStrictEqual(observed.retained, []) &&
          isDeepStrictEqual(observed.rendered, [])
        : observed.channelId === receipt.channelId &&
          canonical.messageId === receipt.messageId &&
          decoyId === null &&
          isDeepStrictEqual(observed.retained, [canonical]) &&
          isDeepStrictEqual(observed.rendered, [
            {
              messageId: canonical.messageId,
              senderId: canonical.senderId,
              text: canonical.text,
            },
          ])) &&
      isDeepStrictEqual(report?.observation, observed) &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      records.flatMap(({ effects }) => effects ?? []).length === 1 &&
      effect?.service === "deliveryHistory" &&
      effect.method === "inspect" &&
      !effect.error &&
      matchesValue(effect.args, [request.operationId]) &&
      matchesValue(effect.result, observed),
    "Delivery history needs the assigned native receipt, durable row, and consumer projection"
  );
  requireEvidence(
    report.origin === originVerdict &&
      report.consumer === consumerVerdict &&
      report.verified === !foreign &&
      matchesValue(origin?.inputs?.observation, observed) &&
      matchesValue(origin.output, originVerdict) &&
      (foreign
        ? !match && !comparison
        : matchesValue(match?.inputs?.receipt, receipt) &&
          matchesValue(match.inputs?.row, canonical) &&
          matchesValue(match.output, originVerdict) &&
          matchesValue(comparison?.inputs?.retained, canonical) &&
          matchesValue(comparison.inputs?.rendered, observed.rendered) &&
          matchesValue(comparison.output, consumerVerdict)),
    "Delivery history needs the exact origin and consumer decisions"
  );
  return {
    world: { context_id: contextId, channel_id: observed.channelId, message_id: receipt.messageId },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function transcriptCursorEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.transcriptCursor;
  const { caseId, contextId, channelId, request, saved, frontier, expectedMessages,
    late, observation, pages, operations, checks } = fixture ?? {};
  const { assignment } = workflow;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const children = (parent, name) => parent ? records.filter(
    (record) => record.parent_call_id === parent.call_id && record.definition.name === name
  ) : [];
  const [resume] = children(root, "resumeChannelTranscript");
  const [admit] = children(resume, "assessReplayStart");
  const [collect] = children(resume, "collectReplayPages");
  const [finish] = children(resume, "finishTranscript");
  const available = assignment.cursor === "start";
  const admitOutcome = available ? "read" : assignment.outcome;
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const effectMatches = (effect, method, args, result) =>
    effect?.service === "transcriptCursor" && effect.method === method && !effect.error &&
    matchesValue(effect.args, args) && matchesValue(effect.result, result);
  requireEvidence(
    fixture?.passed === true &&
      ["scope", "pages", "checkpoint", "isolatedTail"].every((key) => checks?.[key] === true) &&
      caseId === assignment.id && typeof contextId === "string" &&
      contextId === execution.provenance?.contextId && typeof channelId === "string" &&
      channelId === execution.provenance?.channelId &&
      request?.goal === assignment.goal && typeof request.operationId === "string" &&
      Number.isSafeInteger(frontier) && frontier >= 0 &&
      saved?.channelId === (assignment.cursor === "foreign" ? channelId + "-other" : channelId) &&
      saved.seq === (assignment.cursor === "head" ? frontier : 0) &&
      observation?.channelId === channelId && observation.maxPages === assignment.maxPages &&
      isDeepStrictEqual(observation.saved, saved) && isDeepStrictEqual(report?.start, observation) &&
      (assignment.cursor === "foreign"
        ? observation.first === null
        : observation.first?.through === frontier && observation.first.after === saved.seq) &&
      matchesValue(resume?.inputs?.request, request) && matchesValue(resume.output, report) &&
      effectMatches(resume.effects?.[0], "open", [request.operationId], observation) &&
      matchesValue(admit?.inputs?.start, observation) && matchesValue(admit.output, admitOutcome),
    "Transcript continuation requires the assigned channel and original native watermark"
  );
  const pageChecks = children(collect, "checkReplayPage");
  const next = assignment.outcome === "foreign-channel"
    ? null
    : { channelId, seq: pages?.at(-1)?.nextAfter ?? saved.seq };
  requireEvidence(
    Array.isArray(pages) && pages.length <= assignment.maxPages &&
      Array.isArray(expectedMessages) && expectedMessages.length === assignment.messages.length &&
      expectedMessages.every((message, i) => message.preview === assignment.messages[i] &&
        Number.isSafeInteger(message.seq) && message.seq <= frontier &&
        message.seq > (expectedMessages[i - 1]?.seq ?? 0)) &&
      ("late" in assignment
        ? typeof late?.envelopeId === "string" && Number.isSafeInteger(late.seq) && late.seq > frontier
        : late === null) &&
      effects.length === Math.max(1, pages.length) &&
      isDeepStrictEqual(operations, ["open", ...Array(Math.max(0, pages.length - 1)).fill("next")]) &&
      (available
        ? pages.length > 0 && isDeepStrictEqual(observation.first, pages[0]) &&
          matchesValue(collect?.inputs?.start, observation) &&
          matchesValue(collect.output, { pages, usable: true }) && pageChecks.length === pages.length &&
          matchesValue(finish?.output, report)
        : pages.length === 0 && !collect && !finish &&
          (observation.first === null || observation.first.envelopeCount === 0)) &&
      pages.every((page, i) => {
        const after = pages[i - 1]?.nextAfter ?? saved.seq;
        const verification = pageChecks.find((call) => matchesValue(call.inputs?.page, page));
        return page.after === after && page.through === frontier &&
          Number.isSafeInteger(page.nextAfter) && page.nextAfter > after && page.nextAfter <= frontier &&
          page.hasMore === (page.nextAfter < frontier) &&
          Number.isSafeInteger(page.envelopeCount) && page.envelopeCount > 0 && page.envelopeCount <= assignment.pageSize &&
          isDeepStrictEqual(page.messages, expectedMessages.filter(({ seq }) => seq > after && seq <= page.nextAfter)) &&
          (i === 0 || effectMatches(collect.effects?.[i - 1], "next", [request.operationId, after, frontier], page)) &&
          matchesValue(verification?.output, "verified");
      }) &&
      (assignment.outcome !== "complete" || next.seq === frontier) &&
      (assignment.outcome !== "continue" || (pages.length === assignment.maxPages && next.seq < frontier)) &&
      report.outcome === assignment.outcome && isDeepStrictEqual(report.next, next) &&
      isDeepStrictEqual(report.pages, pages) && isDeepStrictEqual(report.messages, pages.flatMap((page) => page.messages)),
    "Transcript continuation requires ordered covered pages and their exact durable checkpoint"
  );
  return {
    world: { context_id: contextId, channel_id: channelId, through_seq: frontier },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function unitIdentityEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.unitIdentity;
  const { contextId, caseId, request, original, selected, prepared, operations, checks } = fixture ?? {};
  const { assignment } = workflow;
  const report = exercise.report;
  const staged = assignment.outcome === "prepared";
  const next = staged ? "prepare" : assignment.outcome;
  const authoringId = `${assignment.intent.family}:${assignment.intent.term}`;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) => parent && records.find(
    (record) => record.parent_call_id === parent.call_id && record.definition.name === name
  );
  const identity = child(root, "prepareUnitIdentity");
  const intent = child(identity, "iconIntent");
  const assess = child(identity, "assessIcon");
  const choose = child(assess, "chooseIconAction");
  const verify = child(identity, "verifyUnitIdentity");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const isEffect = (effect, method, args, value) =>
    effect?.service === "unitIdentity" && effect.method === method && !effect.error &&
    matchesValue(effect.args, args) && matchesValue(effect.result, value);
  requireEvidence(
    fixture?.passed === true &&
      ["source", "candidate", "working", "publication", "operations"].every((key) => checks?.[key] === true) &&
      caseId === assignment.id && typeof contextId === "string" &&
      contextId === execution.provenance?.contextId && request?.goal === assignment.goal &&
      request.prepare === assignment.prepare && isDeepStrictEqual(request.unit, assignment.unit) &&
      typeof request.operationId === "string" && request.operationId.length > 0 &&
      original?.repoPath === assignment.repoPath && typeof original.revision === "string" &&
      selected?.choice?.id === authoringId && selected.choice.family === assignment.intent.family &&
      selected.declaration === "./assets/icon.svg" && /^[0-9a-f]{64}$/u.test(selected.artworkDigest ?? "") &&
      isDeepStrictEqual(report?.observed, original) && isDeepStrictEqual(report.intent, assignment.intent) &&
      isDeepStrictEqual(report.assessment, { candidate: selected, next }) &&
      matchesValue(identity?.inputs?.request, request) && matchesValue(identity.output, report) &&
      matchesValue(intent?.inputs?.unit, request.unit) && matchesValue(intent.output, report.intent) &&
      matchesValue(assess?.inputs?.observed, original) && matchesValue(assess.output, report.assessment) &&
      matchesValue(choose?.inputs?.candidate, selected) && matchesValue(choose.output, next) &&
      effects.length === (staged ? 3 : 2) &&
      isEffect(identity.effects?.[0], "observe", [request.operationId], original) &&
      isEffect(assess.effects?.[0], "resolve", [request.operationId, report.intent], selected),
    "Unit identity requires the exact working revision and grounded catalog choice"
  );
  requireEvidence(
    report.outcome === assignment.outcome && isDeepStrictEqual(report.change, prepared) &&
      isDeepStrictEqual(operations, staged ? ["observe", "resolve", "stage"] : ["observe", "resolve"]) &&
      (staged
        ? prepared?.repoPath === assignment.repoPath && prepared.revision !== original.revision &&
          typeof prepared.revision === "string" && prepared.icon === selected.declaration &&
          prepared.artworkDigest === selected.artworkDigest && prepared.mainUnchanged === true &&
          prepared.manifestOtherwiseUnchanged === true &&
          isDeepStrictEqual(prepared.changedFiles, ["package.json", "assets/icon.svg"]) &&
          isEffect(identity.effects?.[1], "stage", [request.operationId, original.revision, authoringId], prepared) &&
          matchesValue(verify?.inputs?.change, prepared) && matchesValue(verify.output, "prepared")
        : prepared === null && !verify &&
          (next === "already-matches"
            ? original.icon === selected.declaration && original.artworkDigest === selected.artworkDigest
            : original.artworkDigest !== selected.artworkDigest)),
    "Unit identity requires protected main and the verified authorized working-state outcome"
  );
  return {
    world: { context_id: contextId, repository: assignment.repoPath, revision: original.revision },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function gmailComposeHistoryEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.gmailComposeHistory;
  const { seed, request, received, checks } = fixture ?? {};
  const { assignment } = workflow;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) => parent && records.find(
    (record) => record.parent_call_id === parent.call_id && record.definition.name === name
  );
  const history = child(root, "inspectComposeHistory");
  const assessment = child(history, "assessComposeState");
  const cite = child(history, "citeComposeHistory");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const effect = history?.effects?.[0];
  requireEvidence(
    fixture?.passed === true &&
      ["channel", "lineage", "disposition", "evidence"].every((key) => checks?.[key] === true) &&
      seed?.caseId === assignment.id && typeof seed.contextId === "string" &&
      seed.contextId === execution.provenance?.contextId &&
      seed.channelId === execution.provenance?.channelId &&
      typeof seed.messageId === "string" && received?.channelId === seed.channelId &&
      received.messageId === seed.messageId &&
      request?.goal === assignment.goal && typeof request.operationId === "string" &&
      Array.isArray(seed.lineage) && seed.lineage.length === assignment.updates.length + 1 &&
      seed.lineage.every(({ id, seq }, i) => typeof id === "string" && id.length > 0 &&
        Number.isSafeInteger(seq) && seq > (seed.lineage[i - 1]?.seq ?? -1)) &&
      new Set(seed.lineage.map(({ id }) => id)).size === seed.lineage.length &&
      matchesValue(history?.inputs?.request, request) && matchesValue(history.output, report) &&
      effects.length === 1 && effect?.service === "gmailComposeHistory" && effect.method === "read" &&
      !effect.error && matchesValue(effect.args, [request.operationId]) && matchesValue(effect.result, received),
    "Gmail compose history requires the exact assigned channel and persisted readback"
  );
  let state = { ...assignment.initial };
  const events = seed.lineage.map((entry, i) => {
    if (i) state = { ...state, ...assignment.updates[i - 1] };
    return { ...entry, event: i ? "update" : "start", state: {
      status: state.status, recipientPresent: !!state.to, alias: "default",
      draftId: state.draftId ?? null, mimeIdentity: !!state.rfcMessageId, sentIdentity: false,
    }};
  });
  const review = child(assessment, assignment.action === "reconcile-delivery" ? "checkDelivery" : "checkDraft");
  const citations = [events[0].id, events.at(-1).id];
  requireEvidence(
    isDeepStrictEqual(received.events, events) && isDeepStrictEqual(report?.receipt, received) &&
      matchesValue(assessment?.inputs?.events, received.events) &&
      matchesValue(assessment.output, report.decision) &&
      matchesValue(review?.inputs?.state, events.at(-1).state) &&
      matchesValue(review.output, report.decision) &&
      report.decision.action === assignment.action &&
      typeof report.decision.reason === "string" && report.decision.reason.trim() &&
      isDeepStrictEqual(report.evidenceIds, citations) && matchesValue(cite?.output, citations),
    "Gmail compose history requires the exact lineage and appropriate recovery decision"
  );
  return {
    world: { context_id: seed.contextId, channel_id: seed.channelId, message_id: seed.messageId },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function explorerTextEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.explorerTextProbe;
  const { caseId, contextId, request, observed, actual, operations, checks } = fixture ?? {};
  const { assignment } = workflow;
  const report = exercise.report;
  const digest = hash(assignment.text);
  const bytes = Buffer.byteLength(assignment.text);
  const input = {
    bytes, digest, characters: Array.from(assignment.text).length,
    lineEnding: assignment.lineEnding, claim: assignment.claim, repeat: assignment.repeat,
  };
  const plan = {
    expectedBytes: bytes, expectedDigest: digest, check: assignment.check,
    comparison: assignment.repeat ? "repeat-store" : "round-trip",
  };
  const receipt = {
    blob: {
      digest, writtenBytes: bytes, exists: true, statBytes: bytes, readDigest: digest,
      repeatDigest: assignment.repeat ? digest : null,
    },
    file: { digest, bytes, removed: true },
  };
  const assessment = {
    classification: assignment.classification,
    issue: assignment.classification === "ok" ? null : "claim",
  };
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) => parent && records.find(
    (record) => record.parent_call_id === parent.call_id && record.definition.name === name
  );
  const probe = child(root, "probeWorkspaceText");
  const planning = child(probe, "planProbe");
  const classify = child(probe, "classifyProbe");
  const followup = child(probe, "chooseNext");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const read = probe?.effects?.[0];
  const run = probe?.effects?.[1];
  requireEvidence(
    fixture?.passed === true &&
      ["operations", "input", "plan", "native", "classification"].every((key) => checks?.[key] === true) &&
      caseId === assignment.id && typeof contextId === "string" &&
      contextId === execution.provenance?.contextId && request?.goal === assignment.goal &&
      typeof request.operationId === "string" && request.operationId.length > 0 &&
      isDeepStrictEqual(operations, ["input", "run"]) &&
      isDeepStrictEqual(observed, input) && isDeepStrictEqual(actual, receipt) &&
      isDeepStrictEqual(report?.input, observed) && isDeepStrictEqual(report.receipt, actual) &&
      matchesValue(probe?.inputs?.request, request) && matchesValue(probe.output, report) &&
      effects.length === 2 &&
      read?.service === "explorerTextProbe" && read.method === "input" && !read.error &&
      matchesValue(read.args, [request.operationId]) && matchesValue(read.result, observed) &&
      run?.service === "explorerTextProbe" && run.method === "run" && !run.error &&
      matchesValue(run.args, [request.operationId, report.plan]) && matchesValue(run.result, actual),
    "Explorer text verification requires the exact native file and blob receipts"
  );
  const focus = child(planning, "chooseTextCheck");
  const contract = child(classify, "verifyContract");
  const claim = child(classify, "reviewClaim");
  requireEvidence(
    isDeepStrictEqual(report.plan, plan) && isDeepStrictEqual(report.assessment, assessment) &&
      typeof report.next === "string" && report.next.trim() &&
      matchesValue(planning?.inputs?.input, observed) && matchesValue(planning.output, report.plan) &&
      matchesValue(focus?.output, plan.check) &&
      matchesValue(classify?.inputs?.receipt, actual) && matchesValue(classify.output, report.assessment) &&
      matchesValue(contract?.inputs?.receipt, actual) && matchesValue(contract.output, null) &&
      matchesValue(claim?.output, assessment.issue ? "contradicted" : "supported-or-unresolved") &&
      matchesValue(followup?.inputs?.assessment, report.assessment) &&
      matchesValue(followup.output, report.next),
    "Explorer text verification requires the planned check and nested contract and claim decisions"
  );
  return {
    world: { context_id: contextId, content_digest: digest },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function tourRehearsalEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.tourRehearsal;
  const { caseId, panelId, contextId, request, start, visited, restored, checks } = fixture ?? {};
  const { assignment } = workflow;
  const unmatchedTopics = assignment.unmatched ?? [];
  const held = unmatchedTopics.length > 0;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const children = (parent, name) => parent
    ? records.filter((record) =>
        record.parent_call_id === parent.call_id && record.definition.name === name)
    : [];
  const [rehearsal] = children(root, "rehearseTour");
  const [planning] = children(rehearsal, "planRehearsal");
  const [route] = children(rehearsal, "reviewStops");
  const [restoration] = children(rehearsal, "verifyRestoration");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const effectMatches = (effect, method, args, result) =>
    effect?.service === "tourRehearsal" && effect.method === method && !effect.error &&
    matchesValue(effect.args, args) && matchesValue(effect.result, result);
  const id = request?.operationId;
  const observed = (frame, scene, notes, progress) =>
    frame?.storedScene === scene && frame.storedNotes === notes &&
    frame.notesVisible === notes && frame.progress === progress &&
    frame.eyebrow === start.deck.find((item) => item.id === scene)?.eyebrow &&
    typeof frame.heading === "string" && frame.heading.length > 0;

  requireEvidence(
    fixture?.passed === true &&
      ["initial", "plan", "visits", "restoration", "outcome"].every((key) => checks?.[key] === true) &&
      caseId === assignment.id && typeof panelId === "string" && panelId.length > 0 &&
      typeof contextId === "string" && contextId === execution.provenance?.contextId &&
      typeof id === "string" && id.length > 0 &&
      request.goal === assignment.goal && request.restore === assignment.restore &&
      isDeepStrictEqual(request.topics, assignment.topics) &&
      Array.isArray(start?.deck) && isDeepStrictEqual(start.allowed, assignment.allowed) &&
      observed(start.frame, assignment.initial.scene, assignment.initial.notes, assignment.initial.progress) &&
      isDeepStrictEqual(report?.start, start) &&
      matchesValue(rehearsal?.inputs?.request, request) && matchesValue(rehearsal.output, report) &&
      effectMatches(rehearsal.effects?.[0], "observe", [id], start),
    "Tour rehearsal requires the owned panel and its initial rendered frame"
  );
  const stops = assignment.expected.map(({ scene }, i) => ({
    topic: assignment.topics[i],
    scene: start.deck.find((item) => item.id === scene),
    notes: assignment.notes,
  }));
  const resolutions = children(planning, "resolveTourTopic");
  const plan = { stops, unmatchedTopics };
  requireEvidence(
    matchesValue(planning?.inputs?.start, start) &&
      matchesValue(planning.output, plan) && isDeepStrictEqual(report.plan, plan) &&
      resolutions.length === assignment.topics.length && assignment.topics.every((topic) => {
        const resolution = resolutions.find((call) => matchesValue(call.inputs?.topic, topic));
        return matchesValue(resolution?.output, stops.find((stop) => stop.topic === topic)?.scene ?? null);
      }),
    "Tour rehearsal requires ordered topic decisions grounded in the authorized deck"
  );
  const verifications = children(route, "verifyTourStop");
  requireEvidence(
    Array.isArray(visited) && visited.length === (held ? 0 : stops.length) &&
      effects.length === 1 + visited.length + Number(assignment.restore) &&
      report.outcome === (held ? "held" : "rehearsed") &&
      report.visits.length === visited.length && verifications.length === visited.length &&
      (held ? !route : matchesValue(route?.inputs?.plan, plan) && matchesValue(route.output, report.visits)) &&
      visited.every(({ scene, notes, frame }, i) => {
        const stop = stops[i];
        const visit = report.visits[i];
        const verification = verifications.find((call) => matchesValue(call.inputs?.stop, stop));
        return scene === stop.scene.id && notes === stop.notes &&
          observed(frame, scene, notes, assignment.expected[i].progress) &&
          effectMatches(route.effects?.[i], "visit", [id, scene, notes], frame) &&
          isDeepStrictEqual(visit, { stop, readback: { stage: "verified", frame } }) &&
          matchesValue(verification?.inputs?.frame, frame) &&
          matchesValue(verification.output, visit.readback);
      }) &&
      (assignment.restore
        ? isDeepStrictEqual(restored, start.frame) &&
          effectMatches(rehearsal.effects?.[1], "restore", [id], restored) &&
          matchesValue(restoration?.inputs?.frame, restored) &&
          isDeepStrictEqual(report.restoration, { frame: restored, stage: "verified" }) &&
          matchesValue(restoration.output, report.restoration)
        : restored === undefined && report.restoration === null && !restoration),
    "Tour rehearsal needs each exact live stop and any authorized restoration"
  );
  return {
    world: { context_id: contextId, panel_id: panelId },
    checks,
    evidence: { workspace: { panelId, contextId }, cdp: { fixture } },
  };
}

function buildPerformanceEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.buildPerformance;
  const { request, receipt, checks } = fixture ?? {};
  const { goal, initialBudgetBytes } = workflow.assignment;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) => parent && records.find(
    (record) => record.parent_call_id === parent.call_id && record.definition.name === name
  );
  const review = child(root, "reviewBuildPerformance");
  const assess = child(review, "assessBuildRun");
  const payloadReview = child(review, "reviewPayload");
  const followup = child(review, "chooseFollowup");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const effect = review?.effects?.[0];
  const runtime = receipt?.targets?.find(({ target }) => target === "runtime");
  const payload = runtime?.payload;
  const contextId = execution.provenance?.contextId;
  requireEvidence(
    fixture?.passed === true &&
      ["native", "observation", "judgments"].every((key) => checks?.[key] === true) &&
      typeof contextId === "string" && contextId.length > 0 &&
      request?.goal === goal && request.initialBudgetBytes === initialBudgetBytes &&
      typeof request.operationId === "string" && request.operationId.length > 0 &&
      receipt?.status === "ok" &&
      typeof receipt.source === "string" && receipt.source.startsWith("panels/") &&
      typeof receipt.stateHash === "string" && receipt.stateHash.length > 0 &&
      typeof runtime?.buildKey === "string" && runtime.buildKey.length > 0 &&
      receipt.repeat?.sameBuildKeys === true &&
      Number.isFinite(receipt.repeat.elapsedMs) && receipt.repeat.elapsedMs >= 0 &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      effects.length === 1 &&
      effect?.service === "buildPerformance" && effect.method === "observe" && !effect.error &&
      matchesValue(effect.args, [request.operationId]) && matchesValue(effect.result, receipt),
    "Build performance review requires the assigned native profile and verified repeat keys"
  );
  const phaseNames = { bundlingMs: "bundling", validationMs: "validation", otherMs: "other" };
  const timings = Object.entries(receipt.first.phases ?? {}).sort((a, b) => b[1] - a[1]);
  const state = receipt.first.cacheState === "built-during-profile" ? "built" : receipt.first.cacheState;
  const measured = state === "built" && timings[0]?.[1] > 0;
  const phase = measured
    ? timings[0][1] === timings[1]?.[1] ? "tied" : phaseNames[timings[0][0]]
    : "unavailable";
  const phaseCall = child(assess, "identifyPhase");
  const contributor = child(payloadReview, "chooseInitialContributor");
  const largest = payload?.largestInitialInputs.reduce(
    (best, item) => !best || item.bytes > best.bytes ? item : best, null
  );
  const budget = initialBudgetBytes === undefined ? "unassigned"
    : payload?.initialBytes > initialBudgetBytes ? "over" : "within";
  requireEvidence(
    isDeepStrictEqual(report?.observation, receipt) &&
      ["built", "preexisting", "unknown"].includes(state) &&
      isDeepStrictEqual(report.execution, { state, repeat: "verified", phase }) &&
      matchesValue(assess?.inputs?.observation, receipt) &&
      matchesValue(assess.output, report.execution) &&
      (measured
        ? matchesValue(phaseCall?.inputs?.times, receipt.first.phases) && matchesValue(phaseCall.output, phase)
        : !phaseCall) &&
      payload?.initialBytes > 0 && payload.totalBytes >= payload.initialBytes &&
      isDeepStrictEqual(report.payload, { budget, largestInitialInput: largest }) &&
      matchesValue(payloadReview?.inputs?.payload, payload) &&
      matchesValue(payloadReview.output, report.payload) &&
      (largest
        ? matchesValue(contributor?.inputs?.contributors, payload.largestInitialInputs) && matchesValue(contributor.output, largest)
        : !contributor) &&
      report.next?.action === (budget === "over" ? "reduce-initial-payload" : "record-baseline") &&
      typeof report.next.reason === "string" && report.next.reason.trim() &&
      matchesValue(followup?.inputs?.observation, receipt) &&
      matchesValue(followup.output, report.next),
    "Build performance review requires the measured phase and initial payload decisions"
  );
  return {
    world: { context_id: contextId, state_hash: receipt.stateHash, build_key: runtime.buildKey },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function logCursorEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedLogCursor;
  const { caseId, contextId, request, observed, seed, checks } = fixture ?? {};
  const { id, goal, kind, lines } = workflow.assignment;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const review = child(root, "reviewLogCursor");
  const cursor = child(review, "checkCursor");
  const boot = child(cursor, "compareBoot");
  const coverage = child(cursor, "checkCoverage");
  const classifications = records.filter(
    ({ definition }) => definition.name === "classifyHostLogGroup"
  );
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const effect = review?.effects?.[0];
  requireEvidence(
    fixture?.passed === true &&
      caseId === id &&
      contextId === execution.provenance?.contextId &&
      typeof contextId === "string" &&
      request?.goal === goal &&
      typeof request.operationId === "string" &&
      request.operationId.length > 0 &&
      ["cursor", "raw", "outcome", "brief"].every((key) => checks?.[key] === true) &&
      typeof seed?.boot === "string" &&
      typeof seed.marker === "string" &&
      Number.isSafeInteger(seed.start) &&
      Array.isArray(seed.steps) &&
      seed.steps.length === lines.length &&
      seed.steps.every(
        (seq, i) => Number.isSafeInteger(seq) && seq > (seed.steps[i - 1] ?? seed.start)
      ) &&
      observed?.liveBoot === seed.boot &&
      observed.throughSeq === seed.steps.at(-1) &&
      observed.latestSeq >= observed.throughSeq &&
      observed.saved?.seq === seed.start &&
      observed.saved.serverBootId ===
        (kind === "reset-for-new-boot" ? "previous:" + seed.boot : seed.boot) &&
      observed.overflow === (kind === "narrow-window") &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      effects.length === 1 &&
      effect?.service === "serverLogCursor" &&
      effect.method === "observe" &&
      !effect.error &&
      matchesValue(effect.args, [request.operationId]) &&
      matchesValue(effect.result, observed),
    "Log cursor review requires the exact saved cursor and actual live boot observation"
  );

  requireEvidence(
    report?.decision?.status === kind &&
      typeof report.decision.reason === "string" &&
      report.decision.reason.trim() &&
      report.liveBoot === seed.boot &&
      report.latestSeq === observed.latestSeq &&
      matchesValue(cursor?.inputs?.window, observed) &&
      matchesValue(cursor.output, report.decision) &&
      matchesValue(boot?.output, kind === "reset-for-new-boot" ? "changed" : "same") &&
      (kind === "reset-for-new-boot" ? !coverage : matchesValue(coverage?.output, report.decision)),
    "Log cursor review needs the nested boot and coverage decision"
  );
  const snapshot = observed.snapshot;
  const last = seed.steps.at(-1);
  const first = seed.steps[0];
  requireEvidence(
    kind !== "review-window"
      ? snapshot === null &&
          report.next === null &&
          report.brief === null &&
          classifications.length === 0
      : snapshot?.serverBootId === seed.boot &&
          snapshot.latestSeq === last &&
          Array.isArray(snapshot.records) &&
          isDeepStrictEqual(
            snapshot.records.map(({ seq }) => seq),
            seed.steps
          ) &&
          snapshot.records.every(
            ({ tag, message }, i) =>
              tag === "WorkerdManager" &&
              typeof message === "string" &&
              message.includes(seed.marker + " " + lines[i])
          ) &&
          isDeepStrictEqual(report.next, { serverBootId: seed.boot, seq: last }) &&
          report.brief?.serverBootId === seed.boot &&
          report.brief.latestSeq === last &&
          report.brief.status === "incident" &&
          isDeepStrictEqual(report.brief.window, {
            fromSeq: first,
            toSeq: last,
            records: seed.steps.length,
          }) &&
          report.brief.findings?.length === 1 &&
          report.brief.findings[0].class === "failure" &&
          report.brief.findings[0].count === seed.steps.length &&
          report.brief.findings[0].firstSeq === first &&
          report.brief.findings[0].lastSeq === last &&
          report.brief.findings[0].tag === "WorkerdManager" &&
          report.brief.findings[0].message === snapshot.records[0].message.slice(0, 300) &&
          classifications.length === 1 &&
          matchesValue(classifications[0].output, "failure"),
    "Log cursor review must keep held cursors unchanged and cite the exact covered records"
  );
  return {
    world: { context_id: contextId, server_boot_id: seed.boot, through_seq: last },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function evalRecoveryEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedEvalRecovery;
  const { caseId, contextId, request, attempt, readback, checks } = fixture ?? {};
  const { id, goal, stored, fails, allowReadback, next } = workflow.assignment;
  const expectedCell = fails ? "failed" : "returned";
  const finding = stored ? "matched" : "absent";
  const effect = allowReadback ? "confirmed" : "unchecked";
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const review = child(root, "reviewEvalRecovery");
  const inspect = child(review, "inspectJournal");
  const compare = child(inspect, "compareReceipts");
  const confirm = child(review, "verifyEffect");
  const assessment = child(confirm, "assessReadback");
  const decision = child(review, "chooseRecovery");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const observed = review?.effects?.[0];
  const read = confirm?.effects?.[0];
  requireEvidence(
    fixture?.passed === true &&
      caseId === id &&
      contextId === execution.provenance?.contextId &&
      typeof contextId === "string" &&
      request?.goal === goal &&
      typeof request.operationId === "string" &&
      request.operationId.length > 0 &&
      ["original", "storage", "readback", "recovery"].every((key) => checks?.[key] === true) &&
      /^system-test-eval-recovery:[a-f0-9-]{36}$/u.test(attempt?.runId) &&
      attempt.operationId === request.operationId &&
      attempt.cell === expectedCell &&
      attempt.journal === "complete" &&
      attempt.allowReadback === allowReadback &&
      /^[a-f0-9]{64}$/u.test(attempt.expectedDigest) &&
      Number.isSafeInteger(attempt.expectedSize) &&
      attempt.expectedSize > 0 &&
      isDeepStrictEqual(
        attempt.stores,
        stored
          ? [
              {
                digest: attempt.expectedDigest,
                contentDigest: attempt.expectedDigest,
                size: attempt.expectedSize,
              },
            ]
          : []
      ) &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      effects.length === (allowReadback ? 2 : 1) &&
      observed?.service === "evalRecoveryJournal" &&
      observed.method === "observe" &&
      !observed.error &&
      matchesValue(observed.args, [request.operationId]) &&
      matchesValue(observed.result, attempt),
    "Eval recovery requires the original native journal and exact assigned attempt"
  );
  requireEvidence(
    report?.runId === attempt.runId &&
      report.cell === expectedCell &&
      report.journal === finding &&
      report.effect === effect &&
      report.next === next &&
      typeof report.reason === "string" &&
      report.reason.trim() &&
      isDeepStrictEqual(report.readback, readback) &&
      matchesValue(inspect?.inputs?.attempt, attempt) &&
      matchesValue(inspect.output, finding) &&
      matchesValue(compare?.output, finding) &&
      matchesValue(confirm?.inputs?.attempt, attempt) &&
      matchesValue(confirm.inputs.finding, finding) &&
      matchesValue(confirm.output, { readback, effect }) &&
      matchesValue(decision?.inputs?.attempt, attempt) &&
      matchesValue(decision.output, { next, reason: report.reason }) &&
      (allowReadback
        ? isDeepStrictEqual(readback, {
            digest: attempt.expectedDigest,
            observedDigest: attempt.expectedDigest,
            size: attempt.expectedSize,
          }) &&
          read?.service === "evalRecoveryReadback" &&
          read.method === "read" &&
          !read.error &&
          matchesValue(read.args, [request.operationId, attempt.expectedDigest]) &&
          matchesValue(read.result, readback) &&
          matchesValue(assessment?.output, effect)
        : readback === null && !read && !assessment),
    "Eval recovery requires the exact effect readback and nested recovery decision"
  );
  return {
    world: { context_id: contextId, run_id: attempt.runId },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function pdfLayoutEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedPdfLayout;
  const { caseId, contextId, request, observed, checks } = fixture ?? {};
  const { id, goal, kind, rows, order } = workflow.assignment;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const review = child(root, "reviewPdfLayout");
  const layout = child(review, "inspectLayout");
  const geometry = child(layout, "describeGeometry");
  const classification = child(layout, "classifyLayout");
  const reading = child(review, "resolveReadingOrder");
  const arrangement = child(reading, "arrangeFragments");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const inspected = review?.effects?.[0];
  requireEvidence(
    fixture?.passed === true &&
      caseId === id &&
      contextId === execution.provenance?.contextId &&
      typeof contextId === "string" &&
      request?.goal === goal &&
      typeof request.operationId === "string" &&
      request.operationId.length > 0 &&
      ["source", "geometry", "reading"].every((key) => checks?.[key] === true) &&
      observed?.pageNumber === 1 &&
      observed.width === 500 &&
      observed.height === 200 &&
      /^[a-f0-9]{64}$/u.test(observed.digest) &&
      report?.digest === observed.digest &&
      report.pageNumber === 1 &&
      Array.isArray(observed.rows) &&
      observed.rows.every(Array.isArray) &&
      isDeepStrictEqual(
        observed.rows.map((row) => row.map(({ text }) => text)),
        rows
      ) &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      effects.length === 1 &&
      inspected?.service === "pdfLayoutRead" &&
      inspected.method === "inspect" &&
      !inspected.error &&
      matchesValue(inspected.args, [request.operationId]) &&
      matchesValue(inspected.result, observed),
    "PDF layout requires the exact observed page and original fragment receipt"
  );
  const entries = observed.rows.flatMap((row, rowIndex) =>
    row.map((fragment, fragmentIndex) => ({ row: rowIndex, fragment: fragmentIndex, ...fragment }))
  );
  const ordered = order.map((text) => entries.find((entry) => entry.text === text));
  const locations = ordered.map(({ row, fragment }) => ({ row, fragment }));
  requireEvidence(
    entries.every(
      ({ row, fragment, bounds }) =>
        Array.isArray(bounds) &&
        bounds.length === 4 &&
        bounds.every(Number.isFinite) &&
        bounds[0] === 24 + fragment * 226 &&
        bounds[1] < 34 + row * 20 &&
        bounds[1] >= 16 + row * 20 &&
        bounds[2] > 0 &&
        bounds[3] > 0
    ) &&
      report.layout?.kind === kind &&
      typeof report.layout.basis === "string" &&
      report.layout.basis.trim() &&
      report.reading?.status === "ordered" &&
      isDeepStrictEqual(report.reading.entries, ordered) &&
      matchesValue(layout?.inputs?.page, observed) &&
      matchesValue(layout.output, report.layout) &&
      matchesValue(geometry?.inputs?.page, observed) &&
      matchesValue(classification?.output, report.layout) &&
      matchesValue(reading?.inputs?.page, observed) &&
      matchesValue(reading.output, report.reading) &&
      matchesValue(arrangement?.output, locations),
    "PDF layout needs the correct reading order over the original geometry"
  );
  return {
    world: { context_id: contextId, digest: observed.digest, page: observed.pageNumber },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function dictationEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedDictation;
  const { caseId, contextId, request, observed, checks } = fixture ?? {};
  const { id, goal, recording, durationMs, windowed } = workflow.assignment;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const review = child(root, "reviewDictation");
  const capture = child(review, "reviewCapture");
  const condition = child(capture, "reviewRecording");
  const readiness = child(capture, "chooseReadiness");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const inspected = review?.effects?.[0];
  requireEvidence(
    fixture?.passed === true &&
      caseId === id &&
      contextId === execution.provenance?.contextId &&
      typeof contextId === "string" &&
      request?.goal === goal &&
      request.mode === "inspect" &&
      request.presentation === "verbatim" &&
      typeof request.operationId === "string" &&
      request.operationId.length > 0 &&
      ["liveWorker", "recording", "report"].every((key) => checks?.[key] === true) &&
      typeof observed?.ready === "boolean" &&
      observed.recording === recording &&
      observed.durationMs === durationMs &&
      observed.windowed === windowed &&
      isDeepStrictEqual(observed, report?.capture) &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      effects.length === 1 &&
      inspected?.service === "dictationCaptureRead" &&
      inspected.method === "inspect" &&
      !inspected.error &&
      matchesValue(inspected.args, [request.operationId]) &&
      matchesValue(inspected.result, observed),
    "Dictation review requires the live worker status and exact recording measurements"
  );
  const next =
    recording === "absent"
      ? "supply-recording"
      : recording !== "valid"
        ? "repair-recording"
        : observed.ready
          ? "ready"
          : "prepare-local-worker";
  requireEvidence(
    report.review?.next === next &&
      typeof report.review.guidance === "string" &&
      report.review.guidance.trim() &&
      report.draft === null &&
      report.transcript === null &&
      matchesValue(capture?.inputs?.capture, observed) &&
      matchesValue(capture.inputs.mode, "inspect") &&
      matchesValue(capture.output, report.review) &&
      matchesValue(condition?.inputs?.capture, observed) &&
      matchesValue(readiness?.inputs?.capture, observed) &&
      matchesValue(readiness.inputs.mode, "inspect") &&
      matchesValue(readiness.output, next),
    "Dictation review requires the nested capture and readiness decision"
  );
  return {
    world: { context_id: contextId, recording, duration_ms: durationMs },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function nativeSuiteEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedNativeSuite;
  const { caseId, contextId, request, observed, executed, checks } = fixture ?? {};
  const { id, goal, target, suite, file, testName, mode, runtime } = workflow.assignment;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const review = child(root, "reviewTestSuite");
  const plan = child(review, "reviewPlan");
  const route = child(plan, "interpretRuntime");
  const disposition = child(plan, "chooseRunDisposition");
  const result = child(review, "reviewResult");
  const outcome = child(result, "interpretOutcome");
  const followUp = child(result, "planFollowUp");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const resolved = review?.effects?.find(
    ({ service, method }) => service === "testSuitePlanRead" && method === "resolve"
  );
  const ran = review?.effects?.find(
    ({ service, method }) => service === "testSuiteVerificationRun" && method === "run"
  );
  const expectedDisposition = mode === "verify" ? "run-assignment" : "report-plan";
  requireEvidence(
    fixture?.passed === true &&
      caseId === id &&
      contextId === execution.provenance?.contextId &&
      typeof contextId === "string" &&
      request?.goal === goal &&
      request.target === target &&
      request.suite === suite &&
      request.file === file &&
      request.testName === testName &&
      request.mode === mode &&
      typeof request.operationId === "string" &&
      request.operationId.length > 0 &&
      ["plan", "route", "execution"].every((key) => checks?.[key] === true) &&
      observed?.target === target &&
      observed.suite === suite &&
      observed.runtime === runtime &&
      observed.contextId === contextId &&
      typeof observed.stateHash === "string" &&
      observed.stateHash.length > 0 &&
      isDeepStrictEqual(observed, report?.plan) &&
      isDeepStrictEqual(executed, report.execution) &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      effects.length === (mode === "verify" ? 2 : 1) &&
      resolved &&
      !resolved.error &&
      matchesValue(resolved.args, [request.operationId]) &&
      matchesValue(resolved.result, observed),
    "Suite review requires the live declared runtime and the exact caller assignment"
  );
  requireEvidence(
    report.decision?.route?.runtime === runtime &&
      report.decision.route.nativeApproval === (runtime === "native") &&
      typeof report.decision.route.explanation === "string" &&
      report.decision.route.explanation.trim() &&
      report.decision.next === expectedDisposition &&
      matchesValue(plan?.inputs?.plan, observed) &&
      matchesValue(plan.output, report.decision) &&
      matchesValue(route?.output, report.decision.route) &&
      matchesValue(disposition?.output, expectedDisposition),
    "Suite review requires the nested route and exact execution disposition"
  );
  requireEvidence(
    mode === "inspect"
      ? !ran && !result && executed === null && report.result === null
      : ran &&
          !ran.error &&
          matchesValue(ran.args, [request.operationId, observed.stateHash]) &&
          matchesValue(ran.result, executed) &&
          executed?.current === true &&
          executed.status === "passed" &&
          Number.isSafeInteger(executed.passed) &&
          executed.passed > 0 &&
          executed.failed === 0 &&
          typeof executed.artifactKey === "string" &&
          executed.artifactKey.length > 0 &&
          (runtime === "native") === executed.artifactKey.startsWith("native:") &&
          /^[a-f0-9]{64}$/u.test(executed.executionDigest) &&
          /^[a-f0-9]{64}$/u.test(executed.reportDigest) &&
          report.result?.outcome === "verified" &&
          typeof report.result.followUp === "string" &&
          report.result.followUp.trim() &&
          matchesValue(result?.inputs?.execution, executed) &&
          matchesValue(result.output, report.result) &&
          matchesValue(outcome?.output, report.result.outcome) &&
          matchesValue(followUp?.output, report.result.followUp),
    "Suite verification requires the exact execution receipt and a grounded outcome"
  );
  return {
    world: { context_id: contextId, target, suite, runtime, mode },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function gitBridgeReviewEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedGitBridgeReview;
  const { caseId, contextId, request, observed, checks } = fixture ?? {};
  const { id, goal, repository, direction, draft, source, next } = workflow.assignment;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const review = child(root, "reviewGitBridge");
  const upstream = child(review, "reviewUpstream");
  const semantic = child(review, "reviewSemantic");
  const freshness = child(upstream, "checkFreshness");
  const consequences = child(upstream, "interpretTransfer");
  const basis = child(semantic, "reviewPublicationBasis");
  const integration = child(semantic, "reviewCandidate");
  const decision = child(review, "chooseBridgeStep");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const effect = review?.effects?.[0];
  requireEvidence(
    fixture?.passed === true &&
      caseId === id &&
      contextId === execution.provenance?.contextId &&
      typeof contextId === "string" &&
      request?.goal === goal &&
      request.repository === repository &&
      request.direction === direction &&
      typeof request.operationId === "string" &&
      request.operationId.length > 0 &&
      ["contextPreserved", "semantic", "upstream", "report"].every(
        (key) => checks?.[key] === true
      ) &&
      isDeepStrictEqual(observed, report?.view) &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      effects.length === 1 &&
      effect?.service === "gitBridgeReviewRead" &&
      effect.method === "observe" &&
      !effect.error &&
      matchesValue(effect.args, [request.operationId]) &&
      matchesValue(effect.result, observed),
    "Git Bridge review requires the exact actual upstream and semantic observation"
  );

  const state = observed.semantic;
  requireEvidence(
    observed.repository === repository &&
      state?.current === true &&
      state.contextId === contextId &&
      state.clean === !draft &&
      state.relation === "at" &&
      typeof state.mainEventId === "string" &&
      (draft
        ? state.working?.kind === "application"
        : state.working?.kind === "event" && state.working.eventId === state.mainEventId) &&
      (source === "protected"
        ? typeof state.mainRepositoryId === "string" &&
          state.mainRepositoryId === state.workingRepositoryId
        : state.mainRepositoryId === null && state.workingRepositoryId === null) &&
      isDeepStrictEqual(observed.upstream, {
        state: "local-only",
        remote: null,
        branch: null,
        autoPush: false,
        candidate: null,
        observation: null,
      }),
    "Git Bridge review requires the assigned repository's protected basis and live local-only status"
  );
  requireEvidence(
    report.next === next &&
      typeof report.reason === "string" &&
      report.reason.trim() &&
      report.upstreamReview?.freshness === "absent" &&
      typeof report.upstreamReview?.consequence === "string" &&
      report.upstreamReview.consequence.trim() &&
      report.semanticReview?.source?.state === source &&
      report.semanticReview?.integration?.candidate === null &&
      matchesValue(upstream?.inputs?.direction, direction) &&
      matchesValue(upstream?.inputs?.upstream, observed.upstream) &&
      matchesValue(upstream.output, report.upstreamReview) &&
      matchesValue(freshness?.output, "absent") &&
      matchesValue(consequences?.output, report.upstreamReview.consequence) &&
      matchesValue(semantic?.inputs?.semantic, state) &&
      matchesValue(semantic.output, report.semanticReview) &&
      matchesValue(basis?.output, report.semanticReview.source) &&
      matchesValue(integration?.output, report.semanticReview.integration) &&
      matchesValue(decision?.inputs?.view, observed) &&
      matchesValue(decision.output, { next, reason: report.reason }),
    "Git Bridge review requires the nested upstream, semantic basis, and next-step decisions"
  );
  return {
    world: { context_id: contextId, repository, direction },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function vcsDeliveryEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedVcsDelivery;
  const { caseId, contextId, request, snapshot, checks } = fixture ?? {};
  const { id, goal, path, repository, seedPath, text, commit, next, terms } = workflow.assignment;
  const changed = seedPath === path;
  const report = exercise.report;
  const file = snapshot?.file;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const delivery = child(root, "reviewVcsDelivery");
  const chain = child(delivery, "inspectChain");
  const change = child(delivery, "reviewChange");
  const local = child(chain, "describeLocalChain");
  const integration = child(chain, "reviewIntegration");
  const interpretation = child(change, "interpretFile");
  const focused = child(change, "planChecks");
  const decision = child(delivery, "chooseDeliveryStep");
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const effect = delivery?.effects?.[0];
  requireEvidence(
    fixture?.passed === true &&
      caseId === id &&
      contextId === execution.provenance?.contextId &&
      typeof contextId === "string" &&
      snapshot?.current === true &&
      snapshot.contextId === contextId &&
      ["contextPreserved", "exactState", "assignedFile", "report"].every(
        (key) => checks?.[key] === true
      ) &&
      request?.goal === goal &&
      request.repository === repository &&
      request.path === path &&
      typeof request.operationId === "string" &&
      request.operationId.length > 0 &&
      isDeepStrictEqual(report?.snapshot, snapshot) &&
      matchesValue(delivery?.inputs?.request, request) &&
      matchesValue(delivery.output, report) &&
      effects.length === 1 &&
      effect?.service === "vcsDeliveryRead" &&
      effect.method === "observe" &&
      !effect.error &&
      matchesValue(effect.args, [request.operationId]) &&
      matchesValue(effect.result, snapshot),
    "VCS delivery needs the actual semantic snapshot and only the assigned VCS observation"
  );

  requireEvidence(
    snapshot.clean === commit &&
      snapshot.relation === (commit ? "ahead" : "at") &&
      snapshot.working?.kind === (commit ? "event" : "application") &&
      snapshot.protectedMain?.kind === "event" &&
      snapshot.committed?.kind === "event" &&
      (commit
        ? isDeepStrictEqual(snapshot.working, snapshot.committed) &&
          snapshot.committed.eventId !== snapshot.protectedMain.eventId
        : isDeepStrictEqual(snapshot.committed, snapshot.protectedMain)) &&
      isDeepStrictEqual(snapshot.integrations, []) &&
      file?.path === path &&
      file.hasLocalDifference === (changed && !commit) &&
      file.hasDeliveryDifference === changed &&
      (changed
        ? file.working?.excerpt === text &&
          file.protectedMain === null &&
          (commit ? isDeepStrictEqual(file.working, file.committed) : file.committed === null)
        : file.working &&
          isDeepStrictEqual(file.working, file.committed) &&
          isDeepStrictEqual(file.working, file.protectedMain)),
    "VCS delivery must retain the real working, committed and protected-main versions"
  );

  requireEvidence(
    report.next === next &&
      report.chain?.main?.state === "current" &&
      report.chain?.local?.state === (commit ? "clean" : "uncommitted") &&
      typeof report.review?.effect === "string" &&
      report.review.effect.trim() &&
      Array.isArray(report.review.checks) &&
      report.review.checks.every((check) => typeof check === "string") &&
      (changed
        ? terms.every((term) => report.review.effect.toLowerCase().includes(term)) &&
          terms.some((term) => report.review.checks.join(" ").toLowerCase().includes(term))
        : report.review.checks.length === 0) &&
      matchesValue(chain?.inputs?.snapshot, snapshot) &&
      matchesValue(chain.output, report.chain) &&
      matchesValue(local?.output, report.chain.local) &&
      matchesValue(integration?.output, report.chain.main) &&
      matchesValue(change?.inputs?.file, file) &&
      matchesValue(change.output, report.review) &&
      matchesValue(interpretation?.inputs?.file, file) &&
      matchesValue(focused?.inputs?.path, path) &&
      matchesValue(focused.output, report.review.checks) &&
      matchesValue(decision?.inputs?.snapshot, snapshot) &&
      matchesValue(decision.output, report.next),
    "VCS delivery needs the nested inspection, focused verification and exact next step"
  );
  return {
    world: { context_id: contextId, path, repository },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function webBriefEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedWebBrief;
  const { caseId, contextId, request, reads, tails, cache, checks } = fixture ?? {};
  const { id, goal, sources, facts } = workflow.assignment;
  const report = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const assigned = records.find(
    (record) =>
      record.parent_call_id === root?.call_id && record.definition.name === "writeAssignedBrief"
  );
  const research = records.find(
    (record) =>
      record.parent_call_id === assigned?.call_id && record.definition.name === "researchBrief"
  );
  const effects = records.flatMap(({ effects }) => effects ?? []);
  const collapse = (text) => text.replace(/\s+/gu, " ").trim();
  requireEvidence(
    caseId === id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      fixture.passed === true &&
      ["assigned", "continuations", "cache", "outcome", "citations"].every(
        (key) => checks?.[key] === true
      ) &&
      request?.goal === goal &&
      isDeepStrictEqual(request.sources, sources) &&
      Number.isSafeInteger(request.retrievedAt) &&
      Number.isFinite(new Date(request.retrievedAt).getTime()) &&
      isDeepStrictEqual(
        reads?.map(({ requested }) => requested),
        sources
      ) &&
      Array.isArray(tails) &&
      cache?.length === sources.length &&
      effects.length === sources.length + tails.length &&
      effects.every((effect) => effect.service === "web" && !effect.error) &&
      report?.question === goal &&
      report.status === (facts.length ? "answered" : "insufficient") &&
      Array.isArray(report.statements) &&
      (facts.length ? report.statements.length > 0 : report.statements.length === 0) &&
      Array.isArray(report.notRead) &&
      report.notRead.length === 0 &&
      matchesValue(assigned?.inputs?.request, request) &&
      matchesValue(assigned.output, report) &&
      matchesValue(research?.inputs?.question, goal) &&
      matchesValue(research.inputs.sources, sources) &&
      matchesValue(research.inputs.retrievedAt, request.retrievedAt) &&
      matchesValue(research.output, report) &&
      records.some((record) => record.definition.name === "findEvidence") &&
      (!facts.length || records.some((record) => record.definition.name === "writeBrief")),
    "Web brief must use the shared research tree and its exact assigned public URLs"
  );

  for (const [index, { requested, page }] of reads.entries()) {
    const cached = cache[index];
    const continuations = tails.filter(({ digest }) => digest === page.digest);
    const expectsContinuation = page.truncated && page.head.length < 9000;
    const [tail] = continuations;
    requireEvidence(
      page.session === "public" &&
        /^[a-f0-9]{64}$/u.test(page.digest) &&
        continuations.length === (expectsContinuation ? 1 : 0) &&
        cached?.verified === true &&
        cached.requested === requested &&
        cached.digest === page.digest &&
        cached.size === page.size &&
        cached.visible === (page.head + (tail?.text ?? "")).slice(0, 9000) &&
        effects.some(
          (effect) =>
            effect.method === "fetch" &&
            matchesValue(effect.args, [{ url: requested, session: "public" }]) &&
            matchesValue(effect.result, page)
        ) &&
        (!tail ||
          (tail.offset === page.headBytes &&
            tail.limit === 9000 - page.head.length &&
            tail.nextOffset === tail.offset + tail.bytes &&
            effects.some(
              (effect) =>
                effect.method === "read" &&
                matchesValue(effect.args, [
                  { digest: tail.digest, offset: tail.offset, limit: tail.limit },
                ]) &&
                matchesValue(effect.result, tail)
            ))),
      "Web brief needs the actual fetched page and its host-verified cached bytes"
    );
  }

  const retrieved = new Date(request.retrievedAt).toISOString().slice(0, 10);
  requireEvidence(
    report.statements.every(
      (statement) =>
        typeof statement.text === "string" &&
        statement.text.trim() &&
        Array.isArray(statement.cites) &&
        statement.cites.length > 0 &&
        statement.cites.every(
          (cite) =>
            cite.retrieved === retrieved &&
            typeof cite.quote === "string" &&
            collapse(cite.quote).length >= 20 &&
            reads.some(
              ({ page }, index) =>
                page.url === cite.url &&
                page.title === cite.title &&
                collapse(cache[index].visible).includes(collapse(cite.quote))
            )
        )
    ) &&
      facts.every(({ source, pattern }) => {
        const finalUrl = reads.find(({ requested }) => requested === source)?.page.url;
        return report.statements.some(({ cites }) =>
          cites.some(
            (cite) => cite.url === finalUrl && collapse(cite.quote).toLowerCase().includes(pattern)
          )
        );
      }),
    "Web brief citations must quote the assigned fetched evidence for each claim"
  );
  return {
    world: { context_id: contextId, sources, digests: reads.map(({ page }) => page.digest) },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function architectureBoundaryEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedArchitectureBoundary;
  const { caseId, contextId, request, route, declaration, ownedTarget, checks } = fixture ?? {};
  const {
    id,
    goal,
    protocol,
    name,
    source,
    className,
    creatorScoped,
    concern,
    proposedOwner,
    expectedOwner,
  } = workflow.assignment;
  const report = exercise.report;
  const aligned = proposedOwner === expectedOwner;
  const decision = aligned ? "retain-boundary" : "move-state-to-owner";
  const records = exercise.calls.map(({ record }) => record);
  const child = (parent, name) =>
    parent &&
    records.find(
      (record) => record.parent_call_id === parent.call_id && record.definition.name === name
    );
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const review = child(root, "reviewArchitectureBoundary");
  const provider = child(review, "inspectProvider");
  const resolution = child(provider, "resolveProvider");
  const declarationRead = child(provider, "readDeclaration");
  const comparison = child(provider, "matchDeclaration");
  const ownership = child(review, "reviewOwnership");
  const owner = child(ownership, "chooseOwner");
  const next = child(review, "chooseDisposition");
  const exactEffect = (call, method, args, result) => {
    const [effect] = call?.effects ?? [];
    return (
      call?.effects?.length === 1 &&
      effect?.service === "architectureProviderRead" &&
      effect.method === method &&
      !effect.error &&
      matchesValue(effect.args, args) &&
      matchesValue(effect.result, result)
    );
  };

  requireEvidence(
    fixture?.passed === true &&
      caseId === id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      ["route", "declaration", "unchanged", "report"].every((key) => checks?.[key] === true) &&
      request?.goal === goal &&
      request.concern === concern &&
      request.proposedOwner === proposedOwner &&
      typeof request.operationId === "string" &&
      route?.receipt === request.operationId + ":provider" &&
      route.contextId === contextId &&
      route.protocol === protocol &&
      route.name === name &&
      route.source === source &&
      route.receiver?.kind === "durable-object" &&
      route.receiver.className === className &&
      route.receiver.creatorScoped === creatorScoped &&
      typeof route.receiver.address === "string" &&
      route.receiver.address.length > 0 &&
      (creatorScoped ? route.receiver.address === ownedTarget : ownedTarget === null) &&
      typeof route.revision === "string" &&
      declaration?.revision === route.revision &&
      declaration.routeReceipt === route.receipt &&
      declaration.name === name &&
      declaration.source === source &&
      declaration.className === className &&
      declaration.creatorScoped === creatorScoped &&
      declaration.protocols?.includes(protocol) &&
      typeof declaration.hash === "string" &&
      declaration.hash.length > 0 &&
      isDeepStrictEqual(report?.provider, { route, declaration, consistent: true }) &&
      isDeepStrictEqual(report.ownership, { owner: expectedOwner, proposedOwner, aligned }) &&
      report.decision === decision &&
      records.flatMap(({ effects }) => effects ?? []).length === 2 &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      matchesValue(provider?.inputs?.operationId, request.operationId) &&
      matchesValue(provider.output, report.provider) &&
      matchesValue(resolution?.inputs?.operationId, request.operationId) &&
      matchesValue(resolution.output, route) &&
      exactEffect(resolution, "resolve", [request.operationId], route) &&
      matchesValue(declarationRead?.inputs?.routeReceipt, route.receipt) &&
      matchesValue(declarationRead.output, declaration) &&
      exactEffect(declarationRead, "declaration", [route.receipt], declaration) &&
      matchesValue(comparison?.inputs?.route, route) &&
      matchesValue(comparison.inputs.declaration, declaration) &&
      matchesValue(comparison.output, true) &&
      matchesValue(ownership?.inputs?.provider, report.provider) &&
      matchesValue(ownership.inputs.concern, concern) &&
      matchesValue(ownership.inputs.proposedOwner, proposedOwner) &&
      matchesValue(ownership.output, report.ownership) &&
      matchesValue(owner?.inputs?.concern, concern) &&
      matchesValue(owner.inputs.provider, report.provider) &&
      matchesValue(owner.output, expectedOwner) &&
      matchesValue(next?.inputs?.provider, report.provider) &&
      matchesValue(next.inputs.ownership, report.ownership) &&
      matchesValue(next.output, decision),
    "Architecture review needs the actual assigned provider, source declaration and correct durable owner"
  );
  return {
    world: { context_id: contextId, protocol, source, owner: expectedOwner },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function releaseReviewHandoffEvidence(execution, exercise, scenario, workflow) {
  const fixture = execution.diagnostics.managedReleaseReviewHandoff;
  const { caseId, contextId, checks, request, release, scope, handoff, sources, sourceDigests } =
    fixture ?? {};
  const results = exercise.report?.results;
  requireEvidence(
    fixture?.passed === true &&
      caseId === workflow.assignment.id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      ["release", "scope", "handoff", "transfer", "order"].every((key) => checks?.[key] === true) &&
      request?.goal?.startsWith(workflow.assignment.goal + " ") &&
      request.work?.length === workflow.work.length &&
      results?.length === workflow.work.length &&
      exercise.report.remaining?.length === 0 &&
      request.work.every((item, index) =>
        ["kind", "domain", "operation"].every(
          (key) => item[key] === workflow.work[index][key] && results[index]?.[key] === item[key]
        )
      ) &&
      isDeepStrictEqual(request.work[0]?.input, release?.request) &&
      isDeepStrictEqual(request.work[1]?.input, scope?.request),
    "Missing the ordered release, authority and scratch assignments in the same owned context"
  );

  const [extensionReport, scopeReport, scratchReport] = results.map(({ report }) => report);
  const allCalls = exercise.calls;
  const rootId = exercise.rootCallIds[0];
  const direct = (name) =>
    allCalls.find(
      (call) => call.record.parent_call_id === rootId && call.record.definition.name === name
    );
  const ownerRoot = allCalls.find((call) => call.callId === rootId);
  requireEvidence(
    matchesValue(ownerRoot?.record?.inputs?.request, request),
    "The actual composed workflow request differs from its assigned inputs"
  );
  const subtree = (skill, report) => {
    const ids = new Set([direct(skill).callId]);
    const frontier = [...ids];
    for (const parent of frontier) {
      for (const call of allCalls) {
        if (call.record.parent_call_id === parent && !ids.has(call.callId)) {
          ids.add(call.callId);
          frontier.push(call.callId);
        }
      }
    }
    return {
      ...exercise,
      report,
      calls: allCalls.filter((call) => call.callId === rootId || ids.has(call.callId)),
    };
  };
  extensionReleaseEvidence(
    { ...execution, diagnostics: { managedExtensionRelease: release } },
    subtree("reviewExtensionRelease", extensionReport),
    scenario,
    { assignment: workflow.extension }
  );
  authorityReviewEvidence(
    { ...execution, diagnostics: { managedAuthorityReview: scope } },
    subtree("reviewAuthority", scopeReport),
    scenario,
    { assignment: workflow.authority }
  );
  scratchHandoffEvidence(
    {
      ...execution,
      diagnostics: {
        scratchHandoffWorld: { contextId, caseId },
        scratchHandoffVerification: handoff,
      },
    },
    { ...exercise, report: scratchReport },
    scenario,
    { caseId, expectedStatus: "staged" }
  );

  const { workingTree, publishedTree } = release.source;
  const expectedSources = {
    extension:
      `Source disposition: ${extensionReport.source.disposition}; working tree ${workingTree}; published tree ${publishedTree}.\n` +
      `Runtime disposition: ${extensionReport.runtime.disposition}; active version ${release.runtime.activeEv ?? "none"}.\n`,
    authority: `Authority disposition: ${scopeReport.status}.\nHeld operations: ${scopeReport.held.join(", ") || "none"}.\n`,
  };
  const scratchTrace = subtree("assembleHandoff", scratchReport);
  const scratchEffects = scratchTrace.calls
    .filter(({ callId }) => callId !== rootId)
    .flatMap(({ record }) => record.effects ?? []);
  const write = scratchEffects.find(({ service }) => service === "scratchHandoffWrite");
  const scratchInput = request.work[2].input;
  requireEvidence(
    isDeepStrictEqual(sources, expectedSources) &&
      isDeepStrictEqual(
        sourceDigests,
        Object.entries(expectedSources).map(([id, text]) => ({ id, sha256: hash(text) }))
      ) &&
      matchesValue(direct("assembleHandoff").record.inputs?.request, scratchInput) &&
      matchesValue(direct("assembleHandoff").record.output, scratchReport) &&
      scratchEffects.length === 3 &&
      Object.entries(expectedSources).every(([id, text]) => {
        const read = scratchEffects.find(
          (effect) => effect.service === "scratchHandoffRead" && matchesValue(effect.args, [id])
        );
        return (
          read?.method === "read" &&
          !read.error &&
          matchesValue(read.result, { id, lines: text.trimEnd().split("\n") })
        );
      }) &&
      write?.service === "scratchHandoffWrite" &&
      write.method === "stage" &&
      !write.error &&
      matchesValue(write.result, scratchReport.artifact),
    "The staged handoff must cite the actual release and authority readbacks"
  );
  return {
    world: { context_id: contextId, case_id: caseId },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function extensionReleaseEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedExtensionRelease;
  const { caseId, contextId, request, source, runtime, checks } = fixture ?? {};
  const { id, goal, method, name, source: path, activation, mode } = workflow.assignment;
  const report = exercise.report;
  const calls = exercise.calls.map(({ record }) => record);
  const child = (parent, name) =>
    parent &&
    calls.find((call) => call.parent_call_id === parent.call_id && call.definition.name === name);
  const root = calls.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const review = child(root, "reviewExtensionRelease");
  const sourceReview = child(review, "reviewSource");
  const runtimeReview = child(review, "reviewRuntime");
  const next = child(review, "chooseNext");

  const verifiedRead = (stage, reader, scenarioName, methodName, observation, childReport) => {
    const read = child(stage, reader);
    const assessed = child(stage, scenarioName);
    const [effect] = read?.effects ?? [];
    return (
      matchesValue(stage?.inputs?.operationId, request.operationId) &&
      matchesValue(stage.inputs.method, method) &&
      matchesValue(stage.output, childReport) &&
      matchesValue(read?.inputs?.operationId, request.operationId) &&
      matchesValue(read.output, observation) &&
      read.effects?.length === 1 &&
      effect?.service === "extensionReleaseRead" &&
      effect.method === methodName &&
      !effect.error &&
      matchesValue(effect.args, [request.operationId]) &&
      matchesValue(effect.result, observation) &&
      matchesValue(assessed?.inputs?.observation, observation) &&
      matchesValue(assessed.inputs.method, method) &&
      matchesValue(assessed.output, childReport.disposition)
    );
  };

  const staged = mode !== "published";
  const sourceDisposition = staged ? "unpublished-candidate" : "published-method";
  const runtimeDisposition =
    runtime?.pendingApproval || runtime?.status === "pending-approval"
      ? "waiting-approval"
      : runtime?.status === "building"
        ? "building"
        : runtime?.status === "error" || runtime?.hasError
          ? "failed"
          : runtime?.status !== "running" || !runtime.identity || !runtime.activeEv
            ? "cold"
            : runtime.methods.includes(method)
              ? "live-method"
              : "method-not-observed";
  const decision = staged
    ? "verify-and-publish-candidate"
    : {
        "waiting-approval": "wait-for-approval",
        building: "wait-for-build",
        failed: "inspect-failure",
        cold: "await-activation",
        "live-method": "observed-live",
        "method-not-observed": "inspect-active-contract",
      }[runtimeDisposition];

  requireEvidence(
    caseId === id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      request?.goal === goal &&
      request.method === method &&
      typeof request.operationId === "string" &&
      fixture.passed === true &&
      ["source", "runtime", "unchanged", "report"].every((key) => checks?.[key] === true) &&
      source?.operationId === request.operationId &&
      source.contextId === contextId &&
      source.name === name &&
      source.source === path &&
      runtime?.operationId === request.operationId &&
      runtime.name === name &&
      runtime.source === path &&
      typeof source.working?.hash === "string" &&
      typeof source.published?.hash === "string" &&
      source.working.activation === activation &&
      source.working.methods.includes(method) &&
      /^[a-f0-9]{64}$/u.test(source.workingTree ?? "") &&
      /^[a-f0-9]{64}$/u.test(source.publishedTree ?? "") &&
      (staged
        ? source.workingRevision !== source.mainRevision &&
          source.workingTree !== source.publishedTree
        : source.workingTree === source.publishedTree) &&
      (mode === "manifest-change"
        ? source.working.hash !== source.published.hash &&
          !source.published.methods.includes(method) &&
          !runtime.methods.includes(method)
        : source.working.hash === source.published.hash &&
          source.published.methods.includes(method)) &&
      isDeepStrictEqual(report?.source?.observation, source) &&
      isDeepStrictEqual(report?.runtime?.observation, runtime) &&
      report.source.disposition === sourceDisposition &&
      report.runtime.disposition === runtimeDisposition &&
      report.decision === decision &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      calls.flatMap(({ effects }) => effects ?? []).length === 2 &&
      verifiedRead(sourceReview, "readSource", "assessSource", "source", source, report.source) &&
      verifiedRead(
        runtimeReview,
        "readRuntime",
        "assessRuntime",
        "runtime",
        runtime,
        report.runtime
      ) &&
      matchesValue(next?.inputs?.source, report.source) &&
      matchesValue(next.inputs.runtime, report.runtime) &&
      matchesValue(next.output, decision),
    "Extension review must preserve the exact working and published manifest and the approved runtime readback"
  );
  return {
    world: { context_id: contextId, extension: name, method, mode },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function authorityReviewEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedAuthorityReview;
  const { caseId, contextId, request, observations, checks } = fixture ?? {};
  const { id, goal, operations, ceiling, outside } = workflow.assignment;
  const expectedRequest = {
    goal,
    operations: operations.map(({ id, label }) => ({ id, label })),
    ceiling,
  };
  const protectedLeaves = [
    ...new Set(operations.flatMap(({ protectedResources }) => protectedResources)),
  ].map((resourceKey) => ({ capability: "external.open", resourceKey }));
  const report = exercise.report;
  const calls = exercise.calls.map(({ record }) => record);
  const children = (parent, name) =>
    parent
      ? calls.filter(
          (record) => record.parent_call_id === parent.call_id && record.definition.name === name
        )
      : [];
  const root = calls.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const [review] = children(root, "reviewAuthority");
  const operationCalls = children(review, "reviewOperation");
  const [combination] = children(review, "combineCeiling");
  const [collection] = children(combination, "collectProtected");
  requireEvidence(
    caseId === id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      fixture.passed === true &&
      ["assigned", "reviews", "ceiling", "decision"].every((key) => checks?.[key] === true) &&
      isDeepStrictEqual(request, expectedRequest) &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report) &&
      Array.isArray(observations) &&
      observations.length === operations.length &&
      Array.isArray(report?.reviews) &&
      report.reviews.length === operations.length &&
      operationCalls.length === operations.length &&
      calls.flatMap(({ effects }) => effects ?? []).length === operations.length &&
      isDeepStrictEqual(report.protectedLeaves, protectedLeaves) &&
      matchesValue(combination?.inputs?.reviews, report.reviews) &&
      matchesValue(collection?.inputs?.reviews, report.reviews) &&
      matchesValue(collection.output, report.protectedLeaves),
    "Authority review must use the assigned preflight calls and consolidate only exact protected resources"
  );

  const expectedHeld = [];
  let awaitingAcquisition = false;
  for (const [index, operation] of operations.entries()) {
    const observation = observations[index];
    const item = report.reviews[index];
    const expectedOutside = outside.includes(operation.id)
      ? operation.protectedResources.map((resourceKey) => ({
          capability: "external.open",
          resourceKey,
        }))
      : [];
    const disposition = expectedOutside.length
      ? "outside-ceiling"
      : observation.decision === "denied"
        ? "host-denied"
        : observation.decision === "acquirable"
          ? "needs-acquisition"
          : "eligible";
    if (disposition === "outside-ceiling" || disposition === "host-denied")
      expectedHeld.push(operation.id);
    if (disposition === "needs-acquisition") awaitingAcquisition = true;
    const stage = operationCalls.find((candidate) =>
      matchesValue(candidate.inputs?.operationId, operation.id)
    );
    const [preflight] = children(stage, "preflight");
    const [findOutside] = children(stage, "findOutside");
    const [decide] = children(stage, "decideDisposition");
    const [effect] = preflight?.effects ?? [];
    requireEvidence(
      observation.operationId === operation.id &&
        ["allowed", "acquirable", "denied"].includes(observation.decision) &&
        isDeepStrictEqual(
          observation.leaves
            .filter(({ tier }) => tier !== "open")
            .map(({ capability, resourceKey, tier }) => ({ capability, resourceKey, tier })),
          operation.protectedResources.map((resourceKey) => ({
            capability: "external.open",
            resourceKey,
            tier: "gated",
          }))
        ) &&
        isDeepStrictEqual(item?.observation, observation) &&
        isDeepStrictEqual(item.outside, expectedOutside) &&
        item.disposition === disposition &&
        matchesValue(stage?.inputs?.ceiling, ceiling) &&
        matchesValue(stage.output, item) &&
        matchesValue(preflight?.inputs?.operationId, operation.id) &&
        matchesValue(preflight.output, observation) &&
        preflight.effects?.length === 1 &&
        effect?.service === "assignedAuthorityRead" &&
        effect.method === "preflight" &&
        !effect.error &&
        matchesValue(effect.args, [operation.id]) &&
        matchesValue(effect.result, observation) &&
        matchesValue(findOutside?.inputs?.leaves, observation.leaves) &&
        matchesValue(findOutside.inputs.ceiling, ceiling) &&
        matchesValue(findOutside.output, item.outside) &&
        matchesValue(decide?.inputs?.decision, observation.decision) &&
        matchesValue(decide.inputs.outside, item.outside) &&
        matchesValue(decide.output, disposition),
      "Authority review must join each disposition to its exact live preflight and caller scope"
    );
  }
  const status = expectedHeld.length
    ? "held"
    : awaitingAcquisition
      ? "needs-acquisition"
      : "eligible";
  requireEvidence(
    isDeepStrictEqual(report.held, expectedHeld) && report.status === status,
    "Authority review summary must preserve every held and pending operation"
  );
  return {
    world: { context_id: contextId, operations: operations.map(({ id }) => id) },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function problemDraftEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedProblemDraft;
  const { caseId, contextId, request, source, created, saved, checks } = fixture ?? {};
  const { id, goal, account, mode, defect } = workflow.assignment;
  const result = exercise.report;
  const records = exercise.calls.map(({ record }) => record);
  const child = (parent, name) =>
    parent &&
    records.find((call) => call.parent_call_id === parent.call_id && call.definition.name === name);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const save = child(root, "saveProblemDraft");
  const read = child(save, "readDraft");
  const review = child(save, "reviewProblem");
  const classification = child(review, "classifyDefect");
  const selection = child(review, "chooseDraftAction");
  const open = child(save, "openDraft");
  const compose = child(save, "composeNarrative");
  const append = child(save, "appendDraft");
  const confirm = child(save, "confirmDraft");
  const effect = (call, service, method) => {
    const [entry] = call?.effects ?? [];
    return (
      call?.effects?.length === 1 &&
      entry?.service === service &&
      entry.method === method &&
      !entry.error &&
      entry
    );
  };
  const observed = effect(read, "problemDraftRead", "observe");
  const decision =
    mode === "stale" ? "refresh-own-edit" : mode === "new" ? "prepare-local-draft" : "keep-local";
  const authored = (a, b) => Boolean(a?.complete && isDeepStrictEqual(a, b));
  requireEvidence(
    caseId === id &&
      typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      request?.goal === goal &&
      typeof request.operationId === "string" &&
      fixture.passed === true &&
      ["source", "result", "opening", "retention", "persisted", "localOnly"].every(
        (key) => checks?.[key] === true
      ) &&
      isDeepStrictEqual(source?.review?.account, account) &&
      source.review.consent === "save" &&
      result?.defect === defect &&
      matchesValue(save?.inputs?.request, request) &&
      matchesValue(save.output, result) &&
      matchesValue(observed?.args, [request.operationId]) &&
      matchesValue(observed.result, source) &&
      matchesValue(read.output, source) &&
      matchesValue(review?.inputs?.request, source.review) &&
      matchesValue(classification?.inputs?.evidence, account) &&
      matchesValue(classification.output, defect) &&
      child(review, "qualifyEvidence") &&
      matchesValue(selection?.inputs?.request, source.review) &&
      matchesValue(selection.inputs.defect, defect) &&
      matchesValue(selection.output, decision),
    "Problem draft must use the exact observed account and shared defect review"
  );

  if (mode === "stale") {
    requireEvidence(
      result.status === "held" &&
        result.next === "refresh-own-edit" &&
        saved === null &&
        created === null &&
        result.saved === null &&
        source.draft?.revision > source.review.draft?.basisRevision &&
        records.flatMap(({ effects }) => effects ?? []).length === 1 &&
        !open &&
        !compose &&
        !append &&
        !confirm,
      "A stale problem draft must remain unchanged and unsubmitted"
    );
  } else {
    const opened = effect(open, "problemDraftOpen", "create");
    const appended = effect(append, "problemDraftAppend", "append");
    const confirmed = effect(confirm, "problemDraftRead", "confirm");
    const { id: draftId, revision, sectionIds, sections } = saved ?? {};
    const write = { id: draftId, revision, sectionIds };
    requireEvidence(
      result.status === "saved-local" &&
        result.next === "keep-local" &&
        isDeepStrictEqual(result.saved, saved) &&
        typeof draftId === "string" &&
        Number.isSafeInteger(revision) &&
        Array.isArray(sectionIds) &&
        Array.isArray(sections) &&
        sectionIds.length === sections.length &&
        matchesValue(compose?.inputs?.account, account) &&
        matchesValue(compose.inputs.existingSections, source.draft?.existingSections ?? []) &&
        matchesValue(compose.output, sections) &&
        matchesValue(child(compose, "writeVerification")?.output, sections.at(-1)) &&
        authored(append?.inputs?.sections, compose.output) &&
        matchesValue(appended?.result, write) &&
        matchesValue(append.output, write) &&
        matchesValue(confirm?.inputs?.write, write) &&
        matchesValue(confirmed?.args, [write]) &&
        matchesValue(confirmed.result, saved) &&
        matchesValue(confirm.output, saved) &&
        sections.at(-1)?.claims === "unverified" &&
        sections.at(-1)?.section === "verification" &&
        sections.at(-1)?.markdown.includes(account.expected) &&
        records.flatMap(({ effects }) => effects ?? []).length === (mode === "new" ? 4 : 3) &&
        (mode === "new"
          ? source.draft === null &&
            matchesValue(child(compose, "writeSymptom")?.output, sections[0]) &&
            sections.length === 2 &&
            sections[0]?.section === "symptom" &&
            sections[0].claims === (account.reproduced ? "observed" : "unverified") &&
            [account.goal, account.observed, account.expected].every((text) =>
              sections[0].markdown.includes(text)
            ) &&
            matchesValue(opened?.args, [request.operationId]) &&
            created?.id === draftId &&
            created.revision < revision &&
            matchesValue(opened.result, created) &&
            matchesValue(open.output, created) &&
            matchesValue(append.inputs.draft, created) &&
            matchesValue(appended.args, [created, sections])
          : created === null &&
            source.draft?.id === draftId &&
            source.draft.revision < revision &&
            sections.length === 1 &&
            !open &&
            matchesValue(append.inputs.draft, source.draft) &&
            matchesValue(appended.args, [source.draft, sections])),
      "Saved problem draft must bind the composed narrative to an owned append and exact local readback"
    );
  }
  return {
    world: { context_id: contextId, draft_id: saved?.id ?? source.draft?.id, mode },
    checks,
    evidence: { workspace: { fixture } },
  };
}

function agenticChangeEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedAgenticChange;
  const { caseId, request, source, checks } = fixture ?? {};
  const { id, goal, owner, consumers, rebuild, persistedContract, surface } = workflow.assignment;
  const contextId = execution.provenance?.contextId;
  const plan = exercise.report;
  const units = [owner, ...consumers];
  const sameUnits = (actual, expected) =>
    Array.isArray(actual) && isDeepStrictEqual([...actual].sort(), [...expected].sort());
  const records = exercise.calls.map(({ record }) => record);
  const child = (parent, name) =>
    parent &&
    records.find((call) => call.parent_call_id === parent.call_id && call.definition.name === name);
  const root = records.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const planning = child(root, "planAgenticChange");
  const read = child(planning, "readSource");
  const impact = child(planning, "reviewImpact");
  const ownership = child(impact, "findOwners");
  const history = child(impact, "reviewHistory");
  const verification = child(planning, "planVerification");
  const builds = child(verification, "planBuilds");
  const canary = child(verification, "planCanary");
  const [effect] = read?.effects ?? [];
  requireEvidence(
    typeof contextId === "string" &&
      caseId === id &&
      request?.goal === goal &&
      request.contextId === contextId &&
      source?.contextId === contextId &&
      typeof source.revision === "string" &&
      source.revision.length > 0 &&
      Array.isArray(source.guides) &&
      units.every((unit) =>
        source.guides.some(
          (guide) =>
            guide.unit === unit && typeof guide.excerpt === "string" && guide.excerpt.length > 0
        )
      ) &&
      fixture.passed === true &&
      ["source", "unchanged", "ownership", "verification"].every((key) => checks?.[key] === true) &&
      matchesValue(planning?.inputs?.request, request) &&
      matchesValue(planning.output, plan) &&
      matchesValue(read?.inputs?.contextId, contextId) &&
      matchesValue(read.output, source) &&
      read.effects?.length === 1 &&
      effect.service === "agenticChangeSource" &&
      effect.method === "read" &&
      !effect.error &&
      matchesValue(effect.args, [contextId]) &&
      matchesValue(effect.result, source) &&
      matchesValue(impact?.inputs?.goal, goal) &&
      matchesValue(impact.inputs.sources, source) &&
      matchesValue(impact.output, plan?.impact) &&
      matchesValue(ownership?.inputs?.goal, goal) &&
      matchesValue(ownership.inputs.sources, source) &&
      matchesValue(history?.inputs?.goal, goal) &&
      isDeepStrictEqual(history.inputs.units, ownership.output) &&
      matchesValue(verification?.inputs?.goal, goal) &&
      matchesValue(verification.inputs.impact, plan?.impact) &&
      matchesValue(builds?.inputs?.impact, plan?.impact) &&
      matchesValue(builds.output, plan?.builds) &&
      matchesValue(canary?.inputs?.goal, goal) &&
      matchesValue(canary.inputs.builds, plan?.builds) &&
      matchesValue(canary.output, plan?.canary) &&
      plan?.contextId === contextId &&
      plan.revision === source.revision &&
      plan.impact?.owner === owner &&
      sameUnits(plan.impact.consumers, consumers) &&
      plan.impact.blockers?.length === 0 &&
      plan.impact.persistedContract === persistedContract &&
      (persistedContract
        ? plan.impact.retainedHistoryChecks?.length >= 2
        : plan.impact.retainedHistoryChecks?.length === 0) &&
      sameUnits(plan.builds?.focusedTests, units) &&
      sameUnits(plan.builds?.rebuild, rebuild) &&
      plan.canary?.surface === surface &&
      typeof plan.canary.probe === "string" &&
      plan.canary.probe.trim().length > 0 &&
      plan.canary.observations?.length > 0 &&
      plan.canary.cleanup?.length > 0,
    "Agentic change planning must use the exact workspace revision and verify the assigned ownership, history and canary plan"
  );
  return {
    world: { context_id: contextId, revision: source.revision, owner },
    checks: { ...checks, exactPlanningTree: true },
    evidence: { workspace: { fixture } },
  };
}

function gadReviewEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedGadReview;
  const { contextId, channelId, request, seeded, observations } = fixture ?? {};
  const { health, followUp, tail } = observations ?? {};
  const report = exercise.report;
  const { id, goal, view, messages } = workflow.assignment;
  requireEvidence(
    typeof contextId === "string" &&
      contextId === execution.provenance?.contextId &&
      typeof channelId === "string" &&
      channelId === execution.provenance?.channelId &&
      fixture.caseId === id &&
      fixture.passed === true &&
      fixture.checks?.observations === true &&
      fixture.checks?.report === true &&
      request?.goal === goal &&
      request.view === view &&
      /^[a-f0-9-]{36}$/u.test(request.operationId) &&
      Array.isArray(seeded) &&
      isDeepStrictEqual(
        seeded.map(({ text }) => text),
        messages
      ),
    "GAD review must use the assigned owned channel and its exact world"
  );

  const calls = exercise.calls.map(({ record }) => record);
  const child = (parent, name) =>
    parent &&
    calls.find(
      (record) =>
        record.parent_call_id === parent.call_id &&
        record.definition.name === name &&
        record.outcome === "done"
    );
  const root = calls.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const review = child(root, "reviewChannel");
  const checkEffect = (call, service, method, args, result) => {
    const [effect] = call?.effects ?? [];
    return (
      call?.effects?.length === 1 &&
      effect?.service === service &&
      effect.method === method &&
      !effect.error &&
      matchesValue(effect.args, args) &&
      matchesValue(effect.result, result)
    );
  };
  const readbacks = [];
  requireEvidence(
    report !== null &&
      typeof report === "object" &&
      matchesValue(review?.inputs?.request, request) &&
      matchesValue(review.output, report),
    "GAD review must preserve the exact attached request and report"
  );
  if (view === "triage") {
    const reviewedHealth = child(review, "reviewHealth");
    const read = child(reviewedHealth, "readHealth");
    const classified = child(reviewedHealth, "classifyFinding");
    const chosen = child(review, "chooseFollowUp");
    const inspected = child(review, "inspectFinding");
    const kind = "empty-roster";
    const judgments = [{ kind, urgency: "investigate" }];
    requireEvidence(
      calls.length === 7 &&
        health?.channelId === channelId &&
        typeof health.branchId === "string" &&
        health.receipt === request.operationId + ":health" &&
        health.integrity === "ok" &&
        health.activity === "idle" &&
        health.findings?.length === 1 &&
        health.findings[0]?.kind === kind &&
        health.findings[0].count === 1 &&
        health.findings[0].inspector === "inspectChannelRoster" &&
        followUp?.kind === kind &&
        followUp?.receipt === request.operationId + ":follow-up" &&
        followUp.inspector === "inspectChannelRoster" &&
        followUp.counters?.some(
          ({ name, count }) => name === "activeParticipants" && count === 0
        ) &&
        tail === null &&
        report.conversation === null &&
        report.health?.status === "investigate" &&
        isDeepStrictEqual(report.health.evidence, health) &&
        isDeepStrictEqual(report.health.judgments, judgments) &&
        isDeepStrictEqual(report.followUp, followUp) &&
        checkEffect(read, "gadHealth", "observe", [request.operationId], health) &&
        matchesValue(read.output, health) &&
        matchesValue(reviewedHealth.output, report.health) &&
        matchesValue(classified?.inputs?.finding, health.findings[0]) &&
        matchesValue(classified.output, judgments[0]) &&
        matchesValue(chosen?.inputs?.health, report.health) &&
        matchesValue(chosen.output, kind) &&
        checkEffect(inspected, "gadFollowUp", "inspect", [health.receipt, kind], followUp) &&
        matchesValue(inspected.output, followUp),
      "GAD roster triage must join the observed finding to the exact bounded follow-up"
    );
    readbacks.push(read, inspected);
  } else {
    const recap = child(review, "reviewConversation");
    const read = child(recap, "readConversation");
    const interpreted = child(recap, "interpretLatest");
    const latest = seeded.at(-1);
    requireEvidence(
      calls.length === 5 &&
        health === null &&
        followUp === null &&
        seeded.every(
          ({ messageId, seq }, i) =>
            typeof messageId === "string" &&
            messageId.length > 0 &&
            Number.isSafeInteger(seq) &&
            seq > (seeded[i - 1]?.seq ?? 0)
        ) &&
        new Set(seeded.map(({ messageId }) => messageId)).size === seeded.length &&
        latest !== undefined &&
        tail?.channelId === channelId &&
        tail.receipt === request.operationId + ":tail" &&
        tail.status === "observed" &&
        tail.standing === "awaiting-agent" &&
        Number.isSafeInteger(tail.range?.toSeq) &&
        tail.range.fromSeq <= latest.seq &&
        tail.range.toSeq >= latest.seq &&
        tail.latest?.seq === latest.seq &&
        tail.latest.speaker === "user" &&
        tail.latest.text === latest.text &&
        report.health === null &&
        report.followUp === null &&
        report.conversation?.meaning === "other" &&
        typeof report.conversation.note === "string" &&
        report.conversation.note.trim().length > 0 &&
        isDeepStrictEqual(report.conversation.evidence, tail) &&
        checkEffect(read, "gadConversation", "read", [request.operationId], tail) &&
        matchesValue(read.output, tail) &&
        matchesValue(interpreted?.inputs?.evidence, tail) &&
        matchesValue(interpreted.output, report.conversation) &&
        matchesValue(recap.output, report.conversation),
      "GAD recap must interpret the exact latest published user question"
    );
    readbacks.push(read);
  }
  requireEvidence(
    calls.every((record) => record.effects?.length === (readbacks.includes(record) ? 1 : 0)),
    "GAD review contains activity outside the assigned read-only tool calls"
  );
  return {
    world: { context_id: contextId, channel_id: channelId, view },
    checks: { ...fixture.checks, exactReadbacks: true },
    evidence: { workspace: { fixture } },
  };
}

function phoneSetupEvidence(execution, exercise, scenario, workflow) {
  const fixture = execution.diagnostics.managedPhoneSetup;
  const observed = fixture?.observed;
  const request = fixture?.request;
  const report = exercise.report;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      fixture.caseId === scenario &&
      fixture.passed === true &&
      ["assignedStart", "noEligibleDesktop", "reportMatches"].every(
        (name) => fixture.checks?.[name] === true
      ) &&
      request?.goal === workflow.goal &&
      /^[a-f0-9-]{36}$/u.test(request.operationId) &&
      observed?.receipt === request.operationId + ":assignment" &&
      observed.platform === workflow.platform &&
      observed.providerId === null &&
      observed.deviceId === null &&
      observed.pairedDeviceId === null &&
      Array.isArray(observed.desktops) &&
      observed.desktops.length === 0 &&
      report?.status === "desktop-unavailable" &&
      report.pairedDeviceId === null &&
      isDeepStrictEqual(report.evidenceIds, [observed.receipt]) &&
      typeof report.guidance === "string" &&
      report.guidance.trim().length > 0,
    "Phone setup must cite the empty live provider readback for the assigned account"
  );

  const calls = exercise.calls.map(({ record }) => record);
  const child = (parent, name) =>
    parent &&
    calls.find(
      (record) =>
        record.parent_call_id === parent.call_id &&
        record.definition.name === name &&
        record.outcome === "done"
    );
  const root = calls.find(({ call_id }) => call_id === exercise.rootCallIds[0]);
  const setup = child(root, "setUpPhone");
  const assignment = child(setup, "readAssignment");
  const discovery = child(setup, "discoverPhone");
  const chosen = child(discovery, "chooseDesktop");
  const [observe] = assignment?.effects ?? [];
  requireEvidence(
    calls.length === 5 &&
      [setup, assignment, discovery, chosen].every(Boolean) &&
      calls.every((record) => record.effects?.length === (record === assignment ? 1 : 0)) &&
      observe?.service === "phoneSetupRead" &&
      observe.method === "start" &&
      !observe.error &&
      matchesValue(observe.args, [request.operationId]) &&
      matchesValue(observe.result, observed) &&
      matchesValue(setup.inputs?.request, request) &&
      matchesValue(setup.output, report) &&
      matchesValue(assignment.inputs?.operationId, request.operationId) &&
      matchesValue(assignment.output, observed) &&
      matchesValue(discovery.inputs?.assignment, observed) &&
      matchesValue(chosen.inputs?.assignment, observed) &&
      matchesValue(chosen.output, null),
    "Phone setup must follow the recorded read-only desktop decision without preparing or pairing a device"
  );
  return {
    world: { context_id: fixture.contextId, assigned_platform: workflow.platform },
    checks: { ...fixture.checks, readOnlyDiscovery: true },
    evidence: { workspace: { fixture } },
  };
}

function localComparisonEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedLocalComparison;
  const verification = fixture?.verification;
  const report = exercise.report;
  const { modelRef, alternatives, requiresPriorConversation } = workflow.request;
  const refs = [modelRef, ...alternatives];
  const candidates = report?.candidates;
  const rows = verification?.rows;
  const selected = Array.isArray(candidates) && candidates.find((candidate) => candidate?.handoff);
  const mode = requiresPriorConversation ? "fork" : "fresh";
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.checks?.stableInventory === true &&
      verification.checks?.exactReads === true &&
      verification.checks?.handoff === true &&
      verification.checks?.candidates === true &&
      JSON.stringify(verification.inspected) === JSON.stringify(refs) &&
      Array.isArray(rows) &&
      rows.length === refs.length &&
      Array.isArray(candidates) &&
      candidates.length === refs.length &&
      report.receipt === null &&
      refs.every((ref, index) => {
        const row = rows[index];
        const candidate = candidates[index];
        const expected = verification.expected?.candidates?.[index];
        return (
          row?.ref === ref &&
          candidate?.ref === ref &&
          candidate.state === (row.row?.state ?? null) &&
          candidate.disposition === expected?.disposition &&
          (candidate.disposition === "ready-to-delegate"
            ? candidate.handoff?.ref === ref && candidate.handoff.mode === mode
            : candidate.handoff === null)
        );
      }) &&
      (selected
        ? report.disposition === "ready-to-delegate" &&
          report.ref === selected.ref &&
          report.state === selected.state &&
          report.handoff?.ref === selected.ref &&
          report.handoff.mode === mode
        : report.disposition === "no-candidate" &&
          report.ref === modelRef &&
          report.state === null &&
          report.handoff === null),
    "Local model comparison must use the exact assigned reads and handoff"
  );
  return {
    world: { context_id: fixture.contextId, assigned_models: refs },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function googleSetupChoiceMatches(receipt, previous, check) {
  const { before, after } = receipt.controls ?? {};
  if (
    !before ||
    !after ||
    before.scope !== (previous?.scope ?? "gmail") ||
    before.opening !== (previous?.opening ?? "external") ||
    [before, after].some(
      (state) =>
        state.guidance !== state.scope ||
        state.connectEnabled !== false ||
        state.gmailEnabled !== false
    )
  )
    return false;
  switch (check.kind) {
    case "scope-choice":
      return after.scope === check.scope && after.opening === before.opening;
    case "browser-choice":
      return after.scope === before.scope && after.opening === check.opening;
    case "choice-reload":
      return after.scope === "gmail" && after.opening === "external";
    default:
      return false;
  }
}

function googleSetupEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedGoogleSetup;
  const verification = fixture?.verification;
  const report = exercise.report;
  const receipts = verification?.receipts;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      typeof verification.panelId === "string" &&
      verification.panelId.length > 0 &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.checks?.driveNeedsSetup === true &&
      verification.checks?.browserAgrees === true &&
      verification.checks?.reportMatches === true &&
      verification.readiness?.state === "needs-setup" &&
      report?.status === "action-needed" &&
      report.action === "open-setup" &&
      report.ids?.length === 0 &&
      report.checkpoint === null &&
      Array.isArray(report.panelFindings) &&
      Array.isArray(receipts) &&
      report.panelFindings.length === workflow.checks.length &&
      receipts.length === workflow.checks.length &&
      workflow.checks.every((check, index) => {
        const row = receipts[index];
        const finding = report.panelFindings[index];
        const id = `${fixture.contextId}:google-setup:${index + 1}`;
        if (
          row?.id !== id ||
          row.stage !== verification.readiness.state ||
          row.gmailEnabled !== false ||
          JSON.stringify(row.check) !== JSON.stringify(check) ||
          finding?.evidenceId !== id ||
          finding.code !== workflow.codes[index] ||
          JSON.stringify(finding.check) !== JSON.stringify(check)
        )
          return false;
        if (check.kind === "owners")
          return row.accountOwner === true && row.permissionsOwner === true;
        if (check.kind === "viewport")
          return row.viewportWidth === check.width && row.overflow === false;
        if (check.kind === "launch-gate")
          return row.inheritedLaunch === (check.afterReload ? false : null);
        const previous = receipts
          .slice(0, index)
          .findLast(
            (observed) =>
              observed.controls ||
              (observed.check.kind === "launch-gate" && observed.check.afterReload)
          );
        return googleSetupChoiceMatches(row, previous?.controls?.after, check);
      }),
    "Google setup findings must match the assigned panel and account observations"
  );
  const choiceCount = workflow.checks.filter(({ kind }) =>
    ["scope-choice", "browser-choice", "choice-reload"].includes(kind)
  ).length;
  if (choiceCount > 0) {
    const children = (parent, name) =>
      parent
        ? exercise.calls.filter(
            ({ record }) =>
              record.parent_call_id === parent.callId &&
              record.outcome === "done" &&
              record.definition?.name === name
          )
        : [];
    const root = exercise.calls.find(({ callId }) => callId === exercise.rootCallIds[0]);
    const skill =
      root?.record.definition?.name === workflow.root ? root : children(root, workflow.root)[0];
    const journey = children(skill, "reviewSetupJourney")[0];
    const panel = children(journey, "reviewSetupPanel")[0];
    const choices = children(panel, "inspectSetupChoices");
    requireEvidence(
      children(panel, "observeSetupPanel").length === 1 &&
        choices.length === choiceCount &&
        choices.every((choice) => children(choice, "compareSetupChoices").length === 1),
      "Google setup choice journeys must capture the observation and each nested comparison"
    );
  }
  return {
    world: { context_id: fixture.contextId, panel_id: verification.panelId },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function newsCadenceMatches(read, intent) {
  switch (intent.kind) {
    case "poll":
      return read.poll?.intervalMs === intent.intervalMs;
    case "interval":
      return read.briefing?.kind === "interval" && read.briefing.intervalMs === intent.intervalMs;
    case "daily":
      return (
        read.briefing?.kind === "daily" &&
        read.briefing.at === intent.at &&
        read.briefing.timezone === intent.timezone
      );
    case "pause":
    case "resume":
      return read.owner?.paused === (intent.kind === "pause");
    default:
      return false;
  }
}

function newsEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedNews;
  const verification = fixture?.verification;
  const report = exercise.report;
  const assignment = verification?.assignment;
  const observed = verification?.observed;
  const status = ["blocked", "attention", "waiting", "ready"].find((value) =>
    workflow.expected.some((finding) => finding.status === value)
  );
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      assignment?.contextId === fixture.contextId &&
      typeof assignment.channelId === "string" &&
      assignment.channelId === assignment.agentKey &&
      typeof assignment.participantId === "string" &&
      assignment.participantId.length > 0 &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.checks?.matchesReport === true &&
      verification.checks?.matchesState === true &&
      report?.status === status &&
      Array.isArray(report.findings) &&
      Array.isArray(observed) &&
      observed.length === workflow.checks.length &&
      report.findings.length === observed.length &&
      report.findings.every((finding, index) => {
        const work = workflow.checks[index];
        const read = observed[index];
        if (!read || read.kind !== work.kind || finding?.code !== workflow.expected[index]?.code)
          return false;
        let id;
        if (read.kind === "reader") {
          if (
            read.view !== work.view ||
            read.overview?.articleCount !== 0 ||
            read.pages?.length !== 1 ||
            read.pages[0].articleIds?.length !== 0
          )
            return false;
          id = finding.code === "empty-loaded-view" ? read.pages[0].id : read.overview.id;
        } else {
          if (JSON.stringify(read.intent) !== JSON.stringify(work.intent)) return false;
          id = ["poll-confirmed", "poll-mismatch"].includes(finding.code)
            ? read.poll?.id
            : ["briefing-confirmed", "briefing-mismatch"].includes(finding.code)
              ? read.briefing?.id
              : read.owner?.id;
        }
        return (
          typeof id === "string" &&
          id.length > 0 &&
          JSON.stringify(finding.evidenceIds) === JSON.stringify([id])
        );
      }),
    "News findings must match the assigned channel observations and Missions owners"
  );
  if (workflow.repair) {
    const { index, write } = workflow.repair;
    const { before, receipt } = verification.repair ?? {};
    const after = observed[index];
    const intent = workflow.checks[index].intent;
    const child = (parent, name) =>
      parent &&
      exercise.calls.find(
        ({ record }) =>
          record.parent_call_id === parent.callId &&
          record.outcome === "done" &&
          record.definition?.name === name
      );
    const root = exercise.calls.find(({ callId }) => callId === exercise.rootCallIds[0]);
    const skill =
      root?.record.definition?.name === workflow.root ? root : child(root, workflow.root);
    const live = child(skill, "reviewLiveNews");
    const reconcile = child(live, "reconcileCadence");
    requireEvidence(
      child(live, "readNewsState") &&
        child(reconcile, "reviewSchedule") &&
        child(reconcile, "chooseCadenceChange") &&
        child(live, "reviewSchedule"),
      "News cadence reconciliation must capture the observation, decision and final review calls"
    );
    requireEvidence(
      verification.checks?.matchesRepair === true &&
        before?.kind === "schedule" &&
        JSON.stringify(before.intent) === JSON.stringify(intent) &&
        typeof before.owner?.id === "string" &&
        typeof after.owner?.id === "string" &&
        before.owner.id !== after.owner.id &&
        before.poll?.id === after.poll?.id &&
        before.briefing?.id === after.briefing?.id &&
        (!write || (!newsCadenceMatches(before, intent) && newsCadenceMatches(after, intent))) &&
        (write
          ? typeof receipt?.id === "string" &&
            receipt.id.length > 0 &&
            JSON.stringify(receipt.change) === JSON.stringify(intent)
          : receipt?.id === null && receipt.change === null) &&
        (receipt.change?.kind === "poll" || before.poll?.intervalMs === after.poll?.intervalMs) &&
        (["daily", "interval"].includes(receipt.change?.kind) ||
          JSON.stringify(before.briefing) === JSON.stringify(after.briefing)) &&
        (["pause", "resume"].includes(receipt.change?.kind) ||
          before.owner.paused === after.owner.paused),
      "News cadence repair must preserve owner identities and include the assigned write readback"
    );
  }
  return {
    world: {
      context_id: fixture.contextId,
      channel_id: assignment.channelId,
      participant_id: assignment.participantId,
    },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function spectroliteEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedSpectrolite;
  const verification = fixture?.verification;
  const report = exercise.report;
  const { vault, document, preview, navigation, committedDocument } = verification?.observed ?? {};
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      vault?.id === `${fixture.contextId}:vault` &&
      vault.clean === !workflow.draft &&
      (!workflow.draft ||
        (vault.working?.kind === "application" &&
          vault.committed?.kind === "event" &&
          committedDocument?.id === `${fixture.contextId}:committed-document` &&
          committedDocument.path === document?.path &&
          committedDocument.repositoryId === vault.repositoryId &&
          typeof committedDocument.fileId === "string" &&
          committedDocument.fileId === document?.fileId &&
          typeof committedDocument.contentHash === "string" &&
          committedDocument.title === workflow.draft.committedTitle &&
          isDeepStrictEqual(committedDocument.ref, vault.committed) &&
          verification.checks?.committedBaseline === true)) &&
      typeof vault.repositoryId === "string" &&
      vault.repositoryId === document?.repositoryId &&
      document.id === `${fixture.contextId}:document` &&
      document.path === workflow.documentPath &&
      verification.browser?.path === document.path &&
      typeof verification.browser.text === "string" &&
      verification.browser.text.includes(workflow.heading) &&
      (!workflow.draft?.staleText ||
        !verification.browser.text.includes(workflow.draft.staleText)) &&
      (!workflow.draft?.visibleText ||
        verification.browser.text.includes(workflow.draft.visibleText)) &&
      (workflow.previewText === null ||
        verification.browser.rendered?.some(
          (text) => typeof text === "string" && text.includes(workflow.previewText)
        ) === true) &&
      typeof document.contentHash === "string" &&
      document.ref?.id === vault.working?.id &&
      document.ref?.kind === vault.working?.kind &&
      isDeepStrictEqual(navigation?.hops ?? [], workflow.expectedNavigation ?? []) &&
      (!navigation || navigation.id === `${fixture.contextId}:navigation`) &&
      (!navigation || verification.checks?.exactNavigation === true) &&
      (preview === null ||
        (preview?.id === `${fixture.contextId}:preview` &&
          preview.documentPath === document.path &&
          preview.contentHash === document.contentHash)) &&
      Array.isArray(report?.findings) &&
      report.findings.length === workflow.checks.length &&
      report.findings.every((finding, index) => {
        const check = workflow.checks[index];
        const ids = [
          vault.id,
          ...(check === "publication" ? [] : [document.id]),
          ...(check === "revision" && committedDocument ? [committedDocument.id] : []),
          ...(check === "preview" && preview ? [preview.id] : []),
          ...(check === "navigation" && navigation ? [navigation.id] : []),
        ];
        return (
          finding?.check === check &&
          finding.code === workflow.expected[index] &&
          (finding.code !== "draft-changed" ||
            (committedDocument && committedDocument.contentHash !== document.contentHash)) &&
          (finding.code !== "revision-unchanged" ||
            committedDocument?.contentHash === document.contentHash) &&
          (finding.code !== "working-copy-dirty" || vault.clean === false) &&
          (check !== "revision" ||
            (typeof finding.detail === "string" && finding.detail.includes(document.path))) &&
          (finding.code !== "preview-ready" || preview?.phase === "rendered") &&
          (finding.code !== "preview-missing" || preview === null) &&
          (finding.code !== "navigation-ready" || navigation?.hops.at(-1)?.to === document.path) &&
          JSON.stringify(finding.evidenceIds) === JSON.stringify(ids) &&
          typeof finding.detail === "string" &&
          finding.detail.trim().length > 0 &&
          (check !== "document" ||
            workflow.requiredText.every((text) => finding.detail.includes(text))) &&
          (check !== "preview" || !preview?.detail || finding.detail.includes(preview.detail))
        );
      }) &&
      [
        "canonicalDocument",
        "browserIdentity",
        "visiblePreview",
        "actualDisposition",
        "matchedFindings",
      ].every((name) => verification.checks?.[name] === true),
    "Spectrolite findings must match the assigned canonical revision and rendered editor"
  );
  if (workflow.draft) {
    const child = (parentId, name) =>
      exercise.calls.find(
        ({ record }) =>
          record.parent_call_id === parentId &&
          record.definition?.name === name &&
          record.outcome === "done"
      );
    const skill = child(exercise.rootCallIds[0], "reviewSpectrolite");
    const live = skill && child(skill.callId, "reviewLiveVault");
    const revision = live && child(live.callId, "inspectRevision");
    const stages = {
      document: "inspectDocument",
      preview: "inspectPreview",
      navigation: "inspectNavigation",
      revision: "inspectRevision",
      publication: "inspectPublication",
    };
    const publication = live && child(live.callId, "inspectPublication");
    requireEvidence(
      live &&
        child(live.callId, "readVault") &&
        workflow.checks.every((check) => child(live.callId, stages[check])) &&
        revision &&
        child(revision.callId, "matchCommittedDocument") &&
        child(revision.callId, "compareDocumentContent") &&
        (!workflow.checks.includes("publication") ||
          (publication && child(publication.callId, "interpretProgress"))),
      "Spectrolite draft findings must come from the live review and its nested revision checks"
    );
  }
  return {
    world: {
      context_id: fixture.contextId,
      document_path: document.path,
      content_hash: document.contentHash,
      ...(committedDocument ? { committed_hash: committedDocument.contentHash } : {}),
    },
    checks: { ...verification.checks, ...(workflow.draft ? { revisionReviewTree: true } : {}) },
    evidence: { workspace: { fixture } },
  };
}

function grimoireEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedGrimoire;
  const verification = fixture?.verification;
  const report = exercise.report;
  const same = (actual, expected) =>
    expected &&
    actual?.decision === expected.decision &&
    actual.finding === expected.finding &&
    JSON.stringify(actual.evidenceIds) === JSON.stringify(expected.evidenceIds);
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.passed === true &&
      typeof verification.garden === "string" &&
      verification.observed?.before?.id === `${verification.garden}:before` &&
      verification.observed?.current?.id === `${verification.garden}:current` &&
      isDeepStrictEqual(verification.actions, workflow.expectedActions) &&
      same(report, verification.expected) &&
      Array.isArray(report.components) &&
      JSON.stringify(report.components.map(({ decision }) => decision)) ===
        JSON.stringify(workflow.expectedDecisions) &&
      report.components.every((item, index) =>
        same(item, verification.expected.components?.[index])
      ) &&
      [
        "persistedVisits",
        "persistedClock",
        "assignedClaims",
        "readOwnedGarden",
        "matchedJudgment",
        "matchedClaims",
      ].every((name) => verification.checks?.[name] === true),
    "Grimoire claims must match the assigned garden and the persisted resident visits"
  );
  return {
    world: { context_id: fixture.contextId, garden: verification.garden, case_id: workflow.caseId },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function failedTendrilCandidate(step) {
  return step.kind === "update" && step.candidate === "broken-boot";
}

function tendrilBuildEvidence(steps, verification) {
  const { builds, observed } = verification;
  const edits = steps.flatMap((step) => (step.kind === "update" ? [step.candidate] : []));
  const transitions = steps.flatMap((step, index) =>
    ["update", "restore"].includes(step.kind) ? [{ step, index }] : []
  );
  if (transitions.length === 0) return true;
  if (
    verification.checks.nativeBuilds !== true ||
    builds?.panels?.length !== observed.length ||
    builds?.outcomes?.length !== transitions.length ||
    builds?.edits?.length !== edits.length ||
    !builds.edits.every(
      ({ candidate, commandId }, index) =>
        candidate === edits[index] && typeof commandId === "string" && commandId.length > 0
    ) ||
    new Set(builds.edits.map(({ commandId }) => commandId)).size !== edits.length
  )
    return false;
  const proven = (panel, buildKey) =>
    panel.proof?.some((entry) => entry.buildKey === buildKey && entry.state === "proven");
  return transitions.every(({ step, index }, sequence) => {
    const before = builds.panels[index];
    const after = builds.panels[index + 1];
    const outcome = builds.outcomes[sequence];
    if (
      !before?.buildKey ||
      !after?.buildKey ||
      outcome?.pageId !== observed[index + 1].id ||
      !proven(before, before.buildKey) ||
      !proven(after, after.buildKey)
    )
      return false;
    if (step.kind === "restore")
      return (
        outcome.outcome === "restored" &&
        before.buildKey !== after.buildKey &&
        proven(before, after.buildKey)
      );
    const previous = new Set(before.proof.map(({ entryKey }) => entryKey));
    const added = after.proof.filter(({ entryKey }) => !previous.has(entryKey));
    if (failedTendrilCandidate(step))
      return (
        outcome.outcome === "failed" &&
        before.buildKey === after.buildKey &&
        added.some(
          (entry) =>
            entry.buildKey && entry.buildKey !== before.buildKey && entry.state === "failed"
        )
      );
    return (
      outcome.outcome === "proven" &&
      before.buildKey !== after.buildKey &&
      added.some((entry) => entry.state === "proven" && entry.buildKey === after.buildKey)
    );
  });
}

function tendrilEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedTendril;
  const verified = fixture?.verification;
  const { presentation, observed } = verified ?? {};
  const report = exercise.report;
  const { steps } = workflow.request;
  const fields = new Map();
  const matchesFields = (rows) =>
    Array.isArray(rows) &&
    rows.length === fields.size &&
    new Set(rows.map(({ key }) => key)).size === rows.length &&
    rows.every(({ key, value }) => fields.has(key) && fields.get(key) === value);
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verified?.contextId === fixture.contextId &&
      verified.caseId === workflow.caseId &&
      verified.passed === true &&
      ["presentation", "baseline", "exactEffects", "report"].every(
        (name) => verified.checks?.[name] === true
      ) &&
      typeof presentation?.deviceId === "string" &&
      typeof presentation?.slotId === "string" &&
      presentation.state === "presented" &&
      report?.state === "verified" &&
      isDeepStrictEqual(report.presentation, presentation) &&
      Array.isArray(observed) &&
      observed.length === steps.length + 1 &&
      observed.every(
        (page) =>
          typeof page?.id === "string" && page.id.length > 0 && page.slotId === presentation.slotId
      ) &&
      new Set(observed.map(({ id }) => id)).size === observed.length &&
      Array.isArray(report.findings) &&
      report.findings.length === steps.length &&
      observed[0].revision === 0 &&
      observed[0].build === "board-v1" &&
      matchesFields(observed[0].stored) &&
      matchesFields(observed[0].displayed) &&
      steps.every((step, index) => {
        const before = observed[index];
        const after = observed[index + 1];
        const finding = report.findings[index];
        const effect =
          step.kind === "write" ? step.field : step.kind === "invoke" ? step.expected : null;
        if (effect) fields.set(effect.key, effect.value);
        return (
          (step.kind !== "invoke" || before.exposed?.includes(step.name)) &&
          after.build ===
            (step.kind === "restore" || (step.kind === "update" && !failedTendrilCandidate(step))
              ? step.expectedBuild
              : before.build) &&
          after.revision === before.revision + Number(Boolean(effect)) &&
          matchesFields(after.stored) &&
          matchesFields(after.displayed) &&
          finding?.status === (failedTendrilCandidate(step) ? "rolled-back" : "verified") &&
          isDeepStrictEqual(finding.evidence, [before.id, after.id]) &&
          isDeepStrictEqual(finding.page, after)
        );
      }),
    "Tendril findings must bind each effect to displayed and durable state on the assigned slot"
  );

  requireEvidence(
    tendrilBuildEvidence(steps, verified),
    "Tendril build effects must include native proof of the installed, failed and restored builds"
  );

  const children = (parent, name) =>
    parent
      ? exercise.calls.filter(
          ({ record }) =>
            record.parent_call_id === parent.callId &&
            record.outcome === "done" &&
            record.definition?.name === name
        )
      : [];
  const root = exercise.calls.find(({ callId }) => callId === exercise.rootCallIds[0]);
  const skill =
    root?.record.definition?.name === workflow.root ? root : children(root, workflow.root)[0];
  const present = children(skill, "openPresentation")[0];
  const run = children(skill, "runSteps")[0];
  const live = children(run, "reviewLiveStep");
  const builds = children(run, "reviewBuildStep");
  const buildCount = steps.filter((step) => ["update", "restore"].includes(step.kind)).length;
  requireEvidence(
    children(present, "selectTendrilDevice").length === 1 &&
      live.length === steps.length - buildCount &&
      builds.length === buildCount &&
      builds.every((call) => children(call, "verifyBuildStep").length === 1) &&
      live.every((call) => children(call, "verifyLiveStep").length === 1),
    "Tendril capture must include device selection and the verification of each nested live operation"
  );
  return {
    world: {
      context_id: fixture.contextId,
      device_id: presentation.deviceId,
      panel_id: presentation.slotId,
    },
    checks: verified.checks,
    evidence: { workspace: { fixture } },
  };
}

function channelRosterEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedChannelRoster;
  const verification = fixture?.verification;
  const { initial, final, steps, activity } = verification ?? {};
  const { assignment } = workflow;
  const plan = assignment.steps;
  const findings = exercise.report?.findings;
  const names = ["oncall", "review"];
  const token =
    typeof initial?.oncall?.channelId === "string"
      ? /^natlang-roster-([0-9a-f-]{36})-oncall$/u.exec(initial.oncall.channelId)?.[1]
      : null;
  const sourceId = (name, handle) =>
    `do:workers/test-agent:TestAgentWorker:${handle}-${initial[name].channelId}`;
  const members = new Map(names.map((name) => [name, new Map()]));
  for (const [name, handle] of assignment.starting.members ?? []) {
    if (initial?.[name]) members.get(name).set(handle, sourceId(name, handle));
  }
  for (const [name, handle] of assignment.starting.conflicts ?? []) {
    members
      .get(name)
      .set(
        handle,
        `do:workers/local-messaging-fixture:LocalMessagingProbeDO:natlang-roster-conflict-${token}-${name}-${handle}`
      );
  }
  function exactRoster(roster) {
    return names.every((name) => {
      const view = roster?.[name];
      const expected = members.get(name);
      return (
        view?.contextId === fixture.contextId &&
        view.channelId === `natlang-roster-${token}-${name}` &&
        view.messages === 0 &&
        Array.isArray(view.participants) &&
        view.participants.length === expected.size &&
        new Set(view.participants.map(({ handle }) => handle)).size === expected.size &&
        view.participants.every(
          ({ id, handle, type }) => expected.get(handle) === id && type === "agent"
        )
      );
    });
  }
  let cursor = 0;
  const verifiedSteps = [];
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      [
        "initial",
        "exactOperations",
        "finalRoster",
        "isolatedChannels",
        "noMessages",
        "report",
      ].every((key) => verification.checks?.[key] === true) &&
      typeof token === "string" &&
      Array.isArray(steps) &&
      steps.length === plan.length &&
      Array.isArray(findings) &&
      findings.length === plan.length &&
      Array.isArray(activity) &&
      exactRoster(initial) &&
      plan.every(({ channel, handle, action, precondition, expected }, index) => {
        const id = `step-${index + 1}`;
        const { request } = steps[index] ?? {};
        if (
          steps[index]?.id !== id ||
          request?.contextId !== fixture.contextId ||
          request.channelId !== initial[channel].channelId ||
          request.handle !== handle ||
          request.action !== action ||
          !isDeepStrictEqual(
            request.options,
            action === "attach"
              ? { replay: false, response: "mentioned-strict", modelRef: null }
              : null
          )
        )
          return false;
        if (expected === "blocked") {
          const previous = verifiedSteps.findLast(
            (step) => step.channel === channel && step.handle === handle
          );
          return (
            previous &&
            isDeepStrictEqual(findings[index], { id, result: null, blockedBy: previous.id })
          );
        }
        verifiedSteps.push({ id, channel, handle });
        const participantId = sourceId(channel, handle);
        let state = precondition;
        const read = () => ({
          id,
          kind: "read",
          value: { state, participantId: state === "member" ? participantId : null },
        });
        if (!isDeepStrictEqual(activity[cursor++], read())) return false;
        if (expected === "applied") {
          state = action === "attach" ? "member" : "absent";
          if (state === "member") members.get(channel).set(handle, participantId);
          else members.get(channel).delete(handle);
          if (
            !isDeepStrictEqual(activity[cursor++], {
              id,
              kind: action,
              value: {
                outcome: "acknowledged",
                participantId: state === "member" ? participantId : null,
              },
            }) ||
            !isDeepStrictEqual(activity[cursor++], read())
          )
            return false;
        }
        return isDeepStrictEqual(findings[index], {
          id,
          blockedBy: null,
          result: {
            status: expected,
            state,
            participantId: state === "member" ? participantId : null,
          },
        });
      }) &&
      cursor === activity.length &&
      exactRoster(final),
    "Channel roster findings must bind exact activities to the assigned live channel and participant"
  );

  const children = (parent, name) =>
    parent
      ? exercise.calls.filter(
          ({ record }) =>
            record.parent_call_id === parent.callId &&
            record.definition?.name === name &&
            record.outcome === "done"
        )
      : [];
  const root = exercise.calls.find(({ callId }) => callId === exercise.rootCallIds[0]);
  const workflowRoot = children(root, workflow.root)[0];
  const executions = children(workflowRoot, "manageChannelAgent");
  requireEvidence(
    children(workflowRoot, "checkPriorOutcome").length === plan.length &&
      executions.length === verifiedSteps.length &&
      executions.every(
        (call) => children(call, "choose").length === 1 && children(call, "reconcile").length === 1
      ) &&
      executions.flatMap((call) => children(call, "change")).length ===
        plan.filter(({ expected }) => expected === "applied").length,
    "Channel roster capture must include the ordered membership, reconciliation and hold decisions"
  );
  return {
    world: { context_id: fixture.contextId, channel_id: initial.oncall.channelId },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function missionPlanningEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedMissionPlanning;
  const verification = fixture?.verification;
  const { baseline, transitions, assignments, objectKey } = verification ?? {};
  const findings = exercise.report?.findings;
  const cards = assignments?.cards;
  const projects = assignments?.projects;
  const snapshotIds = new Set();
  const acceptSnapshot = (snapshot) => {
    if (
      snapshot?.complete !== true ||
      typeof snapshot.id !== "string" ||
      !snapshot.id ||
      snapshotIds.has(snapshot.id) ||
      !Array.isArray(snapshot.cards) ||
      !isDeepStrictEqual(snapshot.projects, baseline.projects)
    )
      return false;
    snapshotIds.add(snapshot.id);
    return true;
  };
  let before = baseline;
  let applied = 0;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      objectKey === `natlang-mission-planning-${fixture.contextId}` &&
      ["baseline", "outside", "exactEffects", "report"].every(
        (check) => verification.checks?.[check] === true
      ) &&
      cards &&
      projects &&
      Array.isArray(transitions) &&
      Array.isArray(findings) &&
      findings.length === workflow.expected.length &&
      acceptSnapshot(before) &&
      workflow.expected.every((plan, index) => {
        const finding = findings[index];
        if (plan.kind === "held") {
          return isDeepStrictEqual(finding, {
            status: "held",
            cardId: null,
            blockers: plan.codes.map((code) => cards[code] ?? code),
            evidence: [before.id],
          });
        }
        const cardId = cards[plan.key];
        const previous = before.cards.find(({ id }) => id === cardId);
        if (typeof cardId !== "string" || !Number.isInteger(previous?.revision)) return false;
        const change = { kind: plan.kind, cardId, revision: previous.revision };
        if (plan.kind === "prerequisites")
          change.dependencies = plan.requires.map((key) => cards[key]);
        if (plan.kind === "relocate") change.projectId = projects[plan.project];
        const receipt = transitions[applied++];
        if (!isDeepStrictEqual(receipt?.change, change) || !acceptSnapshot(receipt?.after))
          return false;
        const { after } = receipt;
        const updated = after.cards.find(({ id }) => id === cardId);
        const expected = {
          ...previous,
          revision: previous.revision + 1,
          updatedAt: updated?.updatedAt,
        };
        if (plan.kind === "prerequisites") expected.dependencies = change.dependencies;
        if (plan.kind === "relocate") expected.projectId = change.projectId;
        if (plan.kind === "ready") expected.status = "ready";
        const byId = new Map(before.cards.map((card) => [card.id, card]));
        if (
          after.cards.length !== before.cards.length ||
          !after.cards.every((card) =>
            isDeepStrictEqual(card, card.id === cardId ? expected : byId.get(card.id))
          ) ||
          !isDeepStrictEqual(finding, {
            status: "verified",
            cardId,
            blockers: [],
            evidence: [before.id, after.id],
          })
        )
          return false;
        before = after;
        return true;
      }) &&
      applied === transitions.length,
    "Mission planning must link each finding to the assigned live card and observed revision"
  );
  const children = (parent, name) =>
    parent
      ? exercise.calls.filter(
          ({ record }) =>
            record.parent_call_id === parent.callId &&
            record.definition?.name === name &&
            record.outcome === "done"
        )
      : [];
  const root = exercise.calls.find(({ callId }) => callId === exercise.rootCallIds[0]);
  const skill = children(root, workflow.root)[0];
  const plans = children(skill, "planCardChange");
  const writes = children(skill, "applyCardChange");
  requireEvidence(
    root?.record.definition?.name === "runWorkflow" &&
      plans.length === workflow.request.proposals.length &&
      plans.every((call) => children(call, "locateCard").length === 1) &&
      writes.length === transitions.length &&
      writes.every((call) => {
        const verified = children(call, "verifyCardChange");
        return verified.length === 1 && children(verified[0], "verifyPlanningFields").length === 1;
      }),
    "Mission planning capture must include scoped card resolution and nested verification of every write"
  );
  return {
    world: { context_id: fixture.contextId, mission_store: objectKey },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function browserHandoffEvidence(execution, exercise, scenario, workflow) {
  const fixture = execution.diagnostics.managedBrowserHandoff;
  const verification = fixture?.verification;
  const { browser, collection, receipts } = verification ?? {};
  const results = exercise.report?.results;
  const last = browser?.transitions?.at(-1)?.after;
  const { assignment } = workflow;
  const url = browser?.origin + assignment.path;
  const note = `${assignment.heading}: ${url}`;
  const bookmarkId = browser?.assignments?.[assignment.bookmarkKey];
  const panelId = collection?.assignments?.[assignment.panel.key];
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      ["browser", "collection", "reports", "dependency"].every(
        (check) => verification.checks?.[check] === true
      ) &&
      Array.isArray(results) &&
      results.length === 2 &&
      results[0]?.domain === "browserLibrary" &&
      results[0]?.operation === "curateBrowserLibrary" &&
      results[1]?.domain === "collection" &&
      results[1]?.operation === "organizeCollection" &&
      isDeepStrictEqual(exercise.report.remaining, []) &&
      typeof last?.id === "string" &&
      Number.isSafeInteger(bookmarkId) &&
      last.bookmarks?.some((row) => row.id === bookmarkId && row.url === url) &&
      typeof panelId === "string" &&
      panelId === verification.panelId &&
      verification.note === note &&
      Array.isArray(receipts) &&
      receipts.length === 2 &&
      receipts.every((receipt) =>
        isDeepStrictEqual(receipt, { snapshotId: last.id, bookmarkId, url })
      ) &&
      collection.transitions
        ?.at(-1)
        ?.after?.nodes?.some((node) => node.id === panelId && node.note === note),
    "Browser handoff must bind the persisted panel note to the verified browser bookmark"
  );
  const libraryEvidence = browserLibraryEvidence(
    {
      ...execution,
      diagnostics: {
        managedBrowserLibrary: { contextId: fixture.contextId, verification: browser },
      },
    },
    { ...exercise, report: results[0].report },
    scenario,
    workflow.library
  );
  const panelEvidence = collectionEvidence(
    {
      ...execution,
      diagnostics: {
        managedCollection: { contextId: fixture.contextId, verification: collection },
      },
    },
    { ...exercise, report: results[1].report },
    scenario,
    {
      ...collectionWorkflow,
      caseId: assignment.id,
      request: { actions: [{ kind: "note", text: note }] },
      expected: [{ kind: "note", key: assignment.panel.key }],
    }
  );
  return {
    world: { ...libraryEvidence.world, ...panelEvidence.world },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function browserLibraryEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedBrowserLibrary;
  const verification = fixture?.verification;
  const { baseline, transitions, origin, folders, assignments } = verification ?? {};
  const findings = exercise.report?.findings;
  const { actions } = workflow.request;
  const observed = new Set();
  const validSnapshot = (snapshot) => {
    const valid =
      typeof snapshot?.id === "string" &&
      snapshot.id.length > 0 &&
      !observed.has(snapshot.id) &&
      isDeepStrictEqual(snapshot.availableFolders, folders) &&
      Array.isArray(snapshot.bookmarks) &&
      snapshot.bookmarks.every(
        (row) => folders.includes(row.folder) && row.url?.startsWith(origin + "/")
      ) &&
      Array.isArray(snapshot.visits) &&
      snapshot.visits.every((row) => row.url?.startsWith(origin + "/"));
    if (valid) observed.add(snapshot.id);
    return valid;
  };
  const namespace =
    typeof origin === "string"
      ? /^https:\/\/([0-9a-f-]{36})\.library\.vibestudio\.invalid$/u.exec(origin)?.[1]
      : null;
  const folderFor = (folder) => `/System test ${namespace}${folder}`;
  let before = baseline;
  let applied = 0;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      ["initial", "exactEffects", "report", "metadata", "outside"].every(
        (check) => verification.checks?.[check] === true
      ) &&
      typeof namespace === "string" &&
      Array.isArray(folders) &&
      folders.every((folder) => folder.startsWith(folderFor("/"))) &&
      Array.isArray(transitions) &&
      assignments &&
      Array.isArray(findings) &&
      findings.length === actions.length &&
      validSnapshot(before) &&
      workflow.expected.every((plan, index) => {
        const action = actions[index];
        if (plan.kind === "held") {
          return isDeepStrictEqual(findings[index], {
            status: "held",
            bookmarkId: null,
            evidence: [before.id],
          });
        }
        const bookmarkId = assignments[plan.kind === "retire" ? plan.keep : plan.key];
        const id = assignments[plan.key];
        const mutation =
          plan.kind === "save"
            ? {
                kind: "save",
                url: plan.url.replace(workflow.origin, origin),
                folder: folderFor(action.folder),
                title: plan.title,
              }
            : plan.kind === "rename"
              ? { kind: "rename", id, title: action.title }
              : plan.kind === "file"
                ? { kind: "file", id, folder: folderFor(action.folder) }
                : { kind: "retire", id, keepId: bookmarkId };
        const receipt = transitions[applied++];
        if (
          !Number.isSafeInteger(bookmarkId) ||
          !isDeepStrictEqual(receipt?.mutation, mutation) ||
          !validSnapshot(receipt?.after) ||
          !receipt.after.bookmarks.some((row) => row.id === bookmarkId) ||
          !isDeepStrictEqual(findings[index], {
            status: "verified",
            bookmarkId,
            evidence: [before.id, receipt.after.id],
          })
        )
          return false;
        before = receipt.after;
        return true;
      }) &&
      applied === transitions.length,
    "Browser library findings must cite the assigned store observations and exact bookmark effects"
  );
  const children = (parent, name) =>
    parent
      ? exercise.calls.filter(
          ({ record }) =>
            record.parent_call_id === parent.callId &&
            record.definition?.name === name &&
            record.outcome === "done"
        )
      : [];
  const root = exercise.calls.find(({ callId }) => callId === exercise.rootCallIds[0]);
  const skill = children(root, workflow.root)[0];
  const planning = children(skill, "planLibraryChange");
  const recovery = planning.flatMap((call) => children(call, "planVisitRecovery"));
  const retiring = planning.flatMap((call) => children(call, "confirmRetainedReference"));
  const effects = children(skill, "applyLibraryChange");
  const verificationCalls = effects.flatMap((call) => children(call, "verifyLibraryChange"));
  requireEvidence(
    root?.record.definition?.name === "runWorkflow" &&
      planning.length === actions.length &&
      recovery.length === actions.filter((action) => action.kind === "recover").length &&
      effects.length === transitions.length &&
      effects.every((call) => children(call, "verifyLibraryChange").length === 1) &&
      retiring.length >= transitions.filter(({ mutation }) => mutation.kind === "retire").length &&
      verificationCalls.every(
        (call) =>
          children(call, "verifyRetiredCopy").length +
            children(call, "verifySavedReference").length ===
          1
      ),
    "Browser library capture must include nested planning and verification of each store effect"
  );
  return {
    world: { context_id: fixture.contextId },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function collectionEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedCollection;
  const verification = fixture?.verification;
  const { baseline, rootId, transitions, assignments } = verification ?? {};
  const { results } = exercise.report ?? {};
  const { actions } = workflow.request;
  const observedIds = new Set();
  const observe = (snapshot) => {
    const valid =
      snapshot?.complete === true &&
      snapshot.rootId === rootId &&
      typeof snapshot.id === "string" &&
      snapshot.id.length > 0 &&
      !observedIds.has(snapshot.id) &&
      Array.isArray(snapshot.nodes) &&
      snapshot.nodes[0]?.id === rootId &&
      snapshot.nodes.every(({ contextId }) => contextId === fixture.contextId);
    if (valid) observedIds.add(snapshot.id);
    return valid;
  };
  const checkFinding = (finding, status, panelId, evidence) =>
    finding?.status === status &&
    finding.panelId === panelId &&
    isDeepStrictEqual(finding.evidence, evidence);
  let current = baseline;
  let transitionIndex = 0;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.contextId === fixture.contextId &&
      verification.caseId === workflow.caseId &&
      verification.passed === true &&
      ["baseline", "outsideUnchanged", "exactEffects", "reportMatches"].every(
        (check) => verification.checks?.[check] === true
      ) &&
      typeof rootId === "string" &&
      assignments?.root === rootId &&
      Array.isArray(transitions) &&
      Array.isArray(results) &&
      results.length === actions.length &&
      observe(current) &&
      workflow.expected.every((plan, index) => {
        const action = actions[index];
        const finding = results[index];
        if (plan.kind === "held") {
          return checkFinding(finding, "held", null, [current.id]);
        }
        const receipt = transitions[transitionIndex++];
        const panelId = assignments[plan.key];
        const mutation =
          plan.kind === "rename"
            ? { kind: "rename", panelId, title: action.title }
            : plan.kind === "note"
              ? { kind: "note", panelId, text: action.text }
              : plan.kind === "group"
                ? { kind: "group", parentId: assignments[plan.parent], title: action.title }
                : {
                    kind: "move",
                    panelId,
                    parentId: assignments[plan.parent],
                    afterId: plan.after === null ? null : assignments[plan.after],
                  };
        if (
          typeof panelId !== "string" ||
          !isDeepStrictEqual(receipt?.mutation, mutation) ||
          !observe(receipt?.after) ||
          !receipt.after.nodes.some(({ id }) => id === panelId) ||
          !checkFinding(finding, "verified", panelId, [current.id, receipt.after.id])
        )
          return false;
        current = receipt.after;
        return true;
      }) &&
      transitionIndex === transitions.length,
    "Collection findings must cite ordered live snapshots for the exact assigned effects"
  );

  const children = (parent, name) =>
    parent
      ? exercise.calls.filter(
          ({ record }) =>
            record.parent_call_id === parent.callId &&
            record.outcome === "done" &&
            record.definition?.name === name
        )
      : [];
  const root = exercise.calls.find(({ callId }) => callId === exercise.rootCallIds[0]);
  const skill = children(root, workflow.root)[0];
  const planned = children(skill, "planCollectionChange");
  const applied = children(skill, "applyCollectionChange");
  const placements = planned.flatMap((call) => children(call, "planCollectionPlacement"));
  const verified = applied.flatMap((call) => children(call, "verifyCollectionChange"));
  const isPlacement = ({ kind }) => kind === "group" || kind === "move";
  requireEvidence(
    root?.record.definition?.name === "runWorkflow" &&
      planned.length === actions.length &&
      placements.length === actions.filter(isPlacement).length &&
      planned.every(
        (call) =>
          children(call, "planCollectionPlacement").length +
            children(call, "locateCollectionPanel").length ===
          1
      ) &&
      placements.every((call) => children(call, "locateCollectionPanel").length > 0) &&
      applied.length === transitions.length &&
      applied.every((call) => children(call, "verifyCollectionChange").length === 1) &&
      verified.filter((call) => children(call, "verifyPlacement").length === 1).length ===
        transitions.filter(({ mutation }) => isPlacement(mutation)).length,
    "Collection capture must include nested planning, target resolution and effect verification"
  );
  return {
    world: { context_id: fixture.contextId, panel_id: rootId },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function terminalChecklistEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedChecklist;
  const verification = fixture?.verification;
  const report = exercise.report;
  const screens = verification?.screens;
  const continuation = workflow.expectedContinuation;
  const continuing = continuation !== "none";
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.continuation === continuation &&
      report?.status === "verified" &&
      report.continuation === continuation &&
      (!workflow.expectedKeys ||
        (isDeepStrictEqual(verification.sent, workflow.expectedKeys) &&
          verification.checks?.assignedKeys === true &&
          verification.checks?.finalTarget === true)) &&
      typeof verification.sessionId === "string" &&
      Array.isArray(screens) &&
      screens.length === workflow.expectedScreens.length &&
      typeof screens[0]?.ptyId === "string" &&
      Array.isArray(report.screens) &&
      report.screens.length === screens.length &&
      screens.every((screen, index) => {
        const last = continuing && index === screens.length - 1;
        const observed = report.screens[index];
        return (
          screen.sessionId === verification.sessionId &&
          typeof screen.ptyId === "string" &&
          (screen.ptyId === screens[0].ptyId) === !(last && continuation === "restart") &&
          screen.cols === (last ? 62 : 80) &&
          screen.rows === (last ? 18 : 24) &&
          JSON.stringify(screen.checked) === JSON.stringify(workflow.expectedScreens[index]) &&
          ["sessionId", "ptyId", "cols", "rows"].every((key) => observed?.[key] === screen[key]) &&
          JSON.stringify(observed.checked) === JSON.stringify(screen.checked)
        );
      }) &&
      [
        "exactScreenSequence",
        "sessionPreserved",
        "terminalIdentity",
        "viewport",
        "joinedReport",
        "retired",
      ].every((name) => verification.checks?.[name] === true),
    "The checklist report must match the live PTY sequence and verified cleanup"
  );
  return {
    world: { context_id: fixture.contextId, session_id: verification.sessionId },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function onboardingEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedSetup;
  const verification = fixture?.verification;
  const report = exercise.report;
  const sameRoute = (left, right) =>
    right === null
      ? left === null
      : ["capabilityId", "action", "via", "destination"].every((key) => left?.[key] === right[key]);
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      verification.status === workflow.expectedStatus &&
      report?.status === workflow.expectedStatus &&
      /^[a-f0-9]{64}$/u.test(verification.receipt) &&
      report.receipt === verification.receipt &&
      sameRoute(verification.route, workflow.expectedRoute) &&
      sameRoute(report.route, verification.route) &&
      [
        "workspaceHeadUnchanged",
        "generationBound",
        "exactOwnerRows",
        "authoritativeRoute",
        "unknownAndUnverified",
      ].every((name) => verification.checks?.[name] === true),
    "The onboarding plan must match its actual owner receipt and canonical route"
  );
  return {
    world: { context_id: fixture.contextId, owner_snapshot: verification.receipt },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function publicationPreflightEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedPublication;
  const verification = fixture?.verification;
  const report = exercise.report;
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      [
        "protectedHeadUnchanged",
        "exactPanelCapture",
        "localArtifactRepeatable",
        "singleReadback",
        "verifiedDisposition",
      ].every((name) => verification.checks?.[name] === true) &&
      typeof verification.seedRevision === "string" &&
      typeof verification.panelAttempt === "string" &&
      /^sha256:[a-f0-9]{64}$/u.test(verification.artifactDigest) &&
      verification.publicPaths?.includes("index.html") &&
      verification.publicPaths?.includes("vibestudio-build.json") &&
      (!workflow.expectedVisual ||
        (verification.visual === workflow.expectedVisual &&
          report?.visual === workflow.expectedVisual)) &&
      report?.status === (workflow.expectedBlockers.length ? "blocked" : "ready-for-review") &&
      Array.isArray(report.blockers) &&
      JSON.stringify([...report.blockers].sort()) ===
        JSON.stringify([...workflow.expectedBlockers].sort()),
    "The managed publication decision must match the exact local artifact, live panel, and approved review"
  );
  return {
    world: { context_id: fixture.contextId, seed_revision: verification.seedRevision },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function automationLifecycleEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.managedAutomation;
  const verification = fixture?.verification;
  const report = exercise.report;
  requireEvidence(
    fixture?.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.expectedStatus === workflow.expectedStatus &&
      verification.problem === workflow.problem &&
      report?.status === workflow.expectedStatus &&
      report.missionId === verification.assignedId &&
      report.revisionDigest === verification.reportedRevision &&
      report.state === verification.reportedState &&
      (workflow.problem === "missing"
        ? report.revisionDigest === null && report.state === null
        : report.revisionDigest === verification.observedRevision &&
          report.state === verification.afterState) &&
      verification.passed === true &&
      [
        "exactStateAndReport",
        "defaultMonitorUnchanged",
        "exactDefinition",
        "revisionGuard",
        "effectReadback",
        "scopedReadback",
        "noAutomationRunStarted",
        "assignedTransition",
        "missingStaysMissing",
      ].every((name) => verification.checks?.[name] === true) &&
      /^[a-f0-9]{64}$/u.test(verification.expectedRevision) &&
      /^[a-f0-9]{64}$/u.test(verification.observedRevision),
    "The managed automation must retain independently verified scheduling, definition, and run-state evidence"
  );
  return {
    world: { context_id: fixture.contextId, seed_revision: verification.expectedRevision },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function integrationHandoffEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.integrationHandoff;
  const verification = fixture?.verification;
  const artifact = verification?.artifact;
  const results = exercise.report?.results;
  const integrated = results?.[0]?.report;
  const handoff = results?.[1]?.report;
  requireEvidence(
    fixture?.contextId === execution.provenance?.contextId &&
      fixture.caseId === workflow.caseId &&
      verification?.passed === true &&
      [
        "persistedIntegration",
        "beforeChanged",
        "handoffUsedIntegratedHead",
        "exactClaims",
        "allSourcesRead",
        "pairedReports",
      ].every((name) => verification.checks?.[name] === true) &&
      verification.verificationPaths?.length === workflow.expectedPaths.length &&
      workflow.expectedPaths.every((path) => verification.verificationPaths.includes(path)) &&
      typeof verification.seed?.eventId === "string" &&
      typeof verification.source?.eventId === "string" &&
      verification.before !== verification.after &&
      integrated?.status === "integrated" &&
      integrated.head === verification.after &&
      handoff?.status === workflow.expectedStatus &&
      verification.expectedStatus === workflow.expectedStatus &&
      isDeepStrictEqual(verification.unanswered, workflow.unanswered) &&
      isDeepStrictEqual(handoff.unanswered, workflow.unanswered) &&
      isDeepStrictEqual(handoff.missingSources, []) &&
      (workflow.expectedStatus === "unanswered"
        ? artifact === null && handoff.artifact === null
        : artifact &&
          artifact.path === handoff.artifact?.path &&
          artifact.bytes === handoff.artifact?.bytes &&
          Number.isSafeInteger(artifact.bytes) &&
          artifact.bytes > 0 &&
          /^[0-9a-f]{64}$/u.test(artifact.sha256)),
    "The scratch handoff must be independently verified against every assigned file at the integrated head"
  );
  return {
    world: {
      context_id: fixture.contextId,
      seed_revision: verification.seed.eventId,
      source_revision: verification.source.eventId,
    },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
}

function scratchHandoffEvidence(execution, exercise, _scenario, workflow) {
  const fixture = execution.diagnostics.scratchHandoffWorld;
  const verification = execution.diagnostics.scratchHandoffVerification;
  const artifact = verification?.artifact;
  const report = exercise.report;
  const staged = workflow.expectedStatus === "staged";
  requireEvidence(
    fixture?.caseId === workflow.caseId &&
      fixture.contextId === execution.provenance?.contextId &&
      report?.status === workflow.expectedStatus &&
      verification?.passed === true &&
      verification.expectedStatus === workflow.expectedStatus &&
      ["protectedUnchanged", "originalsUnchanged", "disposition", "exactReadback"].every(
        (name) => verification.checks?.[name] === true
      ) &&
      typeof verification.seedRevision === "string" &&
      verification.sourceIds?.length > 0 &&
      (staged
        ? artifact &&
          report.artifact?.path === artifact.path &&
          report.artifact.bytes === artifact.bytes &&
          Number.isSafeInteger(artifact.bytes) &&
          artifact.bytes > 0 &&
          /^[0-9a-f]{64}$/u.test(artifact.sha256)
        : report.artifact === null && artifact === null),
    "The scratch handoff must be independently read back, or held without a scratch artifact, in the assigned context"
  );
  return {
    world: { context_id: fixture.contextId, seed_revision: verification.seedRevision },
    checks: verification.checks,
    evidence: { workspace: { fixture, verification } },
  };
}

function localMessagingEvidence(execution, exercise, scenario) {
  const fixture = execution.diagnostics.localMessagingWorld;
  const verification = execution.diagnostics.localMessagingVerification;
  const channelEvidence = execution.diagnostics.localMessagingEvidence;
  const cleanup = execution.diagnostics.localMessagingCleanupErrors;
  requireEvidence(
    fixture?.kind === "local-messaging" &&
      fixture.contextId === execution.provenance?.contextId &&
      scenario === `messaging-${fixture.caseId}` &&
      cleanup?.length === 0 &&
      verification?.passed === true &&
      verification.status === exercise.report?.status &&
      ["delivered", "held"].includes(verification.status) &&
      channelEvidence?.closedAdmission === true &&
      channelEvidence.boundaries?.length > 0 &&
      channelEvidence.boundaries.every(
        (boundary) => boundary.joined && boundary.barrier?.channelId === boundary.channelId
      ) &&
      channelEvidence.probeSnapshots?.length > 0 &&
      verification.messageIds?.length === (verification.status === "delivered" ? 1 : 0) &&
      (verification.status === "held" ||
        verification.messageIds[0] === exercise.report.messageId) &&
      JSON.stringify(channelEvidence?.report) === JSON.stringify(exercise.report),
    "Missing the exact scoped delivery or hold evidence and cleanup"
  );
  return {
    world: { context_id: fixture.contextId, case_id: fixture.caseId },
    checks: { independentlyVerifiedAddressedDelivery: true, ownedCleanup: true },
    evidence: { workspace: { fixture, verification, channelEvidence, cleanup } },
  };
}

function composedReleaseEvidence(execution, exercise, scenario) {
  const fixture = execution.diagnostics.composedWorkflowWorld;
  const verification = execution.diagnostics.composedWorkflowVerification;
  const dependency = execution.diagnostics.dependencyAudit;
  const results = exercise.report?.results;
  requireEvidence(
    fixture?.kind === "owned-operations-content" &&
      fixture.contextId === execution.provenance?.contextId &&
      scenario === `owned-operations-${fixture.caseId}` &&
      verification?.passed === true &&
      ["operations", "content", "dependency", "cleanup"].every(
        (key) => verification.checks?.[key] === true
      ) &&
      dependency?.passed === true &&
      dependency.events?.length >= 5 &&
      exercise.report?.remaining?.length === 0 &&
      results?.length === 2 &&
      results[0]?.kind === "operate" &&
      results[1]?.kind === "deliverProject",
    "Missing the independently verified operations prerequisite and committed dossier"
  );
  const operations = ownedOperationsEvidence(
    execution,
    { ...exercise, report: results[0].report },
    scenario
  );
  const content = contentProjectEvidence(execution, { ...exercise, report: results[1].report });
  return {
    world: { ...content.world, case_id: fixture.caseId },
    checks: { ...operations.checks, ...content.checks, independentlyVerifiedSkillDependency: true },
    evidence: {
      workspace: {
        fixture,
        verification,
        dependency,
        operations: operations.evidence.workspace,
        content: content.evidence.workspace,
      },
    },
    reviewInput: content.reviewInput,
  };
}

function contentProjectEvidence(execution, exercise) {
  const fixture = execution.diagnostics.contentProjectWorld;
  const verification = execution.diagnostics.contentProjectVerification;
  const input = verification?.semanticReviewInput;
  requireEvidence(
    fixture?.kind === "content-project" &&
      fixture.contextId === execution.provenance?.contextId &&
      typeof fixture.before === "string" &&
      typeof fixture.after === "string" &&
      fixture.before !== fixture.after &&
      exercise.report?.status === "committed" &&
      exercise.report.repoPath === fixture.repoPath &&
      exercise.report.head === fixture.after &&
      verification?.passed === true &&
      verification.reasons?.length === 0 &&
      verification.evidence?.length > 0 &&
      verification.semanticReviewRequired === true &&
      input?.actual?.contextId === fixture.contextId &&
      JSON.stringify(input?.actual?.committedEvent) === fixture.after &&
      input.actual.committedEvent.eventId === exercise.report.eventId &&
      JSON.stringify(input.expected) === JSON.stringify(fixture.request) &&
      input.actual.documents?.length > 0 &&
      typeof input.rubric === "string",
    "Missing independent content-project readback at the committed workspace revision"
  );
  return {
    world: { context_id: fixture.contextId, seed_revision: fixture.before },
    checks: { independentlyVerifiedContentProject: true },
    evidence: { workspace: { fixture, verification } },
    reviewInput: input,
  };
}

export async function exportLiveTeacherWorkflow({
  trajectory,
  pins,
  validator,
  out,
  split,
  review,
  cases = originalCases,
  loadCases,
}) {
  const entry = await readJson(trajectory);
  const source = await readJson(pins);
  const { test, result, execution } = entry;
  const workflow = cases.get(test?.name) ?? (await loadCases?.())?.get(test?.name);
  requireEvidence(workflow, "Unsupported live teacher scenario");
  requireEvidence(
    (source.workspace ?? "system") === (workflow.workspace ?? "system"),
    "The live teacher source pin must name the case's assigned workspace"
  );
  requireEvidence(result?.passed === true && !execution?.error, "The actual system test must pass");
  const exercise = execution?.diagnostics?.natlangTeacher;
  const shared = exercise?.programPath === sharedProgram;
  requireEvidence(
    exercise?.trainingEligible === true &&
      !exercise.executionError &&
      !exercise.captureErrors?.length &&
      (shared || (workflow.program && exercise.programPath === workflow.program)) &&
      Array.isArray(exercise.calls) &&
      Array.isArray(exercise.rootCallIds) &&
      exercise.rootCallIds.length === 1 &&
      typeof exercise.evalRunId === "string",
    "Missing eligible authored Natlang execution, run identity, or root call"
  );
  const rootId = exercise.rootCallIds[0];
  const captured = exercise.calls;
  const root = captured.find((call) => call.callId === rootId);
  const generationTurns = (call) =>
    (call?.record?.model_turns ?? []).filter((turn) => turn.kind === "generation" && turn.reply);
  const expectedRoot = shared ? "runWorkflow" : workflow.root;
  requireEvidence(
    root?.record.definition?.name === expectedRoot &&
      root.record.parent_call_id === null &&
      generationTurns(root).length > 0 &&
      captured.some((call) => call.callId !== rootId && generationTurns(call).length > 0),
    `Expected the authored ${expectedRoot} root and at least one actual child call`
  );
  if (shared) {
    const expectedSkills = workflow.skills ?? [workflow.root];
    const children = captured.filter((call) => call?.record?.parent_call_id === rootId);
    const skills = expectedSkills.map((name) =>
      children.find((call) => call.record.definition?.name === name)
    );
    requireEvidence(
      children.length === skills.length &&
        skills.every(
          (skill) =>
            generationTurns(skill).length > 0 &&
            captured.some((call) => call?.record?.parent_call_id === skill.callId)
        ),
      `Expected the shared workflow to call the assigned ${expectedSkills.join(", ")} skill and its own stages`
    );
    requireEvidence(
      skills
        .slice(1)
        .every(
          (skill, index) =>
            Date.parse(skills[index].record.ended_at) <= Date.parse(skill.record.started_at)
        ),
      "The dependent skill started before its prerequisite completed"
    );
  }
  const code = source.repositories?.natlang;
  const sourceRevisions = Object.values(source.repositories ?? {}).map(
    (revision) => revision.git_commit
  );
  requireEvidence(
    source.run_id &&
      source.instance &&
      source.teacher &&
      sourceRevisions.length >= 3 &&
      Object.values(source.repositories).every(
        (revision) => revision.dirty === false && /^[a-f0-9]{40}$/u.test(revision.git_commit)
      ) &&
      code?.git_commit,
    "Provide the recorded run, instance, and clean pinned source revisions"
  );
  requireEvidence(
    captured.every(
      (call) =>
        call.summary?.run_id === exercise.evalRunId &&
        call.summary?.owner_kind === root.summary.owner_kind &&
        call.summary?.owner_key === root.summary.owner_key &&
        generationTurns(call).every(
          (turn) => turn.reply.raw_response?.vibestudio?.model === source.teacher
        )
    ),
    "An exported model execution belongs to a different EvalDO owner, run, or teacher"
  );
  requireEvidence(
    ["train", "validation", "test"].includes(split),
    "Choose the predeclared split for this source world"
  );

  const taskId = `${workflow.namespace}:${test.name}`;
  const validatorBytes = await readFile(validator);
  requireEvidence(
    source.validator_sha256 === hash(validatorBytes),
    "Validator source differs from the run pin"
  );
  const observed = workflow.evidence(execution, exercise, test.name, workflow);
  const world = { instance: source.instance, run_id: source.run_id, ...observed.world };
  if (workflow.requiresReview) {
    requireEvidence(
      typeof review === "function",
      "An independent content reviewer must be configured"
    );
    const semanticReview = await review(observed.reviewInput, source.teacher);
    requireEvidence(
      semanticReview?.schema === "natlang.live-workflow-review/1" &&
        semanticReview.model !== source.teacher &&
        JSON.stringify(semanticReview.input) === JSON.stringify(observed.reviewInput) &&
        semanticReview.exchange?.request &&
        semanticReview.exchange?.reply,
      "Independent reviewer did not bind the exact committed document readback"
    );
    await writeFile(`${out}.review.json`, `${JSON.stringify(semanticReview, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    requireEvidence(
      semanticReview.verdict?.accepted === true,
      "Independent content review did not pass"
    );
    observed.evidence.workspace.semanticReview = semanticReview;
    observed.checks.independentSemanticReview = true;
  }
  await mkdir(out, { mode: 0o700 });
  async function bind(name, data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
    await writeFile(path.join(out, name), bytes, { mode: 0o600, flag: "wx" });
    return { path: name, sha256: hash(bytes) };
  }
  const validatorFile = await bind(path.basename(workflow.validator.path), validatorBytes);
  const evidence = [];
  for (const [kind, data] of Object.entries(observed.evidence)) {
    evidence.push({ kind, ...(await bind(`${kind}.json`, { ...data, pins: source })) });
  }
  const calls = [];
  for (const [index, call] of captured.entries())
    calls.push(await bind(`call-${index}.json`, call));
  const verification = await bind("verification.json", {
    schema: "natlang.live-task-verification/1",
    task_id: taskId,
    run_id: source.run_id,
    world,
    status: "passed",
    checks: observed.checks,
    validator: validatorFile,
    root_call_ids: [rootId],
    calls: captured.map(({ callId, summary }) => ({
      call_id: callId,
      owner_kind: summary.owner_kind,
      owner_key: summary.owner_key,
      run_id: summary.run_id,
    })),
    evidence,
  });
  return bind("manifest.json", {
    schema: "natlang.live-teacher-task/1",
    id: taskId,
    family: workflow.family,
    split,
    source_namespace: workflow.namespace,
    source_ids: [taskId],
    source_groups: workflowSourceGroups(workflow),
    source_revisions: sourceRevisions,
    code,
    learner_kinds: ["natlang-executor"],
    world,
    required_effect_kinds: evidence.map(({ kind }) => kind),
    calls,
    verification,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: {
      trajectory: { type: "string" },
      pins: { type: "string" },
      validator: { type: "string" },
      out: { type: "string" },
      split: { type: "string" },
      "review-model": { type: "string" },
    },
  });
  for (const option of ["trajectory", "pins", "validator", "out", "split"]) {
    requireEvidence(values[option], `Missing --${option}`);
  }
  const manifest = await exportLiveTeacherWorkflow({
    ...values,
    review: workflowReviewer(values["review-model"]),
    loadCases: () =>
      loadLiveTeacherCases(
        requireDevelopmentTemplateCheckouts(fileURLToPath(new URL("../", import.meta.url)))
          .checkouts
      ),
  });
  console.log(path.join(values.out, manifest.path));
}
