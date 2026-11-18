#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
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
    { managedPdfWorlds },
    { managedPresentationWorlds },
    { managedAuthoringWorlds },
    { managedMemoryWorlds },
    { managedSetupWorlds },
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
    ].map(async (file) => {
      const imported = await import(pathToFileURL(path.join(directory, file)).href);
      return imported.default ?? imported;
    })
  );
  const cases = new Map(originalCases);
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
  for (const { id, pages, blocked, claims } of managedPdfWorlds) {
    const answered = claims.filter(({ evidence }) => evidence.length > 0).length;
    const expectedStatus =
      blocked ??
      (answered === 0 ? "no-match" : answered === claims.length ? "verified" : "partial-match");
    cases.set(`pdf-intake-live-${id}`, {
      ...pdfIntakeWorkflow,
      caseId: id,
      expectedStatus,
      pages,
      blocked,
    });
  }
  for (const { id, expectedBlockers } of managedPublicationWorlds) {
    cases.set(`publication-preflight-live-${id}`, {
      ...publicationPreflightWorkflow,
      caseId: id,
      expectedBlockers,
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
    cases.set(`integration-handoff-${id}`, {
      ...integrationHandoffWorkflow,
      caseId: id,
      expectedPaths: [...new Set(questions.map(({ file }) => file))],
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
      JSON.stringify(verification.requestedPages) === JSON.stringify(workflow.pages) &&
      JSON.stringify(report.readPages) === JSON.stringify(workflow.blocked ? [] : workflow.pages) &&
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
        "pairedReports",
      ].every((name) => verification.checks?.[name] === true) &&
      verification.verificationPaths?.length === workflow.expectedPaths.length &&
      workflow.expectedPaths.every((path) => verification.verificationPaths.includes(path)) &&
      typeof verification.seed?.eventId === "string" &&
      typeof verification.source?.eventId === "string" &&
      verification.before !== verification.after &&
      integrated?.status === "integrated" &&
      integrated.head === verification.after &&
      handoff?.status === "staged" &&
      artifact &&
      artifact.path === handoff.artifact?.path &&
      artifact.bytes === handoff.artifact?.bytes &&
      Number.isSafeInteger(artifact.bytes) &&
      artifact.bytes > 0 &&
      /^[0-9a-f]{64}$/u.test(artifact.sha256),
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
