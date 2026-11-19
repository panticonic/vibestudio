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
const presentationWorkflow = {
  family: "workspace-presentation",
  namespace: "vibestudio:visualize",
  group: "component-selection-and-grounding",
  validator: { template: "system-testing", path: "skills/system-testing/presentation-managed.ts" },
  root: "preparePresentation",
  evidence: presentationEvidence,
};
const authoringWorkflow = {
  family: "workspace-natlang-authoring",
  namespace: "vibestudio:natlang-authoring",
  group: "workspace-compiler-contract-review",
  validator: { template: "system-testing", path: "skills/system-testing/authoring-managed.ts" },
  root: "reviewProgram",
  evidence: authoringEvidence,
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
    { managedPdfWorlds, managedPdfExpectation },
    { managedPresentationWorlds },
    { managedAuthoringWorlds },
    { managedMemoryWorlds },
    { managedSetupWorlds },
    { managedChecklistWorlds },
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
      "authoring-worlds.ts",
      "verified-memory-worlds.ts",
      "onboarding-worlds.ts",
      "checklist-worlds.ts",
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
  for (const { id, checks, expected } of managedNewsWorlds) {
    cases.set(`news-live-${id}`, { ...newsWorkflow, caseId: id, checks, expected });
  }
  for (const {
    id,
    path: documentPath,
    checks,
    expected,
    requiredText,
    heading,
    previewText,
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
    });
  }
  for (const { id, expected } of managedGrimoireWorlds) {
    cases.set(`grimoire-live-${id}`, {
      ...grimoireWorkflow,
      caseId: id,
      expectedDecisions: expected,
    });
  }
  for (const { id, request, expected } of managedChecklistWorlds) {
    cases.set(`terminal-checklist-live-${id}`, {
      ...terminalChecklistWorkflow,
      caseId: id,
      expectedContinuation: request.continuation,
      expectedScreens: expected,
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
  for (const { id, expected } of managedMemoryWorlds) {
    cases.set(`verified-memory-live-${id}`, {
      ...verifiedMemoryWorkflow,
      caseId: id,
      expectedStatus: expected.status,
    });
  }
  for (const { id, request, expected } of managedAuthoringWorlds) {
    cases.set(`authoring-live-${id}`, {
      ...authoringWorkflow,
      caseId: id,
      comparedBaseline: request.compare,
      expectedStatus: expected.status,
    });
  }
  for (const { id, expected } of managedPresentationWorlds) {
    cases.set(`presentation-live-${id}`, {
      ...presentationWorkflow,
      caseId: id,
      renderedIds: expected.filter((view) => Object.hasOwn(view, "labels")).map(({ id }) => id),
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
  for (const { id, expectedBlockers, expectedVisual } of managedPublicationWorlds) {
    cases.set(`publication-preflight-live-${id}`, {
      ...publicationPreflightWorkflow,
      caseId: id,
      expectedBlockers,
      expectedVisual,
    });
  }
  for (const { id, status } of managedAutomationWorlds) {
    cases.set(`automation-lifecycle-live-${id}`, {
      ...automationLifecycleWorkflow,
      caseId: id,
      expectedStatus: status,
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
  return {
    world: { context_id: fixture.contextId, panel_attempt: verification.panelAttempt },
    checks: verification.checks,
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
  return {
    world: {
      context_id: fixture.contextId,
      candidate_revision: verification.candidateRevision,
      baseline_revision: verification.baselineRevision,
    },
    checks: verification.checks,
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
        return row.inheritedLaunch === (check.afterReload ? false : null);
      }),
    "Google setup findings must match the assigned panel and account observations"
  );
  return {
    world: { context_id: fixture.contextId, panel_id: verification.panelId },
    checks: verification.checks,
    evidence: { workspace: { fixture } },
  };
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
  const { vault, document, preview } = verification?.observed ?? {};
  requireEvidence(
    typeof fixture?.contextId === "string" &&
      fixture.contextId === execution.provenance?.contextId &&
      verification?.caseId === workflow.caseId &&
      verification.passed === true &&
      vault?.id === `${fixture.contextId}:vault` &&
      vault.clean === true &&
      typeof vault.repositoryId === "string" &&
      vault.repositoryId === document?.repositoryId &&
      document.id === `${fixture.contextId}:document` &&
      document.path === workflow.documentPath &&
      verification.browser?.path === document.path &&
      typeof verification.browser.text === "string" &&
      verification.browser.text.includes(workflow.heading) &&
      (workflow.previewText === null ||
        verification.browser.rendered?.some(
          (text) => typeof text === "string" && text.includes(workflow.previewText)
        ) === true) &&
      typeof document.contentHash === "string" &&
      document.ref?.id === vault.working?.id &&
      document.ref?.kind === vault.working?.kind &&
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
          document.id,
          ...(check === "preview" && preview ? [preview.id] : []),
        ];
        return (
          finding?.check === check &&
          finding.code === workflow.expected[index] &&
          (finding.code !== "preview-ready" || preview?.phase === "rendered") &&
          (finding.code !== "preview-missing" || preview === null) &&
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
  return {
    world: {
      context_id: fixture.contextId,
      document_path: document.path,
      content_hash: document.contentHash,
    },
    checks: verification.checks,
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
      same(report, verification.expected) &&
      Array.isArray(report.components) &&
      JSON.stringify(report.components.map(({ decision }) => decision)) ===
        JSON.stringify(workflow.expectedDecisions) &&
      report.components.every((item, index) =>
        same(item, verification.expected.components?.[index])
      ) &&
      [
        "persistedVisits",
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
      report?.status === workflow.expectedStatus &&
      report.missionId === verification.assignedId &&
      verification.passed === true &&
      [
        "exactStateAndReport",
        "defaultMonitorUnchanged",
        "definitionPreserved",
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
