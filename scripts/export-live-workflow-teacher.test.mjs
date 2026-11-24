import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import templateConfig from "../src/dev/developmentTemplateConfig.cjs";
import {
  effectsInGraphOrder,
  exportLiveTeacherWorkflow,
  loadLiveTeacherCases,
  openOutcomeGoalEvidence,
  workflowSourceGroups,
} from "./export-live-workflow-teacher.mjs";

test("open outcome admission accepts alternate skill paths and binds the workspace", () => {
  const goal = "Use the current handoff to update the guide.";
  const caseId = "update-guide";
  const contextId = "context";
  const checks = { storedCurrentRevision: true, protectedOtherDocuments: true };
  const boundGoal = JSON.stringify(goal);
  const root = { callId: "root", record: { inputs: { goal: {
    complete: true, bytes: Buffer.byteLength(boundGoal),
    hash: createHash("sha256").update(boundGoal).digest("hex"),
  } } } };
  const execution = { provenance: { contextId }, diagnostics: {
    openGoalVerification: { passed: true, caseId, contextId, goal, checks },
  } };
  const workflow = { assignment: { id: caseId, goal } };
  for (const name of ["readCurrentHandoff", "discoverScopedIntent"]) {
    const exercise = { rootCallIds: ["root"], calls: [root, { callId: "child", record: { definition: { name } } }] };
    assert.deepEqual(openOutcomeGoalEvidence(execution, exercise, caseId, workflow).checks, checks);
  }
  const exercise = { rootCallIds: ["root"], calls: [root] };
  assert.throws(() => openOutcomeGoalEvidence({ ...execution, provenance: { contextId: "other" } },
    exercise, caseId, workflow), /bound to the actual workspace/);
  assert.throws(() => openOutcomeGoalEvidence(execution, exercise, caseId,
    { assignment: { id: caseId, goal: "Different goal" } }), /original user goal/);
  checks.storedCurrentRevision = false;
  assert.throws(() => openOutcomeGoalEvidence(execution, exercise, caseId, workflow), /independently verified outcomes/);
});

test("orders native effects across calls by their recorded execution order", () => {
  const first = { service: "programRunCatalog", graph_order: 0 };
  const later = { service: "programExecution", graph_order: 2 };
  const middle = { service: "programExecution", graph_order: 1 };
  const records = [{ effects: [middle] }, { effects: [first, later] }];
  assert.deepEqual(effectsInGraphOrder(records), [first, middle, later]);
  assert.deepEqual(records[1].effects, [first, later]);

  const legacy = { service: "programReceiptSigner" };
  assert.deepEqual(effectsInGraphOrder([{ effects: [legacy] }, ...records]),
    [legacy, middle, first, later]);
});

test("authored template worlds flow into the collector without losing original split lineage", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "live-teacher-inventory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const casesDir = path.join(dir, "skills/system-testing");
  await mkdir(path.join(casesDir, "local-messaging"), { recursive: true });
  await Promise.all(
    [
      [
        "content-project-worlds",
        "contentProjectWorlds",
        [
          { id: "release-runbook", sourceGroup: "content-project/release-operations-v1" },
          { id: "handoff", sourceGroup: "content-project/release-operations-v1" },
          { id: "inventory", sourceGroup: "content-project/inventory-v1" },
        ],
      ],
      [
        "owned-operations-worlds",
        "ownedOperationsWorlds",
        [{ id: "release-blocked", sourceGroup: "vibestudio:owned-operations:release:blocked" }],
      ],
      ["unit-repair-worlds", "workerRepairWorlds", [{ id: "pagination" }]],
      [
        "vcs-integration-worlds",
        "workspaceIntegrationWorlds",
        [
          {
            id: "rollout",
            sourceGroup: "rollout",
            files: [{ path: "limits.json" }, { path: "preview.json" }],
          },
        ],
      ],
      [
        "scratch-handoff-worlds",
        "managedScratchWorlds",
        [{ id: "review", group: "review", status: "staged" }],
      ],
      [
        "integration-handoff-worlds",
        "integrationHandoffWorlds",
        [
          { id: "rollout", integration: "rollout", questions: [{ text: "Which cap applies?" }] },
          {
            id: "rollout-unconfirmed",
            integration: "rollout",
            questions: [{ text: "Who signed the rollout?", unanswered: true }],
          },
        ],
      ],
      [
        "automation-lifecycle-worlds",
        "managedAutomationWorlds",
        [{ id: "stale", status: "held", problem: "revision-race" }],
      ],
      [
        "publication-preflight-worlds",
        "managedPublicationWorlds",
        [
          {
            id: "caption",
            expectedBlockers: ["missing-presentation"],
            expectedVisual: "Checklist",
          },
          {
            id: "submitted-journal",
            expectedBlockers: ["awaiting-provider"],
            expectedNext: "watch-provider",
            journalPhase: "submitted",
          },
        ],
      ],
      [
        "pdf-intake-worlds",
        "managedPdfWorlds",
        [
          {
            id: "page-missing",
            pages: [1, 5],
            blocked: "missing-pages",
            claims: [{ evidence: [] }],
          },
          {
            id: "later-batch-rejected",
            pages: [2, 3, 1, 4],
            fault: { batch: 2, kind: "receipt-mismatch" },
            claims: [{ evidence: [] }],
          },
        ],
      ],
      ["phone-setup-world", "phoneSetupUnavailable", null],
      ["client-admission-worlds", "managedClientAdmissionWorlds", []],
      ["log-cursor-worlds", "managedLogCursorWorlds", []],
      ["log-handoff-worlds", "managedLogHandoffWorlds", []],
      ["build-performance-worlds", "buildPerformanceWorlds", []],
      ["tour-rehearsal-worlds", "tourRehearsalWorlds", []],
      ["explorer-probe-worlds", "explorerTextWorlds", []],
      ["gmail-compose-history-worlds", "gmailComposeHistoryWorlds", []],
      ["unit-identity-worlds", "unitIdentityWorlds", []],
      ["transcript-cursor-worlds", "transcriptCursorWorlds", []],
      ["remote-route-worlds", "remoteRouteWorlds", []],
      ["remote-commission-worlds", "liveRemoteCommissionWorld", null],
      ["remote-deployment-worlds", "managedDeploymentWorlds", []],
      ["notification-worlds", "notificationWorlds", []],
      ["retained-triage-worlds", "retainedTriageWorlds", []],
      ["github-setup-worlds", "githubSetupWorlds", []],
      ["github-diagnosis-worlds", "managedGitHubDiagnosisWorlds", []],
      ["adventure-review-worlds", "managedAdventureWorlds", []],
      ["adventure-transition-world", "programmedAdventureWorld", null],
      ["drive-checkpoint-worlds", "managedDriveCheckpointWorlds", []],
      ["drive-sharing-worlds", "managedDriveSharingWorlds", []],
      ["regency-review-worlds", "managedRegencyWorlds", []],
      ["examples-portfolio-worlds", "managedExamplesPortfolioWorlds", []],
      ["personal-resume-worlds", "personalResumeWorlds", []],
      ["template-release-worlds", "templateReleaseWorlds", []],
      ["template-candidate-worlds", "templateCandidateManagedWorlds", []],
      ["delivery-history-worlds", "deliveryHistoryWorlds", []],
      ["android-audit-worlds", "androidAuditWorlds", []],
      ["android-install-worlds", "androidInstallWorlds", []],
      ["android-pair-worlds", "androidPairWorlds", []],
      ["pdf-media-worlds", "pdfMediaWorlds", []],
      ["publication-revision-worlds", "publicationRevisionWorlds", []],
      ["eval-recovery-worlds", "managedEvalRecoveryWorlds", []],
      ["pdf-layout-worlds", "managedPdfLayoutWorlds", []],
      ["offline-dictation-worlds", "managedDictationWorlds", []],
      ["native-suite-worlds", "managedNativeSuiteWorlds", []],
      ["git-bridge-review-worlds", "managedGitBridgeReviewWorlds", []],
      ["vcs-delivery-worlds", "managedVcsDeliveryWorlds", []],
      ["web-brief-worlds", "managedWebBriefWorlds", []],
      ["architecture-boundary-worlds", "managedArchitectureBoundaryWorlds", []],
      ["release-review-handoff-worlds", "managedReleaseReviewHandoffWorlds", []],
      ["extension-release-worlds", "managedExtensionReleaseWorlds", []],
      ["unit-design-worlds", "managedUnitDesignWorlds", []],
      ["authority-review-worlds", "managedAuthorityReviewWorlds", []],
      ["problem-draft-worlds", "managedProblemDraftWorlds", []],
      ["agentic-change-worlds", "managedAgenticChangeWorlds", []],
      ["gad-review-worlds", "managedGadReviewWorlds", []],
      ["terminal-check-worlds", "managedTerminalCheckWorlds", []],
      ["terminal-evidence-worlds", "managedTerminalEvidenceWorlds", []],
      ["integration-readiness-worlds", "managedIntegrationReadinessWorlds", []],
      ["local-messaging/worlds", "localMessagingWorlds", [{ id: "audience-hold" }]],
      [
        "provenance-history-worlds",
        "managedProvenanceHistoryWorlds",
        [{ id: "sample", checks: [] }],
      ],
      ["runtime-program-worlds", "managedRuntimeProgramWorlds", [{ id: "sample", files: {} }]],
      ["incident-continuation-worlds", "incidentContinuationWorlds", []],
      ["log-audit-worlds", "managedLogAuditWorlds", [{ id: "sample", windows: [], lines: [] }]],
      [
        "local-model-comparison-worlds",
        "localModelComparisonWorlds",
        [{ id: "sample", request: {} }],
      ],
      [
        "google-setup-worlds",
        "managedGoogleSetupWorlds",
        [{ id: "sample", checks: [], codes: [] }],
      ],
      ["tendril-worlds", "managedTendrilWorlds", []],
      ["collection-worlds", "managedCollectionWorlds", []],
      ["browser-import-worlds", "managedBrowserImportWorlds", []],
      ["browser-library-worlds", "managedBrowserLibraryWorlds", []],
      ["browser-handoff-worlds", "managedBrowserHandoffWorlds", []],
      ["mission-planning-worlds", "managedMissionPlanningWorlds", []],
      ["mission-facility-worlds", "missionFacilityWorlds", []],
      ["channel-roster-worlds", "managedChannelRosterWorlds", []],
      ["panel-health-worlds", "managedPanelHealthWorlds", []],
      [
        "news-worlds",
        "managedNewsWorlds",
        [
          {
            id: "sample",
            checks: [{ kind: "reader", view: "saved" }],
            expected: [{ status: "ready", code: "empty-loaded-view" }],
          },
        ],
      ],
      [
        "spectrolite-worlds",
        "managedSpectroliteWorlds",
        [
          {
            id: "sample",
            path: "Review.mdx",
            checks: ["document"],
            expected: ["document-ready"],
            requiredText: ["Review.mdx"],
          },
        ],
      ],
      [
        "grimoire-worlds",
        "managedGrimoireWorlds",
        [{ id: "quiet-garden", actions: [], expected: ["supported", "supported"] }],
      ],
      [
        "checklist-worlds",
        "managedChecklistWorlds",
        [
          { id: "restart", request: { continuation: "restart" }, expected: [[], ["1"], ["1"]] },
          {
            id: "keep-on-restart",
            request: { continuation: "restart", target: { checked: ["1"], unchecked: [] } },
            expected: [["1"], ["1"]],
            keys: [],
          },
        ],
      ],
      [
        "onboarding-worlds",
        "managedSetupWorlds",
        [{ id: "retired", expected: { status: "invalid-selection", route: null } }],
      ],
      [
        "verified-memory-worlds",
        "managedMemoryWorlds",
        [
          { id: "retired", expected: { status: "missing-source" } },
          {
            id: "compare-retired",
            expected: { status: "missing-source" },
            comparison: { status: "unverified", expected: { status: "verified" } },
          },
        ],
      ],
      ["session-replay-worlds", "managedSessionReplayWorlds", []],
      ["testkit-cleanup-worlds", "managedTestkitCleanupWorlds", []],
      [
        "authoring-worlds",
        "managedAuthoringWorlds",
        [
          {
            id: "old-reference",
            request: { compare: true },
            expected: { status: "baseline-rejected" },
          },
        ],
      ],
      [
        "presentation-worlds",
        "managedPresentationWorlds",
        [
          {
            id: "repair",
            expected: [
              { id: "jobs", labels: ["Mon"] },
              { id: "hold", status: "needs-review" },
            ],
          },
        ],
      ],
      [
        "panel-repair-world",
        "panelRepairWorlds",
        [
          {
            id: "panel-draft-discard-clears",
            sourceGroup: "discard-draft-reset",
            failedChecks: ["discardRestoresSaved", "discardedDraftStaysDiscarded"],
          },
        ],
      ],
    ].map(([file, name, worlds]) =>
      writeFile(
        path.join(casesDir, `${file}.ts`),
        `export const ${name} = ${JSON.stringify(worlds)};
         ${name === "managedWebBriefWorlds" ? "export const managedResearchIntakeWorlds = []; export const managedResearchHandoffWorlds = []; export const researchHandoffWork = [];" : ""}
         ${name === "managedAutomationWorlds" ? "export const managedAutomationPlanningWorlds = [];" : ""}
         ${name === "deliveryHistoryWorlds" ? "export const chatDeliveryWorlds = [];" : ""}
         ${name === "ownedOperationsWorlds" ? 'export const ownedOperationsComposedWorlds = [{ id: "release-readiness-dossier", sourceGroup: "vibestudio:owned-operations:release:pending" }, { id: "release-blocked-dossier", sourceGroup: "vibestudio:owned-operations:release:blocked", heldReason: "Release dossier held." }];' : ""}
         ${
           name === "managedPdfWorlds"
             ? `export const managedPdfExpectation = ({ id }) => ({
           "page-missing": { expectedStatus: "missing-pages", readPages: [], remaining: [1, 5], attemptedBatches: [] },
           "later-batch-rejected": { expectedStatus: "incomplete", readPages: [2, 3], remaining: [1, 4], attemptedBatches: [[2, 3], [1, 4]] },
         })[id]; export const managedPdfHandoffWorlds = [{ pdf: "later-batch-rejected" }];`
             : ""
         }`
      )
    )
  );
  const cases = await loadLiveTeacherCases({ "system-testing": dir });
  const groups = (id) => workflowSourceGroups(cases.get(id));
  assert.deepEqual(groups("content-project-release-runbook"), [
    "vibestudio:content-project:grounded-project-delivery",
  ]);
  assert.deepEqual(groups("content-project-handoff"), [
    "vibestudio:content-project:release-operations-v1",
    "vibestudio:content-project:grounded-project-delivery",
  ]);
  assert.deepEqual(groups("content-project-inventory"), [
    "vibestudio:content-project:inventory-v1",
  ]);
  assert.equal(cases.get("content-project-inventory").requiresReview, true);
  const automation = cases.get("automation-lifecycle-live-stale");
  assert.equal(automation.root, "reconcileAutomation");
  assert.equal(automation.expectedStatus, "held");
  const currentRevision = "b".repeat(64);
  const oldRevision = "a".repeat(64);
  const automationVerification = {
    passed: true,
    caseId: automation.caseId,
    expectedStatus: "held",
    problem: "revision-race",
    assignedId: "assigned-mission",
    expectedRevision: oldRevision,
    observedRevision: currentRevision,
    reportedRevision: currentRevision,
    afterState: "active",
    reportedState: "active",
    checks: Object.fromEntries(
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
      ].map((name) => [name, true])
    ),
  };
  const automationExecution = {
    provenance: { contextId: "owned" },
    diagnostics: {
      managedAutomation: { contextId: "owned", verification: automationVerification },
    },
  };
  const automationReport = {
    missionId: "assigned-mission",
    status: "held",
    revisionDigest: currentRevision,
    state: "active",
  };
  assert.ok(automation.evidence(automationExecution, { report: automationReport }, "", automation));
  assert.throws(
    () =>
      automation.evidence(
        automationExecution,
        { report: { ...automationReport, revisionDigest: oldRevision } },
        "",
        automation
      ),
    /independently verified scheduling/
  );
  const cleanPdf = cases.get("pdf-intake-live-page-missing");
  assert.equal(cleanPdf.root, "extractPdfEvidence");
  assert.equal(cleanPdf.expectedStatus, "missing-pages");
  assert.deepEqual(cleanPdf.pages, [1, 5]);
  const interruptedPdf = cases.get("pdf-intake-live-later-batch-rejected");
  const receipt = {
    caseId: interruptedPdf.caseId,
    requestedPages: interruptedPdf.pages,
    readPages: interruptedPdf.readPages,
    remaining: interruptedPdf.remaining,
    attemptedBatches: interruptedPdf.attemptedBatches,
    expectedStatus: interruptedPdf.expectedStatus,
    fault: interruptedPdf.fault,
    passed: true,
    checks: Object.fromEntries(
      [
        "sourceUnchanged",
        "workspaceHeadUnchanged",
        "localExtraction",
        "exactCitations",
        "disposition",
      ].map((key) => [key, true])
    ),
    seedRevision: "before",
    digest: "a".repeat(64),
  };
  const pdfExecution = {
    provenance: { contextId: "owned" },
    diagnostics: { managedPdf: { contextId: "owned", verification: receipt } },
  };
  const pdfReport = {
    status: "incomplete",
    digest: receipt.digest,
    readPages: [2, 3],
    remaining: [1, 4],
  };
  assert.equal(
    interruptedPdf.evidence(pdfExecution, { report: pdfReport }, "", interruptedPdf).checks
      .localExtraction,
    true
  );
  assert.throws(
    () =>
      interruptedPdf.evidence(
        pdfExecution,
        { report: { ...pdfReport, readPages: [2, 3, 1] } },
        "",
        interruptedPdf
      ),
    /exact page scope/
  );
  receipt.attemptedBatches = [
    [2, 3],
    [1, 4],
    [1, 4],
  ];
  assert.throws(
    () => interruptedPdf.evidence(pdfExecution, { report: pdfReport }, "", interruptedPdf),
    /exact page scope/
  );
  const pdfHandoff = cases.get("pdf-handoff-live-later-batch-rejected");
  assert.deepEqual(pdfHandoff.skills, ["extractPdfEvidence", "assembleHandoff"]);
  assert.equal(pdfHandoff.expectedHandoff, "unanswered");
  const bridge = {
    contextId: "owned",
    verification: {
      passed: true,
      checks: { exactPdf: true, exactHandoff: true, verifiedTransfer: true },
      pdf: {
        ...receipt,
        attemptedBatches: [
          [2, 3],
          [1, 4],
        ],
      },
      scratch: { passed: true, artifact: null, expectedStatus: "unanswered" },
      sourceDigests: [2, 3].map((page) => ({ id: `page-${page}`, sha256: "a".repeat(64) })),
    },
  };
  const pdfHandoffExecution = {
    provenance: { contextId: "owned" },
    diagnostics: { managedPdfHandoff: bridge },
  };
  const pdfHandoffExercise = {
    report: {
      results: [{ report: pdfReport }, { report: { status: "unanswered", artifact: null } }],
    },
  };
  assert.ok(pdfHandoff.evidence(pdfHandoffExecution, pdfHandoffExercise, "", pdfHandoff));
  bridge.verification.sourceDigests[0].id = "page-1";
  assert.throws(
    () => pdfHandoff.evidence(pdfHandoffExecution, pdfHandoffExercise, "", pdfHandoff),
    /verified PDF prefix/
  );
  const review = cases.get("authoring-live-old-reference");
  assert.equal(review.root, "reviewProgram");
  assert.equal(review.comparedBaseline, true);
  assert.equal(review.expectedStatus, "baseline-rejected");
  const memory = cases.get("verified-memory-live-retired");
  assert.equal(memory.root, "recallDecision");
  assert.equal(memory.workspace, "personal");
  assert.equal(memory.expectedStatus, "missing-source");
  const comparison = cases.get("verified-memory-live-compare-retired");
  assert.equal(comparison.root, "compareDecisionRevisions");
  const before = {
    status: "verified",
    leadId: "earlier",
    citation: {
      eventId: "earlier",
      path: "decision.md",
      contentHash: "digest",
      line: 1,
      quote: "Value: A",
    },
  };
  const after = { status: "missing-source", leadId: "later", citation: null };
  const comparisonExecution = {
    provenance: { contextId: "owned" },
    diagnostics: {
      managedMemory: {
        contextId: "owned",
        verification: {
          caseId: comparison.caseId,
          status: "unverified",
          eventId: "later",
          passed: true,
          endpoints: { beforeEventId: "earlier", afterEventId: "later", before, after },
          checks: {
            protectedMainUnchanged: true,
            actualRecall: true,
            observedWorld: true,
            joinedSource: true,
          },
        },
      },
    },
  };
  const completed = (callId, parent, name) => ({
    callId,
    record: { parent_call_id: parent, definition: { name }, outcome: "done" },
  });
  const comparisonExercise = {
    rootCallIds: ["root"],
    calls: [
      completed("compare", "root", "compareDecisionRevisions"),
      completed("before", "compare", "recallDecision"),
      completed("after", "compare", "recallDecision"),
      completed("judge", "compare", "classifyComparison"),
    ],
    report: { status: "unverified", before, after },
  };
  assert.ok(comparison.evidence(comparisonExecution, comparisonExercise, "", comparison));
  assert.throws(
    () =>
      comparison.evidence(
        comparisonExecution,
        {
          ...comparisonExercise,
          report: { status: "unverified", before: after, after: before },
        },
        "",
        comparison
      ),
    /both nested recalls/
  );
  comparisonExercise.calls.splice(2, 1);
  assert.throws(
    () => comparison.evidence(comparisonExecution, comparisonExercise, "", comparison),
    /both nested recalls/
  );
  assert.equal(cases.get("news-live-sample").workspace, "news");
  assert.equal(cases.get("google-setup-live-sample").workspace, "google-workspace");
  assert.equal(cases.get("local-model-compare-live-sample").root, "prepareLocalModel");
  assert.equal(cases.get("host-log-audit-live-sample").root, "investigateSystem");
  assert.equal(cases.get("runtime-program-live-sample").root, "reviewRuntimeEvidence");
  assert.equal(cases.get("provenance-history-live-sample").root, "reviewProvenance");
  assert.equal(cases.get("spectrolite-live-sample").workspace, "spectrolite");
  const garden = cases.get("grimoire-live-quiet-garden");
  assert.equal(garden.workspace, "examples");
  const gardenComponent = {
    decision: "supported",
    finding: "chosen-home",
    evidenceIds: ["owned:current"],
  };
  const gardenReport = { ...gardenComponent, components: [gardenComponent, gardenComponent] };
  const gardenVerification = {
    passed: true,
    garden: "owned",
    actions: [],
    observed: { before: { id: "owned:before" }, current: { id: "owned:current" } },
    expected: gardenReport,
    checks: Object.fromEntries(
      [
        "persistedVisits",
        "persistedClock",
        "assignedClaims",
        "readOwnedGarden",
        "matchedJudgment",
        "matchedClaims",
      ].map((key) => [key, true])
    ),
  };
  const gardenExecution = {
    provenance: { contextId: "owned" },
    diagnostics: { managedGrimoire: { contextId: "owned", verification: gardenVerification } },
  };
  assert.ok(garden.evidence(gardenExecution, { report: gardenReport }, "", garden));
  gardenVerification.actions = ["linger"];
  assert.throws(
    () => garden.evidence(gardenExecution, { report: gardenReport }, "", garden),
    /persisted resident visits/
  );
  const checklist = cases.get("terminal-checklist-live-restart");
  assert.equal(checklist.root, "verifyChecklist");
  assert.equal(checklist.expectedContinuation, "restart");
  assert.deepEqual(checklist.expectedScreens, [[], ["1"], ["1"]]);
  const retainedChecklist = cases.get("terminal-checklist-live-keep-on-restart");
  assert.deepEqual(retainedChecklist.expectedKeys, []);
  const checklistScreens = [
    { sessionId: "owned-session", ptyId: "before", cols: 80, rows: 24, checked: ["1"] },
    { sessionId: "owned-session", ptyId: "after", cols: 62, rows: 18, checked: ["1"] },
  ];
  const checklistVerification = {
    caseId: retainedChecklist.caseId,
    passed: true,
    continuation: "restart",
    sessionId: "owned-session",
    screens: checklistScreens,
    sent: [],
    checks: Object.fromEntries(
      [
        "exactScreenSequence",
        "sessionPreserved",
        "terminalIdentity",
        "viewport",
        "joinedReport",
        "retired",
        "assignedKeys",
        "finalTarget",
      ].map((key) => [key, true])
    ),
  };
  const checklistExecution = {
    provenance: { contextId: "owned" },
    diagnostics: { managedChecklist: { contextId: "owned", verification: checklistVerification } },
  };
  const checklistExercise = {
    report: { status: "verified", continuation: "restart", screens: checklistScreens },
  };
  assert.ok(
    retainedChecklist.evidence(checklistExecution, checklistExercise, "", retainedChecklist)
  );
  checklistVerification.sent = ["1", "1"];
  assert.throws(
    () => retainedChecklist.evidence(checklistExecution, checklistExercise, "", retainedChecklist),
    /live PTY sequence/
  );
  const setup = cases.get("onboarding-live-retired");
  assert.equal(setup.root, "planSetup");
  assert.equal(setup.workspace, "personal");
  assert.equal(setup.expectedStatus, "invalid-selection");
  const presentation = cases.get("presentation-live-repair");
  assert.equal(presentation.root, "preparePresentation");
  assert.deepEqual(presentation.renderedIds, ["jobs"]);
  assert.deepEqual(groups("presentation-live-repair"), [
    "vibestudio:visualize:component-selection-and-grounding",
  ]);
  const preflight = cases.get("publication-preflight-live-caption");
  assert.equal(preflight.root, "preflightPublication");
  assert.deepEqual(preflight.expectedBlockers, ["missing-presentation"]);
  assert.equal(preflight.expectedVisual, "Checklist");
  const publicationVerification = {
    caseId: preflight.caseId,
    passed: true,
    checks: {
      protectedHeadUnchanged: true,
      exactPanelCapture: true,
      localArtifactRepeatable: true,
      singleReadback: true,
      verifiedDisposition: true,
    },
    seedRevision: "before",
    panelAttempt: "panel-attempt",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    publicPaths: ["index.html", "vibestudio-build.json"],
    visual: "Checklist",
  };
  const publicationExecution = {
    provenance: { contextId: "owned" },
    diagnostics: {
      managedPublication: { contextId: "owned", verification: publicationVerification },
    },
  };
  const publicationReport = {
    status: "blocked",
    blockers: ["missing-presentation"],
    visual: "Checklist",
  };
  assert.ok(preflight.evidence(publicationExecution, { report: publicationReport }, "", preflight));
  assert.throws(
    () =>
      preflight.evidence(
        publicationExecution,
        { report: { ...publicationReport, visual: "Timeline" } },
        "",
        preflight
      ),
    /exact local artifact/
  );
  const submitted = cases.get("publication-preflight-live-submitted-journal");
  const submittedExecution = structuredClone(publicationExecution);
  Object.assign(submittedExecution.diagnostics.managedPublication.verification, {
    caseId: submitted.caseId, next: "watch-provider", journalPhase: "submitted",
  });
  submittedExecution.diagnostics.managedPublication.verification.checks.exactJournalReadback = true;
  const submittedExercise = {
    rootCallIds: ["runWorkflow"],
    calls: [
      "runWorkflow", "preflightPublication", "reviewPublication", "readProgress", "readSubmittedDeployment",
    ].map((name, index, stages) => ({ record: {
      call_id: name, parent_call_id: stages[index - 1] ?? null, definition: { name },
      outcome: "done", model_turns: [{ kind: "generation", reply: {} }],
    } })),
    report: { status: "waiting", next: "watch-provider", blockers: ["awaiting-provider"] },
  };
  assert.ok(submitted.evidence(submittedExecution, submittedExercise, "", submitted));
  submittedExercise.calls.pop();
  assert.throws(
    () => submitted.evidence(submittedExecution, submittedExercise, "", submitted),
    /submitted-readback stage/
  );
  const scratch = cases.get("scratch-handoff-live-review");
  assert.equal(scratch.root, "assembleHandoff");
  assert.equal(scratch.expectedStatus, "staged");
  const joined = cases.get("integration-handoff-rollout");
  assert.deepEqual(joined.skills, ["integrateWorkspace", "assembleHandoff"]);
  assert.deepEqual(joined.expectedPaths, ["limits.json", "preview.json"]);
  const heldHandoff = cases.get("integration-handoff-rollout-unconfirmed");
  assert.equal(heldHandoff.expectedStatus, "unanswered");
  assert.deepEqual(heldHandoff.unanswered, ["Who signed the rollout?"]);
  const verification = {
    passed: true,
    checks: Object.fromEntries(
      [
        "persistedIntegration",
        "beforeChanged",
        "handoffUsedIntegratedHead",
        "exactClaims",
        "allSourcesRead",
        "pairedReports",
      ].map((key) => [key, true])
    ),
    verificationPaths: heldHandoff.expectedPaths,
    seed: { eventId: "seed" },
    source: { eventId: "source" },
    before: "before",
    after: "after",
    expectedStatus: "unanswered",
    unanswered: heldHandoff.unanswered,
    artifact: null,
  };
  const execution = {
    provenance: { contextId: "owned" },
    diagnostics: {
      integrationHandoff: { contextId: "owned", caseId: heldHandoff.caseId, verification },
    },
  };
  const handoff = {
    status: "unanswered",
    unanswered: heldHandoff.unanswered,
    missingSources: [],
    artifact: null,
  };
  const exercise = {
    report: { results: [{ report: { status: "integrated", head: "after" } }, { report: handoff }] },
  };
  assert.equal(heldHandoff.evidence(execution, exercise, "", heldHandoff).checks.exactClaims, true);
  handoff.artifact = { path: "/.tmp/handoff", bytes: 8 };
  assert.throws(
    () => heldHandoff.evidence(execution, exercise, "", heldHandoff),
    /independently verified/
  );
  handoff.artifact = null;
  handoff.unanswered = [];
  assert.throws(
    () => heldHandoff.evidence(execution, exercise, "", heldHandoff),
    /independently verified/
  );
  assert.ok(
    groups("integration-handoff-rollout").includes(
      "vibestudio:workspace-integration:settings-conflict"
    )
  );
  const discard = cases.get("panel-draft-discard-clears");
  assert.equal(discard.root, "repairPanel");
  const rollout = cases.get("workspace-integration-rollout");
  assert.deepEqual(rollout.expectedPaths, ["limits.json", "preview.json"]);
  assert.deepEqual(groups("workspace-integration-rollout"), [
    "vibestudio:workspace-integration:rollout",
    "vibestudio:workspace-integration:settings-conflict",
  ]);
  assert.deepEqual(discard.failedChecks, ["discardRestoresSaved", "discardedDraftStaysDiscarded"]);
  assert.deepEqual(groups("panel-draft-discard-clears"), [
    "vibestudio:panel-repair:discard-draft-reset",
    "vibestudio:panel-repair:draft-navigation",
  ]);
  assert.deepEqual(groups("owned-operations-release-blocked"), [
    "vibestudio:owned-operations:release:blocked",
  ]);
  assert.deepEqual(groups("worker-repair-pagination"), ["vibestudio:unit-repair:pagination"]);
  assert.deepEqual(groups("messaging-audience-hold"), [
    "vibestudio:local-messaging:scoped-addressed-delivery",
  ]);
  const composed = cases.get("owned-operations-release-readiness-dossier");
  assert.deepEqual(composed.skills, ["operate", "deliverProject"]);
  assert.equal(composed.requiresReview, true);
  assert.deepEqual(workflowSourceGroups(composed), [
    "vibestudio:owned-operations:release:pending",
    "vibestudio:owned-operations:durable-worker-handoff",
    "vibestudio:content-project:grounded-project-delivery",
  ]);
  const holdId = "owned-operations-release-blocked-dossier";
  const hold = cases.get(holdId);
  assert.deepEqual(hold.skills, ["operate"]);
  assert.deepEqual(hold.assignedSkills, composed.skills);
  assert.equal(hold.requiresReview, false);
  const contextId = "owned-context";
  const repoPath = "projects/owned-dossier";
  const fixture = { contextId, caseId: "release-blocked-dossier" };
  const operationsChecks = Object.fromEntries([
    "reportedHandles", "reportedCleanup", "programRequestedCleanup",
    "actualNoOwnedWorkersRemain", "actualNoOwnedContextsRemain",
  ].map((key) => [key, true]));
  const heldExecution = {
    provenance: { contextId },
    diagnostics: {
      composedWorkflowWorld: { ...fixture, kind: "owned-operations-content", repoPath, before: "seed" },
      composedWorkflowVerification: { passed: true, checks: { operations: true, content: true, dependency: true, cleanup: true } },
      dependencyAudit: { passed: true, events: [{ kind: "operationOutcomeRead" }, { kind: "operationCleanup" }] },
      contentProjectWorld: { contextId, kind: "content-project", repoPath, before: "seed", after: "seed", repositoryId: null, clean: true },
      contentProjectVerification: { passed: true },
      ownedOperationsWorld: { ...fixture, kind: "owned-operations", request: { kind: "release-continuation" } },
      ownedOperationsVerification: { passed: true, checks: operationsChecks },
      ownedOperationsAudit: { opened: [{}], snapshots: [{}], remainingEntityIds: [], remainingContextIds: [] },
      ownedOperationsCleanupErrors: [],
    },
  };
  const heldExercise = { report: {
    results: [{ kind: "operate", report: { kind: "release-continuation", handoff: { decision: "blocked" } } }],
    remaining: [hold.heldReason],
  } };
  assert.equal(hold.evidence(heldExecution, heldExercise, holdId, hold).checks.dossierHeld, true);
  heldExecution.diagnostics.contentProjectWorld.after = "changed";
  assert.throws(() => hold.evidence(heldExecution, heldExercise, holdId, hold), /workspace unchanged/);
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "live-panel-export-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const options = {
    trajectory: path.join(dir, "trajectory.json"),
    pins: path.join(dir, "pins.json"),
    validator: path.join(dir, "oracle.ts"),
    out: path.join(dir, "closed"),
    split: "train",
  };
  const code = { git_commit: "a".repeat(40), dirty: false };
  const teacher = "openai-codex:gpt-6-luna";
  const oracle = "actual validator source";
  await writeFile(options.validator, oracle);
  await writeFile(
    options.pins,
    JSON.stringify({
      run_id: "outer",
      instance: "managed",
      teacher,
      repositories: { natlang: code, vibestudio: code, base: code },
      validator_sha256: createHash("sha256").update(oracle).digest("hex"),
    })
  );
  const call = (id, name, parent) => ({
    callId: id,
    summary: { owner_kind: "do", owner_key: "fixture", run_id: "eval", call_id: id },
    record: {
      executor: { kind: "agent" },
      definition: { name },
      parent_call_id: parent,
      model_turns: [
        { kind: "generation", reply: { raw_response: { vibestudio: { model: teacher } } } },
      ],
    },
  });
  const before = { kind: "anchor", value: "old" },
    after = { kind: "anchor", value: "new" };
  const diagnostics = {
    workspaceRepoFixture: {
      kind: "draft-repair-panel",
      contextId: "ctx",
      taskBaseEventId: "seed",
      repoPath: "panels/demo",
    },
    panelRepairWorkspace: { before, after },
    panelDraftBaseline: { checks: { preservesUnsavedDraft: false } },
    panelDraftVerification: { passed: true, checks: { preservesUnsavedDraft: true } },
    natlangTeacher: {
      trainingEligible: true,
      report: { status: "verified", revision: JSON.stringify(after) },
      programPath: "skills/workspace-dev/panel-repair/repairPanel.nl",
      rootCallIds: ["root"],
      evalRunId: "eval",
      calls: [call("root", "repairPanel", null), call("child", "reproduce", "root")],
    },
  };
  const entry = {
    test: { name: "panel-draft-unmount" },
    result: { passed: true },
    execution: { provenance: { contextId: "ctx" }, diagnostics },
  };
  const save = () => writeFile(options.trajectory, JSON.stringify(entry));
  await save();
  return { options, diagnostics, entry, save };
}

test("goal evidence admits and preserves valid decisions after an optional root exception", async t => {
  const {options,diagnostics,entry,save}=await fixture(t);
  const exercise=diagnostics.natlangTeacher;
  exercise.trainingEligible=false;
  exercise.executionError="Optional post-goal follow-up failed";
  exercise.calls[0].record.outcome="error";
  exercise.calls[0].record.error={name:"Error",message:exercise.executionError};
  exercise.calls[0].record.effects=[{service:"workspaceDocuments",method:"write",returned:"actual committed revision"}];
  exercise.calls[1].record.outcome="done";
  exercise.calls[1].record.outputs={report:"actual required readback"};
  exercise.captureErrors=["missing exchange"];
  await save();
  await assert.rejects(exportLiveTeacherWorkflow(options),/Missing eligible authored/);
  exercise.captureErrors=[];
  exercise.calls[1].summary.owner_key="other-owner";
  await save();
  await assert.rejects(exportLiveTeacherWorkflow(options),/different EvalDO owner/);
  exercise.calls[1].summary.owner_key="fixture";
  diagnostics.panelDraftVerification.passed=false;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow(options));
  diagnostics.panelDraftVerification.passed=true;
  await save();
  const original=await readFile(options.trajectory,"utf8");
  await exportLiveTeacherWorkflow(options);
  assert.equal(await readFile(options.trajectory,"utf8"),original);
  for(const [index,call] of exercise.calls.entries())
    assert.deepEqual(JSON.parse(await readFile(path.join(options.out,`call-${index}.json`),"utf8")),call);
  const verification=JSON.parse(await readFile(path.join(options.out,"verification.json"),"utf8"));
  assert.equal(verification.status,"passed");
  assert.deepEqual(verification.root_call_ids,["root"]);
  assert.equal(entry.result.passed,true);
});

test("case admission uses actual tool failures without requiring a suite summary", async t => {
  const {options,entry,save} = await fixture(t);
  for (const failure of [{name:"broken"},{name:"broken",expected:false},null]) {
    entry.execution.toolFailures=[failure];
    await save();
    await assert.rejects(exportLiveTeacherWorkflow(options),/unexpected tool failure/);
  }
  entry.execution.toolFailures={unexpected:true};
  await save();
  await assert.rejects(exportLiveTeacherWorkflow(options),/unexpected tool failure/);
  entry.execution.toolFailures=[{name:"declared intentional fault",expected:true}];
  await save();
  await exportLiveTeacherWorkflow(options);
});

test("managed panel export requires the assigned baseline failure and the paired browser readback", async (t) => {
  const { options, diagnostics, save } = await fixture(t);
  diagnostics.panelDraftBaseline.checks.navigationDoesNotSave = false;
  diagnostics.panelDraftVerification.checks.navigationDoesNotSave = true;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow(options), /reproduce the assigned failures/u);
  diagnostics.panelDraftBaseline.checks.navigationDoesNotSave = true;
  delete diagnostics.panelDraftVerification.checks.navigationDoesNotSave;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow(options), /every paired check afterward/u);
});

test("live panel export binds real test world, independent checks and exact EvalDO scope", async (t) => {
  const { options } = await fixture(t);
  await exportLiveTeacherWorkflow(options);
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  const receipt = JSON.parse(await readFile(path.join(options.out, "verification.json"), "utf8"));
  assert.deepEqual(receipt.world, manifest.world);
  assert.equal(receipt.run_id, "outer");
  assert.deepEqual(receipt.requirements, { semantic_review: false });
  assert.equal(receipt.calls[1].run_id, "eval");
  assert.deepEqual(
    receipt.evidence.map(({ kind }) => kind),
    ["workspace", "cdp"]
  );
  assert.deepEqual(receipt.root_call_ids, ["root"]);
  assert.deepEqual(manifest.source_groups, ["vibestudio:panel-repair:draft-navigation"]);
});

test("live panel export rejects a report about a different revision", async (t) => {
  const { options, diagnostics, save } = await fixture(t);
  diagnostics.natlangTeacher.report.revision = "stale";
  await save();
  await assert.rejects(() => exportLiveTeacherWorkflow(options), /repair report/);
});

test("shared program export accepts a native bridge without mandatory model-call wrappers", async (t) => {
  const { options, diagnostics, save } = await fixture(t);
  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, reproduce] = run.calls;
  root.record.definition.name = "runWorkflow";
  root.record.model_turns = []; // An authored TS root can delegate the semantic model work.
  await save();
  await exportLiveTeacherWorkflow(options);
  const skill = structuredClone(reproduce);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "repairPanel";
  reproduce.record.parent_call_id = "skill";
  run.calls.push(skill);
  await save();
  await exportLiveTeacherWorkflow({ ...options, out: `${options.out}-with-wrapper` });
});

test("live panel export rejects a child from a different evaluation", async (t) => {
  const { options, diagnostics, save } = await fixture(t);
  diagnostics.natlangTeacher.calls[1].summary.run_id = "other";
  await save();
  await assert.rejects(() => exportLiveTeacherWorkflow(options), /different EvalDO/);
});

function bindApplicationResult(run, proof, workflow, result) {
  const reference = value => {
    const text = JSON.stringify(value);
    return { complete: true, bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex") };
  };
  const entry = { program: workflow.entry.program, callable: workflow.entry.callable, arguments: workflow.entry.arguments,
    ...(workflow.entry.argumentJson ? { argumentJson: workflow.entry.argumentJson } : {}) };
  run.entry = entry;
  proof.entry = structuredClone(entry);
  proof.actualResult = result;
  const root = run.calls.find(({ callId }) => callId === run.rootCallIds[0]).record;
  root.definition.name = entry.callable;
  if(entry.program.endsWith('.ts')){
    root.definition={...root.definition,id:`ts:${path.basename(entry.program)}#default`,source:path.basename(entry.program),site:'named'};
    root.program_root=path.dirname(entry.program);root.executor={kind:'crisp'};root.model_turns=[];
  }
  root.inputs = Object.fromEntries(Object.entries(entry.arguments).map(([name, value]) => [name, reference(value)]));
  root.output = reference(result);
}

test("open goal export attests application inputs and rejects a hidden assignment", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "open-goal-reconcile-workshop-update";
  const workflow = cases.get(entry.test.name);
  const { id, goal } = workflow.assignment;
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: workflow.workspace }));
  const run = diagnostics.natlangTeacher;
  run.programPath = workflow.program;
  const [root, child] = run.calls;
  const encoded = JSON.stringify(goal);
  root.record.definition.name = "runUserGoal";
  root.record.inputs = {
    goal: { complete: true, bytes: Buffer.byteLength(encoded), hash: createHash("sha256").update(encoded).digest("hex") },
  };
  child.record.definition.name = "reviseWorkspaceDocument";
  child.record.effects = ["list", "read", "revise"].map((method) => ({ service: "goalWorkspace", method }));
  diagnostics.openGoalVerification = {
    passed: true, caseId: id, contextId: "ctx", goal,
    checks: {
      discoveredWorkspace: true, recoveredConcurrentEdit: true, exactDocumentReadback: true,
      preservedOtherDocuments: true, reportedStoredRevision: true,
    },
  };
  bindApplicationResult(run, diagnostics.openGoalVerification, workflow, { status: "edited", path: "guide.md", version: "new" });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases, split: "test" }), /predeclared split/u);
  await exportLiveTeacherWorkflow({ ...options, cases });
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  const verification = JSON.parse(await readFile(path.join(options.out, "verification.json"), "utf8"));
  assert.deepEqual(manifest.interaction, { kind: "open-user-goal", goal, program: workflow.program, entry: run.entry });
  assert.deepEqual(verification.interaction, manifest.interaction);
  assert.equal(verification.split, "train");
  root.record.inputs.work = {};
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: path.join(path.dirname(options.out), "rejected") }),
    /original user goal/u
  );
});

test("semantic application export accepts a direct root and alternate internal call trees", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "open-goal-api-readiness-required-inventory-optional-status";
  const workflow = cases.get(entry.test.name);
  assert.ok(workflow?.entry);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: workflow.workspace }));
  const run = diagnostics.natlangTeacher;
  run.programPath = workflow.program;
  const originalChild = structuredClone(run.calls[1]);
  const root = run.calls[0];
  const result = { plan: { action: "hold", profileId: null, explanation: "Provider access remains unobserved." }, review: null, audit: null, handoff: null };
  run.report = result;
  diagnostics.openGoalVerification = { passed: true, caseId: workflow.assignment.id, contextId: "ctx", goal: workflow.assignment.goal,
    checks: { groundedNativeState: true, authorizedScopePreserved: true } };
  bindApplicationResult(run, diagnostics.openGoalVerification, workflow, result);
  for (const names of [["resolveReadiness"], ["inspectCurrentState", "resolveReadiness", "inspectCurrentState"]]) {
    run.calls = [root, ...names.map((name, index) => {
      const call = structuredClone(originalChild);
      call.callId = call.summary.call_id = `alternative-${index}`;
      call.record.definition.name = name;
      call.record.parent_call_id = root.callId;
      return call;
    })];
    await save();
    const out = path.join(path.dirname(options.out), `application-alternative-${names.length}`);
    await exportLiveTeacherWorkflow({ ...options, cases, out });
    const verification = JSON.parse(await readFile(path.join(out, "verification.json"), "utf8"));
    assert.equal(verification.calls.length, names.length + 1);
  }
  run.calls=[root];await save();
  await assert.rejects(exportLiveTeacherWorkflow({...options,cases,out:path.join(path.dirname(options.out),'crisp-only')}),/at least one captured model generation/);
  run.calls=[root,originalChild];
  diagnostics.openGoalVerification.checks.authorizedScopePreserved = false;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /independently verified outcomes/);
});

test("open browser goal export retains CDP evidence and rejects a replaced generation", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "open-goal-find-pending-captions";
  const workflow = cases.get(entry.test.name);
  const { id, goal } = workflow.assignment;
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: workflow.workspace }));
  const run = diagnostics.natlangTeacher;
  run.programPath = workflow.program;
  const [root, child] = run.calls;
  const encoded = JSON.stringify(goal);
  root.record.definition.name = "runUserGoal";
  root.record.inputs = {
    goal: { complete: true, bytes: Buffer.byteLength(encoded), hash: createHash("sha256").update(encoded).digest("hex") },
  };
  child.record.definition.name = "workInBrowser";
  child.record.effects = [{ service: "goalBrowser", method: "inspect" }];
  const snapshot = {
    attemptId: "rendered", buildKey: "build", binding: {
      status: "acquired", generation: { protocol: "panel-cdp-generation.v1", panelId: "owned-panel",
        attemptId: "rendered", buildKey: "build" },
    },
  };
  diagnostics.openGoalVerification = {
    passed: true, caseId: id, contextId: "ctx", goal, panelId: "owned-panel",
    inspections: [snapshot], attempts: [], after: structuredClone(snapshot),
    checks: { discoveredBrowser: true, readBackBrowser: true, exactPanelOutcome: true,
      respectedBrowserAuthority: true, reportedVisibleRows: true, protectedHeadUnchanged: true },
  };
  bindApplicationResult(run, diagnostics.openGoalVerification, workflow, { status: "observed", rows: [] });
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.required_effect_kinds, ["workspace", "cdp"]);
  snapshot.binding.generation.attemptId = "other-renderer";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: path.join(path.dirname(options.out), "foreign") }),
    /retained CDP bindings/u
  );
});

test("open suite goal export requires the recorded current suite receipt", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "open-goal-verify-adventure-world-state";
  const workflow = cases.get(entry.test.name);
  const { id, goal, expected } = workflow.assignment;
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: workflow.workspace }));
  const run = diagnostics.natlangTeacher;
  run.programPath = workflow.program;
  const [root, child] = run.calls;
  const encoded = JSON.stringify(goal);
  root.record.definition.name = "runUserGoal";
  root.record.inputs = {
    goal: { complete: true, bytes: Buffer.byteLength(encoded), hash: createHash("sha256").update(encoded).digest("hex") },
  };
  child.record.definition.name = "verifyWorkspaceSuite";
  child.record.effects = [
    ["goalSuite", "discover"], ["goalSuite", "prepare"], ["testSuitePlanRead", "resolve"], ["testSuiteVerificationRun", "run"],
  ].map(([service, method]) => ({ service, method }));
  const plan = { contextId: "ctx", runtime: "workerd", stateHash: "current" };
  const execution = { status: "passed", receipt: { stateHash: "current" } };
  run.report = { selection: expected.choice, review: { execution } };
  diagnostics.openGoalVerification = {
    passed: true, caseId: id, contextId: "ctx", goal, selected: expected.choice,
    plan, routes: [{ id: "adventure", stateHash: "current" }], execution: structuredClone(execution), runAttempts: 1,
    checks: { discoveredSuites: true, selectedAuthorizedSuite: true, currentSuitePlan: true,
      identifiedApproval: true, checkedSuiteReceipt: true },
  };
  bindApplicationResult(run, diagnostics.openGoalVerification, workflow, run.report);
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  diagnostics.openGoalVerification.execution.receipt.stateHash = "prior-revision";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: path.join(path.dirname(options.out), "stale") }),
    /independently observed workspace state/u
  );
});

test("open Drive goal export accepts a different callable and requires verified read-only scope", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "open-goal-audit-onboarding-pack-direct-access";
  const workflow = cases.get(entry.test.name);
  assert.equal(workflow.workspace, "google-workspace");
  const { id, goal } = workflow.assignment;
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: workflow.workspace }));
  const run = diagnostics.natlangTeacher;
  run.programPath = workflow.program;
  const [root, child] = run.calls;
  const valueRef = (value) => {
    const encoded = JSON.stringify(value);
    return { complete: true, bytes: Buffer.byteLength(encoded), hash: createHash("sha256").update(encoded).digest("hex") };
  };
  const outcome = { status: "complete", directAccess: "reviewed" };
  root.record.definition.name = "runUserGoal";
  root.record.inputs = { goal: valueRef(goal) };
  child.record.definition.name = "reviewOwnedDrivePermissions";
  child.record.outcome = "done";
  child.record.inputs = { goal: valueRef(goal) };
  child.record.output = valueRef(outcome);
  child.record.effects = [
    ["googleGoalDiscovery", "discover"], ...["readiness", "listFolder", "readPermissions"].map(method => ["googleWorkspaceRead", method]),
  ].map(([service, method]) => ({ service, method }));
  run.report = { status: "workspace-skill-reviewed", skill: "google", outcome };
  diagnostics.openGoalVerification = {
    passed: true, caseId: id, contextId: "ctx", goal, mode: "audit", gate: "audited",
    requests: [{ kind: "permissions", resource: "pack_current" }], discovery: {}, observed: {},
    checks: { discoveredDriveScope: true, exactProviderReads: true, boundDriveOutcome: true,
      groundedDriveFindings: true, preservedReadOnlyScope: true },
  };
  bindApplicationResult(run, diagnostics.openGoalVerification, workflow, outcome);
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  diagnostics.openGoalVerification.checks.preservedReadOnlyScope = false;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: path.join(path.dirname(options.out), "replaced") }),
    /independently verified outcomes/u
  );
});

test("panel health export rejects an old console record cited after recovery", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "panel-health-live-loading-to-ready";
  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "reviewPanelHealth";
  leaf.record.outcome = "done";
  for (const [id, name, parent] of [
    ["assess-first", "assessObservation", leaf.callId],
    ["first-markers", "checkMarkers", "assess-first"],
    ["first-logs", "checkDiagnostics", "assess-first"],
    ["follow", "checkHealthChange", leaf.callId],
    ["identity", "checkObservationIdentity", "follow"],
    ["assess-later", "assessObservation", "follow"],
    ["later-markers", "checkMarkers", "assess-later"],
    ["later-logs", "checkDiagnostics", "assess-later"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  const common = {
    panelId: "owned-panel",
    phase: "ready",
    attemptId: "attempt",
    buildKey: "build",
    dropped: 0,
  };
  const first = {
    ...common,
    id: "first",
    consoleThrough: 1,
    markers: [{ id: "jobs", values: ["Loading"] }],
    diagnostics: [],
  };
  const later = {
    ...common,
    id: "later",
    consoleThrough: 2,
    markers: [{ id: "jobs", values: ["Alpha", "Beta"] }],
    diagnostics: [{ sequence: 2, level: "info", message: "panel-health: hydration completed" }],
  };
  run.report = {
    initial: { state: "attention", blockers: ["marker/jobs"], evidence: ["first"] },
    later: { state: "healthy", blockers: [], evidence: ["later"] },
    outcome: "recovered",
  };
  diagnostics.managedPanelHealth = {
    contextId: "ctx",
    caseId: "loading-to-ready",
    verification: {
      contextId: "ctx",
      caseId: "loading-to-ready",
      panelId: "owned-panel",
      passed: true,
      observations: [first, later],
      checks: {
        exactOps: true,
        initial: true,
        followUp: true,
        ownedPanel: true,
        report: true,
        protectedHeadUnchanged: true,
      },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  later.diagnostics[0].sequence = 1;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-old-console-record` }),
    /bind its findings to live DOM, retained diagnostic sequences and new evidence/u
  );
});

test("presentation export ties the exact MDX to the managed browser readback", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "presentation-live-unsampled-hall";
  const run = diagnostics.natlangTeacher;
  const mdx = '<Stats items={[{"label":"Confirmed bookings","value":24}]} />';
  run.report = { views: [{ id: "counts", status: "ready", rendered: { mdx } }] };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "preparePresentation";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  const verification = {
    passed: true,
    panelAttempt: "attempt",
    buildKey: "build",
    checks: Object.fromEntries(
      [
        "ownedPanel",
        "exactViewOrder",
        "browserRenderedCatalog",
        "visibleLabels",
        "exactReport",
        "protectedHeadUnchanged",
      ].map((name) => [name, true])
    ),
    rendered: { ids: ["counts"] },
    mdxDigests: [createHash("sha256").update(mdx).digest("hex")],
  };
  diagnostics.managedPresentation = { contextId: "ctx", caseId: "unsampled-hall", verification };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  run.report.views[0].rendered.mdx = mdx.replace("24", "240");
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-mdx` }),
    /match its managed browser readback and exact MDX/u
  );
});

test("presentation export rejects a chart table that changes a plotted value", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "presentation-live-dispatch-pressure";
  const world = cases.get(entry.test.name);
  const run = diagnostics.natlangTeacher;
  run.report = {
    views: world.renderedIds.map((id) => ({
      id,
      status: "ready",
      rendered: { mdx: `view ${id}` },
    })),
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "preparePresentation";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  const verification = {
    passed: true,
    panelAttempt: "attempt",
    buildKey: "build",
    checks: Object.fromEntries(
      [
        "ownedPanel",
        "exactViewOrder",
        "browserRenderedCatalog",
        "visibleLabels",
        "exactReport",
        "protectedHeadUnchanged",
        "interactiveReadback",
      ].map((check) => [check, true])
    ),
    rendered: { ids: world.renderedIds, interactions: structuredClone(world.interactions) },
    mdxDigests: run.report.views.map(({ rendered }) =>
      createHash("sha256").update(rendered.mdx).digest("hex")
    ),
  };
  diagnostics.managedPresentation = { contextId: "ctx", caseId: world.caseId, verification };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  verification.rendered.interactions[0].cells[1][1] = "700";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-table` }),
    /demonstrate its assigned controls in the live browser/u
  );
});

test("Testkit cleanup export separates LIFO acknowledgements from actual residue", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "testkit-cleanup-live-nonrecursive-cleanup";
  const run = diagnostics.natlangTeacher;
  const [root, skill] = run.calls;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  root.record.definition.name = "runWorkflow";
  skill.record.definition.name = "reviewLiveCleanup";
  skill.record.outcome = "done";
  for (const [name, parent] of [
    ["readCleanup", skill.callId],
    ["readOutcome", skill.callId],
    ["reviewSessionTest", skill.callId],
    ["reviewRelease", "reviewSessionTest"],
    ["checkTestkitRelease", "reviewRelease"],
    ["inspectInventory", skill.callId],
    ["matchRegistrations", "inspectInventory"],
  ]) {
    const call = structuredClone(skill);
    call.callId = call.summary.call_id = name;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  const receipt = "ctx:testkit-cleanup";
  const scratch = { id: "scratch-now", kind: "scratch" };
  const worker = { id: "worker-now", kind: "worker" };
  const release = {
    kind: "testkit",
    receipt: `${receipt}:deferred`,
    resources: [scratch, worker],
    released: [
      { ...worker, acknowledgement: "released" },
      { ...scratch, acknowledgement: "failed" },
    ],
  };
  const evidence = {
    receipt,
    outcome: "passed",
    error: null,
    logs: ["cleanup failed: directory not empty"],
    acquired: [scratch, worker],
    release,
    remaining: [scratch],
    protectedUnchanged: true,
  };
  run.report = {
    receipt,
    testOutcome: "passed",
    release: {
      decision: "revise",
      finding: "testkit-release-failed",
      evidenceIds: [release.receipt],
    },
    inventory: "registered-residue",
    remainingIds: [scratch.id],
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const session = run.calls.find(({ callId }) => callId === "reviewSessionTest").record;
  const teardown = run.calls.find(({ callId }) => callId === "reviewRelease").record;
  const testkit = run.calls.find(({ callId }) => callId === "checkTestkitRelease").record;
  teardown.inputs = testkit.inputs = { evidence: ref(release) };
  session.output = teardown.output = testkit.output = ref(run.report.release);
  diagnostics.managedTestkitCleanup = {
    contextId: "ctx",
    verification: {
      caseId: "nonrecursive-cleanup",
      passed: true,
      evidence,
      checks: { exactRead: true, protectedUnchanged: true, joinedReport: true },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  testkit.parent_call_id = skill.callId;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-bypassed-session-review` }),
    /exact session release path/u
  );
  testkit.parent_call_id = "reviewRelease";
  release.released.reverse();
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-order` }),
    /release acknowledgements and remaining inventory/u
  );
  release.released.reverse();
  evidence.remaining = [];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-missing-residue` }),
    /release acknowledgements and remaining inventory/u
  );
});

test("session replay export rejects a replaced message and a missing retry check", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "session-replay-live-adjusted-cutoff-same-key";
  const world = cases.get(entry.test.name).assignment;
  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "reviewLiveReplay";
  leaf.record.outcome = "done";
  for (const [name, parent] of [
    ["readCheckpoint", leaf.callId],
    ["inspectCheckpoint", leaf.callId],
    ["reviewSessionTest", "inspectCheckpoint"],
    ["reviewSession", "reviewSessionTest"],
    ["checkContinuation", "reviewSession"],
    ["preservesReplay", "inspectCheckpoint"],
    ["classifyRetry", "inspectCheckpoint"],
    ["matchAcceptedIdentity", "classifyRetry"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = name;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  const row = { id: "m1", senderId: "owned-client", text: world.messages[0] };
  const receipt = "ctx:replay:1";
  const checkpoint = {
    receipt,
    originalChannel: "owned-channel",
    replayChannel: "owned-channel",
    original: { key: "source-0", text: row.text, messageId: row.id },
    retry: { key: "source-0", text: world.steps[0].text, messageId: row.id },
    originBefore: [row],
    before: [row],
    after: [{ ...row }],
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const verdict = { decision: "confirmed", finding: "continuation-stable", evidenceIds: [receipt] };
  for (const name of ["reviewSessionTest", "reviewSession", "checkContinuation"]) {
    run.calls.find(({ callId }) => callId === name).record.output = ref(verdict);
  }
  const continuation = run.calls.find(({ callId }) => callId === "checkContinuation").record;
  continuation.inputs = { evidence: ref({
    kind: "continuation", receipt, originalChannel: checkpoint.originalChannel,
    replayChannel: checkpoint.replayChannel, originalKey: checkpoint.original.key,
    retryKey: checkpoint.retry.key, originalMessage: row.id, replayedMessages: [row.id], retryMessage: row.id,
  }) };
  run.report = {
    findings: [
      {
        receipt,
        disposition: world.steps[0].expected,
        originalId: row.id,
        retryId: row.id,
        retainedIds: [row.id],
      },
    ],
  };
  diagnostics.managedSessionReplay = {
    contextId: "ctx",
    verification: {
      caseId: world.id,
      passed: true,
      checks: { exactReadOrder: true, reportMatchesReplay: true },
      evidence: [checkpoint],
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  checkpoint.after[0].text = checkpoint.retry.text;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-replaced-message` }),
    /accepted retry and preserved transcripts/u
  );
  checkpoint.after[0].text = row.text;
  continuation.output = ref({ ...verdict, finding: "retry-key-changed" });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-changed-session-verdict` }),
    /replay inspection and its nested decision calls/u
  );
  continuation.output = ref(verdict);
  run.calls.pop();
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-missing-retry-check` }),
    /replay inspection and its nested decision calls/u
  );
});

test("authoring export rejects a review drawn from another baseline", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "authoring-live-baseline-unavailable";
  const run = diagnostics.natlangTeacher;
  const candidateRevision = "a".repeat(64);
  const baselineRevision = "b".repeat(64);
  run.report = { status: "baseline-rejected", candidateRevision, baselineRevision };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "reviewProgram";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  diagnostics.managedAuthoring = {
    contextId: "ctx",
    verification: {
      caseId: "baseline-unavailable",
      status: "baseline-rejected",
      candidateRevision,
      baselineRevision,
      passed: true,
      checks: Object.fromEntries(
        [
          "sourceUnchanged",
          "workspaceHeadUnchanged",
          "exactInspections",
          "intendedWorld",
          "joinedFindings",
        ].map((name) => [name, true])
      ),
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  run.report.baselineRevision = "c".repeat(64);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-baseline` }),
    /must match the assigned compiler snapshots/u
  );
});

test("authoring export requires actual scope receipts and the nested selector comparison", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "authoring-live-scope-drop-release-restriction";
  const world = cases.get(entry.test.name);
  const run = diagnostics.natlangTeacher;
  const candidateRevision = world.trackedScopes[0].revision;
  const baselineRevision = world.trackedScopes[1].revision;
  run.report = {
    status: "changes-required",
    candidateRevision,
    baselineRevision,
    findings: [
      {
        code: "service-scope-change",
        subject: "decisionWriter",
        observed: "unrestricted",
        recovery: "Restrict the writer to the decision recorder.",
      },
    ],
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "reviewProgram";
  leaf.record.outcome = "done";
  for (const [name, parent] of [
    ["inspectRevisions", leaf.callId],
    ["readAssignedProgram", "inspectRevisions"],
    ["reviewContract", leaf.callId],
    ["checkAuthority", "reviewContract"],
    ["checkServices", "checkAuthority"],
    ["compareSelectors", "checkAuthority"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = name;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  const scopeReadbacks = [
    {
      role: "candidate",
      revision: candidateRevision,
      scopes: structuredClone(world.trackedScopes[0].scopes),
    },
    {
      role: "baseline",
      revision: baselineRevision,
      scopes: structuredClone(world.trackedScopes[1].scopes),
    },
  ];
  diagnostics.managedAuthoring = {
    contextId: "ctx",
    verification: {
      caseId: world.caseId,
      status: world.expectedStatus,
      candidateRevision,
      baselineRevision,
      passed: true,
      scopeReadbacks,
      checks: {
        sourceUnchanged: true,
        workspaceHeadUnchanged: true,
        exactInspections: true,
        intendedWorld: true,
        joinedFindings: true,
      },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  scopeReadbacks[1].scopes.decisionWriter = ["review.nl"];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-grant` }),
    /compiled scopes and nested selector checks/u
  );
  scopeReadbacks[1].scopes = structuredClone(world.trackedScopes[1].scopes);
  run.calls.at(-1).record.parent_call_id = "reviewContract";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-flat-comparison` }),
    /compiled scopes and nested selector checks/u
  );
});

test("provenance history export rejects an aliased file or walk scope", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "provenance-history-live-cohort-breadth";
  const world = cases.get(entry.test.name);
  const workingHead = { kind: "event", eventId: "owned-head" };
  const run = diagnostics.natlangTeacher;
  run.report = {
    kind: "live-history",
    findings: world.checks.map((check, index) => ({
      check,
      status: "recorded",
      evidence: [`history:${index + 1}:1`],
    })),
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "reviewProvenance";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  const readbacks = world.checks.map((check, index) => ({
    fileId: "file-current",
    walk: {
      walk: check.walk,
      scope: check.scope,
      subject: { kind: "file", fileId: "file-current", repositoryId: "repo", state: workingHead },
      entries: [
        {
          node: { kind: "work-unit", workUnitId: "same-work" },
          label: "Authored work",
          intent: { text: "Related policy change" },
        },
      ],
      omitted: [],
      nextCursor: null,
    },
    receipt: {
      check,
      exists: true,
      limited: false,
      records: [
        {
          ref: `history:${index + 1}:1`,
          label: "Authored work",
          intent: "Related policy change",
          source: "source:1",
          group: null,
          detail: null,
        },
      ],
    },
  }));
  diagnostics.managedProvenanceHistory = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: world.caseId,
      repoPath: "projects/owned",
      repositoryId: "repo",
      workingHead,
      readbacks,
      passed: true,
      checks: { unchanged: true, exactReads: true, history: true, report: true, constraint: true },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  readbacks[0].walk.subject.fileId = "another-file";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-different-file` }),
    /Provenance history must cite the exact repository, walk scope, and recorded coordinates/u
  );
  readbacks[0].walk.subject.fileId = "file-current";
  readbacks[0].walk.scope = "turn";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-different-scope` }),
    /Provenance history must cite the exact repository, walk scope, and recorded coordinates/u
  );
});

test("live provenance proposal export requires the judgment calls and the exact reversal", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "provenance-history-live-retry-repeat-300";
  const world = cases.get(entry.test.name);
  const head = { kind: "event", eventId: "owned-head" };
  const run = diagnostics.natlangTeacher;
  const [root, sample] = run.calls;
  root.record.definition.name = "runWorkflow";
  const call = (name, parent) => ({
    ...structuredClone(sample),
    callId: name,
    summary: { ...sample.summary, call_id: name },
    record: { ...sample.record, outcome: "done", definition: { name }, parent_call_id: parent },
  });
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  run.calls = [
    root,
    call("reviewProvenance", "root"),
    call("reviewLiveHistory", "reviewProvenance"),
    call("assessProposedProperty", "reviewLiveHistory"),
    call("weighConstraint", "assessProposedProperty"),
    call("compareProperty", "weighConstraint"),
    call("judgeConstraint", "weighConstraint"),
  ];
  const readbacks = world.checks.map((check, index) => {
    const row = {
      node: { kind: "work-unit", workUnitId: "node-" + index },
      label: "Reverted wait",
      detail: "Attempted 300 seconds",
      group: index === 0 ? "counteractions" : "history",
      intent: { tier: "stated", text: "staging cut the link" },
    };
    return {
      fileId: "file",
      walk: {
        walk: check.walk,
        scope: null,
        subject: { kind: "file", fileId: "file", repositoryId: "repo", state: head },
        entries: [row],
        omitted: [],
        nextCursor: null,
      },
      receipt: {
        check,
        exists: true,
        limited: false,
        records: [
          {
            ref: `history:${index + 1}:1`,
            source: `source:${index + 1}`,
            label: row.label,
            detail: row.detail,
            group: row.group,
            intent: row.intent.text,
          },
        ],
      },
    };
  });
  const constraint = { status: "rejected", evidence: ["history:1:1"] };
  run.report = {
    kind: "live-history",
    findings: readbacks.map(({ receipt }) => ({
      check: receipt.check,
      status: "recorded",
      evidence: [receipt.records[0].ref],
    })),
    constraint: structuredClone(constraint),
  };
  diagnostics.managedProvenanceHistory = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: world.caseId,
      repoPath: "projects/owned",
      repositoryId: "repo",
      workingHead: head,
      property: world.constraint.proposedProperty,
      constraint,
      readbacks,
      passed: true,
      checks: { unchanged: true, exactReads: true, history: true, report: true, constraint: true },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  run.report.constraint.evidence = ["history:2:1"];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-counteraction` }),
    /Provenance history must cite/u
  );
  run.report.constraint.evidence = ["history:1:1"];
  run.calls.at(-1).record.parent_call_id = "reviewLiveHistory";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-judgment` }),
    /Provenance history must cite/u
  );
});

test("runtime program export binds stale execution to the measured revision pair", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "runtime-program-live-stale-counter-receipt";
  const world = cases.get(entry.test.name);
  const run = diagnostics.natlangTeacher;
  const execution = { id: "earlier-owned-eval", state: "stale" };
  const receipt = {
    evalRunId: execution.id,
    original: world.original,
    current: world.current,
    signature: true,
    returned: world.execution.output,
    thrown: null,
    execution,
  };
  assert.notEqual(receipt.original, receipt.current);
  run.report = { kind: "program", next: "refresh-program-receipt", basis: execution.id };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "reviewRuntimeEvidence";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  diagnostics.managedRuntimeProgram = {
    contextId: "ctx",
    verification: {
      passed: true,
      checks: { observation: true, verdict: true, basis: true, source: true },
      observed: {
        contextId: "ctx",
        caseId: world.caseId,
        expected: world.expected,
        receipt,
        request: {
          kind: "program",
          goal: world.goal,
          path: "scratch/review/main.ts",
          call: null,
          userRequestedRetry: false,
          compiler: "passed",
          diagnostic: null,
          execution,
        },
      },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  receipt.current = receipt.original;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-different-revision` }),
    /Runtime review must cite the original owned compiler or execution receipt/u
  );
});

test("incident continuation export binds source groups and native read order independently of NL start times", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "incident-continuation-live-search-refresh-review";
  const world = cases.get(entry.test.name);
  assert.deepEqual(workflowSourceGroups(world), [
    "vibestudio:system:incident-log-before-local-inventory",
    "vibestudio:system:assigned-host-log-cursor-and-recovery",
    "vibestudio:local-model:assigned-candidates-live-inventory",
  ]);
  const seed = {
    marker: "natlang-host-log-example",
    boot: "boot",
    workspaceId: "workspace",
    start: 100,
    steps: [101, 102],
  };
  const windows = world.logWorkflow.windows.map((window) => ({
    status: window.status,
    findings: [
      { code: window.code, evidenceIds: window.evidence.map((i) => `boot:${seed.steps[i]}`) },
    ],
  }));
  const log = {
    status: "attention",
    findings: windows.flatMap((window) => window.findings),
    windows,
  };
  const { modelRef, alternatives } = world.modelWorkflow.request;
  const refs = [modelRef, ...alternatives];
  const candidates = refs.map((ref) => ({
    ref,
    state: null,
    disposition: "unavailable",
    handoff: null,
  }));
  const comparison = {
    disposition: "no-candidate",
    ref: modelRef,
    state: null,
    handoff: null,
    receipt: null,
    candidates,
  };
  const run = diagnostics.natlangTeacher;
  run.report = {
    results: [
      { kind: "domain", domain: "system", operation: "investigateSystem", report: log },
      { kind: "domain", domain: "localModel", operation: "prepareLocalModel", report: comparison },
    ],
    remaining: [],
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, sample] = run.calls;
  root.record.definition.name = "runWorkflow";
  function step(id, name, parent, start, end) {
    const call = structuredClone(sample);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    call.record.started_at = new Date(start).toISOString();
    call.record.ended_at = new Date(end).toISOString();
    return call;
  }
  const modelsCall = step("models", "prepareLocalModel", "root", 4, 6);
  run.calls = [
    root,
    step("log", "investigateSystem", "root", 0, 3),
    step("window", "readLogs", "log", 1, 2),
    modelsCall,
    step("compare", "compareCandidates", "models", 5, 6),
  ];
  diagnostics.managedLogAudit = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: world.logWorkflow.caseId,
      passed: true,
      checks: { exactWindows: true, summary: true, reports: true },
      seed,
      observed: world.logWorkflow.windows.map((window) => {
        const sinceSeq = window.cursor === null ? seed.start : seed.steps[window.cursor];
        return {
          boot: seed.boot,
          input: {
            kind: "server-log-incident",
            tag: window.tag,
            sinceSeq,
            expectedBoot: seed.boot,
          },
          records: seed.steps.filter((seq) => seq > sinceSeq),
        };
      }),
    },
  };
  diagnostics.managedLocalComparison = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: world.modelWorkflow.caseId,
      passed: true,
      checks: { stableInventory: true, exactReads: true, handoff: true, candidates: true },
      inspected: refs,
      rows: refs.map((ref) => ({ ref, row: null })),
      expected: comparison,
    },
  };
  const journal = windows
    .map((_, index) => ({ kind: "host-log", index }))
    .concat(refs.map((_, index) => ({ kind: "local-model", index })));
  diagnostics.managedIncidentContinuation = {
    contextId: "ctx",
    verification: {
      caseId: world.caseId,
      contextId: "ctx",
      passed: true,
      journal,
      checks: { reportOrder: true, readOrder: true, log: true, models: true },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  journal[1] = { kind: "local-model", index: 0 };
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-early-read` }),
    /complete host log review before the assigned local inventory/u
  );
  journal[1] = { kind: "host-log", index: 1 };
  modelsCall.record.started_at = new Date(2).toISOString();
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-early-skill` });
});

test("host log export requires the actual boot and exclusive cursor", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "host-log-audit-live-indexing-recovery";
  const world = cases.get(entry.test.name);
  const run = diagnostics.natlangTeacher;
  const seed = {
    marker: "natlang-host-log-abc",
    boot: "boot-a",
    workspaceId: "workspace",
    start: 100,
    steps: [101, 110],
  };
  run.report = {
    status: "attention",
    findings: [
      { code: "log-recovered", evidenceIds: ["boot-a:101", "boot-a:110"] },
      { code: "log-no-observations", evidenceIds: [] },
    ],
    windows: [],
  };
  run.report.windows = run.report.findings.map((finding, index) => ({
    status: world.windows[index].status,
    findings: [finding],
  }));
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "investigateSystem";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  const observed = world.windows.map((window) => ({
    boot: seed.boot,
    input: {
      kind: "server-log-incident",
      expectedBoot: seed.boot,
      sinceSeq: window.cursor === null ? seed.start : seed.steps[window.cursor],
      tag: window.tag,
    },
    records: window.cursor === null ? seed.steps : [],
  }));
  diagnostics.managedLogAudit = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: world.caseId,
      passed: true,
      checks: { exactWindows: true, summary: true, reports: true },
      seed,
      observed,
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  observed[1].records = [110];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-inclusive-cursor` }),
    /Host log findings must cite the assigned boot, cursor, and recorded sequences/u
  );
  observed[1].records = [];
  run.report.findings[0].evidenceIds[0] = "another-boot:101";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-boot` }),
    /Host log findings must cite the assigned boot, cursor, and recorded sequences/u
  );
});

test("local model comparison export rejects a handoff that skips the first eligible model", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "local-model-compare-live-continue-code-review";
  const world = cases.get(entry.test.name);
  const refs = [world.request.modelRef, ...world.request.alternatives];
  const candidates = refs.map((ref, index) => ({
    ref,
    state: index === 0 ? "not-installed" : "startable",
    disposition: index === 0 ? "needs-install" : "ready-to-delegate",
    handoff: index === 0 ? null : { ref, mode: "fork" },
  }));
  const run = diagnostics.natlangTeacher;
  const selected = candidates[1];
  run.report = { ...selected, receipt: null, candidates };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "prepareLocalModel";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  diagnostics.managedLocalComparison = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: world.caseId,
      passed: true,
      checks: { stableInventory: true, exactReads: true, handoff: true, candidates: true },
      inspected: refs,
      rows: candidates.map(({ ref, state }) => ({ ref, row: { state } })),
      expected: structuredClone(run.report),
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  run.report = { ...run.report, ...candidates[2] };
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-skipped-local-candidate` }),
    /Local model comparison must use the exact assigned reads and handoff/u
  );
});

test("Google setup export binds live choice transitions and the measured viewport", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "google-setup-live-mobile-choice-readback";
  const world = cases.get(entry.test.name);
  const run = diagnostics.natlangTeacher;
  const receipts = world.checks.map((check, index) => ({
    id: `ctx:google-setup:${index + 1}`,
    check,
    stage: "needs-setup",
    accountOwner: true,
    permissionsOwner: true,
    gmailEnabled: false,
    inheritedLaunch: null,
    overflow: false,
    viewportWidth: check.width ?? null,
  }));
  const initialChoice = {
    scope: "gmail",
    opening: "external",
    guidance: "gmail",
    connectEnabled: false,
    gmailEnabled: false,
  };
  receipts[1].controls = {
    before: initialChoice,
    after: { ...initialChoice, scope: "workspace", guidance: "workspace" },
  };
  run.report = {
    status: "action-needed",
    action: "open-setup",
    ids: [],
    checkpoint: null,
    panelFindings: receipts.map(({ check, id }, index) => ({
      check,
      evidenceId: id,
      code: world.codes[index],
    })),
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "guideGoogleWorkspace";
  skill.record.outcome = "done";
  leaf.record.parent_call_id = "skill";
  leaf.record.definition.name = "reviewSetupJourney";
  leaf.record.outcome = "done";
  run.calls.push(skill);
  for (const [id, name, parent] of [
    ["panel", "reviewSetupPanel", leaf.callId],
    ["observe", "observeSetupPanel", "panel"],
    ["choices", "inspectSetupChoices", "panel"],
    ["compare", "compareSetupChoices", "choices"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  diagnostics.managedGoogleSetup = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      panelId: "welcome",
      caseId: world.caseId,
      readiness: { state: "needs-setup" },
      passed: true,
      checks: { driveNeedsSetup: true, browserAgrees: true, reportMatches: true },
      receipts,
    },
  };
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "google-workspace" }));
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  receipts[0].viewportWidth = 1280;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-different-viewport` }),
    /Google setup findings must match the assigned panel and account observations/u
  );
  receipts[0].viewportWidth = 390;
  receipts[1].controls.after.connectEnabled = true;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-opened-consent` }),
    /Google setup findings must match the assigned panel and account observations/u
  );
  receipts[1].controls.after.connectEnabled = false;
  run.calls.find(({ callId }) => callId === "compare").record.parent_call_id = "panel";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-detached-choice` }),
    /Google setup choice journeys must capture/u
  );
});

test("News export rejects findings that cite a different schedule owner", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "news-live-reconcile-quieter-poll";
  const world = cases.get(entry.test.name);
  const run = diagnostics.natlangTeacher;
  run.report = {
    status: "ready",
    findings: [
      { code: "briefing-confirmed", evidenceIds: ["briefing-owner"] },
      { code: "poll-confirmed", evidenceIds: ["poll-owner"] },
      { code: "resume-confirmed", evidenceIds: ["reader"] },
    ],
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "reviewNews";
  skill.record.outcome = "done";
  leaf.record.parent_call_id = "live";
  leaf.record.definition.name = "readNewsState";
  leaf.record.outcome = "done";
  run.calls.push(skill);
  for (const [id, name, parent] of [
    ["live", "reviewLiveNews", "skill"],
    ["reconcile", "reconcileCadence", "live"],
    ["before", "reviewSchedule", "reconcile"],
    ["choose", "chooseCadenceChange", "reconcile"],
    ["after", "reviewSchedule", "live"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  diagnostics.managedNews = {
    contextId: "ctx",
    verification: {
      passed: true,
      checks: { matchesReport: true, matchesState: true, matchesRepair: true },
      repair: {
        before: {
          kind: "schedule",
          intent: world.checks[1].intent,
          owner: { id: "initial", paused: false },
          poll: { id: "poll-owner", intervalMs: 1_800_000 },
          briefing: { id: "briefing-owner", kind: "interval", intervalMs: 86_400_000 },
        },
        receipt: { change: world.checks[1].intent, id: "write" },
      },
      caseId: world.caseId,
      assignment: {
        contextId: "ctx",
        channelId: "reader",
        agentKey: "reader",
        participantId: "curator",
      },
      observed: world.checks.map(({ intent }) => ({
        kind: "schedule",
        intent,
        owner: { id: "reader", paused: false },
        poll: { id: "poll-owner", intervalMs: 7_200_000 },
        briefing: { id: "briefing-owner", kind: "interval", intervalMs: 86_400_000 },
      })),
    },
  };
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "news" }));
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const choose = run.calls.find(({ callId }) => callId === "choose");
  choose.record.parent_call_id = "live";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-detached-choice` }),
    /News cadence reconciliation must capture/u
  );
  choose.record.parent_call_id = "reconcile";
  run.report.findings[1].evidenceIds = ["another-reader"];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-different-owner` }),
    /News findings must match the assigned channel observations and Missions owners/u
  );
  run.report.findings[1].evidenceIds = ["poll-owner"];
  const cadence = diagnostics.managedNews.verification.observed[1].poll;
  cadence.intervalMs = 1_800_000;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-unchanged-poll` }),
    /News cadence repair must preserve owner identities/u
  );
  cadence.intervalMs = 7_200_000;
  diagnostics.managedNews.verification.repair.receipt.id = null;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-missing-write` }),
    /News cadence repair must preserve owner identities/u
  );
});

test("News handoff export binds the verified Missions evidence to the staged artifact", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const world = cases.get("news-live-handoff-stale-feed-cadence");
  assert.deepEqual(world.skills, ["reviewNews", "assembleHandoff"]);
  assert.equal(world.workspace, "news");
  assert.equal(cases.get("news-live-reconcile-handoff-after-feed-change").repair.write, true);
  const applied = cases.get("news-live-reconcile-handoff-after-switching-to-interval");
  const declined = cases.get("news-live-reconcile-handoff-after-declining-unsupported-cadence");
  assert.equal(applied.repair.write, true);
  assert.match(applied.handoff.source, /Briefing interval: 180 minutes/u);
  assert.equal(declined.repair.write, false);
  assert.match(declined.handoff.source, /Briefing interval: 150 minutes/u);

  const artifact = { path: "/.tmp/evidence-handoff-verified/handoff.json", bytes: 456, sha256: "a".repeat(64) };
  const report = {
    status: "attention",
    findings: world.expected.map(({ code }, index) => ({
      code,
      evidenceIds: [["poll-mission", "daily-mission", "preferences"][index]],
    })),
  };
  const verification = {
    passed: true,
    checks: { exactNews: true, exactHandoff: true, verifiedTransfer: true },
    news: {
      caseId: world.caseId,
      passed: true,
      checks: { matchesReport: true, matchesState: true },
      assignment: { contextId: "ctx", channelId: "reader", agentKey: "reader", participantId: "curator" },
      observed: world.checks.map(({ intent }) => ({
        kind: "schedule",
        intent,
        owner: { id: "preferences", paused: true },
        poll: { id: "poll-mission", intervalMs: 5_400_000 },
        briefing: { id: "daily-mission", kind: "daily", at: "07:45", timezone: "Europe/Berlin" },
      })),
    },
    handoff: { passed: true, artifact, sourceIds: ["news-missions"], seedRevision: "seed" },
    sourceSha256: createHash("sha256").update(world.handoff.source).digest("hex"),
  };
  const execution = {
    provenance: { contextId: "ctx" },
    diagnostics: { managedNews: { contextId: "ctx", verification } },
  };
  const exercise = {
    report: {
      results: [
        { domain: "news", operation: "reviewNews", report },
        {
          domain: "scratchHandoff", operation: "assembleHandoff",
          report: { status: "staged", artifact: { path: artifact.path, bytes: artifact.bytes } },
        },
      ],
    },
  };
  const admit = () => world.evidence(execution, exercise, {}, world);
  assert.equal(admit().checks.verifiedTransfer, true);
  exercise.report.results[1].report.artifact.path = "/.tmp/unassigned.json";
  assert.throws(admit, /match the staged scratch artifact/u);
  exercise.report.results[1].report.artifact.path = artifact.path;
  report.findings[0].evidenceIds = ["unassigned-poll"];
  assert.throws(admit, /match the assigned channel observations/u);
  report.findings[0].evidenceIds = ["poll-mission"];
  const after = verification.news.observed.at(-1);
  after.briefing.at = "08:45";
  assert.throws(admit, /cite the verified schedule settings/u);
  after.briefing.at = "07:45";
  verification.sourceSha256 = "0".repeat(64);
  assert.throws(admit, /cite the verified schedule settings/u);
});

test("Spectrolite export binds the browser, committed baseline and nested revision checks", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "spectrolite-live-dispatch-approval-route";
  const run = diagnostics.natlangTeacher;
  const world = cases.get(entry.test.name);
  run.report = {
    findings: world.checks.map((check, index) => ({
      check,
      code: world.expected[index],
      detail:
        check === "navigation"
          ? [...world.expectedNavigation.map(({ from }) => from), world.documentPath].join(" → ")
          : world.documentPath,
      evidenceIds: [
        "ctx:vault",
        "ctx:document",
        ...(check === "preview" ? ["ctx:preview"] : []),
        ...(check === "navigation" ? ["ctx:navigation"] : []),
      ],
    })),
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "reviewSpectrolite";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  const working = { kind: "event", id: "committed" };
  const preview = {
    id: "ctx:preview",
    documentPath: world.documentPath,
    contentHash: "canonical",
    phase: "rendered",
    detail: null,
  };
  const navigation = { id: "ctx:navigation", hops: structuredClone(world.expectedNavigation) };
  diagnostics.managedSpectrolite = {
    contextId: "ctx",
    verification: {
      caseId: world.caseId,
      passed: true,
      browser: { path: world.documentPath, text: world.heading, rendered: [world.previewText] },
      observed: {
        vault: { id: "ctx:vault", repositoryId: "vault", clean: true, working },
        document: {
          id: "ctx:document",
          repositoryId: "vault",
          path: world.documentPath,
          contentHash: "canonical",
          ref: working,
        },
        preview,
        navigation,
      },
      checks: Object.fromEntries(
        [
          "canonicalDocument",
          "exactNavigation",
          "browserIdentity",
          "visiblePreview",
          "actualDisposition",
          "matchedFindings",
        ].map((name) => [name, true])
      ),
    },
  };
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "spectrolite" }));
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  preview.contentHash = "older";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-different-revision` }),
    /Spectrolite findings must match the assigned canonical revision/u
  );
  preview.contentHash = "canonical";
  navigation.hops.reverse();
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-route` }),
    /Spectrolite findings must match the assigned canonical revision/u
  );

  entry.test.name = "spectrolite-live-draft-evacuation-route";
  const draft = cases.get(entry.test.name);
  const workingDraft = { kind: "application", id: "uncommitted" };
  run.report.findings = draft.checks.map((check, index) => ({
    check,
    code: draft.expected[index],
    detail: draft.documentPath,
    evidenceIds: [
      "ctx:vault",
      ...(check === "publication" ? [] : ["ctx:document"]),
      ...(check === "preview" ? ["ctx:preview"] : []),
      ...(check === "revision" ? ["ctx:committed-document"] : []),
    ],
  }));
  const verification = diagnostics.managedSpectrolite.verification;
  Object.assign(verification, {
    caseId: draft.caseId,
    browser: {
      path: draft.documentPath,
      text: draft.heading,
      rendered: [draft.previewText],
    },
  });
  Object.assign(verification.observed.vault, {
    clean: false,
    committed: working,
    working: workingDraft,
  });
  Object.assign(verification.observed.document, {
    fileId: "file:spectrolite",
    path: draft.documentPath,
    ref: workingDraft,
  });
  verification.observed.committedDocument = {
    ...verification.observed.document,
    id: "ctx:committed-document",
    contentHash: "baseline",
    title: draft.draft.committedTitle,
    ref: working,
  };
  verification.observed.navigation = null;
  preview.documentPath = draft.documentPath;
  verification.checks.committedBaseline = true;
  const capture = (name, parent) => {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = name;
    call.record.definition.name = name;
    call.record.outcome = "done";
    call.record.parent_call_id = parent;
    run.calls.push(call);
  };
  leaf.record.definition.name = "reviewLiveVault";
  leaf.record.outcome = skill.record.outcome = "done";
  for (const name of [
    "readVault",
    "inspectDocument",
    "inspectPreview",
    "inspectRevision",
    "inspectPublication",
  ])
    capture(name, leaf.callId);
  capture("matchCommittedDocument", "inspectRevision");
  capture("compareDocumentContent", "inspectRevision");
  capture("interpretProgress", "inspectPublication");
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-working-draft` });
  const compare = run.calls.find(({ callId }) => callId === "compareDocumentContent");
  compare.record.parent_call_id = leaf.callId;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-flat-revision-review` }),
    /Spectrolite draft findings must come from the live review and its nested revision checks/u
  );
  compare.record.parent_call_id = "inspectRevision";
  verification.observed.committedDocument.ref = workingDraft;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-committed-ref` }),
    /Spectrolite findings must match the assigned canonical revision/u
  );
  verification.observed.committedDocument.ref = working;
  verification.browser.text += draft.draft.staleText;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-stale-draft-browser` }),
    /Spectrolite findings must match the assigned canonical revision/u
  );
  entry.test.name = "spectrolite-live-review-handoff-uncommitted-brief";
  const handoff = cases.get(entry.test.name);
  assert.deepEqual(handoff.skills, ["reviewSpectrolite", "planVaultHandoff"]);
  const vaultReport = { findings: handoff.checks.map((check, index) => ({
    ...run.report.findings.find((finding) => finding.check === check),
    code: handoff.expected[index],
    detail: handoff.documentPath,
  })) };
  verification.caseId = handoff.caseId;
  verification.browser = { path: handoff.documentPath, text: handoff.heading, rendered: [handoff.previewText] };
  const { vault, document, committedDocument } = verification.observed;
  document.path = committedDocument.path = preview.documentPath = handoff.documentPath;
  committedDocument.title = handoff.draft.committedTitle;
  const transferred = { vault, document, committedDocument, preview };
  const plan = {
    disposition: "draft-only", ref: workingDraft, contentHash: document.contentHash,
    evidenceIds: [vault.id, document.id, committedDocument.id, preview.id],
  };
  run.report = { results: [
    { domain: "spectrolite", operation: "reviewSpectrolite", report: vaultReport },
    { domain: "spectrolite", operation: "planVaultHandoff", report: plan },
  ] };
  const ref = (value) => {
    const serialized = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(serialized).digest("hex"), bytes: Buffer.byteLength(serialized) };
  };
  capture("planVaultHandoff", run.rootCallIds[0]);
  capture("chooseHandoff", "planVaultHandoff");
  const [, choiceCall] = run.calls.slice(-2);
  const handoffCall = run.calls.at(-2);
  skill.record.ended_at = new Date(1).toISOString();
  handoffCall.record.started_at = new Date(2).toISOString();
  handoffCall.record.effects = [{
    service: "spectroliteHandoffRead", method: "evidence", args: ref([]), result: ref(transferred),
  }];
  choiceCall.record.inputs = { path: ref(handoff.documentPath), evidence: ref(transferred) };
  handoffCall.record.output = choiceCall.record.output = ref(plan);
  diagnostics.managedSpectrolite.verification = {
    passed: true, checks: { verifiedVault: true, exactHandoff: true }, vault: verification, transferred,
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-draft-handoff` });
  plan.ref = working;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-handoff-wrong-revision` }),
    /Spectrolite handoff must use the verified editor and vault revision receipts/u
  );
  entry.test.name = "spectrolite-live-review-handoff-hold-after-preview-removal";
  const held = cases.get(entry.test.name);
  verification.caseId = held.caseId;
  verification.browser = { path: held.documentPath, text: held.heading, rendered: [] };
  document.path = committedDocument.path = held.documentPath;
  committedDocument.title = held.draft.committedTitle;
  verification.observed.preview = transferred.preview = null;
  vaultReport.findings = held.checks.map((check, index) => ({
    check, code: held.expected[index], detail: held.documentPath,
    evidenceIds: [
      vault.id, ...(check === "publication" ? [] : [document.id]),
      ...(check === "revision" ? [committedDocument.id] : []),
    ],
  }));
  Object.assign(plan, {
    disposition: "hold", ref: null, contentHash: null, evidenceIds: [vault.id, document.id],
  });
  handoffCall.record.effects[0].result = ref(transferred);
  choiceCall.record.inputs = { path: ref(held.documentPath), evidence: ref(transferred) };
  handoffCall.record.output = choiceCall.record.output = ref(plan);
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-missing-preview-handoff` });

  plan.evidenceIds.push(committedDocument.id);
  handoffCall.record.output = choiceCall.record.output = ref(plan);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-held-handoff-cites-unchecked-baseline` }),
    /Spectrolite handoff must use the verified editor and vault revision receipts/u
  );

});

test("channel roster export rejects a participant from the other channel", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "channel-roster-live-readonly-roster-inventory";
  const { assignment } = cases.get(entry.test.name);
  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "runRosterPlan";
  leaf.record.outcome = "done";
  const add = (id, name, parent) => {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  };
  const token = "e0ba1cee-4e51-415e-9d9d-2a672a584b2b";
  const channelId = (name) => `natlang-roster-${token}-${name}`;
  const member = (name, handle) =>
    `do:workers/test-agent:TestAgentWorker:${handle}-${channelId(name)}`;
  const initial = Object.fromEntries(
    ["oncall", "review"].map((name) => [
      name,
      {
        channelId: channelId(name),
        contextId: "ctx",
        messages: 0,
        participants: assignment.starting.members
          .filter(([channel]) => channel === name)
          .map(([, handle]) => ({ id: member(name, handle), handle, type: "agent" })),
      },
    ])
  );
  const findings = [];
  const activity = [];
  const steps = assignment.steps.map(({ channel, handle, action, precondition }, index) => {
    const id = `step-${index + 1}`;
    const membership = `${id}-membership`;
    add(`${id}-gate`, "checkPriorOutcome", leaf.callId);
    add(membership, "manageChannelAgent", leaf.callId);
    add(`${id}-choose`, "choose", membership);
    add(`${id}-reconcile`, "reconcile", membership);
    const value = {
      state: precondition,
      participantId: precondition === "member" ? member(channel, handle) : null,
    };
    activity.push({ id, kind: "read", value });
    findings.push({ id, result: { status: "observed", ...value }, blockedBy: null });
    return {
      id,
      request: { contextId: "ctx", channelId: channelId(channel), handle, action, options: null },
    };
  });
  run.report = { findings };
  const final = structuredClone(initial);
  diagnostics.managedChannelRoster = {
    contextId: "ctx",
    verification: {
      caseId: assignment.id,
      contextId: "ctx",
      initial,
      final,
      steps,
      activity,
      passed: true,
      checks: {
        initial: true,
        exactOperations: true,
        finalRoster: true,
        isolatedChannels: true,
        noMessages: true,
        report: true,
      },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  final.review.participants[0].id = member("oncall", "reviewer");
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-swapped-channel` }),
    /bind exact activities to the assigned live channel and participant/u
  );
});

test("Mission planning export rejects a write carrying an earlier card revision", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "mission-planning-live-implement-after-design";
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "personal" }));

  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "reconcileMissionPlan";
  leaf.record.outcome = "done";
  for (const [id, name, parent] of [
    ["plan-1", "planCardChange", leaf.callId],
    ["locate-1", "locateCard", "plan-1"],
    ["plan-2", "planCardChange", leaf.callId],
    ["locate-2", "locateCard", "plan-2"],
    ["apply", "applyCardChange", leaf.callId],
    ["verify", "verifyCardChange", "apply"],
    ["verify-fields", "verifyPlanningFields", "verify"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  const cardId = "owned-implementation";
  const projects = [{ id: "owned-project", name: "Build", archived: false }];
  const original = {
    id: cardId,
    projectId: "owned-project",
    title: "Implement migration",
    revision: 3,
    status: "inbox",
    dependencies: ["approved-design"],
    automationId: null,
    updatedAt: 100,
  };
  const snapshot = (id, card) => ({ id, complete: true, projects, cards: [card] });
  const change = { kind: "ready", cardId, revision: 3 };
  run.report = {
    findings: [
      { status: "verified", cardId, blockers: [], evidence: ["before", "after"] },
      { status: "held", cardId: null, blockers: [cardId], evidence: ["after"] },
    ],
  };
  diagnostics.managedMissionPlanning = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: "implement-after-design",
      objectKey: "natlang-mission-planning-ctx",
      baseline: snapshot("before", original),
      transitions: [
        {
          change,
          after: snapshot("after", { ...original, revision: 4, status: "ready", updatedAt: 200 }),
        },
      ],
      assignments: { cards: { implement: cardId }, projects: { build: "owned-project" } },
      passed: true,
      checks: { baseline: true, outside: true, exactEffects: true, report: true },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  change.revision = 2;
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-stale` }),
    /Mission planning must link each finding to the assigned live card and observed revision/u
  );
});

test("Browser handoff rejects a receipt from an earlier library snapshot", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "browser-handoff-live-latest-migration";
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "personal" }));
  const world = cases.get(entry.test.name);
  assert.equal(workflowSourceGroups(world).length, 3);

  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, sample] = run.calls;
  root.record.definition.name = "runWorkflow";
  run.calls = [root];
  for (const [id, name, parent, start, end] of [
    ["library", "curateBrowserLibrary", root.callId, 1, 3],
    ["library-plan", "planLibraryChange", "library", 2, 3],
    ["collection", "organizeCollection", root.callId, 4, 6],
    ["collection-plan", "planCollectionChange", "collection", 5, 6],
  ]) {
    const call = structuredClone(sample);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    call.record.outcome = "done";
    call.record.started_at = new Date(start * 1000).toISOString();
    call.record.ended_at = new Date(end * 1000).toISOString();
    run.calls.push(call);
  }
  run.report = {
    results: [
      { kind: "domain", domain: "browserLibrary", operation: "curateBrowserLibrary", report: {} },
      { kind: "domain", domain: "collection", operation: "organizeCollection", report: {} },
    ],
    remaining: [],
  };
  const origin = "https://scope.library.vibestudio.invalid";
  const url = origin + world.assignment.path;
  const note = `${world.assignment.heading}: ${url}`;
  diagnostics.managedBrowserHandoff = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: world.caseId,
      passed: true,
      checks: { browser: true, collection: true, reports: true, dependency: true },
      browser: {
        origin,
        assignments: { newNotes: 17 },
        transitions: [{ after: { id: "latest", bookmarks: [{ id: 17, url }] } }],
      },
      collection: {
        assignments: { inbox: "owned-inbox" },
        transitions: [{ after: { nodes: [{ id: "owned-inbox", note }] } }],
      },
      panelId: "owned-inbox",
      note,
      receipts: [
        { snapshotId: "earlier", bookmarkId: 17, url },
        { snapshotId: "latest", bookmarkId: 17, url },
      ],
    },
  };
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /Browser handoff must bind the persisted panel note to the verified browser bookmark/u
  );
});

test("Browser library export rejects a bookmark from another origin", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "browser-library-live-hold-ambiguous-runbook";
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "personal" }));
  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "curateBrowserLibrary";
  leaf.record.outcome = "done";
  for (const [id, name, parent] of [
    ["plan-1", "planLibraryChange", leaf.callId],
    ["find-1", "findBookmark", "plan-1"],
    ["plan-2", "planLibraryChange", leaf.callId],
    ["find-2", "findBookmark", "plan-2"],
    ["apply", "applyLibraryChange", leaf.callId],
    ["verify", "verifyLibraryChange", "apply"],
    ["saved", "verifySavedReference", "verify"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  const namespace = "7b1612e9-3165-4279-a9d0-33dc53c36f80";
  const origin = `https://${namespace}.library.vibestudio.invalid`;
  const reading = `/System test ${namespace}/Reading`;
  const followUp = `/System test ${namespace}/Follow-up`;
  const folders = [reading, followUp];
  const snapshot = (id, folder) => ({
    id,
    availableFolders: folders,
    bookmarks: [{ id: 11, folder, title: "Runbook", url: origin + "/operations" }],
    visits: [],
  });
  const after = snapshot("after", followUp);
  run.report = {
    findings: [
      { status: "held", bookmarkId: null, evidence: ["before"] },
      { status: "verified", bookmarkId: 11, evidence: ["before", "after"] },
    ],
  };
  diagnostics.managedBrowserLibrary = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: "hold-ambiguous-runbook",
      origin,
      folders,
      baseline: snapshot("before", reading),
      transitions: [{ mutation: { kind: "file", id: 11, folder: followUp }, after }],
      assignments: { operations: 11 },
      passed: true,
      checks: { initial: true, exactEffects: true, report: true, metadata: true, outside: true },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  after.bookmarks[0].url = "https://outside.invalid/operations";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-outside-origin` }),
    /Browser library findings must cite the assigned store observations/u
  );
});

test("Collection field verification rejects collateral changes in the refreshed tree", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const { default: matchesFieldChange } = await import(pathToFileURL(path.join(
    checkouts.personal, "skills/collection-conductor/organizeCollection/applyCollectionChange",
    "verifyCollectionChange/verifyFieldChange/matchesFieldChange.ts"
  )).href);
  const before = {
    rootId: "root", complete: true, id: "before",
    nodes: [
      { id: "root", parentId: null, title: "Collection", note: null, source: "about/collection", contextId: "ctx" },
      { id: "agenda", parentId: "root", title: "Agenda", note: "First", source: "about/page", contextId: "ctx" },
      { id: "review", parentId: "root", title: "Review", note: "Keep", source: "about/page", contextId: "ctx" },
    ],
  };
  const mutation = { kind: "note", panelId: "agenda", text: "Updated" };
  const after = structuredClone({ ...before, id: "after" });
  after.nodes[1].note = mutation.text;
  assert.equal(matchesFieldChange(before, after, mutation), true);
  after.nodes[2].note = null;
  assert.equal(matchesFieldChange(before, after, mutation), false);
  after.nodes[2].note = before.nodes[2].note;
  after.nodes.reverse();
  assert.equal(matchesFieldChange(before, after, mutation), false);
});

test("Collection export rejects a held finding citing an unobserved panel tree", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "collection-live-hold-duplicate-agenda";
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "personal" }));
  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "organizeCollection";
  leaf.record.outcome = "done";
  for (const [id, name, parent] of [
    ["plan-1", "planCollectionChange", leaf.callId],
    ["locate-1", "locateCollectionPanel", "plan-1"],
    ["plan-2", "planCollectionChange", leaf.callId],
    ["locate-2", "locateCollectionPanel", "plan-2"],
    ["apply", "applyCollectionChange", leaf.callId],
    ["verify", "verifyCollectionChange", "apply"],
    ["field", "verifyFieldChange", "verify"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  const snapshot = (id, note) => ({
    id,
    complete: true,
    rootId: "owned-root",
    nodes: [
      { id: "owned-root", contextId: "ctx" },
      { id: "reference-panel", contextId: "ctx", note },
    ],
  });
  const mutation = { kind: "note", panelId: "reference-panel", text: "Leave with the project" };
  run.report = {
    results: [
      { status: "held", panelId: null, evidence: ["before"] },
      { status: "verified", panelId: "reference-panel", evidence: ["before", "after"] },
    ],
  };
  diagnostics.managedCollection = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      rootId: "owned-root",
      caseId: "hold-duplicate-agenda",
      baseline: snapshot("before", null),
      transitions: [{ mutation, after: snapshot("after", mutation.text) }],
      assignments: { root: "owned-root", reference: "reference-panel" },
      passed: true,
      checks: { baseline: true, outsideUnchanged: true, exactEffects: true, reportMatches: true },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  run.report.results[0].evidence = ["fabricated"];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-unobserved` }),
    /Collection findings must cite ordered live snapshots/u
  );
});

test("Tendril export rejects a durable change that the live page did not show", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "tendril-live-timer-clear";
  const run = diagnostics.natlangTeacher;
  const slotId = "owned-board";
  const state = (minutes) => [{ key: "minutes", value: minutes }];
  const observed = [null, 10, 0].map((value, index) => ({
    id: `page-${index}`,
    slotId,
    build: "board-v1",
    revision: index,
    stored: value === null ? [] : state(value),
    displayed: value === null ? [] : state(value),
    exposed: ["clearTimer"],
  }));
  const presentation = { deviceId: "local:headless-host", slotId, state: "presented" };
  run.report = {
    state: "verified",
    presentation,
    findings: observed.slice(1).map((page, index) => ({
      status: "verified",
      evidence: [observed[index].id, page.id],
      page: structuredClone(page),
    })),
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "runTendril";
  leaf.record.outcome = "done";
  for (const [id, name, parent] of [
    ["present", "openPresentation", leaf.callId],
    ["select", "selectTendrilDevice", "present"],
    ["steps", "runSteps", leaf.callId],
    ["write", "reviewLiveStep", "steps"],
    ["write-verify", "verifyLiveStep", "write"],
    ["clear", "reviewLiveStep", "steps"],
    ["clear-verify", "verifyLiveStep", "clear"],
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  diagnostics.managedTendril = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: "timer-clear",
      presentation,
      observed,
      passed: true,
      checks: { presentation: true, baseline: true, exactEffects: true, report: true },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  observed[2].displayed = state(10);
  run.report.findings[1].page.displayed = state(10);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-stale-page` }),
    /Tendril findings must bind each effect/u
  );
});

test("Tendril export requires a new native failed history entry for rollback", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "tendril-live-retire-bad-during-intake";
  const run = diagnostics.natlangTeacher;
  const slotId = "live-board";
  const phase = { key: "phase", value: "intake" };
  const label = { key: "label", value: "Intake receipts" };
  const presentation = { deviceId: "local:headless-host", slotId, state: "presented" };
  const observed = [[], [phase], [phase, label], [phase, label], [phase, label]].map(
    (rows, index) => ({
      id: `page-${index}`,
      slotId,
      build: "board-v1",
      revision: Math.min(index, 2),
      stored: rows,
      displayed: structuredClone(rows),
      exposed: ["returnToIntake"],
    })
  );
  const working = { entryKey: "entry-old", buildKey: "before-build", state: "proven" };
  const failed = { entryKey: "entry-new", buildKey: "candidate-build", state: "failed" };
  const panels = observed.map((_, index) => ({
    buildKey: working.buildKey,
    proof: index < 3 ? [working] : [failed, working],
  }));
  run.report = {
    state: "verified",
    presentation,
    findings: observed.slice(1).map((page, index) => ({
      status: index === 2 ? "rolled-back" : "verified",
      evidence: [observed[index].id, page.id],
      page: structuredClone(page),
    })),
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  leaf.record.definition.name = "runTendril";
  leaf.record.outcome = "done";
  for (const [id, name, parent] of [
    ["present", "openPresentation", leaf.callId],
    ["select", "selectTendrilDevice", "present"],
    ["steps", "runSteps", leaf.callId],
    ...[0, 1, 2, 3].flatMap((index) => {
      const branch = index === 2 ? "Build" : "Live";
      return [
        [`step-${index}`, `review${branch}Step`, "steps"],
        [`verify-${index}`, `verify${branch}Step`, `step-${index}`],
      ];
    }),
  ]) {
    const call = structuredClone(leaf);
    call.callId = call.summary.call_id = id;
    call.record.definition.name = name;
    call.record.parent_call_id = parent;
    run.calls.push(call);
  }
  diagnostics.managedTendril = {
    contextId: "ctx",
    verification: {
      contextId: "ctx",
      caseId: "retire-bad-during-intake",
      presentation,
      observed,
      passed: true,
      checks: {
        presentation: true,
        baseline: true,
        exactEffects: true,
        report: true,
        nativeBuilds: true,
      },
      builds: {
        panels,
        outcomes: [{ pageId: observed[3].id, outcome: "failed" }],
        edits: [{ candidate: "broken-boot", commandId: "owned-source-edit" }],
      },
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  panels[3].proof = [working];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-no-failed-entry` }),
    /Tendril build effects must include native proof/u
  );
});

test("terminal checklist export binds the report to a new PTY after restart", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "terminal-checklist-live-restart-state";
  const run = diagnostics.natlangTeacher;
  const screens = [
    { sessionId: "session", ptyId: "initial", cols: 80, rows: 24, checked: [] },
    { sessionId: "session", ptyId: "initial", cols: 80, rows: 24, checked: ["2"] },
    { sessionId: "session", ptyId: "restarted", cols: 62, rows: 18, checked: ["2"] },
  ];
  run.report = { status: "verified", continuation: "restart", screens: structuredClone(screens) };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "verifyChecklist";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  diagnostics.managedChecklist = {
    contextId: "ctx",
    verification: {
      caseId: "restart-state",
      sessionId: "session",
      continuation: "restart",
      screens,
      passed: true,
      checks: Object.fromEntries(
        [
          "exactScreenSequence",
          "sessionPreserved",
          "terminalIdentity",
          "viewport",
          "joinedReport",
          "retired",
        ].map((name) => [name, true])
      ),
    },
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  // A matching report and fixture still cannot attest a restart with the old PTY.
  screens[2].ptyId = run.report.screens[2].ptyId = "initial";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-unchanged-pty` }),
    /must match the live PTY sequence and verified cleanup/u
  );
});

test("onboarding export requires the assigned workspace and canonical owner destination", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "onboarding-live-device-settings";
  const run = diagnostics.natlangTeacher;
  const receipt = "1".repeat(64);
  const route = {
    capabilityId: "connection.device",
    action: "setup",
    via: "shell-navigation",
    destination: "settings/devices",
  };
  run.report = { status: "route-client", receipt, route };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "planSetup";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  diagnostics.managedSetup = {
    contextId: "ctx",
    verification: {
      caseId: "device-settings",
      status: "route-client",
      receipt,
      route,
      passed: true,
      checks: Object.fromEntries(
        [
          "workspaceHeadUnchanged",
          "generationBound",
          "exactOwnerRows",
          "authoritativeRoute",
          "unknownAndUnverified",
        ].map((name) => [name, true])
      ),
    },
  };
  await save();
  await assert.rejects(
    () => exportLiveTeacherWorkflow({ ...options, cases }),
    /assigned workspace/u
  );
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "personal" }));
  await exportLiveTeacherWorkflow({ ...options, cases });
  run.report.route = { ...route, destination: "settings/connection" };
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-route` }),
    /must match its actual owner receipt and canonical route/u
  );
});

test("workspace integration binds conflict source and verified state without browser evidence", async (t) => {
  const { options, entry, diagnostics, save } = await fixture(t);
  entry.test.name = "workspace-integration-theme-locale";
  const before = { kind: "event", eventId: "before" };
  const after = { kind: "event", eventId: "after" };
  const source = { kind: "event", eventId: "incoming" };
  diagnostics.natlangTeacher.programPath =
    "skills/vibestudio-vcs/integration/integrateWorkspace.nl";
  diagnostics.natlangTeacher.report = { status: "integrated", head: JSON.stringify(after) };
  diagnostics.natlangTeacher.calls[0].record.definition.name = "integrateWorkspace";
  diagnostics.workspaceIntegrationWorld = {
    kind: "vcs-integration",
    contextId: "ctx",
    commonSeedEvent: { kind: "event", eventId: "seed" },
    source,
    before,
    after,
  };
  diagnostics.workspaceIntegrationVerification = {
    passed: true,
    reasons: [],
    head: after,
    evidence: [{ workingHead: after }],
  };
  await save();
  await exportLiveTeacherWorkflow(options);
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  assert.equal(manifest.world.seed_revision, "seed");
  assert.equal(manifest.world.source_revision, "incoming");
  assert.deepEqual(manifest.required_effect_kinds, ["workspace"]);
  assert.deepEqual(manifest.source_groups, ["vibestudio:workspace-integration:settings-conflict"]);

  const dir = path.join(path.dirname(options.trajectory), "worlds");
  const directory = path.join(dir, "skills/system-testing");
  await mkdir(path.join(directory, "local-messaging"), { recursive: true });
  await Promise.all(
    [
      ["content-project-worlds", "export const contentProjectWorlds = [];"],
      ["phone-setup-world", "export const phoneSetupUnavailable = undefined;"],
      ["client-admission-worlds", "export const managedClientAdmissionWorlds = [];"],
      ["log-cursor-worlds", "export const managedLogCursorWorlds = [];"],
      ["log-handoff-worlds", "export const managedLogHandoffWorlds = [];"],
      ["build-performance-worlds", "export const buildPerformanceWorlds = [];"],
      ["tour-rehearsal-worlds", "export const tourRehearsalWorlds = [];"],
      ["explorer-probe-worlds", "export const explorerTextWorlds = [];"],
      ["gmail-compose-history-worlds", "export const gmailComposeHistoryWorlds = [];"],
      ["unit-identity-worlds", "export const unitIdentityWorlds = [];"],
      ["transcript-cursor-worlds", "export const transcriptCursorWorlds = [];"],
      ["remote-route-worlds", "export const remoteRouteWorlds = [];"],
      ["remote-commission-worlds", "export const liveRemoteCommissionWorld = null;"],
      ["remote-deployment-worlds", "export const managedDeploymentWorlds = [];"],
      ["notification-worlds", "export const notificationWorlds = [];"],
      ["retained-triage-worlds", "export const retainedTriageWorlds = [];"],
      ["github-setup-worlds", "export const githubSetupWorlds = [];"],
      ["github-diagnosis-worlds", "export const managedGitHubDiagnosisWorlds = [];"],
      ["adventure-review-worlds", "export const managedAdventureWorlds = [];"],
      ["adventure-transition-world", "export const programmedAdventureWorld = null;"],
      ["drive-checkpoint-worlds", "export const managedDriveCheckpointWorlds = [];"],
      ["drive-sharing-worlds", "export const managedDriveSharingWorlds = [];"],
      ["regency-review-worlds", "export const managedRegencyWorlds = [];"],
      ["examples-portfolio-worlds", "export const managedExamplesPortfolioWorlds = [];"],
      ["template-release-worlds", "export const templateReleaseWorlds = [];"],
      ["template-candidate-worlds", "export const templateCandidateManagedWorlds = [];"],
      ["delivery-history-worlds", "export const deliveryHistoryWorlds = []; export const chatDeliveryWorlds = [];"],
      ["android-audit-worlds", "export const androidAuditWorlds = [];"],
      ["android-install-worlds", "export const androidInstallWorlds = [];"],
      ["android-pair-worlds", "export const androidPairWorlds = [];"],
      ["pdf-media-worlds", "export const pdfMediaWorlds = [];"],
      ["publication-revision-worlds", "export const publicationRevisionWorlds = [];"],
      ["eval-recovery-worlds", "export const managedEvalRecoveryWorlds = [];"],
      ["pdf-layout-worlds", "export const managedPdfLayoutWorlds = [];"],
      ["offline-dictation-worlds", "export const managedDictationWorlds = [];"],
      ["native-suite-worlds", "export const managedNativeSuiteWorlds = [];"],
      ["git-bridge-review-worlds", "export const managedGitBridgeReviewWorlds = [];"],
      ["vcs-delivery-worlds", "export const managedVcsDeliveryWorlds = [];"],
      ["web-brief-worlds", "export const managedWebBriefWorlds = []; export const managedResearchIntakeWorlds = []; export const managedResearchHandoffWorlds = []; export const researchHandoffWork = [];"],
      ["architecture-boundary-worlds", "export const managedArchitectureBoundaryWorlds = [];"],
      ["release-review-handoff-worlds", "export const managedReleaseReviewHandoffWorlds = [];"],
      ["extension-release-worlds", "export const managedExtensionReleaseWorlds = [];"],
      ["unit-design-worlds", "export const managedUnitDesignWorlds = [];"],
      ["authority-review-worlds", "export const managedAuthorityReviewWorlds = [];"],
      ["problem-draft-worlds", "export const managedProblemDraftWorlds = [];"],
      ["agentic-change-worlds", "export const managedAgenticChangeWorlds = [];"],
      ["gad-review-worlds", "export const managedGadReviewWorlds = [];"],
      ["terminal-check-worlds", "export const managedTerminalCheckWorlds = [];"],
      ["terminal-evidence-worlds", "export const managedTerminalEvidenceWorlds = [];"],
      ["integration-readiness-worlds", "export const managedIntegrationReadinessWorlds = [];"],
      [
        "owned-operations-worlds",
        "export const ownedOperationsWorlds = [], ownedOperationsComposedWorlds = [];",
      ],
      ["unit-repair-worlds", "export const workerRepairWorlds = [];"],
      ["local-messaging/worlds", "export const localMessagingWorlds = [];"],
      ["panel-repair-world", "export const panelRepairWorlds = [];"],
      ["scratch-handoff-worlds", "export const managedScratchWorlds = [];"],
      ["integration-handoff-worlds", "export const integrationHandoffWorlds = [];"],
      ["automation-lifecycle-worlds", "export const managedAutomationWorlds = []; export const managedAutomationPlanningWorlds = [];"],
      ["publication-preflight-worlds", "export const managedPublicationWorlds = [];"],
      ["pdf-intake-worlds", "export const managedPdfWorlds = [];"],
      ["presentation-worlds", "export const managedPresentationWorlds = [];"],
      ["authoring-worlds", "export const managedAuthoringWorlds = [];"],
      ["session-replay-worlds", "export const managedSessionReplayWorlds = [];"],
      ["testkit-cleanup-worlds", "export const managedTestkitCleanupWorlds = [];"],
      ["verified-memory-worlds", "export const managedMemoryWorlds = [];"],
      ["onboarding-worlds", "export const managedSetupWorlds = [];"],
      ["checklist-worlds", "export const managedChecklistWorlds = [];"],
      ["grimoire-worlds", "export const managedGrimoireWorlds = [];"],
      ["spectrolite-worlds", "export const managedSpectroliteWorlds = [];"],
      ["news-worlds", "export const managedNewsWorlds = [];"],
      ["tendril-worlds", "export const managedTendrilWorlds = [];"],
      ["collection-worlds", "export const managedCollectionWorlds = [];"],
      ["browser-import-worlds", "export const managedBrowserImportWorlds = [];"],
      ["browser-library-worlds", "export const managedBrowserLibraryWorlds = [];"],
      ["browser-handoff-worlds", "export const managedBrowserHandoffWorlds = [];"],
      ["mission-planning-worlds", "export const managedMissionPlanningWorlds = [];"],
      ["mission-facility-worlds", "export const missionFacilityWorlds = [];"],
      ["channel-roster-worlds", "export const managedChannelRosterWorlds = [];"],
      ["panel-health-worlds", "export const managedPanelHealthWorlds = [];"],
      ["google-setup-worlds", "export const managedGoogleSetupWorlds = [];"],
      ["provenance-history-worlds", "export const managedProvenanceHistoryWorlds = [];"],
      ["personal-resume-worlds", "export const personalResumeWorlds = [];"],
      ["runtime-program-worlds", "export const managedRuntimeProgramWorlds = [];"],
      ["incident-continuation-worlds", "export const incidentContinuationWorlds = [];"],
      ["log-audit-worlds", "export const managedLogAuditWorlds = [];"],
      ["local-model-comparison-worlds", "export const localModelComparisonWorlds = [];"],
      [
        "vcs-integration-worlds",
        `export const workspaceIntegrationWorlds = [{id:"notification-rollout", sourceGroup:"rollout", files:[{path:"notifications/channels.json"},{path:"notifications/retries.json"}]}];`,
      ],
    ].map(([file, contents]) => writeFile(path.join(directory, `${file}.ts`), contents))
  );
  const cases = await loadLiveTeacherCases({ "system-testing": dir });
  entry.test.name = "workspace-integration-notification-rollout";
  diagnostics.workspaceIntegrationWorld.privateOracle = {
    files: [
      {
        path: "notifications/channels.json",
        fileId: "channels",
        sourceChangeIds: ["incoming:channels"],
      },
      {
        path: "notifications/retries.json",
        fileId: "retries",
        sourceChangeIds: ["incoming:retries"],
      },
    ],
  };
  diagnostics.workspaceIntegrationVerification.verificationPaths = ["notifications/channels.json"];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-incomplete` }),
    /must verify every assigned file/u
  );
});

test("worker repair export binds the actual workerd artifact and candidate state", async (t) => {
  const { options, entry, diagnostics, save } = await fixture(t);
  entry.test.name = "worker-label-repair-type-mismatch";
  const revisions = { before: "seed-head", after: "candidate-head" };
  const target = "workers/labels";
  diagnostics.natlangTeacher.programPath = "skills/workspace-dev/unit-repair/repairUnit.nl";
  diagnostics.natlangTeacher.report = { status: "verified", revision: revisions.after };
  diagnostics.natlangTeacher.calls[0].record.definition.name = "repairUnit";
  diagnostics.unitRepairWorld = {
    contextId: "ctx",
    unit: target,
    ...revisions,
    baseline: [{ severity: "error", source: "tsc" }],
  };
  const receipt = {
    protocol: "unit-verification-receipt.v1",
    operation: "test",
    contextId: "ctx",
    target,
    stateHash: "current-state",
    runtime: "workerd",
    artifactKey: "selected-artifact",
    executionDigest: "selected-execution",
  };
  const protectedFiles = [
    { path: target + "/package.json", sha256: "a".repeat(64) },
    { path: target + "/index.test.ts", sha256: "b".repeat(64) },
  ];
  diagnostics.unitRepairVerification = {
    passed: true,
    checks: {
      changedRevision: true,
      sourceBuild: true,
      originalManifestAndTests: true,
      originalWorkerdSuite: true,
    },
    evidence: {
      revision: revisions.after,
      protectedSource: { before: protectedFiles, after: protectedFiles },
      build: { status: "ok", stateHash: "current-state" },
      tests: { status: "passed", report: { total: 5 }, receipt },
    },
  };
  receipt.stateHash = "stale-state";
  await save();
  await assert.rejects(() => exportLiveTeacherWorkflow(options), /compiler and original workerd/);
  receipt.stateHash = "current-state";
  await save();
  await exportLiveTeacherWorkflow(options);
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  assert.equal(manifest.world.seed_revision, revisions.before);
  assert.deepEqual(manifest.required_effect_kinds, ["workspace"]);
  assert.deepEqual(manifest.source_groups, ["vibestudio:unit-repair:worker-label-normalizer"]);
});

test("content export requires independent semantic review of exact committed bytes", async (t) => {
  const { options, entry, diagnostics, save } = await fixture(t);
  entry.test.name = "content-project-release-runbook";
  const event = { kind: "event", eventId: "local-event" };
  const head = JSON.stringify(event);
  const request = { goal: "Deliver a runbook", documentRoles: ["rollback"], facts: [] };
  const repoPath = "projects/release";
  diagnostics.natlangTeacher.programPath = "skills/workspace-dev/content-project/deliverProject.nl";
  diagnostics.natlangTeacher.report = {
    status: "committed",
    repoPath,
    eventId: event.eventId,
    head,
  };
  diagnostics.natlangTeacher.calls[0].record.definition.name = "deliverProject";
  diagnostics.contentProjectWorld = {
    kind: "content-project",
    contextId: "ctx",
    repoPath,
    before: "initial",
    after: head,
    request,
  };
  const reviewInput = {
    actual: {
      contextId: "ctx",
      committedEvent: event,
      documents: [{ path: "README.md", text: "Actual committed document" }],
    },
    expected: request,
    rubric: "Ground the runbook in the supplied facts",
  };
  diagnostics.contentProjectVerification = {
    passed: true,
    reasons: [],
    evidence: [{ inspected: head }],
    semanticReviewRequired: true,
    semanticReviewInput: reviewInput,
  };
  await save();
  await assert.rejects(() => exportLiveTeacherWorkflow(options), /reviewer must be configured/);
  const review = async (input, teacher) => {
    assert.deepEqual(input, reviewInput);
    assert.notEqual(teacher, "provider:other");
    return {
      schema: "natlang.live-workflow-review/1",
      model: "provider:other",
      input,
      exchange: { request: { messages: [] }, reply: { calls: [] } },
      verdict: { accepted: true },
    };
  };
  await assert.rejects(
    () =>
      exportLiveTeacherWorkflow({
        ...options,
        review: async (input, teacher) => ({ ...(await review(input, teacher)), model: teacher }),
      }),
    /did not bind/
  );
  await exportLiveTeacherWorkflow({ ...options, review });
  const proof = JSON.parse(await readFile(path.join(options.out, "verification.json"), "utf8"));
  const workspaceEvidence = JSON.parse(
    await readFile(path.join(options.out, "workspace.json"), "utf8")
  );
  assert.deepEqual(proof.requirements, { semantic_review: true });
  assert.equal(proof.checks.independentSemanticReview, true);
  assert.deepEqual(workspaceEvidence.semanticReview.input, reviewInput);
  assert.equal(proof.calls.length, 2);
  // Legacy committed-project consumers bind the same explicit lifecycle, while
  // preserving byte-bound historical reviews with the original input format.
  const baseline={kind:"event",eventId:"baseline"};
  diagnostics.contentProjectWorld.before=JSON.stringify(baseline);
  delete reviewInput.actual.committedEvent;
  reviewInput.actual.lifecycle={requestedDisposition:"committed",baseline:{committedEvent:baseline,workingHead:baseline,clean:true,protectedMainEventId:"main"},current:{committedEvent:event,workingHead:event,clean:true,protectedMainEventId:"main"},delta:{committedEventChanged:true,workingHeadChanged:true,protectedMainChanged:false}};
  await save();
  await exportLiveTeacherWorkflow({...options,out:options.out+"-lifecycle",review});
  reviewInput.actual.lifecycle.baseline.committedEvent={kind:"event",eventId:"forged"};
  await save();
  await assert.rejects(()=>exportLiveTeacherWorkflow({...options,out:options.out+"-forged",review}),/independent content-project readback/);
});

test("owned operations export requires persisted readbacks and absence after teardown", async (t) => {
  const { options, entry, diagnostics, save } = await fixture(t);
  entry.test.name = "owned-operations-release-audit-continuation";
  diagnostics.natlangTeacher.programPath = "skills/agents/operational-handoff/operate.nl";
  diagnostics.natlangTeacher.report = { kind: "release-continuation" };
  diagnostics.natlangTeacher.calls[0].record.definition.name = "operate";
  diagnostics.ownedOperationsWorld = {
    kind: "owned-operations",
    contextId: "ctx",
    caseId: "release-audit-continuation",
    request: { kind: "release-continuation" },
  };
  diagnostics.ownedOperationsVerification = {
    passed: true,
    checks: {
      reportedHandles: true,
      reportedCleanup: true,
      programRequestedCleanup: true,
      actualNoOwnedWorkersRemain: true,
      actualNoOwnedContextsRemain: true,
    },
  };
  diagnostics.ownedOperationsCleanupErrors = [];
  const audit = {
    opened: [{ handle: { id: "owned-worker" } }],
    snapshots: [{ phase: "before-cleanup", value: { revision: 2 } }],
    remainingEntityIds: ["owned-worker"],
    remainingContextIds: [],
  };
  diagnostics.ownedOperationsAudit = audit;
  await save();
  await assert.rejects(() => exportLiveTeacherWorkflow(options), /persistence and teardown/);
  audit.remainingEntityIds = [];
  await save();
  await exportLiveTeacherWorkflow(options);
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  assert.equal(manifest.world.case_id, "release-audit-continuation");
});

test("managed phone setup export binds the no-desktop outcome to the exact live read", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "phone-setup-live-desktop-unavailable";
  const world = cases.get(id);
  assert.equal(world.family, "system-live-phone-setup");
  const operationId = "01234567-89ab-4cde-8fab-0123456789ab";
  const request = { goal: world.goal, operationId };
  const observed = {
    receipt: operationId + ":assignment",
    platform: "ios",
    providerId: null,
    deviceId: null,
    desktops: [],
    pairedDeviceId: null,
  };
  const report = {
    status: "desktop-unavailable",
    pairedDeviceId: null,
    guidance: "Open the desktop app on this account.",
    evidenceIds: [observed.receipt],
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      bytes: Buffer.byteLength(text),
      hash: createHash("sha256").update(text).digest("hex"),
    };
  };
  entry.test.name = id;
  diagnostics.managedPhoneSetup = {
    contextId: "ctx",
    caseId: id,
    request,
    observed,
    passed: true,
    checks: { assignedStart: true, noEligibleDesktop: true, reportMatches: true },
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs = {}, value = null) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs,
      output: ref(value),
      effects: [],
    },
  });
  const read = call("readAssignment", "setUpPhone", { operationId: ref(operationId) }, observed);
  read.record.effects.push({
    service: "phoneSetupRead",
    method: "start",
    args: ref([operationId]),
    result: ref(observed),
  });
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    rootCallIds: ["runWorkflow"],
    report,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    calls: [
      call("runWorkflow", null),
      call("setUpPhone", "runWorkflow", { request: ref(request) }, report),
      read,
      call("discoverPhone", "setUpPhone", { assignment: ref(observed) }),
      call("chooseDesktop", "discoverPhone", { assignment: ref(observed) }),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const exported = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  assert.equal(exported.world.assigned_platform, "ios");
  assert.deepEqual(exported.source_groups, ["vibestudio:phone-setup:phone-provider-discovery"]);

  read.record.effects[0].result = ref({ ...observed, receipt: "foreign-assignment" });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /recorded read-only desktop decision/u
  );
  read.record.effects[0].result = ref(observed);
  diagnostics.natlangTeacher.calls[3].record.effects.push({
    service: "phoneSetupPrepare",
    method: "prepare",
  });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /recorded read-only desktop decision/u
  );
});

test("GAD export rejects a stale recap and a roster follow-up from a different snapshot", async (t) => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  for (const suffix of ["empty-roster", "latest-handoff-question"]) {
    const { options, diagnostics, entry, save } = await fixture(t);
    const id = `gad-review-live-${suffix}`;
    const { assignment } = cases.get(id);
    const pins = JSON.parse(await readFile(options.pins, "utf8"));
    await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
    entry.test.name = id;
    entry.execution.provenance.channelId = "owned";
    const operationId = "01234567-89ab-4cde-8fab-0123456789ab";
    const request = { goal: assignment.goal, view: assignment.view, operationId };
    const seeded = assignment.messages.map((text, i) => ({
      messageId: "message-" + i,
      seq: i + 2,
      text,
    }));
    const ref = (value) => {
      const text = JSON.stringify(value);
      return {
        complete: true,
        hash: createHash("sha256").update(text).digest("hex"),
        bytes: Buffer.byteLength(text),
      };
    };
    const prototype = diagnostics.natlangTeacher.calls[0];
    const call = (name, parent, inputs, output) => ({
      callId: name,
      summary: { ...prototype.summary, call_id: name },
      record: {
        ...prototype.record,
        call_id: name,
        parent_call_id: parent,
        definition: { name },
        outcome: "done",
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output),
        effects: [],
      },
    });
    function addEffect(row, service, method, args, result) {
      const effect = { service, method, args: ref(args), result: ref(result) };
      row.record.effects.push(effect);
      return effect;
    }
    let report;
    let stages;
    let invalidate;
    const observations = { health: null, followUp: null, tail: null };
    if (request.view === "triage") {
      const kind = "empty-roster";
      const finding = {
        kind,
        count: 1,
        inspector: "inspectChannelRoster",
        evidence: "No active participants",
      };
      const health = {
        receipt: operationId + ":health",
        channelId: "owned",
        branchId: "main",
        integrity: "ok",
        activity: "idle",
        findings: [finding],
      };
      const followUp = {
        receipt: operationId + ":follow-up",
        kind,
        inspector: finding.inspector,
        counters: [{ name: "activeParticipants", count: 0 }],
      };
      observations.health = health;
      observations.followUp = followUp;
      const judgment = { kind, urgency: "investigate" };
      report = {
        health: { evidence: health, status: "investigate", judgments: [judgment] },
        followUp,
        conversation: null,
      };
      const read = call("readHealth", "reviewHealth", { operationId }, health);
      const follow = call(
        "inspectFinding",
        "reviewChannel",
        { healthReceipt: health.receipt, kind },
        followUp
      );
      addEffect(read, "gadHealth", "observe", [operationId], health);
      const effect = addEffect(follow, "gadFollowUp", "inspect", [health.receipt, kind], followUp);
      stages = [
        call("reviewHealth", "reviewChannel", { operationId }, report.health),
        read,
        call("classifyFinding", "reviewHealth", { finding }, judgment),
        call(
          "chooseFollowUp",
          "reviewChannel",
          { health: report.health, goal: assignment.goal },
          kind
        ),
        follow,
      ];
      invalidate = () => {
        effect.args = ref(["stale-health", kind]);
      };
    } else {
      const latest = seeded.at(-1);
      const tail = {
        receipt: operationId + ":tail",
        channelId: "owned",
        status: "observed",
        standing: "awaiting-agent",
        range: { fromSeq: 1, toSeq: latest.seq, envelopes: latest.seq },
        latest: { seq: latest.seq, speaker: "user", text: latest.text },
      };
      observations.tail = tail;
      report = {
        health: null,
        followUp: null,
        conversation: {
          evidence: tail,
          meaning: "other",
          note: "The handoff question is still unanswered.",
        },
      };
      const read = call("readConversation", "reviewConversation", { operationId }, tail);
      addEffect(read, "gadConversation", "read", [operationId], tail);
      const interpreted = call(
        "interpretLatest",
        "reviewConversation",
        { evidence: tail, goal: assignment.goal },
        report.conversation
      );
      stages = [
        call(
          "reviewConversation",
          "reviewChannel",
          { operationId, goal: assignment.goal },
          report.conversation
        ),
        read,
        interpreted,
      ];
      invalidate = () => {
        interpreted.record.inputs.evidence = ref({ ...tail, latest: seeded[0] });
      };
    }
    diagnostics.managedGadReview = {
      contextId: "ctx",
      channelId: "owned",
      caseId: suffix,
      request,
      seeded,
      observations,
      passed: true,
      checks: { observations: true, report: true },
    };
    diagnostics.natlangTeacher = {
      ...diagnostics.natlangTeacher,
      programPath: "skills/vibestudio-workflows/runWorkflow.nl",
      rootCallIds: ["runWorkflow"],
      report,
      calls: [
        call("runWorkflow", null, {}, null),
        call("reviewChannel", "runWorkflow", { request }, report),
        ...stages,
      ],
    };
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
    assert.equal(manifest.world.channel_id, "owned");
    assert.equal(manifest.world.view, request.view);
    invalidate();
    await save();
    await assert.rejects(
      exportLiveTeacherWorkflow({ ...options, cases }),
      /GAD (roster triage|recap)/u
    );
  }
});

test("terminal export rejects substituted check arguments and a missing decision to hold", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "terminal-check-live-pipeline-bounded-output";
  const { assignment } = cases.get(id);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = id;
  const operationId = "01234567-89ab-4cde-8fab-0123456789ab";
  const request = { goal: assignment.goal, operationId };
  const plan = {
    receipt: operationId + ":plan",
    checks: assignment.checks.map(({ id, purpose, prerequisites, intent }) => ({
      id,
      purpose,
      prerequisites,
      mode: intent.kind,
    })),
  };
  const outcomes = assignment.checks
    .filter((check) => check.expected)
    .map(({ id, expected }) => ({
      result: {
        receipt: operationId + ":check:" + id,
        id,
        status: "complete",
        exitCode: expected.exitCode,
        stdout: expected.stdout,
        stderr: "",
        timedOut: false,
        truncated: expected.status === "output-truncated",
      },
      status: expected.status,
    }));
  const report = { assignmentReceipt: plan.receipt, outcomes, held: ["compare"] };
  diagnostics.managedTerminalChecks = {
    contextId: "ctx",
    caseId: assignment.id,
    request,
    plan,
    results: outcomes.map(({ result }) => result),
    passed: true,
    checks: { plan: true, processes: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (callId, name, parent, inputs, output, effects = []) => ({
    callId,
    summary: { ...prototype.summary, call_id: callId },
    record: {
      ...prototype.record,
      call_id: callId,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const checkEffect = (service, method, args, value) => ({
    service,
    method,
    args: ref(args),
    result: ref(value),
  });
  const choice = (index, selected) =>
    call(
      "choice-" + index,
      "selectNextCheck",
      "terminal",
      { goal: assignment.goal, checks: plan.checks, outcomes: outcomes.slice(0, index) },
      selected
    );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", "runWorkflow", null, {}, null),
      call("terminal", "runTerminalChecks", "runWorkflow", { request }, report),
      call("plan", "readAssignedChecks", "terminal", { operationId }, plan, [
        checkEffect("terminalCheckRead", "observe", [operationId], plan),
      ]),
      ...outcomes.flatMap(({ result, status }, i) => [
        choice(i, result.id),
        call(
          "execution-" + i,
          "performCheck",
          "terminal",
          { assignmentReceipt: plan.receipt, checkId: result.id },
          result,
          [checkEffect("terminalCheckRun", "execute", [plan.receipt, result.id], result)]
        ),
        call("classification-" + i, "classifyResult", "terminal", { result }, status),
      ]),
      choice(outcomes.length, null),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.world.process_checks, ["pipeline", "sequence", "compare"]);

  const execution = diagnostics.natlangTeacher.calls.find(({ callId }) => callId === "execution-1");
  const effect = execution.record.effects[0];
  const original = effect.args;
  effect.args = ref([plan.receipt, "compare"]);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /record every selection/u);
  effect.args = original;
  diagnostics.natlangTeacher.calls.pop();
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /record every selection/u);
});

test("integration readiness rejects leaked credential fields and substituted lookup IDs", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "integration-readiness-live-required-transport-unbound";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const operationId = "01234567-89ab-4cde-8fab-0123456789ab";
  const request = { goal: assignment.goal, operationId };
  const plan = {
    receipt: operationId + ":integration",
    destinations: assignment.destinations.map(({ id, purpose, use, required }) => ({
      id,
      purpose,
      use,
      required,
    })),
  };
  const observations = assignment.destinations.map(({ id, state }) => ({
    id,
    receipt: operationId + ":binding:" + id,
    state,
    canRefresh: state === "active" ? false : null,
  }));
  const destinations = observations.map((observation) => ({
    observation,
    disposition: observation.state === "active" ? "ready" : "setup-needed",
  }));
  const coverage = {
    status: assignment.status,
    guidance: "Identify the publication provider and audience.",
  };
  const report = { ...coverage, planReceipt: plan.receipt, destinations, held: [] };
  diagnostics.managedIntegrationReadiness = {
    contextId: "ctx",
    caseId: assignment.id,
    request,
    plan,
    observations,
    passed: true,
    checks: { plan: true, bindings: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (callId, name, parent, inputs, output, effects = []) => ({
    callId,
    summary: { ...prototype.summary, call_id: callId },
    record: {
      ...prototype.record,
      call_id: callId,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const effect = (service, method, args, result) => ({
    service,
    method,
    args: ref(args),
    result: ref(result),
  });
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", "runWorkflow", null, {}, null),
      call("review", "reviewIntegration", "runWorkflow", { request }, report),
      call("plan", "readIntegrationPlan", "review", { operationId }, plan, [
        effect("integrationPlanRead", "observe", [operationId], plan),
      ]),
      ...destinations.flatMap((result, i) => {
        const { id } = result.observation;
        const args = { planReceipt: plan.receipt, destinationId: id };
        return [
          call("audience-" + i, "reviewAudience", "review", args, result),
          call("resolve-" + i, "resolveBinding", "audience-" + i, args, result.observation, [
            effect(
              "integrationCredentialLookup",
              "resolve",
              [plan.receipt, id],
              result.observation
            ),
          ]),
          call(
            "interpret-" + i,
            "interpretBinding",
            "audience-" + i,
            { observation: result.observation },
            result.disposition
          ),
        ];
      }),
      call(
        "summary",
        "summarizeCoverage",
        "review",
        { goal: assignment.goal, destinations: plan.destinations, reviews: destinations },
        coverage
      ),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.world.destinations, ["catalog-read", "catalog-publish"]);

  observations[0].credentialId = "private";
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /secret-free binding statuses/u
  );
  delete observations[0].credentialId;
  const resolve = diagnostics.natlangTeacher.calls.find(({ callId }) => callId === "resolve-1");
  resolve.record.effects[0].args = ref([plan.receipt, "catalog-read"]);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /both scoped host lookups/u
  );
});

test("agentic change export joins the captured source revision and its planning tree", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "agentic-change-live-channel-envelope-replay";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const { goal, owner, consumers } = assignment;
  const request = { goal, contextId: "ctx" };
  const source = {
    contextId: "ctx",
    revision: "workspace-event:assigned",
    guides: [owner, ...consumers].map((unit) => ({ unit, excerpt: "Installed guide" })),
  };
  const units = { owner, consumers, blockers: [] };
  const history = {
    persistedContract: true,
    retainedHistoryChecks: ["Reduce existing history.", "Check a freshly persisted outcome."],
  };
  const impact = { ...units, ...history };
  const builds = { focusedTests: [owner, ...consumers], rebuild: assignment.rebuild };
  const canary = {
    surface: assignment.surface,
    probe: "Complete a turn and reopen its transcript.",
    observations: ["Stored and rendered terminal outcome"],
    cleanup: ["Retire the canary channel"],
  };
  const report = { contextId: "ctx", revision: source.revision, impact, builds, canary };
  const probe = { probe: canary.probe, observations: canary.observations };
  diagnostics.managedAgenticChange = {
    caseId: assignment.id,
    request,
    source,
    passed: true,
    checks: { source: true, unchanged: true, ownership: true, verification: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const readback = {
    service: "agenticChangeSource",
    method: "read",
    args: ref(["ctx"]),
    result: ref(source),
  };
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("planAgenticChange", "runWorkflow", { request }, report),
      call("readSource", "planAgenticChange", { contextId: "ctx" }, source, [readback]),
      call("reviewImpact", "planAgenticChange", { goal, sources: source }, impact),
      call("findOwners", "reviewImpact", { goal, sources: source }, units),
      call("reviewHistory", "reviewImpact", { goal, units }, history),
      call("planVerification", "planAgenticChange", { goal, impact }, { builds, canary }),
      call("planBuilds", "planVerification", { impact }, builds),
      call("planCanary", "planVerification", { goal, builds }, canary),
      call("chooseSurface", "planCanary", { goal, builds }, canary.surface),
      call("designProbe", "planCanary", { goal, surface: canary.surface }, probe),
      call("planCleanup", "planCanary", { surface: canary.surface, probe }, canary.cleanup),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const cleanup = diagnostics.natlangTeacher.calls.find(({ callId }) => callId === "planCleanup");
  cleanup.record.inputs.probe = ref({ ...probe, probe: "Reuse the parent agent." });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-unrelated-cleanup` }),
    /exact workspace revision/u
  );
  cleanup.record.inputs.probe = ref(probe);
  readback.result = ref({ ...source, revision: "workspace-event:foreign" });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /exact workspace revision/u
  );
});

test("local problem export requires persisted narrative and rejects a stale draft write", async (t) => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  for (const suffix of ["save-wrong-sort", "continue-workspace-error", "hold-stale-draft"]) {
    const { options, diagnostics, entry, save } = await fixture(t);
    const name = `problem-draft-live-${suffix}`;
    const { assignment } = cases.get(name);
    const pins = JSON.parse(await readFile(options.pins, "utf8"));
    await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
    entry.test.name = name;
    const { goal, account, defect, mode } = assignment;
    const held = mode === "stale";
    const opening = mode === "new";
    const request = { goal, operationId: "assignment" };
    const draft = { id: "draft", revision: 2, existingSections: opening ? [] : ["symptom"] };
    const review = {
      goal,
      consent: "save",
      account,
      draft: opening
        ? null
        : {
            id: draft.id,
            revision: draft.revision,
            basisRevision: held ? 1 : 2,
            userEdits: false,
          },
      evidence: [],
      frozen: null,
    };
    const source = { review, draft: opening ? null : draft };
    const sections = [
      ...(opening
        ? [
            {
              section: "symptom",
              claims: "unverified",
              markdown: [account.goal, account.observed, account.expected].join("\n"),
            },
          ]
        : []),
      {
        section: "verification",
        claims: "unverified",
        markdown: "Repeat the assigned operation. " + account.expected,
      },
    ];
    const write = { id: draft.id, revision: 3, sectionIds: sections.map(({ section }) => section) };
    const saved = held ? null : { ...write, sections };
    const next = held ? "refresh-own-edit" : "keep-local";
    const decision = opening ? "prepare-local-draft" : next;
    const report = { defect, status: held ? "held" : "saved-local", next, saved };
    diagnostics.managedProblemDraft = {
      caseId: assignment.id,
      contextId: "ctx",
      request,
      source,
      created: opening ? draft : null,
      saved,
      passed: true,
      checks: {
        source: true,
        result: true,
        opening: true,
        retention: true,
        persisted: true,
        localOnly: true,
      },
    };
    const ref = (value) => {
      const text = JSON.stringify(value);
      return {
        complete: true,
        hash: createHash("sha256").update(text).digest("hex"),
        bytes: Buffer.byteLength(text),
      };
    };
    const prototype = diagnostics.natlangTeacher.calls[0];
    const call = (name, parent, inputs, output, effects = []) => ({
      callId: name,
      summary: { ...prototype.summary, call_id: name },
      record: {
        ...prototype.record,
        call_id: name,
        parent_call_id: parent,
        definition: { name },
        outcome: "done",
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output),
        effects,
      },
    });
    const effect = (service, method, args, result) => ({
      service,
      method,
      args: ref(args),
      result: ref(result),
    });
    const append = call("appendDraft", "saveProblemDraft", { draft, sections }, write, [
      effect("problemDraftAppend", "append", [draft, sections], write),
    ]);
    diagnostics.natlangTeacher = {
      ...diagnostics.natlangTeacher,
      programPath: "skills/vibestudio-workflows/runWorkflow.nl",
      rootCallIds: ["runWorkflow"],
      report,
      calls: [
        call("runWorkflow", null, {}, null),
        call("saveProblemDraft", "runWorkflow", { request }, report),
        call("readDraft", "saveProblemDraft", { operationId: request.operationId }, source, [
          effect("problemDraftRead", "observe", [request.operationId], source),
        ]),
        call("reviewProblem", "saveProblemDraft", { request: review }, { defect, next: decision }),
        call("classifyDefect", "reviewProblem", { evidence: account }, defect),
        call("qualifyEvidence", "reviewProblem", { request: review }, {}),
        call("chooseDraftAction", "reviewProblem", { request: review, defect }, decision),
        ...(opening
          ? [
              call("openDraft", "saveProblemDraft", { operationId: request.operationId }, draft, [
                effect("problemDraftOpen", "create", [request.operationId], draft),
              ]),
              call("writeSymptom", "composeNarrative", { account }, sections[0]),
            ]
          : []),
        ...(!held
          ? [
              call(
                "composeNarrative",
                "saveProblemDraft",
                { account, existingSections: draft.existingSections },
                sections
              ),
              call("writeVerification", "composeNarrative", { account }, sections.at(-1)),
              append,
              call("confirmDraft", "saveProblemDraft", { write }, saved, [
                effect("problemDraftRead", "confirm", [write], saved),
              ]),
            ]
          : []),
      ],
    };
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    if (held) {
      diagnostics.natlangTeacher.calls.push(append);
    } else {
      append.record.effects[0].args = ref([{ ...draft, revision: 1 }, sections]);
    }
    await save();
    await assert.rejects(
      exportLiveTeacherWorkflow({ ...options, cases }),
      held ? /stale problem draft/u : /owned append/u
    );
  }
});

test("authority export rejects an origin substitution in live preflight evidence", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "authority-review-live-distinct-origins";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const { operations, ceiling, goal } = assignment;
  const request = { goal, operations: operations.map(({ id, label }) => ({ id, label })), ceiling };
  const protectedLeaf = (resourceKey) => ({ capability: "external.open", resourceKey });
  const observations = operations.map(({ id, protectedResources }) => ({
    operationId: id,
    decision: "acquirable",
    leaves: protectedResources.map((resourceKey) => ({
      ...protectedLeaf(resourceKey),
      tier: "gated",
      status: "acquirable",
    })),
  }));
  const summary = {
    status: "held",
    held: ["support"],
    protectedLeaves: ["https://calendar.example", "https://help.example"].map(protectedLeaf),
  };
  const reviews = observations.map((observation) => {
    const held = observation.operationId === "support";
    return {
      observation,
      outside: held ? [protectedLeaf("https://help.example")] : [],
      disposition: held ? "outside-ceiling" : "needs-acquisition",
    };
  });
  const report = { ...summary, reviews };
  diagnostics.managedAuthorityReview = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    observations,
    passed: true,
    checks: { assigned: true, reviews: true, ceiling: true, decision: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (callId, name, parent, inputs, output, effects = []) => ({
    callId,
    summary: { ...prototype.summary, call_id: callId },
    record: {
      ...prototype.record,
      call_id: callId,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", "runWorkflow", null, {}, null),
      call("review", "reviewAuthority", "runWorkflow", { request }, report),
      ...reviews.flatMap((result) => {
        const { observation, disposition, outside } = result;
        const { operationId, decision, leaves } = observation;
        return [
          call(operationId, "reviewOperation", "review", { operationId, ceiling }, result),
          call(`read-${operationId}`, "preflight", operationId, { operationId }, observation, [
            {
              service: "assignedAuthorityRead",
              method: "preflight",
              args: ref([operationId]),
              result: ref(observation),
            },
          ]),
          call(`scope-${operationId}`, "findOutside", operationId, { leaves, ceiling }, outside),
          call(
            `decide-${operationId}`,
            "decideDisposition",
            operationId,
            { decision, outside },
            disposition
          ),
        ];
      }),
      call("combine", "combineCeiling", "review", { reviews }, summary),
      call("collect", "collectProtected", "combine", { reviews }, report.protectedLeaves),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const support = diagnostics.natlangTeacher.calls.find(({ callId }) => callId === "read-support");
  support.record.effects[0].result = ref({
    ...observations.at(-1),
    leaves: [{ ...observations.at(-1).leaves[0], resourceKey: "https://calendar.example" }],
  });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact live preflight/u);
});

test("extension release export rejects treating a local manifest change as the approved runtime", async (t) => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  for (const scenario of ["hold-unpublished-pdf-candidate", "hold-code-only-pdf-candidate"]) {
    const { options, diagnostics, entry, save } = await fixture(t);
    const name = "extension-release-live-" + scenario;
    const { assignment } = cases.get(name);
    const changesManifest = assignment.mode === "manifest-change";
    const pins = JSON.parse(await readFile(options.pins, "utf8"));
    await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
    entry.test.name = name;
    const { goal, method, name: extension, source: pathInWorkspace, activation } = assignment;
    const operationId = "release-assignment";
    const request = { goal, operationId, method };
    const source = {
      operationId,
      contextId: "ctx",
      name: extension,
      source: pathInWorkspace,
      workingRevision: "application:candidate",
      mainRevision: "workspace-event:published",
      workingTree: "a".repeat(64),
      publishedTree: "b".repeat(64),
      working: {
        hash: changesManifest ? "candidate-manifest" : "published-manifest",
        activation,
        methods: changesManifest ? ["probe", method] : ["probe"],
      },
      published: { hash: "published-manifest", activation, methods: ["probe"] },
    };
    const runtime = {
      operationId,
      name: extension,
      source: pathInWorkspace,
      status: "running",
      activeEv: "published-build",
      identity: "extension-live",
      methods: ["probe"],
      pendingApproval: null,
      hasError: false,
      dependencyUpdate: false,
    };
    const report = {
      source: { observation: source, disposition: "unpublished-candidate" },
      runtime: {
        observation: runtime,
        disposition: changesManifest ? "method-not-observed" : "live-method",
      },
      decision: "verify-and-publish-candidate",
    };
    diagnostics.managedExtensionRelease = {
      caseId: assignment.id,
      contextId: "ctx",
      request,
      source,
      runtime,
      passed: true,
      checks: { source: true, runtime: true, unchanged: true, report: true },
    };
    const ref = (value) => {
      const text = JSON.stringify(value);
      return {
        complete: true,
        hash: createHash("sha256").update(text).digest("hex"),
        bytes: Buffer.byteLength(text),
      };
    };
    const prototype = diagnostics.natlangTeacher.calls[0];
    const call = (name, parent, inputs, output, effects = []) => ({
      callId: name,
      summary: { ...prototype.summary, call_id: name },
      record: {
        ...prototype.record,
        call_id: name,
        parent_call_id: parent,
        definition: { name },
        outcome: "done",
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output),
        effects,
      },
    });
    const effect = (method, value) => ({
      service: "extensionReleaseRead",
      method,
      args: ref([operationId]),
      result: ref(value),
    });
    const readRuntime = call("readRuntime", "reviewRuntime", { operationId }, runtime, [
      effect("runtime", runtime),
    ]);
    diagnostics.natlangTeacher = {
      ...diagnostics.natlangTeacher,
      programPath: "skills/vibestudio-workflows/runWorkflow.nl",
      rootCallIds: ["runWorkflow"],
      report,
      calls: [
        call("runWorkflow", null, {}, null),
        call("reviewExtensionRelease", "runWorkflow", { request }, report),
        call("reviewSource", "reviewExtensionRelease", { operationId, method }, report.source),
        call("readSource", "reviewSource", { operationId }, source, [effect("source", source)]),
        call(
          "assessSource",
          "reviewSource",
          { observation: source, method },
          report.source.disposition
        ),
        call("reviewRuntime", "reviewExtensionRelease", { operationId, method }, report.runtime),
        readRuntime,
        call(
          "assessRuntime",
          "reviewRuntime",
          { observation: runtime, method },
          report.runtime.disposition
        ),
        call(
          "chooseNext",
          "reviewExtensionRelease",
          { source: report.source, runtime: report.runtime },
          report.decision
        ),
      ],
    };
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    readRuntime.record.effects[0].result = ref({
      ...runtime,
      activeEv: "local-candidate",
      methods: ["probe", method],
    });
    await save();
    await assert.rejects(
      exportLiveTeacherWorkflow({ ...options, cases }),
      /approved runtime readback/u
    );
  }
});

async function checkClientCapabilityCase(t, id, expectedDecision) {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = `client-admission-live-${id}`;
  const { assignment } = cases.get(name);
  entry.test.name = name;
  const { goal, source, host, runtime, workingAbi, publishedAbi, abi, addedCapability } = assignment;
  const operationId = "client-review";
  const request = { goal, operationId };
  const published = {
    hash: "published-manifest",
    id: "browser",
    runtime,
    abi: publishedAbi,
    required: ["device-session"],
    optional: ["notifications"],
  };
  const working = { ...published, hash: "working-manifest", abi: workingAbi };
  if (addedCapability) working[addedCapability.tier] = [
    ...published[addedCapability.tier],
    addedCapability.name,
  ];
  const observation = {
    operationId,
    contextId: "ctx",
    source,
    workingRevision: "application:working-client",
    mainRevision: "event:published-client",
    working,
    published,
    trusted: true,
    host: {
      kind: host,
      runtimes: { [runtime]: publishedAbi },
      capabilities: ["device-session"],
      deviceLevel: ["device-session"],
    },
    catalog: {
      source,
      status: "ready",
      effectiveVersion: "published-version",
      activeBuildKey: "published-build",
    },
  };
  const report = {
    source: { observation, disposition: "working-change" },
    host: {
      abi,
      capabilities: {
        missingRequired: addedCapability?.tier === "required" ? [addedCapability.name] : [],
        untrustedRequired: [],
        deniedOptional: working.optional,
      },
    },
    decision: expectedDecision,
  };
  diagnostics.managedClientAdmission = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    observation,
    passed: true,
    checks: { source: true, host: true, catalog: true, unchanged: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const read = call("readClient", "inspectSource", { operationId }, observation, [
    {
      service: "clientAdmissionRead",
      method: "observe",
      args: ref([operationId]),
      result: ref(observation),
    },
  ]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewClientAdmission", "runWorkflow", { request }, report),
      call("inspectSource", "reviewClientAdmission", { operationId }, report.source),
      read,
      call("reviewHost", "reviewClientAdmission", { observation }, report.host),
      call("checkAbi", "reviewHost", { observation }, abi),
      call("checkCapabilities", "reviewHost", { observation }, report.host.capabilities),
      call("checkRequired", "checkCapabilities", { observation }, {
        missingRequired: report.host.capabilities.missingRequired,
        untrustedRequired: [],
      }),
      call("checkOptional", "checkCapabilities", { observation }, report.host.capabilities.deniedOptional),
      call(
        "chooseNext",
        "reviewClientAdmission",
        { source: report.source, host: report.host },
        report.decision
      ),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  if (addedCapability) {
    const leaf = addedCapability.tier === "required" ? "checkRequired" : "checkOptional";
    diagnostics.natlangTeacher.calls.find(({ callId }) => callId === leaf).record.output =
      ref(addedCapability.tier === "required"
        ? { missingRequired: [], untrustedRequired: [] }
        : ["notifications"]);
    await save();
    await assert.rejects(
      exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-missing-capability` }),
      /exact host compatibility and capability decisions/u
    );
  } else {
    read.record.effects[0].result = ref({
      ...observation,
      host: { ...observation.host, runtimes: { [runtime]: workingAbi } },
    });
    await save();
    await assert.rejects(
      exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-abi` }),
      /host contract and build catalog/u
    );
  }
}

test("client admission export rejects substituted host ABI evidence", (t) =>
  checkClientCapabilityCase(t, "working-desktop-abi-incompatible", "resolve-abi")
);
test("client admission export preserves unavailable required capabilities", (t) =>
  checkClientCapabilityCase(t, "desktop-candidate-requires-mobile-device-controls", "resolve-required-capabilities")
);
test("client admission export preserves denied optional capabilities", (t) =>
  checkClientCapabilityCase(t, "android-candidate-requests-optional-menu", "review-candidate")
);

test("Examples readiness export links both games to the exact criteria in order", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const name = "examples-portfolio-live-ready-quiet-estate-and-forecast";
  const workflow = (await loadLiveTeacherCases(checkouts)).get(name);
  const { world, request, garden, realm } = workflow.assignment;
  const groups = workflowSourceGroups(workflow);
  assert.ok(groups.includes("vibestudio:examples:grimoire-resident-care"));
  assert.ok(groups.includes("vibestudio:examples:regency-saved-and-projected-accounts"));
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const suffix = "e7e43702-5e20-4592-ac74-06605c3776da";
  const gardenId = "natlang-garden-" + suffix;
  const realmId = "natlang-realm-" + suffix;
  const gardenObserved = { before: { id: gardenId + ":before" }, current: { id: gardenId + ":current" } };
  const saved = { id: realmId + ":saved", month: 0, treasury: 120 };
  const forecast = { id: realmId + ":forecast:1", month: 1, treasury: realm.projectedTreasury };
  const realmObserved = { saved, forecast };
  const findings = (caseWorld, evidenceId) => caseWorld.expected.map((decision, index) => ({
    decision, finding: "finding-" + index, evidenceIds: [evidenceId],
  }));
  const result = (components) => ({ ...components[0], components });
  const demos = {
    garden: result(findings(garden, gardenObserved.current.id)),
    realm: result(findings(realm, forecast.id)),
  };
  const selected = world.criteria.map(({ demo, claimIndex }) => demos[demo].components[claimIndex]);
  const report = {
    decision: world.readiness, finding: "all-criteria-supported",
    evidenceIds: selected.flatMap(({ evidenceIds }) => evidenceIds),
    components: selected,
    demos,
  };
  const check = (...keys) => Object.fromEntries(keys.map((key) => [key, true]));
  const verification = {
    passed: true, request, expected: report,
    checks: check("exactGarden", "exactRealm", "scope", "assignedDecisions", "exactReadiness"),
    gardenEvidence: {
      passed: true, garden: gardenId, observed: gardenObserved, expected: demos.garden,
      actions: garden.actions.map((action) => action.toLowerCase()),
      checks: check("persistedVisits", "persistedClock", "assignedClaims", "readOwnedGarden", "matchedJudgment", "matchedClaims"),
    },
    realmEvidence: {
      passed: true, realm: realmId, observed: realmObserved, expected: demos.realm,
      checks: check("exactBasis", "openingIntact", "exactForecast", "assignedClaims", "exactReport"),
    },
  };
  const execution = { provenance: { contextId: "owned" }, diagnostics: {
    managedExamplesPortfolio: { contextId: "owned", verification },
  } };
  const call = (callId, parent, name, inputs = {}, output, effects) => ({
    callId, record: {
      parent_call_id: parent, outcome: "done", definition: { name },
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      ...(output && { output: ref(output) }), ...(effects && { effects }),
    },
  });
  const readGarden = { service: "gardenRead", method: "observe", result: ref(gardenObserved) };
  const readRealm = { service: "realmRead", method: "observe", args: ref([1]), result: ref(realmObserved) };
  const combine = call("decision-result", "decide", "combineFindings", { components: selected });
  const exercise = { report, rootCallIds: ["root"], calls: [
    call("root", null, "runWorkflow"),
    call("review", "root", "reviewExample", { request }, report),
    call("portfolio", "review", "reviewLivePortfolio", { request }, report),
    call("garden", "portfolio", "inspectLiveGarden", { claims: garden.request.claims }, demos.garden),
    call("garden-read", "garden", "readGarden", {}, undefined, [readGarden]),
    call("garden-combine", "garden", "combineFindings", {}, demos.garden),
    ...garden.request.claims.flatMap((claim, index) => [
      call("garden-claim-" + index, "garden", "qualifyClaim", { claim, observed: gardenObserved }),
      call("garden-review-" + index, "garden-claim-" + index, "reviewGarden", {}, demos.garden.components[index]),
    ]),
    call("realm", "portfolio", "inspectLiveRealm", { claims: realm.request.claims, months: 1 }, demos.realm),
    call("realm-read", "realm", "readSettlement", {}, undefined, [readRealm]),
    call("realm-combine", "realm", "combineFindings", {}, demos.realm),
    ...realm.request.claims.flatMap((claim, index) => {
      const settlement = claim.kind === "settlement";
      const input = settlement ? { check: claim.check, current: claim.source === "saved" ? saved : forecast }
        : { check: claim.check, before: saved, after: forecast, basis: "forecast", assertCommitted: claim.assertCommitted };
      const verdict = demos.realm.components[index];
      return [
        call("realm-claim-" + index, "realm", "qualifyClaim", { claim, observed: realmObserved }, verdict),
        call("realm-review-" + index, "realm-claim-" + index, "reviewRealm"),
        call("realm-leaf-" + index, "realm-review-" + index, settlement ? "inspectSettlement" : "compareEconomy", input, verdict),
      ];
    }),
    call("decide", "portfolio", "decideReadiness", { ...demos, criteria: world.criteria }, report),
    combine,
  ] };
  assert.ok(workflow.evidence(execution, exercise, name, workflow));
  combine.record.inputs.components = ref([...selected].reverse());
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /selected the acceptance criteria/);
  combine.record.inputs.components = ref(selected);
  readRealm.args = ref([3]);
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /saved or projected evidence/);
});

test("Regency export keeps the committed claim and forecast evidence distinct", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const name = "regency-review-live-one-month-ledger-and-reserves";
  const workflow = (await loadLiveTeacherCases(checkouts)).get(name);
  const { assignment } = workflow;
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const contextId = "owned-realm";
  const realm = "natlang-realm-e7e43702-5e20-4592-ac74-06605c3776da";
  const saved = { id: realm + ":saved", month: 0, treasury: 120 };
  const forecast = { id: realm + ":forecast:1", month: 1, treasury: assignment.projectedTreasury };
  const observed = { saved, forecast };
  const components = assignment.expected.map((decision, index) => ({
    decision, finding: "finding-" + index, evidenceIds: [saved.id, forecast.id],
  }));
  const report = { decision: "contradicted", finding: "criteria-contradicted", evidenceIds: [saved.id, forecast.id], components };
  const execution = {
    provenance: { contextId },
    diagnostics: { managedRegencyReview: { contextId, verification: {
      passed: true, realm, observed, expected: report,
      checks: Object.fromEntries(["exactBasis", "openingIntact", "exactForecast", "assignedClaims", "exactReport"].map((key) => [key, true])),
    } } },
  };
  const call = (callId, parent, name, fields = {}) => ({
    callId, record: { parent_call_id: parent, outcome: "done", definition: { name }, ...fields },
  });
  const branches = assignment.request.claims.flatMap((claim, index) => {
    const settlement = claim.kind === "settlement";
    const values = settlement ? {
      check: claim.check, current: claim.source === "saved" ? saved : forecast,
    } : { check: claim.check, before: saved, after: forecast, basis: "forecast", assertCommitted: claim.assertCommitted };
    const inputs = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, ref(value)]));
    return [
      call("claim-" + index, "live", "qualifyClaim", { inputs: { claim: ref(claim), observed: ref(observed) }, output: ref(components[index]) }),
      call("review-" + index, "claim-" + index, "reviewRealm"),
      call("leaf-" + index, "review-" + index, settlement ? "inspectSettlement" : "compareEconomy", { inputs, output: ref(components[index]) }),
    ];
  });
  const observation = { service: "realmRead", method: "observe", args: ref([1]), result: ref(observed) };
  const exercise = {
    report,
    rootCallIds: ["root"],
    calls: [
      call("root", null, "runWorkflow"),
      call("review", "root", "reviewExample", { inputs: { request: ref(assignment.request) }, output: ref(report) }),
      call("live", "review", "inspectLiveRealm"),
      call("observe", "live", "readSettlement", { effects: [observation] }),
      call("combine", "live", "combineFindings", { output: ref(report) }),
      ...branches,
    ],
  };
  assert.ok(workflow.evidence(execution, exercise, name, workflow));
  const leaf = branches.at(-1);
  leaf.record.inputs.basis = ref("observed");
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /saved or projected evidence/);
  leaf.record.inputs.basis = ref("forecast");
  observation.args = ref([3]);
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /saved or projected evidence/);
});

test("Drive checkpoint export binds full, partial and stale outcomes to their actual page effects", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  for (const world of ["terminal-shared-drive-page", "missing-terminal-shared-drive-page", "checkpoint-moved-during-paging", "superseded-checkpoint-shift-handoff"]) {
    const name = "drive-checkpoint-live-" + world;
    const workflow = cases.get(name);
    const { assignment } = workflow;
    const { initial, expected, driveId, pages } = assignment;
    const request = { kind: "sync-checkpoint", goal: assignment.goal };
    const receipt = { state: expected.state, cursor: expected.cursor };
    const terminal = pages.at(-1).response?.newStartPageToken ?? null;
    const report = {
      action: "none", status: expected.state === "saved" ? "complete" : "partial", ids: expected.ids,
      findings: [], checkpoint: expected.cursor, checkpointWrite: receipt,
    };
    const latest = new Map();
    const changes = pages.map(({ cursor, response }) => {
      const effect = { service: "googleWorkspaceRead", method: "readChanges", args: ref([cursor]) };
      if (!response) return { ...effect, error: "Drive tail unavailable" };
      const next = response.nextPageToken ?? null;
      const rows = response.changes.map((row) => ({
        fileId: row.fileId, removed: row.removed ?? false, name: row.file?.name ?? null, time: null,
      }));
      for (const row of rows) latest.set(row.fileId, row);
      return { ...effect, result: ref({ next, checkpoint: next ? null : response.newStartPageToken, rows }) };
    });
    const contextId = "owned-drive";
    const verification = {
      caseId: assignment.id, passed: true, request, observed: initial, terminal, persisted: expected.cursor,
      receipt: expected.attempts ? receipt : null,
      requests: pages.map(({ cursor, response }) => ({ cursor, driveId, status: response ? 200 : 503 })),
      checks: Object.fromEntries(["exactTransport", "exactRead", "exactWrite", "exactReport"].map((key) => [key, true])),
    };
    const execution = { provenance: { contextId }, diagnostics: { managedDriveCheckpoint: { contextId, verification } } };
    const call = (callId, parent, label, inputs = {}, output, effects) => ({
      callId, record: {
        parent_call_id: parent, outcome: "done", definition: { name: label },
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        ...(output && { output: ref(output) }), ...(effects && { effects }),
      },
    });
    const write = { service: "driveCheckpoint", method: "commit", args: ref([initial, terminal]), result: ref(receipt) };
    const exercise = { report, rootCallIds: ["root"], calls: [
      call("root", null, "runWorkflow"),
      call("guide", "root", "guideGoogleWorkspace", { request }, report, [{ service: "googleWorkspaceRead", method: "readiness", result: ref({ state: "ready" }) }]),
      call("sync", "guide", "syncCheckpoint", { request }, report),
      call("read", "sync", "readCheckpoint", {}, initial, [{ service: "driveCheckpoint", method: "read", result: ref(initial) }]),
      call("continue", "sync", "continueSync", {}, undefined, changes),
      call("summary", "continue", "summarizeDelta", { changes: [...latest.values()] }),
      ...(expected.attempts ? [call("commit", "sync", "commitCheckpoint", {}, receipt, [write])] : []),
    ] };
    if (assignment.handoff) {
      const handoffInput = {
        goal: "Stage the assigned cursor evidence",
        questions: ["Which cursor is saved?", "What happened to the candidate?"],
        sources: [{ id: "checkpoint", path: "/.tmp/input" }],
      };
      const composed = {
        goal: assignment.goal + " Stage the handoff.",
        work: workflow.work.map((item, index) => ({ ...item, input: [request, handoffInput][index] })),
      };
      const artifact = { path: "/.tmp/checkpoint/handoff.json", bytes: 40 };
      const staged = { status: "staged", artifact, missingSources: [], unanswered: [] };
      const sha = (text) => createHash("sha256").update(text).digest("hex");
      const source = workflow.projectDriveCheckpointSource(verification);
      const transfer = { service: "scratchHandoffRead", method: "read", args: ref(["checkpoint"]),
        result: ref({ id: "checkpoint", lines: source.trimEnd().split("\n") }) };
      const handoffVerification = {
        passed: true, expectedStatus: "staged", sourceIds: ["checkpoint"], seedRevision: "saved-revision",
        artifact: { ...artifact, sha256: sha("artifact") },
        checks: Object.fromEntries(["protectedUnchanged", "originalsUnchanged", "disposition", "exactReadback"].map((key) => [key, true])),
      };
      const joined = {
        passed: true, caseId: assignment.id, request: composed, checkpoint: verification, handoff: handoffVerification,
        checks: { exactCheckpoint: true, exactHandoff: true, verifiedTransfer: true },
        sourceSha256: sha(source),
      };
      execution.diagnostics.managedDriveCheckpoint.verification = joined;
      exercise.report = { remaining: [], results: workflow.work.map((item, index) => ({ ...item, report: [report, staged][index] })) };
      exercise.calls[0].record.inputs.request = ref(composed);
      exercise.calls[1].record.ended_at = "2026-11-20T10:00:01Z";
      const assemble = call("scratch", "root", "assembleHandoff", { request: handoffInput }, staged);
      assemble.record.started_at = "2026-11-20T10:00:02Z";
      exercise.calls.push(assemble, call("scratch-read", "scratch", "readSource", {}, undefined, [transfer]),
        call("scratch-write", "scratch", "commitHandoff", {}, undefined, [
          { service: "scratchHandoffWrite", method: "stage", result: ref(artifact) },
        ]));
      assert.ok(workflow.evidence(execution, exercise, name, workflow));
      const losingCursor = source.replace(`Saved cursor: ${expected.cursor}`, `Saved cursor: ${terminal}`);
      joined.sourceSha256 = sha(losingCursor);
      transfer.result = ref({ id: "checkpoint", lines: losingCursor.trimEnd().split("\n") });
      assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /quote the persisted cursor/);
      continue;
    }
    assert.ok(workflow.evidence(execution, exercise, name, workflow));
    if (expected.attempts) {
      write.args = ref([initial, "ignore-intermediate-checkpoint"]);
      assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /guarded terminal write/);
    } else {
      exercise.calls.push(call("commit", "sync", "commitCheckpoint", {}, receipt, [write]));
      assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /guarded terminal write/);
    }
  }
});

test("Browser migration export binds preview, execution, and recovery decisions to its assigned observations", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const migrations = [...cases].filter(([, workflow]) => workflow.family === "personal-live-browser-import-review");
  assert.equal(migrations.length, 7);
  for (const [name, workflow] of migrations) {
    const { id, goal, kind, categories, reads, expected, job, preview, source } = workflow.assignment;
    const approved = workflow.assignment.execution?.approvedPreview;
    const dispatched = workflow.assignment.execution?.start;
    const request = { goal, kind, categories, ...(approved && { approvedPreview: approved }) };
    const report = { ...expected, findings: ["Review the assigned records"] };
    const contextId = "owned-browser-migration";
    const values = { source, preview, history: job, start: dispatched };
    const verification = {
      caseId: id, passed: true, request, reads: reads.map((kind) => ({ kind, value: values[kind] })),
      checks: { exactReads: true, exactReport: true, retainedState: true, previewCalls: true },
    };
    const importReadback = approved && {
      starts: dispatched ? 1 : 0, phase: job?.phase ?? null,
      bookmarks: workflow.assignment.execution.bookmarks,
    };
    if (importReadback) verification.importReadback = importReadback;
    const execution = {
      provenance: { contextId }, diagnostics: { managedBrowserImport: { contextId, verification } },
    };
    const call = (callId, parent, label, inputs, output, effects = [], interval = [0, 100]) => ({
      callId, record: {
        parent_call_id: parent, outcome: "done", definition: { name: label },
        started_at: new Date(interval[0]).toISOString(), ended_at: new Date(interval[1]).toISOString(),
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output), effects,
      },
    });
    const exercise = { report, rootCallIds: ["root"], calls: [
      call("root", null, "runWorkflow", {
        request: { goal, work: [{ kind: "domain", domain: "browserImport", operation: "reviewBrowserImport", input: request }] },
      }, report),
      call("review", "root", "reviewBrowserImport", { request }, report),
    ] };
    const parent = approved ? "execute" : "review";
    const compare = approved && call("compare", parent, "compareApprovedPreview", { approved, observed: preview }, Boolean(dispatched), [], [52, 60]);
    if (compare) exercise.calls.push(call(parent, "review", "executeApprovedImport", { request }, report), compare);
    const declared = {
      source: ["inspectAssignedSource", "browserImportSource"],
      history: ["inspectRetainedJob", "browserImportHistory"],
      start: ["startApprovedImport", "browserImportStart"],
      preview: ["inspectPreview", "browserImportPreview"],
    };
    for (const [index, read] of reads.entries()) {
      const [stage, service] = declared[read];
      const time = 10 + index * 30;
      const effect = { service, method: read === "start" ? "start" : "observe", result: ref(values[read]) };
      if (read === "start") effect.args = ref([preview]);
      const inputs = read === "history" ? {} : read === "start" ? { observed: preview } : { requested: categories };
      exercise.calls.push(call(read, parent, stage, inputs, values[read], [effect], [time, time + 10]));
    }
    const interpret = job && call("interpret", parent, "interpretRetainedJob", { job }, { next: expected.next }, [],
      approved ? [115, 120] : [25, 30]);
    if (interpret) exercise.calls.push(interpret);
    assert.ok(workflow.evidence(execution, exercise, name, workflow));
    if (approved) {
      verification.importReadback = { ...importReadback, starts: importReadback.starts + 1 };
      assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /retain the assigned preview counts/);
      verification.importReadback = importReadback;
      compare.record.output = ref(!dispatched);
    } else if (interpret) {
      interpret.record.inputs.job = ref({ ...job, progress: [] });
    } else {
      exercise.calls.find(({ callId }) => callId === "preview").record.started_at = new Date(0).toISOString();
    }
    assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /read and interpret .* in order/);
  }
});

test("Drive sharing export binds permission reads to completed inventory and the exact file", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  for (const id of [
    "confirmed-roster-direct-sharing",
    "shortcut-does-not-confirm-roster",
    "roster-confirmation-with-unavailable-tail",
    "roster-with-incomplete-search-flag",
  ]) {
    const name = `drive-sharing-live-${id}`;
    const workflow = cases.get(name);
    const { goal, inventory, sharing, folderPages, permissionPages, expected } = workflow.assignment;
    const request = { kind: "inventory-sharing", goal, inventory, sharing };
    const audited = expected.gate === "audited";
    const report = {
      status: audited ? "complete" : "partial", action: "none", checkpoint: null,
      ids: expected.ids, inventoryAudit: { gate: expected.gate, inventoryIds: expected.inventoryIds },
    };
    const listingReport = {
      ids: expected.inventoryIds, status: expected.gate === "inventory-partial" ? "partial" : "complete",
    };
    const eligible = [];
    const permissions = [];
    const requests = [];
    const readFolders = folderPages.map(({ cursor, response }) => {
      requests.push({ kind: "folder", cursor, status: response ? 200 : 503 });
      const effect = { service: "googleWorkspaceRead", method: "listFolder", args: ref([inventory.folderId, cursor]) };
      if (!response) return { ...effect, error: "Page unavailable" };
      const rows = response.files.map((file) => ({
        id: file.id, name: file.name, mimeType: file.mimeType, modifiedAt: file.modifiedTime ?? null,
        shortcut: Boolean(file.shortcutDetails),
      }));
      eligible.push(...rows.filter((row) => expected.eligibleIds.includes(row.id)));
      return { ...effect, result: ref({
        next: response.nextPageToken ?? null, incomplete: response.incompleteSearch === true, rows,
      }) };
    });
    const readPermissions = permissionPages.map(({ cursor, response }) => {
      requests.push({ kind: "permissions", cursor, status: 200 });
      const rows = response.permissions.map((row) => ({
        id: row.id, principalKind: row.type, principal: row.emailAddress ?? null,
        role: row.role, discovery: false, deleted: row.deleted ?? false,
      }));
      permissions.push(...rows);
      return {
        service: "googleWorkspaceRead", method: "readPermissions", args: ref([sharing.fileId, cursor]),
        result: ref({ next: response.nextPageToken ?? null, rows }),
      };
    });
    const contextId = "scoped-drive-sharing";
    const verification = {
      caseId: id, passed: true, request, requests, permissions, eligibleIds: expected.eligibleIds,
      checks: { exactTransport: true, inventoryGate: true, exactReport: true },
    };
    const execution = {
      provenance: { contextId }, diagnostics: { managedDriveSharing: { contextId, verification } },
    };
    const call = (callId, parent, label, inputs, output, effects = [], interval = [0, 100]) => ({
      callId, record: {
        parent_call_id: parent, outcome: "done", definition: { name: label },
        started_at: new Date(interval[0]).toISOString(), ended_at: new Date(interval[1]).toISOString(),
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output), effects,
      },
    });
    const guide = call("guide", "root", "guideGoogleWorkspace", { request }, report, [
      { service: "googleWorkspaceRead", method: "readiness", result: ref({ state: "ready" }) },
    ]);
    const select = call("select", "listing", "selectRows", { request: inventory, rows: eligible }, expected.inventoryIds);
    const decide = call("decide", "review", "decideSharingGate", {
      status: listingReport.status, selectedIds: listingReport.ids, fileId: sharing.fileId,
    }, expected.gate, [], [35, 40]);
    const exercise = { report, rootCallIds: ["root"], calls: [
      call("root", null, "runWorkflow", {}, report),
      guide,
      call("review", "guide", "reviewInventorySharing", { request }, report),
      call("listing", "review", "inspectFolder", { request: inventory }, listingReport, readFolders, [10, 30]),
      select,
      decide,
    ] };
    const audit = call("audit", "review", "reviewSharing", { request: sharing }, report, readPermissions, [45, 90]);
    if (audited) {
      exercise.calls.push(audit,
        call("classify", "audit", "classifyAccess", { request: sharing, permissions }, expected.ids));
    }
    assert.ok(workflow.evidence(execution, exercise, name, workflow));
    select.record.output = ref(expected.eligibleIds);
    assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /before any permission reads/);
    select.record.output = ref(expected.inventoryIds);
    if (expected.gate === "inventory-partial") {
      decide.record.inputs.status = ref("complete");
      assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /before any permission reads/);
      decide.record.inputs.status = ref("partial");
    }
    if (id === "roster-with-incomplete-search-flag") {
      const result = readFolders[0].result;
      readFolders[0].result = ref({ next: "folder-tail", incomplete: false, rows: eligible.slice(0, 1) });
      assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /before any permission reads/);
      readFolders[0].result = result;
    }
    if (audited) {
      audit.record.started_at = new Date(20).toISOString();
    } else {
      guide.record.effects.push({ service: "googleWorkspaceRead", method: "readPermissions", error: "Gate closed" });
    }
    assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /before any permission reads/);
  }
});

test("Programmed Adventure export requires the committed change, a repaint and the loaded image after reload", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const name = "adventure-live-repaint-and-reload";
  const workflow = (await loadLiveTeacherCases(checkouts)).get(name);
  const { request } = workflow.assignment;
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const journey = "natlang-adventure-11d71f32-0bb0-4c84-a05d-53d895943c34";
  const before = { id: journey + ":before", place: "landing", tick: 0, signature: "lit" };
  const current = { id: journey + ":current", place: "landing", tick: 1, signature: "covered" };
  const openingArtwork = { id: "opening", place: before.place, signature: before.signature };
  const replacementArtwork = { id: "replacement", place: current.place, signature: current.signature };
  const repaint = { location: current.place, asset: replacementArtwork.id, tick: 1, narration: "turn", light: "Light is blocked by a covering" };
  const reload = { ...repaint, id: journey + ":reloaded" };
  const covering = { id: "connection", from: request.covering, to: request.lamp };
  const observed = { before, current, openingArtwork, replacementArtwork, covering, effectiveLight: false, repaint, reload };
  const frames = {
    before: { location: before.place, asset: openingArtwork.id, tick: 0, narration: "", light: "Light is shining" },
    after: { ...repaint, asset: openingArtwork.id }, repaint, reload: { ...repaint },
  };
  const frame = (value) => ({ ...value, key: journey, loaded: true, fresh: "true" });
  const original = { before: frame(frames.before), after: frame(frames.after), painted: frame(repaint), reloaded: frame(frames.reload),
    cleanupComplete: true, builderObserved: false };
  const components = ["supported", "supported", "supported", "contradicted", "supported", "supported"].map((decision, index) => ({
    decision, finding: "finding-" + index, evidenceIds: [current.id],
  }));
  const report = { decision: "contradicted", finding: "criteria-contradicted", evidenceIds: [current.id], components };
  const checks = Object.fromEntries(["settled", "mutation", "browserMatches", "exactClaims", "exactReport"].map((key) => [key, true]));
  const execution = { provenance: { contextId: "owned" }, diagnostics: {
    programmedInteraction: original,
    managedProgrammedAdventure: { contextId: "owned", verification: { passed: true, journey, frames, observed, expected: report, checks } },
  } };
  const call = (callId, parent, label, inputs = {}, output, effects) => ({
    callId, record: {
      parent_call_id: parent, outcome: "done", definition: { name: label },
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      ...(output && { output: ref(output) }), ...(effects && { effects }),
    },
  });
  const applyArtwork = call("paint-check", "new", "compareIllustration", { current, artwork: replacementArtwork }, components[4]);
  const exercise = { report, rootCallIds: ["root"], calls: [
    call("root", null, "runWorkflow"),
    call("review", "root", "reviewExample", { request }, report),
    call("transition", "review", "reviewProgrammedAdventure", { request }, report),
    call("read", "transition", "readTurn", {}, undefined, [{ service: "adventureTransitionRead", method: "observe", result: ref(observed) }]),
    call("time", "transition", "reviewAdventure"),
    call("time-check", "time", "compareJourney", { before, after: current, check: { kind: "time-advanced" } }, components[0]),
    call("place", "transition", "reviewAdventure"),
    call("place-check", "place", "compareJourney", { before, after: current, check: { kind: "same-place" } }, components[1]),
    call("cover", "transition", "inspectCovering", { covering: request.covering, lamp: request.lamp, observed }, components[2]),
    call("repaint", "transition", "inspectRepaint", { observed }, components.slice(3, 5)),
    call("opening", "repaint", "reviewAdventure"),
    call("opening-check", "opening", "compareIllustration", { current, artwork: openingArtwork }, components[3]),
    call("new", "repaint", "reviewAdventure"), applyArtwork,
    call("reload", "transition", "inspectReload", { observed }, components[5]),
    call("combine", "transition", "combineFindings", { components }, report),
  ] };
  assert.ok(workflow.evidence(execution, exercise, name, workflow));
  original.reloaded.loaded = false;
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /replacement artwork after reload/);
  original.reloaded.loaded = true;
  applyArtwork.record.inputs.artwork = ref(openingArtwork);
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /nested covering, continuity, artwork and reload/);
});

test("Adventure export joins the loaded cover to the saved journey and requires each nested reviewer", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const name = "adventure-review-live-postal-painted-opening";
  const workflow = (await loadLiveTeacherCases(checkouts)).get(name);
  const { assignment } = workflow;
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const contextId = "owned-adventure";
  const journey = "natlang-adventure-11d71f32-0bb0-4c84-a05d-53d895943c34";
  const before = { id: journey + ":before", place: assignment.place, tick: 0, signature: "a".repeat(64) };
  const current = { ...before, id: journey + ":current" };
  const artwork = { id: "cover-image", place: current.place, signature: current.signature };
  const panel = { location: current.place, asset: artwork.id, tick: current.tick };
  const observed = { before, current, artwork };
  const components = assignment.expected.map((decision, index) => ({
    decision,
    finding: "finding-" + index,
    evidenceIds: [current.id],
  }));
  const report = { decision: "contradicted", finding: "criteria-contradicted", evidenceIds: [current.id], components };
  const verification = {
    passed: true,
    campaign: assignment.campaign,
    journey,
    observed,
    panel,
    expected: report,
    checks: Object.fromEntries(["ownedOpening", "artwork", "persisted", "assignedClaims", "exactReport"].map((key) => [key, true])),
  };
  const execution = {
    provenance: { contextId },
    diagnostics: { managedAdventureReview: { contextId, verification } },
  };
  const call = (callId, parent, name, fields = {}) => ({
    callId,
    record: { parent_call_id: parent, outcome: "done", definition: { name }, ...fields },
  });
  const leaves = { access: "inspectAccess", continuity: "compareJourney", artwork: "compareIllustration" };
  const exercise = {
    report,
    rootCallIds: ["root"],
    calls: [
      call("root", null, "runWorkflow"),
      call("review", "root", "reviewExample", { inputs: { request: ref(assignment.request) }, output: ref(report) }),
      call("live", "review", "inspectLiveAdventure"),
      call("read", "live", "readJourney", { effects: [{ service: "adventureRead", method: "observe", result: ref(observed) }] }),
      call("combine", "live", "combineFindings", { output: ref(report) }),
      ...assignment.request.claims.flatMap((claim, index) => [
        call("claim-" + index, "live", "qualifyClaim", {
          inputs: { claim: ref(claim), observed: ref(observed) },
          output: ref(components[index]),
        }),
        call("review-" + index, "claim-" + index, "reviewAdventure"),
        call("leaf-" + index, "review-" + index, leaves[claim.kind], { output: ref(components[index]) }),
      ]),
    ],
  };
  assert.ok(workflow.evidence(execution, exercise, name, workflow));
  panel.asset = "other-cover";
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /independently checked artwork/);
  panel.asset = artwork.id;
  exercise.calls.pop();
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /nested reviewer/);
});

test("Grimoire handoff binds each claim and the staged evidence to the owned readback", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "grimoire-live-discovery-with-missing-habitat-handoff";
  const workflow = cases.get(name);
  assert.deepEqual(workflow.skills, ["reviewExample", "assembleHandoff"]);
  assert.ok(workflowSourceGroups(workflow).includes("vibestudio:examples:grimoire-resident-care"));
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, bytes: Buffer.byteLength(text), hash: sha(text) };
  };
  const { claims } = workflow.gardenRequest;
  const contextId = "garden-context";
  const observed = { before: { id: "owned:before" }, current: { id: "owned:current" } };
  const components = workflow.expectedDecisions.map((decision, index) => ({
    decision,
    finding: `evidence-${index}`,
    evidenceIds: [observed.current.id],
  }));
  const gardenReport = { ...components[0], components };
  const source = workflow.projectGardenHandoff(claims, components);
  const artifact = { path: "/.tmp/handoff/handoff.json", bytes: 27 };
  const stagedReport = { status: "staged", artifact, missingSources: [], unanswered: [] };
  const sandbox = { goal: "Stage", questions: workflow.handoff.questions, sources: [{ id: "garden", path: "/.tmp/input" }] };
  const request = {
    goal: workflow.gardenRequest.goal,
    work: workflow.work.map((item, index) => ({ ...item, input: [workflow.gardenRequest, sandbox][index] })),
  };
  const check = (...keys) => Object.fromEntries(keys.map((key) => [key, true]));
  const verification = {
    passed: true,
    request,
    checks: check("exactGarden", "exactHandoff", "verifiedTransfer"),
    sourceSha256: sha(source),
    garden: {
      passed: true,
      garden: "owned",
      actions: workflow.expectedActions,
      observed,
      expected: gardenReport,
      checks: check("persistedVisits", "persistedClock", "assignedClaims", "readOwnedGarden", "matchedJudgment", "matchedClaims"),
    },
    handoff: {
      passed: true,
      expectedStatus: "staged",
      checks: check("protectedUnchanged", "originalsUnchanged", "disposition", "exactReadback"),
      sourceIds: ["garden"],
      seedRevision: "seed",
      artifact: { ...artifact, sha256: sha("artifact") },
    },
  };
  const execution = {
    provenance: { contextId },
    diagnostics: { managedGrimoire: { contextId, verification } },
  };
  const call = (callId, parent, name, fields = {}) => ({
    callId,
    record: { parent_call_id: parent, outcome: "done", definition: { name }, ...fields },
  });
  const read = { service: "scratchHandoffRead", method: "read", args: ref(["garden"]), result: ref({
    id: "garden", lines: source.trimEnd().split("\n"),
  }) };
  const claimsTrace = claims.map((claim, index) =>
    call(`claim-${index}`, "inspect", "qualifyClaim", {
      inputs: { claim: ref(claim), observed: ref(observed) },
    })
  );
  const exercise = {
    report: {
      results: workflow.work.map((item, index) => ({ ...item, report: [gardenReport, stagedReport][index] })),
      remaining: [],
    },
    rootCallIds: ["root"],
    calls: [
      call("root", null, "runWorkflow", { inputs: { request: ref(request) } }),
      call("garden", "root", "reviewExample", {
        ended_at: "2026-11-20T10:00:01Z", inputs: { request: ref(workflow.gardenRequest) }, output: ref(gardenReport),
      }),
      call("inspect", "garden", "inspectLiveGarden"),
      call("read-garden", "inspect", "readGarden", {
        effects: [{ service: "gardenRead", method: "observe", result: ref(observed) }],
      }),
      ...claimsTrace,
      call("scratch", "root", "assembleHandoff", {
        started_at: "2026-11-20T10:00:02Z", inputs: { request: ref(sandbox) }, output: ref(stagedReport),
      }),
      call("read-source", "scratch", "readSource", { effects: [read] }),
      call("write", "scratch", "commitHandoff", {
        effects: [{ service: "scratchHandoffWrite", method: "stage", result: ref(artifact) }],
      }),
    ],
  };
  assert.ok(workflow.evidence(execution, exercise, name, workflow));
  const withheld = claimsTrace.at(-1);
  withheld.record.inputs.observed = ref({ ...observed, current: { id: "unowned:current" } });
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /exact committed garden findings/);
  withheld.record.inputs.observed = ref(observed);
  const replaced = source.replace("not-observed", "contradicted");
  verification.sourceSha256 = sha(replaced);
  read.result = ref({ id: "garden", lines: replaced.trimEnd().split("\n") });
  assert.throws(() => workflow.evidence(execution, exercise, name, workflow), /exact committed garden findings/);
});

test("release review handoff binds each transferred source to its live prerequisite", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "release-review-handoff-live-code-only-probe-and-status";
  const workflow = cases.get(name);
  const { assignment, extension, authority, work } = workflow;
  for (const id of [
    "extension-release-live-" + extension.id,
    "authority-review-live-" + authority.id,
  ]) {
    for (const group of workflowSourceGroups(cases.get(id)))
      assert.ok(workflowSourceGroups(workflow).includes(group));
  }
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const contextId = "ctx";
  const releaseRequest = {
    goal: extension.goal,
    operationId: "pdf-release",
    method: extension.method,
  };
  const manifest = { hash: "same-package", activation: "on-invoke", methods: ["probe"] };
  const source = {
    operationId: releaseRequest.operationId,
    contextId,
    name: extension.name,
    source: extension.source,
    workingRevision: "application:pdf",
    mainRevision: "event:pdf",
    workingTree: "a".repeat(64),
    publishedTree: "b".repeat(64),
    working: manifest,
    published: manifest,
  };
  const runtime = {
    operationId: releaseRequest.operationId,
    name: extension.name,
    source: extension.source,
    status: "available",
    identity: null,
    activeEv: null,
    methods: [],
    pendingApproval: null,
    hasError: false,
  };
  const releaseReport = {
    source: { observation: source, disposition: "unpublished-candidate" },
    runtime: { observation: runtime, disposition: "cold" },
    decision: "verify-and-publish-candidate",
  };
  const authorityRequest = {
    goal: authority.goal,
    operations: authority.operations.map(({ id, label }) => ({ id, label })),
    ceiling: [],
  };
  const operationId = authority.operations[0].id;
  const observation = { operationId, decision: "allowed", leaves: [] };
  const assessment = { observation, outside: [], disposition: "eligible" };
  const authorityReport = {
    status: "eligible",
    protectedLeaves: [],
    held: [],
    reviews: [assessment],
  };
  const scratchRequest = {
    goal: "Stage an exact handoff",
    questions: ["What is the release disposition?", "What was held?"],
    sources: [
      { id: "extension", path: "/.tmp/input/extension.txt" },
      { id: "authority", path: "/.tmp/input/authority.txt" },
    ],
  };
  const artifact = { path: "/.tmp/evidence-handoff-a/handoff.json", bytes: 120 };
  const handoffReport = { status: "staged", artifact, missingSources: [], unanswered: [] };
  const request = {
    goal: assignment.goal + " Complete the reviews in order.",
    work: work.map((item, index) => ({
      ...item,
      input: [releaseRequest, authorityRequest, scratchRequest][index],
    })),
  };
  const report = {
    results: work.map((item, index) => ({
      ...item,
      report: [releaseReport, authorityReport, handoffReport][index],
    })),
    remaining: [],
  };
  const sources = {
    extension: `Source disposition: unpublished-candidate; working tree ${source.workingTree}; published tree ${source.publishedTree}.\nRuntime disposition: cold; active version none.\n`,
    authority: "Authority disposition: eligible.\nHeld operations: none.\n",
  };
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  diagnostics.managedReleaseReviewHandoff = {
    caseId: assignment.id,
    contextId,
    request,
    sources,
    passed: true,
    sourceDigests: Object.entries(sources).map(([id, text]) => ({ id, sha256: sha(text) })),
    checks: { release: true, scope: true, handoff: true, transfer: true, order: true },
    release: {
      caseId: extension.id,
      contextId,
      request: releaseRequest,
      source,
      runtime,
      passed: true,
      checks: { source: true, runtime: true, unchanged: true, report: true },
    },
    scope: {
      caseId: authority.id,
      contextId,
      request: authorityRequest,
      observations: [observation],
      passed: true,
      checks: { assigned: true, reviews: true, ceiling: true, decision: true },
    },
    handoff: {
      artifact: { ...artifact, sha256: "d".repeat(64) },
      passed: true,
      expectedStatus: "staged",
      seedRevision: "application:pdf",
      sourceIds: ["extension", "authority"],
      checks: {
        protectedUnchanged: true,
        originalsUnchanged: true,
        disposition: true,
        exactReadback: true,
      },
    },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: sha(text), bytes: Buffer.byteLength(text) };
  };
  const effect = (service, method, args, result) => ({
    service,
    method,
    args: ref(args),
    result: ref(result),
  });
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = [], start = 0) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      started_at: new Date(start * 1000).toISOString(),
      ended_at: new Date((start + 1) * 1000).toISOString(),
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const readAuthority = call("readAuthorityProof", "assembleHandoff", { id: "authority" }, {}, [
    effect("scratchHandoffRead", "read", ["authority"], {
      id: "authority",
      lines: sources.authority.trimEnd().split("\n"),
    }),
  ]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, { request }, report),
      call(
        "reviewExtensionRelease",
        "runWorkflow",
        { request: releaseRequest },
        releaseReport,
        [],
        1
      ),
      call(
        "reviewSource",
        "reviewExtensionRelease",
        { operationId: releaseRequest.operationId, method: extension.method },
        releaseReport.source
      ),
      call("readSource", "reviewSource", { operationId: releaseRequest.operationId }, source, [
        effect("extensionReleaseRead", "source", [releaseRequest.operationId], source),
      ]),
      call(
        "assessSource",
        "reviewSource",
        { observation: source, method: extension.method },
        releaseReport.source.disposition
      ),
      call(
        "reviewRuntime",
        "reviewExtensionRelease",
        { operationId: releaseRequest.operationId, method: extension.method },
        releaseReport.runtime
      ),
      call("readRuntime", "reviewRuntime", { operationId: releaseRequest.operationId }, runtime, [
        effect("extensionReleaseRead", "runtime", [releaseRequest.operationId], runtime),
      ]),
      call(
        "assessRuntime",
        "reviewRuntime",
        { observation: runtime, method: extension.method },
        releaseReport.runtime.disposition
      ),
      call(
        "chooseNext",
        "reviewExtensionRelease",
        { source: releaseReport.source, runtime: releaseReport.runtime },
        releaseReport.decision
      ),
      call("reviewAuthority", "runWorkflow", { request: authorityRequest }, authorityReport, [], 3),
      call("reviewOperation", "reviewAuthority", { operationId, ceiling: [] }, assessment),
      call("preflight", "reviewOperation", { operationId }, observation, [
        effect("assignedAuthorityRead", "preflight", [operationId], observation),
      ]),
      call("findOutside", "reviewOperation", { leaves: [], ceiling: [] }, []),
      call(
        "decideDisposition",
        "reviewOperation",
        { decision: "allowed", outside: [] },
        "eligible"
      ),
      call("combineCeiling", "reviewAuthority", { reviews: [assessment] }, authorityReport),
      call("collectProtected", "combineCeiling", { reviews: [assessment] }, []),
      call("assembleHandoff", "runWorkflow", { request: scratchRequest }, handoffReport, [], 5),
      call("readExtensionProof", "assembleHandoff", { id: "extension" }, {}, [
        effect("scratchHandoffRead", "read", ["extension"], {
          id: "extension",
          lines: sources.extension.trimEnd().split("\n"),
        }),
      ]),
      readAuthority,
      call("commitHandoff", "assembleHandoff", { body: "{}" }, artifact, [
        effect("scratchHandoffWrite", "stage", ["{}"], artifact),
      ]),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  readAuthority.record.effects[0].result = ref({
    id: "authority",
    lines: ["Authority disposition: held."],
  });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /actual release and authority readbacks/u
  );
});

test("architecture export rejects a different creator-scoped provider", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "architecture-boundary-live-creator-scoped-transcript-owner";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const {
    goal,
    protocol,
    name: service,
    source,
    className,
    creatorScoped,
    concern,
    proposedOwner,
    expectedOwner,
  } = assignment;
  const contextId = "ctx";
  const request = { goal, operationId: "scope", concern, proposedOwner };
  const route = {
    receipt: "scope:provider",
    contextId,
    revision: "event:assigned",
    protocol,
    name: service,
    source,
    receiver: { kind: "durable-object", address: "owned-conversation", className, creatorScoped },
  };
  const declaration = {
    routeReceipt: route.receipt,
    source,
    revision: route.revision,
    hash: "manifest-hash",
    name: service,
    protocols: [protocol],
    className,
    creatorScoped,
  };
  const provider = { route, declaration, consistent: true };
  const ownership = { owner: expectedOwner, proposedOwner, aligned: false };
  const report = { provider, ownership, decision: "move-state-to-owner" };
  diagnostics.managedArchitectureBoundary = {
    caseId: assignment.id,
    contextId,
    request,
    route,
    declaration,
    ownedTarget: route.receiver.address,
    passed: true,
    checks: { route: true, declaration: true, unchanged: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const effect = (method, args, result) => ({
    service: "architectureProviderRead",
    method,
    args: ref(args),
    result: ref(result),
  });
  const resolution = call(
    "resolveProvider",
    "inspectProvider",
    { operationId: request.operationId },
    route,
    [effect("resolve", [request.operationId], route)]
  );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewArchitectureBoundary", "runWorkflow", { request }, report),
      call(
        "inspectProvider",
        "reviewArchitectureBoundary",
        { operationId: request.operationId },
        provider
      ),
      resolution,
      call("readDeclaration", "inspectProvider", { routeReceipt: route.receipt }, declaration, [
        effect("declaration", [route.receipt], declaration),
      ]),
      call("matchDeclaration", "inspectProvider", { route, declaration }, true),
      call(
        "reviewOwnership",
        "reviewArchitectureBoundary",
        { concern, proposedOwner, provider },
        ownership
      ),
      call("chooseOwner", "reviewOwnership", { concern, provider }, expectedOwner),
      call(
        "chooseDisposition",
        "reviewArchitectureBoundary",
        { provider, ownership },
        report.decision
      ),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  resolution.record.effects[0].result = ref({
    ...route,
    receiver: { ...route.receiver, address: "foreign-conversation" },
  });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /actual assigned provider/u
  );
});

test("web brief export binds exact page continuation and cited text", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "web-brief-live-registry-subdomain-scope";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const { goal, sources, facts } = assignment;
  const url = sources[0];
  const request = { goal, sources, retrievedAt: Date.UTC(2026, 10, 19) };
  const quote = "The designation " + facts[0].pattern + ".";
  const head = "Registry excerpt\n";
  const visible = head + quote;
  const digest = createHash("sha256").update(visible).digest("hex");
  const page = {
    url,
    title: "The registry",
    digest,
    size: Buffer.byteLength(visible),
    head,
    headBytes: Buffer.byteLength(head),
    truncated: true,
    session: "public",
  };
  const readArgs = { digest, offset: page.headBytes, limit: 9000 - head.length };
  const tail = { ...readArgs, text: quote, bytes: Buffer.byteLength(quote), nextOffset: page.size };
  const report = {
    question: goal,
    status: "answered",
    notRead: [],
    rejected: 0,
    statements: [
      {
        text: quote,
        cites: [{ url, title: page.title, quote, retrieved: "2026-11-19", published: null }],
      },
    ],
  };
  diagnostics.managedWebBrief = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    passed: true,
    reads: [{ requested: url, page }],
    tails: [tail],
    cache: [{ requested: url, digest, size: page.size, visible, verified: true }],
    checks: { assigned: true, continuations: true, cache: true, outcome: true, citations: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const continuation = { service: "web", method: "read", args: ref([readArgs]), result: ref(tail) };
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("writeAssignedBrief", "runWorkflow", { request }, report),
      call(
        "researchBrief",
        "writeAssignedBrief",
        { question: goal, sources, retrievedAt: request.retrievedAt },
        report,
        [
          {
            service: "web",
            method: "fetch",
            args: ref([{ url, session: "public" }]),
            result: ref(page),
          },
          continuation,
        ]
      ),
      call("findEvidence", "researchBrief", { question: goal }, { claim: quote, quote }),
      call("writeBrief", "researchBrief", { question: goal }, report.statements),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  // Pure TS forwarding has no writeAssignedBrief model-call record.
  const run = diagnostics.natlangTeacher;
  run.calls = run.calls.filter(call => call.record.definition.name !== "writeAssignedBrief");
  run.calls.find(call => call.record.definition.name === "researchBrief").record.parent_call_id = "runWorkflow";
  run.applicationResult = { results: [{ kind: "domain", domain: "webResearch", operation: "writeAssignedBrief", report }], remaining: [] };
  run.calls[0].record.output = ref(run.applicationResult);
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-native-bridge` });
  run.applicationResult.results[0].report = { ...report, question: "A fabricated return" };
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /actual returned brief/u);
  run.applicationResult.results[0].report = report;
  continuation.args = ref([{ ...readArgs, offset: 1 }]);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /host-verified cached bytes/u
  );
});

test("VCS delivery export checks the original revision read and the nested decision", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "vcs-delivery-live-committed-cleanup-contract";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const { goal, path: filePath, repository, next, text } = assignment;
  const request = { goal, repository, path: filePath, operationId: "read-assigned-vcs-candidate" };
  const committed = { kind: "event", eventId: "workspace-event:candidate" };
  const version = {
    fileId: "file:cleanup",
    hash: "content:cleanup",
    mode: 420,
    excerpt: text,
    truncated: false,
  };
  const snapshot = {
    contextId: "ctx",
    current: true,
    clean: true,
    relation: "ahead",
    working: committed,
    committed,
    protectedMain: { kind: "event", eventId: "workspace-event:main" },
    integrations: [],
    file: {
      path: filePath,
      working: version,
      committed: version,
      protectedMain: null,
      hasLocalDifference: false,
      hasDeliveryDifference: true,
    },
  };
  const chain = {
    local: { state: "clean", summary: "Already committed" },
    main: { state: "current", summary: "Candidate is ahead" },
  };
  const interpretation = { effect: "Cancellation closes the preview panel", risks: [] };
  const review = { ...interpretation, checks: ["Cancel a preview and confirm its panel closes"] };
  const report = { snapshot, chain, review, next };
  diagnostics.managedVcsDelivery = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    passed: true,
    snapshot,
    checks: { contextPreserved: true, exactState: true, assignedFile: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const observed = {
    service: "vcsDeliveryRead",
    method: "observe",
    args: ref([request.operationId]),
    result: ref(snapshot),
  };
  const decision = call(
    "chooseDeliveryStep",
    "reviewVcsDelivery",
    { snapshot, chain, review },
    next
  );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewVcsDelivery", "runWorkflow", { request }, report, [observed]),
      call("inspectChain", "reviewVcsDelivery", { snapshot }, chain),
      call("describeLocalChain", "inspectChain", {}, chain.local),
      call("reviewIntegration", "inspectChain", {}, chain.main),
      call("reviewChange", "reviewVcsDelivery", { file: snapshot.file }, review),
      call("interpretFile", "reviewChange", { file: snapshot.file }, interpretation),
      call("planChecks", "reviewChange", { path: filePath }, review.checks),
      decision,
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  observed.result = ref({ ...snapshot, relation: "behind" });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /actual semantic snapshot/u
  );

  observed.result = ref(snapshot);
  decision.record.output = ref("already-current");
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact next step/u);
});

test("Git Bridge export rejects stale remote facts and a substituted candidate decision", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "git-bridge-review-live-draft-awaiting-semantic-publication";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const { goal, repository, direction, source, next } = assignment;
  const request = { goal, repository, direction, operationId: "assigned-bridge-read" };
  const upstream = {
    state: "local-only",
    remote: null,
    branch: null,
    autoPush: false,
    candidate: null,
    observation: null,
  };
  const semantic = {
    contextId: "ctx",
    current: true,
    mainEventId: "workspace-event:main",
    working: { kind: "application", applicationId: "application:working" },
    clean: false,
    relation: "at",
    workingRepositoryId: "repo:review",
    mainRepositoryId: "repo:review",
  };
  const view = { repository, upstream, semantic };
  const upstreamReview = {
    freshness: "absent",
    consequence: "The repository has no configured upstream.",
  };
  const semanticReview = {
    source: { state: source, explanation: "Protected main lacks the draft application." },
    integration: { candidate: null, explanation: "The bridge returned no pending import." },
  };
  const action = { next, reason: "Review and publish the draft semantically before export." };
  const report = { view, upstreamReview, semanticReview, ...action };
  diagnostics.managedGitBridgeReview = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    passed: true,
    observed: view,
    checks: { contextPreserved: true, semantic: true, upstream: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const observe = {
    service: "gitBridgeReviewRead",
    method: "observe",
    args: ref([request.operationId]),
    result: ref(view),
  };
  const candidate = call(
    "reviewCandidate",
    "reviewSemantic",
    { candidate: null },
    semanticReview.integration
  );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewGitBridge", "runWorkflow", { request }, report, [observe]),
      call("reviewUpstream", "reviewGitBridge", { direction, upstream }, upstreamReview),
      call("checkFreshness", "reviewUpstream", { upstream }, upstreamReview.freshness),
      call(
        "interpretTransfer",
        "reviewUpstream",
        { direction, upstream },
        upstreamReview.consequence
      ),
      call("reviewSemantic", "reviewGitBridge", { semantic }, semanticReview),
      call("reviewPublicationBasis", "reviewSemantic", { semantic }, semanticReview.source),
      candidate,
      call("chooseBridgeStep", "reviewGitBridge", { view }, action),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  observe.result = ref({ ...view, upstream: { ...upstream, observation: { at: 123, behind: 2 } } });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact actual upstream/u);

  observe.result = ref(view);
  candidate.record.output = ref({
    ...semanticReview.integration,
    candidate: { eventId: "different" },
  });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /nested upstream/u);
});

test("declared-suite export binds a focused verification to the observed runtime and state", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "native-suite-live-verify-adventure-engine-workerd";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const { goal, target, suite, file, mode, runtime } = assignment;
  const request = {
    goal,
    target,
    suite,
    file,
    mode,
    testName: null,
    operationId: "assigned-suite-verification",
  };
  const plan = { target, suite, runtime, contextId: "ctx", stateHash: "assigned-state" };
  const execution = {
    receipt: {
      operation: "test", target, suite, runtime, contextId: "ctx",
      ref: "ctx:ctx", stateHash: plan.stateHash,
    },
    current: true,
    status: "passed",
    artifactKey: "artifact:verified",
    executionDigest: "a".repeat(64),
    reportDigest: "b".repeat(64),
    passed: 1,
    failed: 0,
    diagnostics: [],
  };
  const decision = {
    route: { runtime, nativeApproval: false, explanation: "Run in the declared workerd runtime" },
    next: "run-assignment",
  };
  const result = { outcome: "verified", followUp: "One test passed" };
  const report = { plan, decision, execution, result };
  diagnostics.managedNativeSuite = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    passed: true,
    observed: plan,
    executed: execution,
    checks: { plan: true, route: true, execution: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const resolved = {
    service: "testSuitePlanRead",
    method: "resolve",
    args: ref([request.operationId]),
    result: ref(plan),
  };
  const ran = {
    service: "testSuiteVerificationRun",
    method: "run",
    args: ref([request.operationId, plan.stateHash]),
    result: ref(execution),
  };
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewTestSuite", "runWorkflow", { request }, report, [resolved, ran]),
      call("reviewPlan", "reviewTestSuite", { plan }, decision),
      call("interpretRuntime", "reviewPlan", { plan }, decision.route),
      call("chooseRunDisposition", "reviewPlan", { mode }, decision.next),
      call("reviewResult", "reviewTestSuite", { plan, execution }, result),
      call("checkReceipt", "reviewResult", { plan, execution }, "matched"),
      call("interpretOutcome", "reviewResult", {}, result.outcome),
      call("planFollowUp", "reviewResult", {}, result.followUp),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const receiptCheck = diagnostics.natlangTeacher.calls.find(({ callId }) => callId === "checkReceipt");
  receiptCheck.record.output = ref("stale");
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-receipt-mismatch` }),
    /exact execution receipt/u
  );
  receiptCheck.record.output = ref("matched");
  ran.args = ref([request.operationId, "superseded-state"]);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /exact execution receipt/u
  );
});

test("dictation export preserves measured audio and the live worker decision", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "offline-dictation-live-multi-window-readiness";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const { goal, recording, durationMs, windowed } = assignment;
  const request = {
    goal,
    mode: "inspect",
    presentation: "verbatim",
    operationId: "assigned-dictation",
  };
  const capture = { ready: false, recording, durationMs, windowed };
  const review = {
    next: "prepare-local-worker",
    guidance: "Prepare the local worker for this multi-window recording.",
  };
  const report = { capture, review, transcript: null, draft: null };
  diagnostics.managedDictation = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    passed: true,
    observed: capture,
    checks: { liveWorker: true, recording: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const inspected = {
    service: "dictationCaptureRead",
    method: "inspect",
    args: ref([request.operationId]),
    result: ref(capture),
  };
  const readiness = call(
    "chooseReadiness",
    "reviewCapture",
    { capture, mode: "inspect" },
    review.next
  );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewDictation", "runWorkflow", { request }, report, [inspected]),
      call("reviewCapture", "reviewDictation", { capture, mode: "inspect" }, review),
      call("reviewRecording", "reviewCapture", { capture }, review.guidance),
      readiness,
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  readiness.record.output = ref("transcribe");
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /nested capture and readiness/u
  );
});

test("PDF layout export binds reading order to the actual fragment boxes", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "pdf-layout-live-parallel-narrative-columns";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const { goal, kind, rows, order } = assignment;
  const request = { goal, operationId: "assigned-pdf-layout" };
  const page = {
    digest: "a".repeat(64),
    pageNumber: 1,
    width: 500,
    height: 200,
    rows: rows.map((row, y) =>
      row.map((text, x) => ({ text, bounds: [24 + x * 226, 18 + y * 20, 70, 12] }))
    ),
  };
  const fragments = page.rows.flatMap((row, y) =>
    row.map((part, x) => ({ row: y, fragment: x, ...part }))
  );
  const ordered = order.map((text) => fragments.find((part) => part.text === text));
  const locations = ordered.map(({ row, fragment }) => ({ row, fragment }));
  const layout = { kind, basis: "Parallel note headings and aligned fragment starts." };
  const reading = { status: "ordered", entries: ordered };
  const report = { digest: page.digest, pageNumber: 1, layout, reading };
  diagnostics.managedPdfLayout = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    passed: true,
    observed: page,
    checks: { source: true, geometry: true, reading: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const inspected = {
    service: "pdfLayoutRead",
    method: "inspect",
    args: ref([request.operationId]),
    result: ref(page),
  };
  const arrangement = call("arrangeFragments", "resolveReadingOrder", { page, layout }, locations);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewPdfLayout", "runWorkflow", { request }, report, [inspected]),
      call("inspectLayout", "reviewPdfLayout", { page, goal }, layout),
      call("describeGeometry", "inspectLayout", { page }, layout.basis),
      call("classifyLayout", "inspectLayout", { goal }, layout),
      call("resolveReadingOrder", "reviewPdfLayout", { page, layout }, reading),
      arrangement,
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  arrangement.record.output = ref(fragments.map(({ row, fragment }) => ({ row, fragment })));
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /correct reading order/u);
});

test("eval recovery export requires the original failed cell and its independently read effect", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "eval-recovery-live-completed-before-failure";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
  entry.test.name = name;
  const request = { goal: assignment.goal, operationId: "assigned-effect" };
  const digest = "a".repeat(64);
  const size = 20;
  const runId = "system-test-eval-recovery:392f38af-55a1-482d-b074-5ac48bdcce3e";
  const attempt = {
    operationId: request.operationId,
    runId,
    cell: "failed",
    journal: "complete",
    expectedDigest: digest,
    expectedSize: size,
    allowReadback: true,
    stores: [{ digest, contentDigest: digest, size }],
  };
  const readback = { digest, observedDigest: digest, size };
  const decision = {
    next: assignment.next,
    reason: "The exact effect was read back after the failure.",
  };
  const report = {
    runId,
    cell: "failed",
    journal: "matched",
    readback,
    effect: "confirmed",
    ...decision,
  };
  diagnostics.managedEvalRecovery = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    passed: true,
    attempt,
    readback,
    checks: { original: true, storage: true, readback: true, recovery: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const observed = {
    service: "evalRecoveryJournal",
    method: "observe",
    args: ref([request.operationId]),
    result: ref(attempt),
  };
  const read = {
    service: "evalRecoveryReadback",
    method: "read",
    args: ref([request.operationId, digest]),
    result: ref(readback),
  };
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewEvalRecovery", "runWorkflow", { request }, report, [observed]),
      call("inspectJournal", "reviewEvalRecovery", { attempt }, "matched"),
      call("compareReceipts", "inspectJournal", { attempt }, "matched"),
      call(
        "verifyEffect",
        "reviewEvalRecovery",
        { attempt, finding: "matched" },
        { readback, effect: "confirmed" },
        [read]
      ),
      call("assessReadback", "verifyEffect", { attempt, read: readback }, "confirmed"),
      call("chooseRecovery", "reviewEvalRecovery", { attempt }, decision),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  read.args = ref([request.operationId, "b".repeat(64)]);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact effect readback/u);

  const truncatedId = "eval-recovery-live-truncated-with-visible-store";
  const truncated = cases.get(truncatedId);
  const truncatedRequest = { ...request, goal: truncated.assignment.goal };
  const retainedAttempt = { ...attempt, journal: "truncated" };
  const disposition = { next: "recover-journal", reason: "The retained prefix may omit another receipt." };
  const incompleteReport = {
    ...report, journal: "incomplete", readback: null, effect: "unchecked", ...disposition,
  };
  const witness = {
    ...diagnostics.managedEvalRecovery,
    caseId: truncated.assignment.id, request: truncatedRequest, attempt: retainedAttempt, readback: null,
  };
  const qualification = {
    provenance: { contextId: "ctx" },
    diagnostics: { managedEvalRecovery: witness },
  };
  const verify = call("verifyEffect", "reviewEvalRecovery", { attempt: retainedAttempt, finding: "incomplete" }, {
    readback: null, effect: "unchecked",
  });
  const captured = {
    ...diagnostics.natlangTeacher, report: incompleteReport, calls: [
      call("runWorkflow", null, {}, null),
      call("reviewEvalRecovery", "runWorkflow", { request: truncatedRequest }, incompleteReport, [
        { ...observed, result: ref(retainedAttempt) },
      ]),
      call("inspectJournal", "reviewEvalRecovery", { attempt: retainedAttempt }, "incomplete"),
      call("compareReceipts", "inspectJournal", { attempt: retainedAttempt }, "incomplete"),
      verify,
      call("chooseRecovery", "reviewEvalRecovery", { attempt: retainedAttempt }, disposition),
    ],
  };
  const validateTruncated = () => truncated.evidence(qualification, captured, truncatedId, truncated);
  assert.equal(validateTruncated().world.run_id, runId);
  verify.record.effects.push(read);
  assert.throws(validateTruncated, /original native journal/u);
});

test("log cursor export joins distinct classifier calls to the bounded live read", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "log-cursor-live-resume-mixed-severity-window";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const request = { goal: assignment.goal, operationId: "assigned-log-cursor" };
  const seed = { marker: "owned-log", boot: "system-boot-1", start: 50, steps: [52, 54, 55, 57] };
  const records = seed.steps.map((seq, i) => ({
    seq,
    timestamp: 123 + i,
    level: "warn",
    pid: 7,
    tag: "WorkerdManager",
    message: seed.marker + " " + assignment.lines[i],
  }));
  const observed = {
    saved: { serverBootId: seed.boot, seq: seed.start },
    liveBoot: seed.boot,
    oldestSeq: 1,
    latestSeq: 60,
    throughSeq: 57,
    overflow: false,
    snapshot: { serverBootId: seed.boot, latestSeq: 57, totalCaptured: 60, records },
  };
  const decision = {
    status: "review-window",
    reason: "The existing boot still retains the assigned range.",
  };
  const logGroup = (id, first, last, count) => ({
    id,
    level: "warn",
    tag: "WorkerdManager",
    message: records[first].message,
    count,
    firstSeq: records[first].seq,
    lastSeq: records[last].seq,
  });
  const routine = logGroup(0, 0, 0, 1);
  const notable = logGroup(1, 1, 3, 2);
  const failure = logGroup(2, 2, 2, 1);
  const finding = ({ id, ...group }, label) => ({ ...group, class: label });
  const brief = {
    serverBootId: seed.boot,
    latestSeq: 57,
    window: { fromSeq: 52, toSeq: 57, records: 4 },
    status: "incident",
    headline: "One failure and one notable group",
    findings: [finding(failure, "failure"), finding(notable, "notable")],
  };
  const report = {
    liveBoot: seed.boot,
    latestSeq: 60,
    decision,
    brief,
    next: { serverBootId: seed.boot, seq: 57 },
  };
  diagnostics.managedLogCursor = {
    caseId: assignment.id,
    contextId: "ctx",
    request,
    passed: true,
    observed,
    seed,
    checks: { cursor: true, raw: true, outcome: true, brief: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = [], id = name) => ({
    callId: id,
    summary: { ...prototype.summary, call_id: id },
    record: {
      ...prototype.record,
      call_id: id,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const read = {
    service: "serverLogCursor",
    method: "observe",
    args: ref([request.operationId]),
    result: ref(observed),
  };
  const review = call("reviewLogCursor", "runWorkflow", { request }, report, [read]);
  const notableCall = call(
    "classifyHostLogGroup", "reviewLogCursor", { group: notable }, "notable", [], "classify-1"
  );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      review,
      call("checkCursor", "reviewLogCursor", { window: observed }, decision),
      call("compareBoot", "checkCursor", {}, "same"),
      call("checkCoverage", "checkCursor", {}, decision),
      call("classifyHostLogGroup", "reviewLogCursor", { group: routine }, "routine", [], "classify-0"),
      notableCall,
      call("classifyHostLogGroup", "reviewLogCursor", { group: failure }, "failure", [], "classify-2"),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  notableCall.record.inputs.group = ref(failure);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact covered records/u);
  notableCall.record.inputs.group = ref(notable);
  report.next.seq = 60;
  review.record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact covered records/u);
});

test("host-log handoff export binds each classification to its own live window", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "log-handoff-live-different-startup-failure";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const seed = {
    marker: "natlang-host-log-owned", boot: "boot", workspaceId: "workspace", start: 10, steps: [11, 21, 22],
  };
  const request = {
    goal: assignment.goal, serverBootId: seed.boot,
    earlier: { after: 10, through: 11 }, later: { after: 11, through: 22 }, tag: "WorkerdManager",
  };
  const reads = {};
  const report = { status: assignment.status };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = [], id = name) => ({
    callId: id,
    summary: { ...prototype.summary, call_id: id },
    record: {
      ...prototype.record, call_id: id, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output), effects,
    },
  });
  const briefCalls = [];
  const queries = [];
  for (const [side, seqs] of [["earlier", [11]], ["later", [21, 22]]]) {
    const { line, label, repeat } = assignment[side][0];
    const message = seed.marker + " " + line;
    const records = seqs.map((seq) => ({ seq, level: "warn", tag: request.tag, message, pid: 1, timestamp: seq }));
    reads[side] = { serverBootId: seed.boot, workspaceId: seed.workspaceId, latestSeq: 25, records };
    const group = {
      level: "warn", tag: request.tag, message, count: repeat, firstSeq: seqs[0], lastSeq: seqs.at(-1),
    };
    report[side] = {
      serverBootId: seed.boot, latestSeq: 25, status: "incident",
      window: { fromSeq: seqs[0], toSeq: seqs.at(-1), records: seqs.length },
      findings: [{ class: label, ...group }],
    };
    const bounds = request[side];
    const query = {
      service: "serverLog", method: "query",
      args: ref([{ sinceSeq: bounds.after, untilSeq: bounds.through, tag: request.tag, limit: 301 }]),
      result: ref(reads[side]),
    };
    queries.push(query);
    briefCalls.push(
      call("briefServerLog", "reviewHostLogHandoff", { request: { bounds, tag: request.tag } }, report[side], [query], side),
      call("classifyHostLogGroup", side, { group: { id: 0, ...group } }, label, [], side + "-classification"),
    );
  }
  diagnostics.managedLogHandoff = {
    caseId: assignment.id, contextId: "ctx", request, passed: true, seed, reads,
    checks: { earlier: true, later: true, progress: true },
  };
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewHostLogHandoff", "runWorkflow", { request }, report),
      ...briefCalls,
      call("interpretLogProgress", "reviewHostLogHandoff", {
        goal: request.goal, earlier: report.earlier, later: report.later,
      }, report.status),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const original = queries[1].result;
  queries[1].result = queries[0].result;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact live records/u);
  queries[1].result = original;
  briefCalls[3].record.inputs.group = briefCalls[1].record.inputs.group;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact observed sequence range/u);
});

test("build performance export binds the handoff to measured payload and repeat keys", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "build-performance-live-initial-delivery-budget";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const request = { goal: assignment.goal, operationId: "assigned-profile", initialBudgetBytes: assignment.initialBudgetBytes };
  const largest = { source: "panel.tsx", bytes: 150 };
  const payload = {
    initialBytes: 400, lazyBytes: 100, totalBytes: 500, largestInitialInputs: [largest],
  };
  const receipt = {
    source: "panels/assigned",
    status: "ok",
    stateHash: "observed-state",
    first: {
      elapsedMs: 23,
      cacheState: "built-during-profile",
      phases: { bundlingMs: 16, validationMs: 5, otherMs: 2 },
    },
    repeat: { elapsedMs: 3, sameBuildKeys: true },
    targets: [{ target: "runtime", buildKey: "observed-build", payload }],
  };
  const report = {
    observation: receipt,
    execution: { state: "built", repeat: "verified", phase: "bundling" },
    payload: { budget: "over", largestInitialInput: largest },
    next: { action: "reduce-initial-payload", reason: "Inspect the measured initial panel contributor." },
  };
  diagnostics.buildPerformance = {
    passed: true, request, receipt, checks: { native: true, observation: true, judgments: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const read = { service: "buildPerformance", method: "observe", args: ref([request.operationId]), result: ref(receipt) };
  const review = call("reviewBuildPerformance", "runWorkflow", { request }, report, [read]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      review,
      call("assessBuildRun", "reviewBuildPerformance", { observation: receipt }, report.execution),
      call("identifyPhase", "assessBuildRun", { times: receipt.first.phases }, report.execution.phase),
      call("reviewPayload", "reviewBuildPerformance", { payload }, report.payload),
      call("chooseInitialContributor", "reviewPayload", { contributors: payload.largestInitialInputs }, largest),
      call("chooseFollowup", "reviewBuildPerformance", { observation: receipt }, report.next),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  receipt.repeat.sameBuildKeys = false;
  read.result = ref(receipt);
  review.record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /verified repeat keys/u);
});

test("tour rehearsal export requires each rendered stop and the original restoration", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "tour-rehearsal-live-boundary-rehearsal-restore";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "personal" }));
  entry.test.name = name;
  const request = {
    operationId: "assigned-tour", goal: assignment.goal, topics: assignment.topics, restore: true,
  };
  const deck = [
    ["opening", "Make it yours"], ["continuum", "Apps meet agents"],
    ["workspaces", "Capabilities & security"], ["websites", "Websites & apps"],
    ["automations", "Automations"], ["closing", "Your first tool"],
  ].map(([id, title], i) => ({ id, title, position: i + 1, eyebrow: `0${i + 1} · ${title}` }));
  const frame = ({ scene, progress }, notes) => {
    const item = deck.find(({ id }) => id === scene);
    return {
      storedScene: scene, storedNotes: notes, eyebrow: item.eyebrow,
      heading: item.title, progress, notesVisible: notes,
    };
  };
  const start = { deck, allowed: assignment.allowed, frame: frame(assignment.initial, false) };
  const stops = assignment.expected.map(({ scene }, i) => ({
    topic: assignment.topics[i], scene: deck.find(({ id }) => id === scene), notes: true,
  }));
  const plan = { stops, unmatchedTopics: [] };
  const visited = assignment.expected.map((expected) => ({
    scene: expected.scene, notes: true, frame: frame(expected, true),
  }));
  const restoration = { frame: structuredClone(start.frame), stage: "verified" };
  const report = {
    start, plan,
    visits: visited.map(({ frame }, i) => ({ stop: stops[i], readback: { stage: "verified", frame } })),
    restoration,
    outcome: "rehearsed",
  };
  diagnostics.tourRehearsal = {
    passed: true, caseId: assignment.id, contextId: "ctx", panelId: "assigned-panel",
    request, start, visited, restored: restoration.frame,
    checks: { initial: true, plan: true, visits: true, restoration: true, outcome: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = [], id = name) => ({
    callId: id,
    summary: { ...prototype.summary, call_id: id },
    record: {
      ...prototype.record,
      call_id: id,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const effect = (method, args, result) => ({
    service: "tourRehearsal", method, args: ref(args), result: ref(result),
  });
  const review = call("rehearseTour", "runWorkflow", { request }, report, [
    effect("observe", [request.operationId], start),
    effect("restore", [request.operationId], restoration.frame),
  ]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      review,
      call("planRehearsal", "rehearseTour", { start }, plan),
      ...stops.map(({ topic, scene }, i) => call("resolveTourTopic", "planRehearsal", { topic }, scene, [], `topic-${i}`)),
      call("reviewStops", "rehearseTour", { plan }, report.visits,
        visited.map(({ scene, notes, frame }) => effect("visit", [request.operationId, scene, notes], frame))),
      ...report.visits.map(({ stop, readback }, i) =>
        call("verifyTourStop", "reviewStops", { frame: readback.frame, stop }, readback, [], `stop-${i}`)),
      call("verifyRestoration", "rehearseTour", { frame: restoration.frame }, restoration),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  restoration.frame.notesVisible = !start.frame.notesVisible;
  review.record.effects[1].result = ref(restoration.frame);
  review.record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /authorized restoration/u);
});

test("Explorer export rejects a scratch byte count that disagrees with native text", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "explorer-text-live-unicode-size-claim";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "personal" }));
  entry.test.name = name;
  const request = { goal: assignment.goal, operationId: "assigned-workspace-text" };
  const digest = createHash("sha256").update(assignment.text).digest("hex");
  const bytes = Buffer.byteLength(assignment.text);
  const input = {
    bytes, digest, characters: Array.from(assignment.text).length,
    lineEnding: assignment.lineEnding, claim: assignment.claim, repeat: assignment.repeat,
  };
  const plan = {
    expectedBytes: bytes, expectedDigest: digest, check: assignment.check, comparison: "round-trip",
  };
  const receipt = {
    blob: { digest, writtenBytes: bytes, exists: true, statBytes: bytes, readDigest: digest, repeatDigest: null },
    file: { digest, bytes, removed: true },
  };
  const assessment = { classification: "doc-mismatch", issue: "claim" };
  const report = { input, plan, receipt, assessment, next: "Update the maintenance note to state bytes." };
  diagnostics.explorerTextProbe = {
    passed: true, caseId: assignment.id, contextId: "ctx", request, observed: input, actual: receipt,
    operations: ["input", "run"],
    checks: { operations: true, input: true, plan: true, native: true, classification: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const effect = (method, args, result) => ({
    service: "explorerTextProbe", method, args: ref(args), result: ref(result),
  });
  const probe = call("probeWorkspaceText", "runWorkflow", { request }, report, [
    effect("input", [request.operationId], input),
    effect("run", [request.operationId, plan], receipt),
  ]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      probe,
      call("planProbe", "probeWorkspaceText", { input }, plan),
      call("chooseTextCheck", "planProbe", { input }, plan.check),
      call("classifyProbe", "probeWorkspaceText", { receipt }, assessment),
      call("verifyContract", "classifyProbe", { receipt }, null),
      call("reviewClaim", "classifyProbe", { input, receipt }, "contradicted"),
      call("chooseNext", "probeWorkspaceText", { assessment }, report.next),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  receipt.file.bytes = input.characters;
  probe.record.effects[1].result = ref(receipt);
  probe.record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact native file and blob receipts/u);
});

test("Gmail compose export requires the native delivery history and reconciliation decision", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "gmail-compose-history-live-reconcile-uncertain-delivery";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "google-workspace" }));
  entry.test.name = name;
  entry.execution.provenance.channelId = "assigned-channel";
  const request = { goal: assignment.goal, operationId: "assigned-history" };
  const seed = {
    caseId: assignment.id, contextId: "ctx", channelId: "assigned-channel", messageId: "compose",
    lineage: [1, 3, 5].map((seq) => ({ id: `event-${seq}`, seq })),
  };
  const events = seed.lineage.map((item, i) => ({
    ...item, event: i ? "update" : "start", state: {
      status: i ? assignment.updates[i - 1].status : assignment.initial.status,
      recipientPresent: true, alias: "default", draftId: null,
      mimeIdentity: true, sentIdentity: false,
    },
  }));
  const receipt = { channelId: seed.channelId, messageId: seed.messageId, events };
  const decision = { action: "reconcile-delivery", reason: "Check the existing MIME identity." };
  const evidenceIds = [events[0].id, events.at(-1).id];
  const historyReport = { receipt, decision, evidenceIds };
  const latest = events.at(-1);
  const target = { id: events[0].id, channelId: seed.channelId, accountRef: "channel-only:" + seed.channelId };
  const projected = {
    kind: "compose", goal: assignment.goal,
    scope: { target, observed: { ...target, id: latest.id, binding: "channel-readback" } },
    card: {
      id: latest.id, messageId: seed.messageId, requestedMessageId: seed.messageId, ownedByChannel: true,
      state: latest.state.status, hasRecipient: true, alias: "default",
    },
    readback: { kind: "reconcile", id: latest.id, providerProof: "not-checked" },
  };
  const review = { status: "waiting", findings: [{ code: "delivery-unproven", evidenceIds: [latest.id] }] };
  const report = { history: historyReport, review };
  diagnostics.gmailComposeHistory = {
    passed: true, seed, request, received: receipt, projected,
    checks: { channel: true, lineage: true, disposition: true, evidence: true, projection: true, review: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const history = call("inspectComposeHistory", "auditComposeHistory", { request }, historyReport, [{
    service: "gmailComposeHistory", method: "read", args: ref([request.operationId]), result: ref(receipt),
  }]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("auditComposeHistory", "runWorkflow", { request }, report, [{
        service: "gmailComposeAudit", method: "project", args: ref([request.operationId, "reconcile"]), result: ref(projected),
      }]),
      history,
      call("assessComposeState", "inspectComposeHistory", { events }, decision),
      call("checkDelivery", "assessComposeState", { state: events.at(-1).state }, decision),
      call("citeComposeHistory", "inspectComposeHistory", { events }, evidenceIds),
      call("reviewGmailWorkflow", "auditComposeHistory", { request: projected }, review),
      call("reviewCompose", "reviewGmailWorkflow", { input: projected }, review),
      call("establishGmailScope", "reviewGmailWorkflow", { scope: projected.scope }, null),
      call("qualifyComposeCard", "reviewCompose", { input: projected.card }, null),
      call("inspectDelivery", "reviewCompose", { input: projected }, review),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const workflowReview = diagnostics.natlangTeacher.calls.find(({ callId }) => callId === "reviewGmailWorkflow");
  workflowReview.record.inputs.request = ref({ ...projected, card: { ...projected.card, messageId: "other-card" } });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact assigned channel and persisted readback/u);
  workflowReview.record.inputs.request = ref(projected);
  evidenceIds[1] = "other-channel-event";
  history.record.output = ref(historyReport);
  diagnostics.natlangTeacher.calls[1].record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact lineage and appropriate recovery/u);

  evidenceIds[1] = latest.id;
  history.record.output = ref(historyReport);
  const audit = diagnostics.natlangTeacher.calls[1];
  audit.record.output = ref(report);
  audit.record.parent_call_id = "planComposeContinuation";
  const continuationName = "google-setup-live-hold-interrupted-send-pending-setup";
  entry.test.name = continuationName;
  const world = cases.get(continuationName);
  const receipts = world.checks.map((check, index) => ({
    id: `ctx:google-setup:${index + 1}`,
    check,
    stage: "needs-setup",
    gmailEnabled: false,
    inheritedLaunch: check.kind === "launch-gate" && check.afterReload ? false : null,
    ...(check.kind === "viewport" ? { viewportWidth: check.width, overflow: false } : {}),
  }));
  const setup = {
    status: "action-needed", action: "open-setup", ids: [], checkpoint: null,
    panelFindings: receipts.map(({ id, check }, index) => ({ check, code: world.codes[index], evidenceId: id })),
  };
  const launchRows = receipts.filter(({ check }) => check.kind === "launch-gate");
  assert.equal(launchRows.length, 2);
  const gate = { evidenceId: launchRows.at(-1).id, enabled: false };
  const disposition = { launch: "held", action: "reconcile-before-retry", evidenceIds: [gate.evidenceId, latest.id] };
  const continuation = { audit: report, continuation: disposition };
  diagnostics.managedGoogleSetup = {
    contextId: "ctx",
    verification: {
      passed: true, checks: { verifiedSetup: true, verifiedCompose: true, boundContinuation: true },
      gate, compose: diagnostics.gmailComposeHistory,
      setup: {
        contextId: "ctx", caseId: world.caseId, panelId: "welcome", receipts, passed: true,
        readiness: { state: "needs-setup" },
        checks: { driveNeedsSetup: true, browserAgrees: true, reportMatches: true },
      },
    },
  };
  diagnostics.natlangTeacher.report = { results: [
    { domain: "google", operation: "guideGoogleWorkspace", report: setup },
    { domain: "gmailReview", operation: "planComposeContinuation", report: continuation },
  ] };
  const setupCall = call("guideGoogleWorkspace", "runWorkflow", {}, setup);
  const continuationCall = call("planComposeContinuation", "runWorkflow", { request }, continuation, [{
    service: "gmailContinuationRead", method: "launchEvidence", args: ref([]), result: ref(gate),
  }]);
  setupCall.record.ended_at = new Date(1).toISOString();
  continuationCall.record.started_at = new Date(2).toISOString();
  const decisionCall = call("decideContinuation", "planComposeContinuation", { gate, audit: report }, disposition);
  diagnostics.natlangTeacher.calls.push(
    setupCall,
    call("reviewSetupJourney", "guideGoogleWorkspace", {}, setup),
    continuationCall,
    decisionCall,
  );
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-continuation` });
  continuationCall.record.effects[0].result = ref({ ...gate, evidenceId: "other-panel" });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-wrong-launch-control` }),
    /requires the assigned launch observation/u
  );
  gate.evidenceId = launchRows[0].id;
  disposition.evidenceIds[0] = gate.evidenceId;
  continuationCall.record.effects[0].result = ref(gate);
  continuationCall.record.output = ref(continuation);
  decisionCall.record.inputs.gate = ref(gate);
  decisionCall.record.output = ref(disposition);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-superseded-launch-control` }),
    /requires the assigned launch observation/u
  );

});

test("unit identity export rejects artwork that differs from the grounded catalog choice", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "unit-identity-live-stage-workspace-index-icon";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const request = { operationId: "assigned-icon", goal: assignment.goal, unit: assignment.unit, prepare: true };
  const original = { repoPath: assignment.repoPath, revision: "assigned-before", icon: "./assets/icon.svg", artworkDigest: "a".repeat(64) };
  const selected = { choice: { family: "lucide", id: "lucide:folder-tree" }, declaration: "./assets/icon.svg", artworkDigest: "b".repeat(64) };
  const assessment = { candidate: selected, next: "prepare" };
  const prepared = {
    repoPath: original.repoPath, revision: "assigned-after", icon: selected.declaration,
    artworkDigest: selected.artworkDigest, mainUnchanged: true, manifestOtherwiseUnchanged: true,
    changedFiles: ["package.json", "assets/icon.svg"],
  };
  const report = { observed: original, intent: assignment.intent, assessment, change: prepared, outcome: "prepared" };
  diagnostics.unitIdentity = {
    passed: true, caseId: assignment.id, contextId: "ctx", request, original, selected, prepared,
    operations: ["observe", "resolve", "stage"],
    checks: { source: true, candidate: true, working: true, publication: true, operations: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output), effects,
    },
  });
  const effect = (method, args, result) => ({ service: "unitIdentity", method, args: ref(args), result: ref(result) });
  const identity = call("prepareUnitIdentity", "runWorkflow", { request }, report, [
    effect("observe", [request.operationId], original),
    effect("stage", [request.operationId, original.revision, selected.choice.id], prepared),
  ]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"], report,
    calls: [
      call("runWorkflow", null, {}, null), identity,
      call("iconIntent", "prepareUnitIdentity", { unit: request.unit }, report.intent),
      call("assessIcon", "prepareUnitIdentity", { observed: original }, assessment, [
        effect("resolve", [request.operationId, report.intent], selected),
      ]),
      call("chooseIconAction", "assessIcon", { candidate: selected }, "prepare"),
      call("verifyUnitIdentity", "prepareUnitIdentity", { change: prepared }, "prepared"),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  prepared.artworkDigest = "c".repeat(64);
  identity.record.output = ref(report);
  identity.record.effects[1].result = ref(prepared);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /verified authorized working-state outcome/u);
});

test("transcript continuation export rejects a checkpoint beyond the frozen channel watermark", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "transcript-cursor-live-freeze-live-tail-during-replay";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const channelId = "owned-transcript";
  entry.execution.provenance.channelId = channelId;
  const request = { goal: assignment.goal, operationId: "assigned-replay" };
  const saved = { channelId, seq: 0 };
  const frontier = 7;
  const expectedMessages = assignment.messages.map((preview, i) => ({
    envelopeId: `envelope-${i}`, seq: [2, 4, 7][i],
    messageId: `message-${i}`, role: "user", preview,
  }));
  const pages = [
    { after: 0, through: frontier, nextAfter: 4, envelopeCount: 2, hasMore: true, messages: expectedMessages.slice(0, 2) },
    { after: 4, through: frontier, nextAfter: 7, envelopeCount: 1, hasMore: false, messages: expectedMessages.slice(2) },
  ];
  const start = { channelId, saved, maxPages: assignment.maxPages, first: pages[0] };
  const report = {
    start, pages, messages: expectedMessages, outcome: "complete", next: { channelId, seq: frontier },
  };
  diagnostics.transcriptCursor = {
    passed: true, caseId: assignment.id, contextId: "ctx", channelId, request, saved, frontier,
    expectedMessages, late: { envelopeId: "later-note", seq: 9 }, observation: start, pages,
    operations: ["open", "next"], checks: { scope: true, pages: true, checkpoint: true, isolatedTail: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = [], id = name) => ({
    callId: id,
    summary: { ...prototype.summary, call_id: id },
    record: {
      ...prototype.record, call_id: id, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output), effects,
    },
  });
  const effect = (method, args, result) => ({ service: "transcriptCursor", method, args: ref(args), result: ref(result) });
  const resume = call("resumeChannelTranscript", "runWorkflow", { request }, report, [
    effect("open", [request.operationId], start),
  ]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"], report,
    calls: [
      call("runWorkflow", null, {}, null), resume,
      call("assessReplayStart", "resumeChannelTranscript", { start }, "read"),
      call("collectReplayPages", "resumeChannelTranscript", { start }, { pages, usable: true }, [
        effect("next", [request.operationId, 4, frontier], pages[1]),
      ]),
      ...pages.map((page, i) => call("checkReplayPage", "collectReplayPages", { page }, "verified", [], `check-${i}`)),
      call("finishTranscript", "resumeChannelTranscript", {}, report),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  report.next.seq = 9;
  resume.record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact durable checkpoint/u);
});

test("publication revision export rejects a review that omits a changed public entry", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "publication-revision-live-changed-public-caption";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const request = { goal: assignment.goal, operationId: "assigned-package" };
  const source = "panels/owned-departures";
  const intent = { provider: "vercel", destination: "managed-review/departures", environment: "preview" };
  const file = (path, byte) => ({ path, digest: byte.repeat(64), bytes: 30 });
  const reviewed = {
    sourceHash: "reviewed-state", artifactDigest: "sha256:" + "0".repeat(64), entry: "site.js", intent,
    files: [file("site.js", "a"), file("vibestudio-build.json", "b")],
  };
  const candidate = {
    sourceHash: "candidate-state", artifactDigest: "sha256:" + "1".repeat(64), entry: "site.js", intent,
    files: [file("site.js", "c"), file("vibestudio-build.json", "d")],
  };
  const comparison = {
    source, reviewed, candidate,
    change: { added: [], removed: [], modified: reviewed.files.map((before, i) => ({ before, after: candidate.files[i] })) },
  };
  const impact = {
    affectedPaths: ["site.js", "vibestudio-build.json"],
    entryChanged: true, htmlChanged: false, manifestChanged: true,
  };
  const report = {
    comparison, impact, match: "same-target", decision: "review-public-change",
    reason: "Review the changed entry and the public manifest.",
  };
  diagnostics.publicationRevision = {
    passed: true, caseId: assignment.id, contextId: "ctx", source, request, observed: comparison,
    editApplicationId: "assigned-edit", checks: { package: true, target: true, decision: true, protection: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output), effects,
    },
  });
  const review = call("reviewPublicationRevision", "runWorkflow", { request }, report, [{
    service: "publicationRevision", method: "compare", args: ref([request.operationId]), result: ref(comparison),
  }]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"], report,
    calls: [
      call("runWorkflow", null, {}, null), review,
      call("matchPublicationTarget", "reviewPublicationRevision", { reviewed: intent, candidate: intent }, report.match),
      call("assessRevisionChange", "reviewPublicationRevision", { comparison }, impact),
      call("checkCriticalPaths", "assessRevisionChange", { paths: impact.affectedPaths }, impact),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  impact.affectedPaths.shift();
  review.record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact changed public files/u);
});

async function checkDeliveryReceiptExport(t, id, verdict, surface = "history") {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const handoff = surface === "conversation-handoff";
  const browser = surface !== "history";
  const name = `${browser ? surface : "delivery-history"}-live-${id}`;
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const request = { goal: assignment.goal, operationId: "assigned-receipt" };
  const matched = verdict === "matched";
  const foreign = verdict === "foreign-channel";
  const senderMismatch = verdict === "receipt-mismatch";
  const receipt = { channelId: "original", messageId: "msg-1", senderId: "sender" };
  const canonical = {
    messageId: (senderMismatch || matched) ? "msg-1" : "msg-2",
    envelopeId: "envelope",
    sequence: 1,
    senderId: senderMismatch ? "observed-sender" : "sender",
    text: assignment.text,
  };
  const observation = {
    channelId: foreign ? "other" : "original",
    receipt,
    retained: (senderMismatch || matched) ? [canonical] : [],
    rendered: (senderMismatch || matched) ? [{
      messageId: canonical.messageId, senderId: canonical.senderId, text: canonical.text,
    }] : [],
  };
  const report = {
    observation,
    origin: verdict,
    consumer: matched ? "matched" : "unreviewed",
    verified: matched,
  };
  diagnostics.deliveryHistory = {
    passed: true,
    caseId: assignment.id,
    contextId: "ctx",
    request,
    observed: observation,
    canonical,
    retryId: assignment.mode === "retry" ? "msg-1" : null,
    decoyId: foreign ? "msg-2" : null,
    checks: { scope: true, nativeDelivery: true, retained: true, verdict: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects,
    },
  });
  const review = call("reviewDeliveryHistory", browser ? "reviewChatDelivery" : "runWorkflow", { request }, report, [
    {
      service: "deliveryHistory",
      method: "inspect",
      args: ref([request.operationId]),
      result: ref(observation),
    },
  ]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      review,
      call("checkOrigin", "reviewDeliveryHistory", { observation }, report.origin),
      ...((senderMismatch || matched) ? [call("matchReceipt", "checkOrigin", { receipt, row: canonical }, verdict)] : []),
      ...(matched ? [call("compareConsumer", "reviewDeliveryHistory", { retained: canonical, rendered: observation.rendered }, "matched")] : []),
    ],
  };
  if (browser) {
    const wrongPanel = assignment.mode === "wrong-panel";
    const chatRequest = { ...request, contextId: "ctx", panelId: "assigned-chat" };
    const panel = {
      contextId: "ctx", panelId: chatRequest.panelId,
      channelId: wrongPanel ? "another-channel" : observation.channelId,
      source: "panels/chat", phase: "ready",
      messages: [{ messageId: wrongPanel ? "msg-decoy" : canonical.messageId, text: canonical.text }],
    };
    const chatReport = {
      delivery: report, panel: matched ? panel : null,
      verdict: !matched ? "history-unverified" : wrongPanel ? "panel-mismatch" : "verified",
    };
    const verification = diagnostics.deliveryHistory;
    verification.request = handoff ? { kind: "chat-handoff", ...chatRequest } : chatRequest;
    verification.chat = {
      actualPanel: panel, observedPanel: matched ? panel : null, panelReads: matched ? 1 : 0,
      panelChannelId: panel.channelId, panelMessageId: panel.messages[0].messageId,
    };
    Object.assign(verification.checks, { livePanel: true, browserScope: true, chatVerdict: true, panelReleased: true });
    const teacher = diagnostics.natlangTeacher;
    teacher.report = chatReport;
    const conversationRoot = handoff ? "reviewConversation" : "runWorkflow";
    teacher.calls.push(call("reviewChatDelivery", conversationRoot, { request: chatRequest }, chatReport));
    if (matched) {
      teacher.calls.push(
        call("inspectPanel", "reviewChatDelivery", { panelId: chatRequest.panelId }, panel, [{
          service: "chatDeliveryPanel", method: "inspect", args: ref([chatRequest.panelId]), result: ref(panel),
        }]),
        call("checkPanel", "reviewChatDelivery", { request: chatRequest, channelId: observation.channelId, panel }, !wrongPanel),
      );
      if (!wrongPanel) teacher.calls.push(
        call("checkMessage", "reviewChatDelivery", { retained: canonical, messages: panel.messages }, "verified"),
      );
    }
    if (handoff) {
      verification.checks.handoff = true;
      teacher.report = {
        kind: "chat-handoff", basis: observation.channelId, ready: false,
        next: assignment.next, chat: chatReport, blockers: [chatReport.verdict],
      };
      const choice = call("chooseChatHandoff", conversationRoot, { chat: chatReport }, assignment.next);
      teacher.calls.push(
        call("reviewConversation", "runWorkflow", { request: verification.request }, teacher.report),
        choice,
      );
      await save();
      await exportLiveTeacherWorkflow({ ...options, cases });
      choice.record.inputs.chat = ref({ ...chatReport, verdict: "verified" });
      await save();
      await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /grounded next step/u);
      return;
    }
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    if (matched) {
      const inspection = teacher.calls.find(({ callId }) => callId === "inspectPanel").record;
      inspection.effects[0].args = ref(["another-panel"]);
    } else {
      verification.chat.panelReads = 1;
    }
    await save();
    await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /stop before browser access/u);
    return;
  }
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  report.origin = "matched";
  report.verified = true;
  review.record.output = ref(report);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /exact origin and consumer decisions/u
  );
}

for (const id of [
  "unsupported-remote-before-verification", "repository-publication-needs-owner-setup",
  "pages-publication-needs-interactive-setup",
]) {
  test(`GitHub diagnosis export binds the local failure and installed route for ${id}`, async (t) => {
    const { options, diagnostics, entry, save } = await fixture(t);
    const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
      path.resolve(import.meta.dirname, "..")
    );
    const cases = await loadLiveTeacherCases(checkouts);
    const name = `github-diagnosis-live-${id}`;
    const { assignment } = cases.get(name);
    const pins = JSON.parse(await readFile(options.pins, "utf8"));
    await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "personal" }));
    entry.test.name = name;
    const { goal, failure, cause, step, setup: expected, check } = assignment;
    const request = { goal, operationId: "assigned-local-preflight" };
    const setupId = "assigned-setup";
    const setupRequest = expected ? { goal, operationId: setupId, interactive: check.interactive } : null;
    const observation = { operationId: request.operationId, failure, setup: setupRequest };
    const diagnosis = { cause, steps: [step] };
    const status = expected ? { stage: "needs-token", connected: false, verified: false } : null;
    const route = expected ? {
      action: "render-setup", accessLevel: expected.access,
      next: "open the installed setup surface", reason: "No active credential",
    } : null;
    const setup = expected ? { status, route, accessLevel: expected.access, handoff: expected.handoff } : null;
    const report = { observation, diagnosis, setup };
    diagnostics.githubDiagnosis = {
      passed: true, caseId: id, contextId: "ctx", request, observation, status, route,
      checks: { failure: true, report: true, owner: true, preserved: true },
    };
    const ref = (value) => {
      const bytes = JSON.stringify(value);
      return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
    };
    const prototype = diagnostics.natlangTeacher.calls[0];
    const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const call = (name, parent, inputs, output, start, end, effects = []) => ({
      callId: name, summary: { ...prototype.summary, call_id: name },
      record: {
        ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output), started_at: at(start), ended_at: at(end), effects,
      },
    });
    const effect = (service, method, args, value) => ({ service, method, args: ref(args), result: ref(value) });
    const decision = call("cause", "troubleshootGithub", { failure }, cause, 4, 4);
    const calls = [
      call("runWorkflow", null, {}, null, 0, 15),
      call("diagnoseGitHubOperation", "runWorkflow", { request }, report, 1, 14),
      call("readGitHubDiagnosis", "diagnoseGitHubOperation", { operationId: request.operationId }, observation, 2, 2,
        [effect("githubDiagnosisRead", "inspect", [request.operationId], observation)]),
      call("troubleshootGithub", "diagnoseGitHubOperation", { failure }, diagnosis, 3, 5),
      decision,
    ];
    if (expected) calls.push(
      call("reviewGitHubSetup", "diagnoseGitHubOperation", { request: setupRequest }, setup, 6, 12),
      call("readGitHubSetup", "reviewGitHubSetup", { operationId: setupId }, status, 7, 7,
        [effect("githubSetupRead", "inspect", [setupId], status)]),
      call("accessLevelFor", "reviewGitHubSetup", { intent: goal }, expected.access, 8, 8),
      call("resolveGitHubRoute", "reviewGitHubSetup", { operationId: setupId, accessLevel: expected.access }, route, 9, 9,
        [effect("githubSetupRoute", "resolve", [setupId, expected.access], route)]),
      call("chooseSetupHandoff", "reviewGitHubSetup", { route, interactive: check.interactive }, expected.handoff, 10, 10),
    );
    diagnostics.natlangTeacher = {
      ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
      report, rootCallIds: ["runWorkflow"], calls,
    };
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    if (expected) {
      const handoff = calls.find(({callId}) => callId === "chooseSetupHandoff");
      handoff.record.inputs.interactive = ref(!check.interactive);
    } else {
      decision.record.inputs.failure = ref("different preflight");
    }
    await save();
    await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }),
      expected ? /exact setup route and surface/u : /observed local preflight/u);
  });
}

for (const id of [
  "notice-on-stderr-with-successful-exit", "zero-exit-with-incomplete-output",
  "receipt-from-neighboring-operation",
]) {
  test(`Terminal evidence export requires actual receipt provenance for ${id}`, async (t) => {
    const { options, diagnostics, entry, save } = await fixture(t);
    const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
      path.resolve(import.meta.dirname, "..")
    );
    const cases = await loadLiveTeacherCases(checkouts);
    const name = `terminal-evidence-live-${id}`;
    const { assignment } = cases.get(name);
    const pins = JSON.parse(await readFile(options.pins, "utf8"));
    await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "examples" }));
    entry.test.name = name;
    const { goal, mode, status, code } = assignment;
    const operationId = "assigned-command";
    const request = { kind: "terminal-receipt", goal, operationId };
    const notice = mode === "notice";
    const foreign = mode === "foreign";
    const truncated = mode === "truncated";
    const native = (origin, stdout, stderr = "") => ({
      contextId: "ctx", operationId: origin, plan: {
        receipt: `${origin}:plan`, checks: [{id:"evidence", mode: notice ? "script" : "argv"}],
      },
      result: {
        status: "complete", id: "evidence", receipt: `${origin}:check:evidence`,
        exitCode: 0, timedOut: false, stdout, stderr, truncated,
      },
    });
    const assigned = native(operationId, notice ? "release-ready" : truncated
      ? Array.from({ length: 500 }, (_, index) => `${index + 1}\n`).join("").slice(0, 1024)
      : "assigned marker", notice ? "diagnostic notice" : "");
    const retained = foreign ? native("neighbor-command", "neighbor marker") : assigned;
    const observation = {
      kind: "terminal", goal,
      target: { id: operationId, contextId: "ctx", operationId, purpose: notice ? "shell-composition" : "ordinary-process" },
      invocation: { id: assigned.plan.receipt, operationId, contextId: "ctx", admission: "admitted", mode: notice ? "shell" : "argv" },
      result: {
        id: retained.result.receipt, contextId: "ctx", operationId: retained.operationId,
        exitCode: 0, timedOut: false, truncated, hasStdout: true, hasStderr: notice,
      },
    };
    const report = { status, findings: [{ code, evidenceIds: foreign
      ? [operationId, retained.result.receipt] : [retained.result.receipt] }] };
    diagnostics.terminalEvidence = {
      passed: true, caseId: id, contextId: "ctx", request, observation, assigned, retained,
      checks: { processes: true, attribution: true, preserved: true, outcome: true },
    };
    const ref = (value) => {
      const bytes = JSON.stringify(value);
      return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
    };
    const prototype = diagnostics.natlangTeacher.calls[0];
    const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const call = (name, parent, inputs, output, start, end, effects = []) => ({
      callId: name, summary: { ...prototype.summary, call_id: name },
      record: {
        ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output), started_at: at(start), ended_at: at(end), effects,
      },
    });
    const result = call("inspectExecution", "reviewTerminal", { input: observation }, report, 6, 6);
    diagnostics.natlangTeacher = {
      ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
      report, rootCallIds: ["runWorkflow"], calls: [
        call("runWorkflow", null, {}, null, 0, 11),
        call("reviewDeviceAndTerminal", "runWorkflow", { request }, report, 1, 10),
        call("reviewLiveTerminal", "reviewDeviceAndTerminal", { request }, report, 2, 9),
        call("readTerminalEvidence", "reviewLiveTerminal", { operationId }, observation, 3, 3,
          [{ service: "terminalEvidenceRead", method: "inspect", args: ref([operationId]), result: ref(observation) }]),
        call("reviewTerminal", "reviewLiveTerminal", { input: observation }, report, 4, 8),
        call("inspectInvocation", "reviewTerminal", { input: observation }, null, 5, 5),
        result,
      ],
    };
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    result.record.inputs.input = ref({ ...observation, result: { ...observation.result, operationId: "wrong-origin" } });
    await save();
    await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /preserve the invocation check/u);
  });
}

for (const id of [
  "published-manifest-matches-review", "stage-valid-lifecycle-change", "reject-invalid-local-icon",
]) {
  test(`Unit design export separates the working and published manifests for ${id}`, async (t) => {
    const { options, diagnostics, entry, save } = await fixture(t);
    const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
      path.resolve(import.meta.dirname, "..")
    );
    const cases = await loadLiveTeacherCases(checkouts);
    const name = `unit-design-live-${id}`;
    const { assignment } = cases.get(name);
    const pins = JSON.parse(await readFile(options.pins, "utf8"));
    await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
    entry.test.name = name;
    const { goal, source, mode } = assignment;
    const operationId = "manifest-review";
    const request = { kind: "extension-design-live", goal, operationId };
    const invalid = mode === "invalid-local";
    const published = mode === "published";
    const ids = [`${operationId}:working`, `${operationId}:published`];
    const manifest = (index, candidateDigest, errorCode) => ({
      kind: "manifest", source, candidateDigest,
      receipt: { id: ids[index], unit: source, candidateDigest, errorCode },
    });
    const observation = {
      contextId: "ctx", workingRevision: published ? "protected" : "local", mainRevision: "protected",
      working: manifest(0, published ? "protected-hash" : "local-hash", invalid ? "MANIFEST_ICON" : null),
      published: manifest(1, "protected-hash", null),
    };
    const components = [
      { decision: invalid ? "revision-needed" : "ready", finding: invalid ? "MANIFEST_ICON" : "manifest-verified", evidenceIds: [ids[0]] },
      { decision: "ready", finding: "manifest-verified", evidenceIds: [ids[1]] },
      { decision: published ? "ready" : "waiting", finding: published ? "manifest-published" : "manifest-not-published", evidenceIds: ids },
    ];
    const report = {
      decision: invalid ? "revision-needed" : published ? "ready" : "waiting",
      finding: invalid ? "required-revision" : published ? "prerequisites-verified" : "pending-lifecycle",
      evidenceIds: ids, components,
    };
    diagnostics.unitDesign = {
      passed: true, caseId: id, contextId: "ctx", request, observation,
      checks: { revision: true, manifests: true, preserved: true, outcome: true },
    };
    const ref = (value) => {
      const bytes = JSON.stringify(value);
      return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
    };
    const prototype = diagnostics.natlangTeacher.calls[0];
    const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const call = (name, parent, inputs, output, start, end, effects = [], id = name) => ({
      callId: id, summary: { ...prototype.summary, call_id: id },
      record: {
        ...prototype.record, call_id: id, parent_call_id: parent, definition: { name }, outcome: "done",
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output), started_at: at(start), ended_at: at(end), effects,
      },
    });
    const working = call("reviewExtension", "reviewLiveExtensionDesign", { evidence: observation.working },
      components[0], 4, 6, [], "review-working");
    diagnostics.natlangTeacher = {
      ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
      report, rootCallIds: ["runWorkflow"], calls: [
        call("runWorkflow", null, {}, null, 0, 16),
        call("reviewWorkspaceUnit", "runWorkflow", { request }, report, 1, 15),
        call("reviewLiveExtensionDesign", "reviewWorkspaceUnit", { request }, report, 2, 14),
        call("readExtensionDesign", "reviewLiveExtensionDesign", { operationId }, observation, 3, 3,
          [{ service: "extensionDesignRead", method: "inspect", args: ref([operationId]), result: ref(observation) }]),
        working,
        call("inspectManifest", "review-working", { evidence: observation.working }, components[0], 5, 5, [], "inspect-working"),
        call("reviewExtension", "reviewLiveExtensionDesign", { evidence: observation.published }, components[1], 7, 9, [], "review-published"),
        call("inspectManifest", "review-published", { evidence: observation.published }, components[1], 8, 8, [], "inspect-published"),
        call("reviewManifestPublication", "reviewLiveExtensionDesign", { observation }, components[2], 10, 10),
        call("combineWork", "reviewLiveExtensionDesign", { components }, report, 11, 11),
      ],
    };
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    working.record.inputs.evidence = ref(observation.published);
    await save();
    await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /keep both manifest validations separate/u);
  });
}

for (const id of [
  "reread-revised-launch-card", "hold-for-unaccepted-checklist-review",
  "distinguish-ready-card-from-started-run",
]) {
  test(`Mission facility export preserves the planning gate for ${id}`, async (t) => {
    const { options, diagnostics, entry, save } = await fixture(t);
    const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
      path.resolve(import.meta.dirname, "..")
    );
    const cases = await loadLiveTeacherCases(checkouts);
    const name = `mission-facility-live-${id}`;
    const { assignment } = cases.get(name);
    const pins = JSON.parse(await readFile(options.pins, "utf8"));
    await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "personal" }));
    entry.test.name = name;
    const { goal, stale, prerequisite, status, code } = assignment;
    const current = !stale && prerequisite === "done";
    const operationId = "operation";
    const taskId = "assigned-task";
    const request = { kind: "mission-live", goal, operationId };
    const observed = {
      kind: "mission", goal,
      target: { id: operationId, taskId, expectedRevision: 5 },
      card: {
        id: taskId, taskId, revision: 5 + Number(stale), state: "ready",
        projectArchived: false, dependencyAccepted: prerequisite === "done", automationId: null,
      },
      detail: { kind: "execution", intent: "start", automationKind: null, receipt: null },
    };
    const report = { status, findings: [{ code, evidenceIds: stale ? [operationId, taskId] : [taskId] }] };
    diagnostics.missionFacility = {
      passed: true, caseId: id, contextId: "ctx", request, observed,
      checks: { attribution: true, assignedState: true, preserved: true, outcome: true },
    };
    const ref = (value) => {
      const bytes = JSON.stringify(value);
      return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
    };
    const prototype = diagnostics.natlangTeacher.calls[0];
    const at = (second) => new Date(1767225600000 + second * 1000).toISOString();
    const call = (name, parent, inputs, output, start, end, effects = []) => ({
      callId: name, summary: { ...prototype.summary, call_id: name },
      record: {
        ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output), started_at: at(start), ended_at: at(end), effects,
      },
    });
    const boundary = call("inspectMissionBoundary", "reviewMission", { input: observed }, report, 6, 6);
    const gate = call("establishMissionCard", "reviewMission", { input: observed }, current ? null : report, 5, 5);
    const calls = [
      call("runWorkflow", null, {}, null, 0, 10),
      call("reviewPersonalFacility", "runWorkflow", { request }, report, 1, 9),
      call("reviewLiveMission", "reviewPersonalFacility", { request }, report, 2, 8),
      call("readMissionCard", "reviewLiveMission", { operationId }, observed, 3, 3,
        [{ service: "missionFacilityRead", method: "inspect", args: ref([operationId]), result: ref(observed) }]),
      call("reviewMission", "reviewLiveMission", { input: observed }, report, 4, 7),
      gate,
      ...(current ? [boundary] : []),
    ];
    diagnostics.natlangTeacher = {
      ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
      report, rootCallIds: ["runWorkflow"], calls,
    };
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    if (current) boundary.record.started_at = at(4);
    else calls.push(boundary);
    await save();
    await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /respect the planning gate/u);
  });
}

for (const id of ["resume-pull-without-github-connection", "review-local-edit-before-push"]) {
  test(`Personal repository export joins the assigned worktree and owner decision for ${id}`, async (t) => {
    const { options, diagnostics, entry, save } = await fixture(t);
    const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
      path.resolve(import.meta.dirname, "..")
    );
    const cases = await loadLiveTeacherCases(checkouts);
    const name = `personal-resume-live-${id}`;
    const { assignment } = cases.get(name);
    const pins = JSON.parse(await readFile(options.pins, "utf8"));
    await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "personal" }));
    entry.test.name = name;
    const { goal, dirty, operation, access, decision, ownerAction } = assignment;
    const operationId = "repo-reentry";
    const repository = `projects/personal-resume-${operationId}`;
    const work = { goal, operationId };
    const request = { goal, work: [{ kind: "resumeRepositoryWork", input: work }] };
    const observation = {
      goal, repository, workingTree: dirty ? "dirty" : "clean",
      availableAccess: [], remoteVerified: null, upstream: "unknown",
    };
    const hasOwner = ownerAction !== "skip";
    const ownerInput = hasOwner ? {
      goal, origin: "selection",
      selection: {
        id: `connection.github/${ownerAction}`, capabilityId: "connection.github",
        action: ownerAction, via: "owner-skill", ownerSkillPath: "skills/github/SKILL.md",
      },
      capabilities: [{ id: "connection.github", label: "GitHub", owner: "skills/github/SKILL.md", state: "not-configured" }],
    } : null;
    const plan = { repository, operation, access, decision, facts: [], next: ["Resolve the prerequisite."] };
    const owner = hasOwner ? {
      action: "follow-owner-route", routeId: ownerInput.selection.id,
      workspaceScope: "current", capabilityIds: ["connection.github"], unknownIds: [], brief: "Use setup.",
    } : null;
    const resume = { repository: plan, owner };
    const report = { results: [{ kind: "resumeRepositoryWork", report: resume }], unresolved: [] };
    const head = { kind: "event", eventId: "owned-head" };
    diagnostics.personalResume = {
      passed: true, caseId: id, contextId: "ctx", request, observedRepo: observation, observedOwner: ownerInput,
      ownerAction: hasOwner ? ownerAction : null,
      checks: { observedRepository: true, repositoryPlan: true, ownerHandoff: true, worktreePreserved: true },
      state: {
        main: "protected-main", finalMain: "protected-main", startingHead: head, finalHead: head,
        startClean: !dirty, finalClean: !dirty, finalFileHash: "owned-hash", expectedFileHash: "owned-hash",
      },
    };
    const ref = (value) => {
      const bytes = JSON.stringify(value);
      return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
    };
    const prototype = diagnostics.natlangTeacher.calls[0];
    const phases = {
      runWorkflow: [0, 13], runPersonalWorkflow: [1, 12], resumeRepositoryWork: [2, 11],
      readRepository: [3, 3], planRepositoryWork: [4, 7], chooseAccess: [5, 5], assessRepo: [6, 6],
      chooseOwnerAction: [8, 8], readOwnerRoute: [9, 9], routeSetup: [10, 10],
    };
    const timestamp = (second) =>
      new Date(Date.parse("2026-01-01T00:00:00Z") + second * 1000).toISOString();
    const call = (name, parent, inputs, output, effects = []) => ({
      callId: name, summary: { ...prototype.summary, call_id: name },
      record: {
        ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
        started_at: timestamp(phases[name][0]), ended_at: timestamp(phases[name][1]),
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
        output: ref(output), effects,
      },
    });
    const effect = (service, method, args, result) => ({ service, method, args: ref(args), result: ref(result) });
    const choice = call("chooseOwnerAction", "resumeRepositoryWork", { repository: plan }, ownerAction);
    diagnostics.natlangTeacher = {
      ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
      report, rootCallIds: ["runWorkflow"], calls: [
        call("runWorkflow", null, {}, null),
        call("runPersonalWorkflow", "runWorkflow", { request }, report),
        call("resumeRepositoryWork", "runPersonalWorkflow", { request: work }, resume),
        call("readRepository", "resumeRepositoryWork", { operationId }, observation,
          [effect("repositoryResumeRead", "inspect", [operationId], observation)]),
        call("planRepositoryWork", "resumeRepositoryWork", { request: observation }, plan),
        call("chooseAccess", "planRepositoryWork", { goal, operation }, access),
        call("assessRepo", "planRepositoryWork", { request: observation, operation, access, ambiguous: false }, decision),
        choice,
        ...(hasOwner ? [
          call("readOwnerRoute", "resumeRepositoryWork", { operationId, action: ownerAction }, ownerInput,
            [effect("repositoryOwnerRead", "resolve", [operationId, ownerAction], ownerInput)]),
          call("routeSetup", "resumeRepositoryWork", { request: ownerInput }, owner),
        ] : []),
      ],
    };
    await save();
    await exportLiveTeacherWorkflow({ ...options, cases });
    if (hasOwner) {
      const route = diagnostics.natlangTeacher.calls.find(({ callId }) => callId === "readOwnerRoute").record;
      route.started_at = timestamp(7);
      await save();
      await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact installed owner route/u);
      route.started_at = timestamp(9);
      route.effects[0].args = ref(["unassigned-operation", ownerAction]);
    } else {
      choice.record.output = ref("setup");
    }
    await save();
    await assert.rejects(
      exportLiveTeacherWorkflow({ ...options, cases }),
      hasOwner ? /exact installed owner route/u : /nested live-state decision/u,
    );
  });
}

test("delivery history export rejects a same-text message from a different channel", (t) =>
  checkDeliveryReceiptExport(t, "identical-note-on-other-channel", "foreign-channel")
);
test("delivery history export requires the sender on the native envelope", (t) =>
  checkDeliveryReceiptExport(t, "reconcile-sender-from-retained-envelope", "receipt-mismatch")
);
test("delivery history export rejects a receipt for an absent causal message", (t) =>
  checkDeliveryReceiptExport(t, "locate-message-from-reconnect-receipt", "missing-message")
);

test("chat delivery export joins the visible message to the assigned panel read", (t) =>
  checkDeliveryReceiptExport(t, "reopened-chat-after-retry", "matched", "chat-delivery")
);
test("chat delivery export requires a foreign receipt to stop before a browser read", (t) =>
  checkDeliveryReceiptExport(t, "wrong-chat-same-reminder", "foreign-channel", "chat-delivery")
);
test("conversation handoff joins the wrong-chat decision to the exact audit", (t) =>
  checkDeliveryReceiptExport(t, "reopen-original-chat-after-context-switch", "matched", "conversation-handoff")
);
test("conversation handoff traces a missing receipt before reading the browser", (t) =>
  checkDeliveryReceiptExport(t, "trace-absent-receipt-before-opening-chat", "missing-message", "conversation-handoff")
);

test("Android audit export requires the native app observation and keeps workspace readiness unverified", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, ".."),
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "android-audit-live-fresh-emulator-uninstalled-app";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(
    options.pins,
    JSON.stringify({ ...pins, workspace: "system" }),
  );
  entry.test.name = name;
  const target = "emulator-5576";
  const request = {
    goal: assignment.goal,
    operationId: "assigned-emulator",
    target,
    intent: "application",
  };
  const observed = { target, state: "device" };
  const application = {
    target,
    packageName: "app.vibestudio.mobile.internal",
    installed: false,
    processObserved: false,
    screenshotCaptured: false,
    screenshotBytes: 0,
    issues: ["app.vibestudio.mobile.internal is not installed"],
  };
  const runtime = {
    observation: application,
    status: "app-absent",
    image: "unavailable",
  };
  const report = {
    targetObservation: observed,
    targetReview: "target-ready",
    runtime,
  };
  diagnostics.androidAudit = {
    passed: true,
    caseId: assignment.id,
    contextId: "ctx",
    request,
    owned: target,
    observed,
    application,
    checks: { target: true, lineage: true, application: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([key, value]) => [key, ref(value)]),
      ),
      output: ref(output),
      effects,
    },
  });
  const effect = (method, value) => ({
    service: "androidRuntimeAudit",
    method,
    args: ref([request.operationId]),
    result: ref(value),
  });
  const audit = call(
    "auditAndroidRuntime",
    "runWorkflow",
    { request },
    report,
    [effect("observeTarget", observed)],
  );
  const app = call(
    "reviewRuntime",
    "auditAndroidRuntime",
    { operationId: request.operationId },
    runtime,
    [effect("observeApplication", application)],
  );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      audit,
      call(
        "reviewTarget",
        "auditAndroidRuntime",
        { observation: observed },
        report.targetReview,
      ),
      app,
      call(
        "assessImage",
        "reviewRuntime",
        { observation: application },
        runtime.image,
      ),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  runtime.status = "workspace-ready";
  audit.record.output = ref(report);
  app.record.output = ref(runtime);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /exact package and image evidence/u,
  );
});

test("Android installation hold rejects an attempted effect against the other ready emulator", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, ".."),
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "android-install-live-hold-absent-install-target";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(
    options.pins,
    JSON.stringify({ ...pins, workspace: "system" }),
  );
  entry.test.name = name;
  const request = {
    goal: assignment.goal,
    workspace: "owned-workspace",
    deviceId: "emulator-5554",
    scenario: "development",
    authority: "execute",
    reset: false,
  };
  const inventory = {
    workspace: request.workspace,
    provider: null,
    foreground: true,
    tooling: true,
    devices: [],
  };
  const setup = { status: "blocked", blocker: "no-device" };
  const report = {
    ...setup,
    deviceId: request.deviceId,
    next: "Connect the assigned emulator.",
  };
  const before = {
    installed: false,
    bundleActive: false,
    rendering: false,
    screenshotCaptured: false,
    screenshotBytes: 0,
    issues: ["The internal app is absent."],
  };
  const owned = "emulator-5576";
  diagnostics.androidInstall = {
    passed: true,
    contextId: "ctx",
    caseId: assignment.id,
    owned,
    request,
    inventory,
    before,
    after: before,
    install: null,
    readback: null,
    checks: { inventory: true, execution: true, device: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([key, value]) => [key, ref(value)]),
      ),
      output: ref(output),
      effects,
    },
  });
  const explain = call(
    "explainBlocker",
    "runMobileScenario",
    {
      deviceId: request.deviceId,
      blocker: report.blocker,
    },
    report,
  );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("runMobileScenario", "runWorkflow", { request }, report),
      call("reviewSetup", "runMobileScenario", { request }, setup),
      call("readInventory", "reviewSetup", {}, inventory, [
        {
          service: "mobileInventory",
          method: "read",
          args: ref([]),
          result: ref(inventory),
        },
      ]),
      call(
        "selectTarget",
        "reviewSetup",
        { devices: [], requested: request.deviceId },
        setup,
      ),
      explain,
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  explain.record.effects.push({
    service: "mobileDevelopment",
    method: "install",
    args: ref([owned]),
    error: "denied",
  });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /assigned-device decision/u,
  );
});

test("Android pairing export joins readiness to the newly paired identity", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, ".."),
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name =
    "android-pair-live-pair-compatible-emulator-and-verify-workspace";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(
    options.pins,
    JSON.stringify({ ...pins, workspace: "system" }),
  );
  entry.test.name = name;
  const owned = "emulator-5576";
  const provider = "owned-desktop";
  const request = {
    goal: assignment.goal,
    workspace: "owned-system",
    deviceId: owned,
    scenario: "pair",
    authority: "execute",
    reset: false,
  };
  const inventory = {
    workspace: request.workspace,
    provider,
    foreground: true,
    tooling: true,
    devices: [{ id: owned, state: "ready" }],
  };
  const decision = { status: "ready", deviceId: owned };
  const receipt = {
    provider,
    workspace: request.workspace,
    attachedDevice: owned,
    pairedDevice: "new-hub-device",
    install: "already-compatible",
  };
  const current = { status: "ready", message: "Workspace connected." };
  const observed = { pairedDevice: receipt.pairedDevice, ...current };
  const report = {
    status: "paired-ready",
    deviceId: owned,
    receipt,
    readback: observed,
  };
  diagnostics.androidPair = {
    passed: true,
    contextId: "ctx",
    caseId: assignment.id,
    request,
    provider,
    owned,
    inventory,
    receipt,
    observed,
    current,
    checks: { inventory: true, pairing: true, readiness: true, report: true },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([key, value]) => [key, ref(value)]),
      ),
      output: ref(output),
      effects,
    },
  });
  const effect = (service, method, args, result) => [
    { service, method, args: ref(args), result: ref(result) },
  ];
  const readback = call(
    "readWorkspace",
    "exercisePairing",
    { pairedDevice: receipt.pairedDevice },
    observed,
    effect("mobileWorkspace", "read", [receipt.pairedDevice], observed),
  );
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("runMobileScenario", "runWorkflow", { request }, report),
      call("reviewSetup", "runMobileScenario", { request }, decision),
      call(
        "readInventory",
        "reviewSetup",
        {},
        inventory,
        effect("mobileInventory", "read", [], inventory),
      ),
      call(
        "selectTarget",
        "reviewSetup",
        { devices: inventory.devices, requested: owned },
        decision,
      ),
      call("exercisePairing", "runMobileScenario", { deviceId: owned }, report),
      call(
        "pairDevice",
        "exercisePairing",
        { deviceId: owned },
        receipt,
        effect("mobilePairing", "pair", [owned], receipt),
      ),
      readback,
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  readback.record.inputs.pairedDevice = ref(owned);
  readback.record.effects[0].args = ref([owned]);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /matching paired-device readiness/u,
  );
});

test("PDF media export rejects an image reference without matching stored artifact evidence", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, ".."),
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "pdf-media-live-rendered-notice-evidence";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(
    options.pins,
    JSON.stringify({ ...pins, workspace: "system" }),
  );
  entry.test.name = name;
  const digest = "a".repeat(64),
    imageDigest = "b".repeat(64);
  const imageArtifactId = "stored-png";
  const request = {
    goal: assignment.goal,
    checks: ["pdf"],
    speech: null,
    git: null,
    pdf: {
      digest,
      requestedPages: [2],
      need: "image",
      minimumOcrConfidence: null,
      evidence: {
        id: "native-pdf",
        digest,
        pageCount: 2,
        encrypted: false,
        selectedPages: [2],
        engines: [{ id: "pdfjs", available: true, bundled: true }],
        pages: [
          {
            pageNumber: 2,
            extractionMethod: "embedded-text",
            imageArtifactId,
            warnings: [],
            lines: [
              {
                text: assignment.pages[1],
                bbox: [24, 30, 90, 12],
                source: "embedded-text",
                confidence: null,
              },
            ],
          },
        ],
      },
    },
  };
  const images = [
    {
      page: 2,
      id: imageArtifactId,
      digest: imageDigest,
      expectedDigest: imageDigest,
      bytes: 2200,
      integrity: true,
      png: true,
    },
  ];
  const finding = {
    check: "pdf",
    disposition: "pdf-ready",
    detail: "Page two has a stored image.",
    evidenceIds: ["native-pdf"],
    transcript: null,
  };
  const report = { findings: [finding] };
  diagnostics.pdfMedia = {
    contextId: "ctx",
    caseId: assignment.id,
    request,
    images,
    passed: true,
    checks: {
      source: true,
      pages: true,
      artifact: true,
      report: true,
    },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return {
      complete: true,
      hash: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record,
      call_id: name,
      parent_call_id: parent,
      definition: { name },
      outcome: "done",
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([key, value]) => [key, ref(value)]),
      ),
      output: ref(output),
      effects: [],
    },
  });
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewMediaAndImport", "runWorkflow", { request }, report),
      call(
        "reviewPdf",
        "reviewMediaAndImport",
        { assignment: request.pdf },
        finding,
      ),
      call("verifyPages", "reviewPdf", { assignment: request.pdf }, null),
      call(
        "checkExtraction",
        "reviewPdf",
        { assignment: request.pdf },
        "pdf-ready",
      ),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  images[0].digest = "c".repeat(64);
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /original artifact evidence/u,
  );
});

test("automation planning export requires the post-plan readback of the edited mission", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "automation-planning-live-hold-resume-after-definition-edited";
  const workflow = cases.get(id);
  const mission = { id: "owned-mission", name: "Release monitor", state: "paused", latestRun: null };
  const original = { ...mission, revisionDigest: "a".repeat(64) };
  const current = { ...mission, revisionDigest: "b".repeat(64) };
  const before = { visible: [original] };
  const after = { visible: [current] };
  const request = {
    goal: `${workflow.assignment.goal} The assigned mission is ${mission.name}.`,
    operationId: "assigned-window",
    timezone: "UTC",
    now: "2026-11-20T00:00:00.000Z",
  };
  const input = { goal: request.goal, timezone: request.timezone, now: request.now, visible: [mission], availableOperations: [] };
  const plan = { kind: "control", automationId: mission.id, action: "resume" };
  const report = { status: "changed", plan, before, after };
  const execution = {
    provenance: { contextId: "owned" },
    diagnostics: {
      automationPlanning: {
        contextId: "owned",
        verification: {
          caseId: workflow.assignment.id, passed: true, request, expectedPlan: plan, before, after,
          checks: {
            assignedPlan: true, snapshotReadback: true, exactDefinition: true,
            schedulingUntouched: true, protectedDefault: true,
          },
        },
      },
    },
  };
  const ref = (value) => {
    const bytes = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
  };
  const timestamp = (offset) => new Date(Date.parse(request.now) + offset).toISOString();
  const call = (id, name, parent, args, output, start, end, effects = []) => ({
    record: {
      call_id: id, parent_call_id: parent, definition: { name },
      inputs: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, ref(value)])),
      output: ref(output), started_at: timestamp(start), ended_at: timestamp(end), effects,
    },
  });
  const read = (id, result, start, end) => call(
    id, "observePlanningState", "review", { operationId: request.operationId }, result, start, end,
    [{ service: "automationPlanning", method: "inspect", args: ref([request.operationId]), result: ref(result) }],
  );
  const later = read("after", after, 6, 7);
  const exercise = {
    report, rootCallIds: ["root"],
    calls: [
      call("root", "runWorkflow", null, {}, null, 0, 9),
      call("review", "reviewAssignedAutomation", "root", { request }, report, 0, 9),
      read("before", before, 1, 2),
      call("plan", "prepareAutomation", "review", { request: input }, plan, 2, 6),
      call("classify", "classifyIntent", "plan", { goal: request.goal }, "control", 2, 3),
      call("control", "planControl", "plan", { request: input }, plan, 3, 5),
      call("resolve", "resolveVisible", "control", { visible: [mission] }, { kind: "found", automation: mission }, 3, 4),
      call("choice", "chooseControl", "control", { state: "paused" }, "resume", 4, 5),
      later,
      call("handoff", "checkHandoff", "review", { plan, before, after }, "changed", 8, 9),
    ],
  };
  assert.equal(workflow.evidence(execution, exercise, id, workflow).world.seed_revision, original.revisionDigest);
  later.record.started_at = timestamp(4);
  assert.throws(
    () => workflow.evidence(execution, exercise, id, workflow),
    /readback taken after its decision/u,
  );
  later.record.started_at = timestamp(6);
  later.record.effects[0].result = ref(before);
  assert.throws(
    () => workflow.evidence(execution, exercise, id, workflow),
    /readback taken after its decision/u,
  );
});

test("template hold export binds its decision to the cached native offer and refuses extra effects", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "template-candidate-live-base-check-predates-review-window";
  const { assignment } = cases.get(name);
  entry.test.name = name;
  const request = {
    goal: assignment.goal, intent: assignment.intent,
    sourceUrl: "git+https://github.com/panticonic/vibestudio-base.git",
    installedCommit: "a".repeat(40), incomingCommit: "a".repeat(40),
    checkedAfterMs: 41, commandId: "assigned-update",
  };
  const observed = {
    installedCommit: request.installedCommit, incomingCommit: request.incomingCommit,
    status: "current", checkedAt: 40, workspaceAppVersion: "0.1.106", currentAppVersion: "0.1.106",
    targetAppVersion: null, minimumAppVersion: null, hostUnavailable: false,
  };
  const report = { status: "refresh", offer: observed, operationId: null, candidate: null };
  diagnostics.templateCandidateManaged = {
    contextId: "ctx", verification: {
      contextId: "ctx", caseId: assignment.id, request, observed, passed: true,
      checks: { observed: true, report: true, lifecycle: true, unchanged: true },
    },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effects = []) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output), effects,
    },
  });
  const read = call("readOffer", "inspectOffer", {}, observed, [{
    service: "templateOffer", method: "read", args: ref([]), result: ref(observed),
  }]);
  const assess = call("assessOffer", "inspectOffer", { request, offer: observed }, "refresh");
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("stageTemplateCandidate", "runWorkflow", { request }, report),
      call("inspectOffer", "stageTemplateCandidate", { request }, { decision: "refresh", offer: observed }),
      read,
      assess,
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const recorded = assess.record.inputs.offer;
  assess.record.inputs.offer = ref({ ...observed, checkedAt: 41 });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /nested offer decision/u);
  assess.record.inputs.offer = recorded;
  read.record.effects.push({ service: "templateCandidatePrepare", method: "prepare" });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /before any preparation/u);
});

test("template staging export binds native preparation and review to the historical instance", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "template-candidate-live-stage-examples-for-semantic-review";
  const { assignment, workspaceBaseline } = cases.get(name);
  entry.test.name = name;
  const source = JSON.parse(await readFile(options.pins, "utf8"));
  const pinned = { ...source, workspace: "examples", workspace_baseline_commit: workspaceBaseline };
  await writeFile(options.pins, JSON.stringify(pinned));
  const request = {
    goal: assignment.goal, intent: assignment.intent,
    sourceUrl: "git+https://github.com/panticonic/vibestudio-template-examples.git",
    installedCommit: "a".repeat(40), incomingCommit: "b".repeat(40),
    checkedAfterMs: 41, commandId: "assigned-staging",
  };
  const observed = {
    installedCommit: request.installedCommit, incomingCommit: request.incomingCommit,
    status: "available", checkedAt: 41, workspaceAppVersion: "0.1.106", currentAppVersion: "0.1.106",
    targetAppVersion: "0.1.106", minimumAppVersion: "0.1.84", hostUnavailable: false,
  };
  const candidate = {
    operationId: request.commandId, contextId: "isolated-worktree",
    mainEventId: "protected-main", incomingCommit: request.incomingCommit,
    state: "review", repositories: [{ repoPath: "workers/grimoire-world", kind: "changed" }], conflicts: [],
  };
  const receipt = { outcome: "acknowledged", review: candidate };
  const observedReview = { review: candidate, mainEventId: "protected-main" };
  const report = { status: assignment.status, offer: observed, operationId: request.commandId, candidate };
  diagnostics.templateCandidateManaged = {
    contextId: "ctx", verification: {
      contextId: "ctx", caseId: assignment.id, request, observed, receipt, observedReview,
      protectedMainEventId: "protected-main", passed: true,
      checks: { observed: true, report: true, lifecycle: true, unchanged: true },
    },
  };
  const ref = (value) => {
    const text = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, parent, inputs, output, effect) => ({
    callId: name, summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
      started_at: "2026-01-05T00:00:00.000Z", ended_at: "2026-01-05T00:00:00.000Z",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects: effect ? [{ service: effect[0], method: effect[1], args: ref([]), result: ref(output) }] : [],
    },
  });
  const read = call("readCandidate", "reconcileCandidate", {}, observedReview, ["templateCandidateReview", "read"]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl", rootCallIds: ["runWorkflow"], report,
    calls: [
      call("runWorkflow", null, {}, null),
      call("stageTemplateCandidate", "runWorkflow", { request }, report),
      call("inspectOffer", "stageTemplateCandidate", { request }, { decision: "prepare", offer: observed }),
      call("readOffer", "inspectOffer", {}, observed, ["templateOffer", "read"]),
      call("assessOffer", "inspectOffer", { request, offer: observed }, "prepare"),
      call("prepareCandidate", "stageTemplateCandidate", {}, receipt),
      call("requestPreparation", "prepareCandidate", {}, receipt, ["templateCandidatePrepare", "prepare"]),
      call("reconcileCandidate", "stageTemplateCandidate", { request, receipt }, { status: assignment.status, candidate }),
      read,
      call("chooseReview", "reconcileCandidate", { candidate }, assignment.status),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  read.record.effects[0].result = ref({ ...observedReview, mainEventId: "foreign-main" });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /matching protected-main/u);
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace_baseline_commit: "c".repeat(40) }));
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /authored instance pin/u);
});

test("template release export requires the freshly inspected protected-main receipt", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "template-release-live-reinspect-renamed-snapshot";
  const workflow = cases.get(id);
  const { assignment, part } = workflow;
  const digest = (hex) => `v1-sha256:${hex.repeat(64)}`;
  const original = {
    mainEventId: "protected-head", name: assignment.previousName,
    requestedParts: [part], includedParts: [part, "packages/companion"],
    requiredParts: ["packages/companion"], manifestDigest: digest("a"), fingerprint: digest("b"),
  };
  const actual = { ...original, name: assignment.name, manifestDigest: digest("c"), fingerprint: digest("d") };
  const request = {
    goal: assignment.goal, operationId: "owned-review", reviewedFingerprint: original.fingerprint,
    acknowledgedParts: original.requiredParts, destination: assignment.destination, version: assignment.version,
  };
  const publicationInput = {
    kind: "publication", goal: request.goal, inspectedFingerprint: original.fingerprint,
    currentFingerprint: actual.fingerprint, missingParts: [], destination: request.destination,
    version: request.version, receipt: null,
  };
  const report = { plan: actual, review: { kind: "publication", next: "reinspect", basis: actual.fingerprint } };
  const execution = {
    provenance: { contextId: "owned" },
    diagnostics: { templateRelease: {
      contextId: "owned",
      verification: {
        caseId: assignment.id, request, original, actual, passed: true,
        checks: {
          assignedScope: true, protectedMain: true, closure: true, nativeManifest: true, fingerprint: true, report: true,
        },
      },
    } },
  };
  const ref = (value) => {
    const bytes = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
  };
  const call = (name, parent, args, output, effects = []) => ({
    record: {
      call_id: name, parent_call_id: parent, definition: { name },
      inputs: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, ref(value)])),
      output: ref(output), started_at: "2026-11-20T00:00:00Z", ended_at: "2026-11-20T00:00:00Z", effects,
    },
  });
  const read = call("readAuthoringPlan", "reviewTemplateRelease", { operationId: request.operationId }, actual, [{
    service: "templateAuthoringRead", method: "inspect", args: ref([request.operationId]), result: ref(actual),
  }]);
  const exercise = {
    report, rootCallIds: ["runWorkflow"],
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewTemplateRelease", "runWorkflow", { request }, report),
      read,
      call("reviewTemplate", "reviewTemplateRelease", { request: publicationInput }, report.review),
      call("reviewPublication", "reviewTemplate", { request: publicationInput }, report.review),
      call("confirmInspection", "reviewPublication", { request: publicationInput }, "reinspect"),
    ],
  };
  assert.equal(workflow.evidence(execution, exercise, id, workflow).world.seed_revision, actual.mainEventId);
  read.record.effects[0].result = ref(original);
  assert.throws(
    () => workflow.evidence(execution, exercise, id, workflow),
    /assigned inspection and nested publication review/u,
  );
});

test("GitHub setup export binds the access decision to the native route and surface", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "github-setup-live-inspect-open-prs-headless";
  const workflow = cases.get(id);
  const { assignment } = workflow;
  const request = { goal: assignment.goal, operationId: "assigned-github", interactive: false };
  const status = { stage: "needs-token", connected: false, verified: false };
  const route = {
    action: "render-setup", accessLevel: "read-only",
    next: 'inline_ui({ path: "skills/github/GitHubSetup.tsx", props: { accessLevel: "read-only" } })',
    reason: "GitHub is disconnected",
  };
  const report = { status, accessLevel: "read-only", route, handoff: "interactive-required" };
  const execution = {
    provenance: { contextId: "owned" },
    diagnostics: { githubSetup: {
      contextId: "owned",
      verification: {
        caseId: assignment.id, request, status, route, passed: true,
        checks: {
          exactConnection: true, accessLevel: true, nativeRoute: true, surfaceHandoff: true,
          credentialsUnchanged: true, workspaceUnchanged: true,
        },
      },
    } },
  };
  const ref = (value) => {
    const bytes = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
  };
  const call = (name, parent, args, output, effects = []) => ({
    record: {
      call_id: name, parent_call_id: parent, definition: { name },
      inputs: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, ref(value)])),
      output: ref(output), started_at: "2026-11-20T00:00:00Z", ended_at: "2026-11-20T00:00:00Z", effects,
    },
  });
  const resolve = call("resolveGitHubRoute", "reviewGitHubSetup", {
    operationId: request.operationId, accessLevel: report.accessLevel,
  }, route, [{
    service: "githubSetupRoute", method: "resolve",
    args: ref([request.operationId, report.accessLevel]), result: ref(route),
  }]);
  const exercise = {
    report, rootCallIds: ["runWorkflow"],
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewGitHubSetup", "runWorkflow", { request }, report),
      call("readGitHubSetup", "reviewGitHubSetup", { operationId: request.operationId }, status, [{
        service: "githubSetupRead", method: "inspect", args: ref([request.operationId]), result: ref(status),
      }]),
      call("accessLevelFor", "reviewGitHubSetup", { intent: request.goal }, report.accessLevel),
      resolve,
      call("chooseSetupHandoff", "reviewGitHubSetup", { route, interactive: false }, report.handoff),
    ],
  };
  assert.equal(workflow.evidence(execution, exercise, id, workflow).world.context_id, "owned");
  resolve.record.effects[0].args = ref([request.operationId, "collaborate"]);
  assert.throws(
    () => workflow.evidence(execution, exercise, id, workflow),
    /nested least-access and presentation decisions/u,
  );
});

test("retained triage export binds diagnosis to the exact released run record", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "retained-triage-live-validator-threw";
  const workflow = cases.get(id);
  const { assignment } = workflow;
  const request = {
    goal: assignment.goal, operationId: "assignment", runId: "retained-triage-owned",
    testName: assignment.testName,
  };
  const native = {
    name: assignment.testName, failure: { phase: "validation", error: { name: "Error", message: assignment.detail } },
    validationFailure: { validator: "harness" },
  };
  const packet = { runId: request.runId, failure: native };
  const expected = {
    class: "validator",
    evidence: [
      { source: "validator-error", text: "the harness validator threw" },
      { source: "phase", text: `validation: Error: ${assignment.detail}` },
    ],
  };
  const report = { runId: request.runId, testName: request.testName, status: "triaged", triage: expected };
  const execution = {
    provenance: { contextId: "owned" },
    diagnostics: { retainedTriage: {
      contextId: "owned",
      verification: {
        caseId: assignment.id, request, native, expected, passed: true,
        checks: { sourceRun: true, released: true, exactRecord: true, nativeFailure: true, triage: true },
      },
    } },
  };
  const ref = (value) => {
    const bytes = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
  };
  const call = (name, parent, args, output, effects = []) => ({
    record: {
      call_id: name, parent_call_id: parent, definition: { name },
      inputs: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, ref(value)])),
      output: ref(output), started_at: "2026-11-20T00:00:00Z", ended_at: "2026-11-20T00:00:00Z", effects,
    },
  });
  const read = call("readRetainedFailure", "reviewRetainedFailure", { operationId: request.operationId }, packet, [{
    service: "retainedTestFailure", method: "inspect", args: ref([request.operationId]), result: ref(packet),
  }]);
  const exercise = {
    report, rootCallIds: ["runWorkflow"],
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewRetainedFailure", "runWorkflow", { request }, report),
      read,
      call("reviewSystemTest", "reviewRetainedFailure", {
        request: { kind: "triage", goal: request.goal, failure: native },
      }, { kind: "triage", ...expected }),
      call("triageFailure", "reviewSystemTest", { failure: native }, expected),
    ],
  };
  assert.equal(workflow.evidence(execution, exercise, id, workflow).world.source_run_id, request.runId);
  read.record.effects[0].result = ref({ ...packet, runId: "different-run" });
  assert.throws(
    () => workflow.evidence(execution, exercise, id, workflow),
    /assigned native read before the nested failure review/u,
  );
});

test("research intake export binds the nested review to assigned public receipts", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "research-intake-live-documentation-evidence";
  const workflow = cases.get(id);
  const { assignment } = workflow;
  const request = { goal: assignment.goal, operationId: "assigned" };
  const url = assignment.sources[0];
  const head = "This domain is for use in documentation examples.";
  const page = {
    id: "source-1", requestedUrl: url, finalUrl: url, title: "Example Domain",
    authority: "primary", session: "public", outcome: "fetched",
    digest: createHash("sha256").update(head).digest("hex"),
    head, size: Buffer.byteLength(head), headBytes: Buffer.byteLength(head), truncated: false, reads: [],
  };
  const projection = { goal: assignment.goal, checks: ["research"], suppliedUrls: [url],
    search: [], pages: [page], integration: null };
  const finding = {
    check: "research", disposition: "supported", evidenceIds: ["source-1"],
    citations: [{ sourceId: "source-1", url, quote: "documentation examples", date: null }],
    detail: "The page states the intended use.",
  };
  const report = { findings: [finding] };
  const execution = {
    provenance: { contextId: "owned" },
    diagnostics: { managedResearchIntake: {
      contextId: "owned", caseId: assignment.id, request, projection, passed: true,
      checks: { exactAcquisition: true, evidenceDisposition: true, exactCitation: true },
    } },
  };
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const call = (name, parent, input, output, effects = []) => ({
    callId: name,
    record: {
      call_id: name, parent_call_id: parent, definition: { name },
      inputs: { request: ref(input) }, output: ref(output), effects,
    },
  });
  const intake = call("reviewResearchIntake", "reviewLiveResearchIntake", projection, report);
  const exercise = {
    rootCallIds: ["runWorkflow"], report, calls: [
      call("reviewLiveResearchIntake", "runWorkflow", request, report, [{
        service: "assignedResearchIntake", method: "read", args: ref([request.operationId]), result: ref(projection),
      }]),
      intake,
      call("resolveEvidence", "reviewResearchIntake", projection, finding),
    ],
  };
  const verify = () => workflow.evidence(execution, exercise, id, workflow);
  assert.deepEqual(verify().world.source_digests, [page.digest]);
  const handoffId = "research-handoff-live-stage-source-grounded-purpose";
  const handoffWorkflow = cases.get(handoffId);
  assert.ok(workflowSourceGroups(workflow).every((group) => workflowSourceGroups(handoffWorkflow).includes(group)));
  const text = `${url} — documentation examples\nCached digest: ${page.digest}\n`;
  const artifact = { path: "/.tmp/evidence-handoff-assigned/handoff.json", bytes: 350 };
  const handoffReport = { status: "staged", artifact, missingSources: [], unanswered: [] };
  const scratchRequest = {
    goal: handoffWorkflow.assignment.goal, questions: [handoffWorkflow.assignment.question],
    sources: [{ id: page.id, path: "/.tmp/input/source-1.txt" }],
  };
  const handoffRequest = {
    goal: handoffWorkflow.assignment.goal + " First run the research intake, then assemble the evidence handoff.",
    work: handoffWorkflow.work.map((item, index) => ({ ...item, input: [request, scratchRequest][index] })),
  };
  const combinedReport = {
    results: handoffWorkflow.work.map((item, index) => ({ ...item, report: [report, handoffReport][index] })),
    remaining: [],
  };
  const combinedExecution = {
    provenance: execution.provenance,
    diagnostics: { managedResearchHandoff: {
      contextId: "owned", caseId: handoffWorkflow.assignment.id, passed: true, request: handoffRequest,
      research: execution.diagnostics.managedResearchIntake,
      checks: { research: true, handoff: true, transfer: true, exactWriteCount: true },
      handoff: {
        passed: true, artifact: { ...artifact, sha256: "a".repeat(64) }, expectedStatus: "staged",
        checks: { protectedUnchanged: true, originalsUnchanged: true, disposition: true, exactReadback: true },
        seedRevision: "before", sourceIds: [page.id],
      },
      sources: { [page.id]: text },
      sourceDigests: [{ id: page.id, sha256: createHash("sha256").update(text).digest("hex") }],
    } },
  };
  const scratchRead = {
    service: "scratchHandoffRead", method: "read", args: ref([page.id]),
    result: ref({ id: page.id, lines: text.trimEnd().split("\n") }),
  };
  const combinedExercise = {
    ...exercise, report: combinedReport, calls: [
      call("runWorkflow", null, handoffRequest, combinedReport),
      ...exercise.calls,
      call("assembleHandoff", "runWorkflow", scratchRequest, handoffReport, [
        scratchRead, { service: "scratchHandoffWrite", method: "stage", result: ref(artifact) },
      ]),
    ],
  };
  const validateHandoff = () => handoffWorkflow.evidence(combinedExecution, combinedExercise, handoffId, handoffWorkflow);
  assert.equal(validateHandoff().checks.transfer, true);
  scratchRead.result = ref({ id: page.id, lines: ["Unrelated source"] });
  assert.throws(validateHandoff, /exact verified excerpts/u);
  intake.record.inputs.request = ref({ ...projection, pages: [] });
  assert.throws(verify, /needs the exact acquired receipts/u);
  intake.record.inputs.request = ref(projection);
  finding.citations[0].quote = "not the documentation examples";
  assert.throws(verify, /source-grounded disposition/u);
});

test("notification export requires the accepted ID to be dismissed and interaction to remain unobserved", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "notification-lifecycle-live-temporary-actions";
  const workflow = cases.get(id);
  const { assignment } = workflow;
  const request = { goal: assignment.goal, operationId: "assigned-notification" };
  const accepted = { notificationId: "notif-durable-id", actionLabels: ["Accept", "Decline"] };
  const dismissed = { notificationId: accepted.notificationId };
  const report = { ...accepted, status: "cleaned-up", interaction: "unobserved" };
  const execution = {
    provenance: { contextId: "owned" },
    diagnostics: { managedNotification: {
      contextId: "owned",
      verification: {
        caseId: assignment.id, request, accepted, dismissed, passed: true,
        checks: { accepted: true, dismissed: true, exactReport: true },
      },
    } },
  };
  const ref = (value) => {
    const bytes = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
  };
  const call = (name, parent, args, output, effects = []) => ({
    record: {
      call_id: name, parent_call_id: parent, definition: { name },
      inputs: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, ref(value)])),
      output: ref(output), started_at: "2026-11-20T00:00:00Z", ended_at: "2026-11-20T00:00:00Z", effects,
    },
  });
  const show = call("showAssignedNotification", "runNotificationLifecycle", { operationId: request.operationId }, accepted, [{
    service: "temporaryNotificationShow", method: "show", args: ref([request.operationId]), result: ref(accepted),
  }]);
  const dismiss = call("dismissAssignedNotification", "runNotificationLifecycle", {
    operationId: request.operationId, notificationId: accepted.notificationId,
  }, dismissed, [{
    service: "temporaryNotificationDismiss", method: "dismiss",
    args: ref([request.operationId, accepted.notificationId]), result: ref(dismissed),
  }]);
  const exercise = {
    report, rootCallIds: ["runWorkflow"],
    calls: [
      call("runWorkflow", null, {}, null),
      call("runNotificationLifecycle", "runWorkflow", { request }, report),
      show, dismiss,
      call("confirmNotificationLifecycle", "runNotificationLifecycle", { accepted, dismissed }, report),
    ],
  };
  const verify = () => workflow.evidence(execution, exercise, id, workflow);
  assert.equal(verify().world.notification_id, accepted.notificationId);
  dismiss.record.effects[0].args = ref([request.operationId, "notif-other"]);
  assert.throws(verify, /requires native acceptance and explicit same-identity dismissal/u);
  dismiss.record.effects[0].args = ref([request.operationId, accepted.notificationId]);
  report.interaction = "clicked";
  assert.throws(verify, /requires native acceptance and explicit same-identity dismissal/u);
});

test("remote route export binds the routing diagnosis to a live gateway read", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const id = "remote-route-live-stale-workspace-assignment";
  const workflow = cases.get(id);
  const { assignment } = workflow;
  const request = {
    goal: assignment.goal, operationId: "assigned-route", serverId: "server",
    workspaceId: "previous-workspace",
  };
  const native = { serverId: "server", bootId: "current-boot", workspaceId: "current-workspace" };
  const report = {
    observed: native, verdict: "workspace-mismatch", layer: "workspace-routing", next: "refresh-workspace-reach",
  };
  const execution = {
    provenance: { contextId: "owned" },
    diagnostics: { remoteRoute: {
      contextId: "owned",
      verification: {
        caseId: assignment.id, request, native, passed: true,
        checks: { scopedRead: true, stableGateway: true, assignedRoute: true, exactReport: true },
      },
    } },
  };
  const ref = (value) => {
    const bytes = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(bytes).digest("hex"), bytes: Buffer.byteLength(bytes) };
  };
  const call = (name, parent, args, output, effects = []) => ({
    record: {
      call_id: name, parent_call_id: parent, definition: { name },
      inputs: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, ref(value)])),
      output: ref(output), started_at: "2026-11-20T00:00:00Z", ended_at: "2026-11-20T00:00:00Z", effects,
    },
  });
  const read = call("readGatewayIdentity", "reviewRemoteRoute", { operationId: request.operationId }, native, [{
    service: "remoteGatewayIdentity", method: "observe", args: ref([request.operationId]), result: ref(native),
  }]);
  const exercise = {
    report, rootCallIds: ["runWorkflow"],
    calls: [
      call("runWorkflow", null, {}, null),
      call("reviewRemoteRoute", "runWorkflow", { request }, report),
      read,
      call("remoteLayer", "reviewRemoteRoute", {
        diagnosis: "The gateway answered, but the selected workspace route reaches a different workspace ID.",
      }, report.layer),
      call("routeHandoff", "reviewRemoteRoute", { verdict: report.verdict, layer: report.layer }, report.next),
    ],
  };
  assert.equal(workflow.evidence(execution, exercise, id, workflow).world.observed_workspace, native.workspaceId);
  read.record.effects[0].result = ref({ ...native, workspaceId: request.workspaceId });
  assert.throws(
    () => workflow.evidence(execution, exercise, id, workflow),
    /needs the native read before its diagnosis/u,
  );
  const continuationId = "remote-route-live-cli-linked-agent-eval";
  const continuation = cases.get(continuationId);
  assert.deepEqual(continuation.skills, ["reviewRemoteRoute", "planCliContinuation"]);
  Object.assign(request, { goal: continuation.assignment.goal, workspaceId: native.workspaceId });
  const gatewayReport = { observed: native, verdict: "verified", layer: "healthy", next: "accept-identity" };
  const gatewayVerification = execution.diagnostics.remoteRoute.verification;
  gatewayVerification.caseId = continuation.assignment.id;
  const selectors = {
    ambient: { contextId: "owned" },
    binding: { contextId: "other", workspaceId: native.workspaceId },
  };
  const evidence = { gateway: native, credential: { kind: "agent", contextId: "owned" }, operation: "eval", selectors };
  const chosen = { source: "ambient", coordinate: selectors.ambient };
  const plan = { source: "ambient", contextId: "owned", status: "usable", action: "ask-parent", gateway: native };
  execution.diagnostics.remoteRoute.verification = {
    caseId: continuation.assignment.id, passed: true,
    checks: { verifiedGateway: true, exactScope: true }, gateway: gatewayVerification, evidence,
  };
  exercise.report = { results: [
    { domain: "remoteAccess", operation: "reviewRemoteRoute", report: gatewayReport },
    { domain: "remoteAccess", operation: "planCliContinuation", report: plan },
  ] };
  const action = call("chooseCliAction", "planCliContinuation", { status: "usable", credential: evidence.credential, operation: "eval" }, "ask-parent");
  read.record.effects[0].result = ref(native);
  exercise.calls = [
    exercise.calls[0], read,
    call("reviewRemoteRoute", "runWorkflow", { request }, gatewayReport),
    call("remoteLayer", "reviewRemoteRoute", { diagnosis: "The server and workspace gateway identities match the assigned route." }, "healthy"),
    call("routeHandoff", "reviewRemoteRoute", { verdict: "verified", layer: "healthy" }, "accept-identity"),
    call("planCliContinuation", "runWorkflow", { request }, plan, [{
      service: "remoteCliScope", method: "evidence", args: ref([request.operationId]), result: ref(evidence),
    }]),
    call("selectContextSource", "planCliContinuation", { selectors }, chosen),
    call("assessCliContext", "planCliContinuation", { choice: chosen, gateway: native, credential: evidence.credential }, "usable"),
    action,
  ];
  assert.equal(continuation.evidence(execution, exercise, continuationId, continuation).world.context_source, "ambient");
  action.record.output = ref("run-assigned-command");
  assert.throws(
    () => continuation.evidence(execution, exercise, continuationId, continuation),
    /requires the verified gateway, selected context and caller-tier decision/u,
  );
});

test("approval transition export requires ordered live snapshots and both nested queue reviews", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "approval-transition-live-cancelled-creation-review";
  assert.deepEqual(workflowSourceGroups(cases.get(name)), ["vibestudio:cli:approval-queue-visibility"]);
  entry.test.name = name;

  const approvalId = "11111111-1111-4111-8111-111111111111";
  const unrelated = "22222222-2222-4222-8222-222222222222";
  const request = {
    goal: "Follow the assigned workspace review across both approval queue observations.",
    caller: "device-workspace",
    approvalId,
    earlier: [
      { source: "workspace", kind: "snapshot", ids: [approvalId] },
      { source: "hub", kind: "snapshot", ids: [unrelated] },
    ],
    later: [
      { source: "workspace", kind: "snapshot", ids: [] },
      { source: "hub", kind: "snapshot", ids: [unrelated] },
    ],
  };
  const visibility = (phase) => ({
    coverage: "complete",
    surfaces: request[phase].map(({ source, ids }) => ({ source, state: "visible", ids })),
    location: phase === "earlier"
      ? { status: "located", source: "workspace" }
      : { status: "absent", source: null },
  });
  const report = {
    transition: "no-longer-listed",
    earlier: visibility("earlier"),
    later: visibility("later"),
  };
  diagnostics.managedApprovalTransition = {
    contextId: "ctx", workspaceId: "approval-workspace", caseId: "cancelled-creation-review",
    request, passed: true,
    checks: {
      workspaceReviewWasPending: true, hubDidNotListAssignedReview: true,
      workspaceReviewWasRemoved: true, report: true,
    },
  };
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  const call = (name, id, parent, inputs, output, second = 0) => ({
    callId: id,
    summary: { ...prototype.summary, call_id: id },
    record: {
      ...prototype.record, call_id: id, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output), effects: [],
      started_at: new Date(second * 1000).toISOString(),
      ended_at: new Date((second + 1) * 1000).toISOString(),
    },
  });
  const queues = ["earlier", "later"].flatMap((phase, index) => {
    const { goal, caller } = request;
    const receipts = request[phase];
    const { surfaces, coverage, location } = report[phase];
    return [
      call("reviewApprovalQueues", phase, "transition", { request: { goal, caller, approvalId, receipts } }, report[phase], index + 1),
      call("selectApprovalSurfaces", phase + "-select", phase, { caller }, ["workspace", "hub"]),
      ...surfaces.map((surface) => call("reviewApprovalSurface", phase + "-" + surface.source, phase,
        { source: surface.source, receipts }, surface)),
      call("summarizeApprovalVisibility", phase + "-summarize", phase, { surfaces }, coverage),
      call("locatePendingApproval", phase + "-locate", phase, { approvalId, surfaces, coverage }, location),
    ];
  });
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["root"],
    report,
    calls: [
      call("runWorkflow", "root", null, {}, null),
      call("reviewApprovalTransition", "transition", "root", { request }, report),
      ...queues,
      call("interpretApprovalTransition", "interpret", "transition", { earlier: report.earlier, later: report.later }, report.transition, 3),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  const laterQueue = queues.find(({ callId }) => callId === "later");
  const originalRequest = laterQueue.record.inputs.request;
  laterQueue.record.inputs.request = queues[0].record.inputs.request;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /two ordered nested queue reviews/u);
  laterQueue.record.inputs.request = originalRequest;

  laterQueue.record.effects.push({ service: "approval", method: "cancel" });
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /no approval side effects/u);
  laterQueue.record.effects.pop();

  request.later[0].ids.push(approvalId);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact live snapshots/u);
});

test("commission export requires the live hub, verified new device and exact nested receipts", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "remote-commission-live-running-hub-new-cli";
  const workflow = cases.get(name);
  assert.deepEqual(workflow.devices, ["terminal"]);
  assert.deepEqual(workflowSourceGroups(workflow), ["vibestudio:remote-access:deployment-and-device-route"]);
  entry.test.name = name;
  const operationId = "f8fbdfc8-0268-4074-bfbe-5579990c9781";
  const accessId = "82ee36a3-4875-4828-a457-1c66961e8b4e";
  const request = { operationId };
  const identity = {
    serverId: "srv_" + "s".repeat(24), bootId: "boot_" + "b".repeat(24),
    buildId: "a".repeat(64), workspaceId: "ws_own",
  };
  const baseline = { receipt: operationId + ":baseline", intent: "deploy", state: "ready", hasPriorIdentity: true };
  const handoff = { state: "assigned", operationId: accessId };
  const profile = { receipt: accessId + ":profile", state: "unpaired", inviteAssigned: true };
  const pair = { receipt: accessId + ":pair", state: "paired" };
  const route = { receipt: accessId + ":route", state: "routed" };
  const child = { receipt: accessId + ":child", state: "verified", workspaceId: identity.workspaceId };
  const report = {
    deployment: { status: "already-running", identity: null, evidenceIds: [baseline.receipt] },
    handoff,
    access: { status: "workspace-ready", workspaceId: identity.workspaceId, evidenceIds: [profile, pair, route, child].map(({ receipt }) => receipt) },
  };
  const proof = { stableDeployment: true, persistedNewProfile: true };
  diagnostics.remoteCommissionManaged = {
    contextId: "ctx", caseId: workflow.assignment.id, request, identity, proof,
    steps: { baseline, handoff, profile, pair, route, child },
    order: ["baseline", "handoff", "profile", "pair", "route", "child"],
    checks: { stableDeployment: true, newPairedProfile: true, receiptOrder: true, assignedChild: true, exactReport: true },
    passed: true,
  };
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  let tick = 0;
  const call = (name, parent, inputs, output, effect) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output),
      effects: effect ? [{
        service: effect[0], method: effect[1], args: ref(Object.values(inputs)), result: ref(output),
      }] : [],
      started_at: new Date(tick++ * 1000).toISOString(),
      ended_at: new Date(tick * 1000).toISOString(),
    },
  });
  const commission = "commissionRemoteWorkspace";
  const deploy = "deployRemoteServer";
  const access = "openRemoteWorkspace";
  const open = "openAssignedRoute";
  const calls = [
    call("runWorkflow", null, {}, null),
    call(commission, "runWorkflow", { request }, report),
    call(deploy, commission, { request }, report.deployment),
    call("observeBaseline", deploy, { operationId }, baseline, ["remoteDeploymentRead", "observe"]),
    call("decideDeployment", deploy, { baseline }, "already-running"),
    call("bindVerifiedWorkspace", commission, { deploymentReceipt: baseline.receipt }, handoff, ["remoteDeploymentHandoff", "open"]),
    call(access, commission, { request: { operationId: accessId } }, report.access),
    call("readAssignedProfile", access, { operationId: accessId }, profile, ["remoteAccessRead", "observe"]),
    call("decideAdmission", access, { observed: profile }, "pair"),
    call("pairAssignedProfile", access, { profileReceipt: profile.receipt }, pair, ["remoteAccessPair", "pair"]),
    call(open, access, { priorReceipt: pair.receipt }, { ...report.access, evidenceIds: [route.receipt, child.receipt] }),
    call("routeThroughHub", open, { priorReceipt: pair.receipt }, route, ["remoteAccessRoute", "select"]),
    call("observeChild", open, { routeReceipt: route.receipt }, child, ["remoteAccessVerify", "verify"]),
    call("interpretChild", open, { child }, "workspace-ready"),
  ];
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"], report, calls,
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });

  const childCall = calls.find(({ callId }) => callId === "observeChild").record;
  const childEffect = childCall.effects[0];
  const exact = childEffect.args;
  childEffect.args = ref([baseline.receipt]);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /ordered nested deployment/u);
  childEffect.args = exact;

  proof.persistedNewProfile = false;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /new paired device/u);
});

test("remote deployment binds a real successor boot to the ordered lifecycle receipts", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "remote-deployment-live-preserves-workspace-on-update";
  entry.test.name = name;
  assert.equal(cases.get(name).requiresDeploymentPackage, true);
  const operationId = "f8fbdfc8-0268-4074-bfbe-5579990c9781";
  const request = { operationId };
  const identity = { serverId: "srv_" + "s".repeat(24), bootId: "boot_" + "b".repeat(24), buildId: "a".repeat(64), workspaceId: "ws_own" };
  const initial = { state: "ready", identity: { ...identity, bootId: "boot_" + "c".repeat(24) } };
  const baseline = { receipt: operationId + ":baseline", intent: "update", state: "ready", hasPriorIdentity: true };
  const apply = { receipt: operationId + ":apply", state: "applied" };
  const verify = { receipt: operationId + ":verification", state: "verified", identity };
  const report = { status: "deployment-ready", identity, evidenceIds: [baseline.receipt, apply.receipt, verify.receipt] };
  diagnostics.remoteDeploymentManaged = {
    contextId: "ctx", caseId: cases.get(name).assignment.id, request, initial, final: { state: "ready", identity },
    steps: { baseline, apply, verify }, order: ["baseline", "apply", "verify"],
    checks: { assignedBaseline: true, receiptOrder: true, deploymentReady: true, expectedIdentity: true, exactReport: true },
    passed: true,
  };
  const ref = (value) => {
    const json = JSON.stringify(value);
    return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
  };
  const prototype = diagnostics.natlangTeacher.calls[0];
  let tick = 0;
  const call = (name, parent, inputs, output, effect) => ({
    callId: name,
    summary: { ...prototype.summary, call_id: name },
    record: {
      ...prototype.record, call_id: name, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      output: ref(output), effects: effect ? [{ service: effect[0], method: effect[1], args: ref(Object.values(inputs)), result: ref(output) }] : [],
      started_at: new Date(tick++ * 1000).toISOString(),
      ended_at: new Date(tick * 1000).toISOString(),
    },
  });
  const deploy = "deployRemoteServer";
  const readiness = "checkReadiness";
  const calls = [
    call("runWorkflow", null, {}, null),
    call(deploy, "runWorkflow", { request }, report),
    call("observeBaseline", deploy, { operationId }, baseline, ["remoteDeploymentRead", "observe"]),
    call("decideDeployment", deploy, { baseline }, "apply"),
    call("applyDeployment", deploy, { baselineReceipt: baseline.receipt }, apply, ["remoteDeploymentApply", "apply"]),
    call(readiness, deploy, { actionReceipt: apply.receipt }, { status: report.status, identity, evidenceIds: [verify.receipt] }),
    call("observeReadiness", readiness, { actionReceipt: apply.receipt }, verify, ["remoteDeploymentVerify", "verify"]),
    call("interpretReadiness", readiness, { verified: verify }, "deployment-ready"),
  ];
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher, programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"], report, calls,
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  const read = calls.find(({ callId }) => callId === "observeReadiness").record;
  read.effects[0].args = ref([baseline.receipt]);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /ordered nested native/u);
  read.effects[0].args = ref([apply.receipt]);
  initial.identity.bootId = identity.bootId;
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /successor with preserved identities/u);
});

test('project content review binds explicit baseline/current/delta without inferring a new commit from a baseline handle',()=>{
 const goal='Prepare a private draft',before={committed:{kind:'event',eventId:'baseline'},workingHead:{kind:'event',eventId:'baseline'},clean:true,mainEventId:'main'};
 const actual={committed:before.committed,workingHead:{kind:'application',applicationId:'draft'},clean:false,mainEventId:'main'};
 const reviewInput={actual:{contextId:'ctx',state:actual.workingHead,documents:[{path:'guide.md',text:'Checked private draft'}],lifecycle:{requestedDisposition:'draft',baseline:{committedEvent:before.committed,workingHead:before.workingHead,clean:true,protectedMainEventId:'main'},current:{committedEvent:actual.committed,workingHead:actual.workingHead,clean:false,protectedMainEventId:'main'},delta:{committedEventChanged:false,workingHeadChanged:true,protectedMainChanged:false}}},expected:{goal},rubric:'Judge actual content; baseline commit predates the task.'};
 const proof={passed:true,caseId:'draft',contextId:'ctx',goal,checks:{nativePrivateBoundary:true},preparedContentProject:{contextId:'ctx',caseId:'draft',sourceGroup:'group',expectedOutcome:'draft',before,actual,artifact:{passed:true,reasons:[],semanticReviewRequired:true,semanticReviewInput:reviewInput}}};
 const text=JSON.stringify(goal),exercise={rootCallIds:['root'],calls:[{callId:'root',record:{inputs:{goal:{complete:true,bytes:Buffer.byteLength(text),hash:createHash('sha256').update(text).digest('hex')}}}}]};
 const execution={provenance:{contextId:'ctx'},diagnostics:{openGoalVerification:proof}},workflow={assignment:{id:'draft',goal,kind:'preparedContentProject',sourceGroup:'group'},requiresReview:true};
 assert.equal(openOutcomeGoalEvidence(execution,exercise,'draft',workflow).reviewInput,reviewInput);
 reviewInput.actual.lifecycle.delta.committedEventChanged=true;
 assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,'draft',workflow),/independently read back project/u);
});

test("void TS entries bind actual undefined transport without waiving requested values",()=>{
 const ref=value=>{const text=JSON.stringify(value);return {complete:true,bytes:Buffer.byteLength(text),hash:createHash('sha256').update(text).digest('hex')};};
 const goal='Apply the independently checked reference effect';
 const entry={program:'skills/reference/review.ts',callable:'review',arguments:{goal},argumentJson:{goal:JSON.stringify(goal)},resultType:'void'};
 const make=()=>{
  const root={callId:'root',record:{call_id:'root',inputs:{goal:ref(goal)},output:ref(null),executor:{kind:'crisp'},definition:{name:'review',source:'review.ts',id:'ts:review.ts#default',returns:'void'}}};
  const proof={passed:true,caseId:'void-reference',contextId:'ctx',goal,entry,actualResultKind:'void',actualResult:null,checks:{actualNativeEffect:true}};
  return {execution:{provenance:{contextId:'ctx'},diagnostics:{openGoalVerification:proof}},exercise:{entry,rootCallIds:['root'],calls:[root],applicationResult:null,applicationResultKind:'void'},workflow:{entry,assignment:{id:'void-reference',goal}},root,proof};
 };
 const good=make();expectVoid(good);
 function expectVoid({execution,exercise,workflow}){
  const observed=openOutcomeGoalEvidence(execution,exercise,'void-reference',workflow);
  assert.deepEqual(observed.evidence.workspace.applicationReturn,{kind:'void',root_call_id:'root',valueJson:'null',selectedResult:null});
 }
 for(const corrupt of [
  value=>{delete value.proof.actualResultKind;},
  value=>{value.workflow.entry={...entry,resultType:'Receipt'};},
  value=>{value.root.record.definition.returns='Receipt';},
  value=>{value.root.record.definition.id='ts:review.ts#other';},
  value=>{value.root.record.executor.kind='agent';},
  value=>{value.exercise.applicationResult={invented:true};},
  value=>{value.root.record.output=ref('wrong');},
 ]){const value=make();corrupt(value);assert.throws(()=>expectVoid(value),/independently verified outcomes/);}
});
