import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import templateConfig from "../src/dev/developmentTemplateConfig.cjs";
import {
  exportLiveTeacherWorkflow,
  loadLiveTeacherCases,
  workflowSourceGroups,
} from "./export-live-workflow-teacher.mjs";

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
      ["build-performance-worlds", "buildPerformanceWorlds", []],
      ["tour-rehearsal-worlds", "tourRehearsalWorlds", []],
      ["explorer-probe-worlds", "explorerTextWorlds", []],
      ["gmail-compose-history-worlds", "gmailComposeHistoryWorlds", []],
      ["unit-identity-worlds", "unitIdentityWorlds", []],
      ["transcript-cursor-worlds", "transcriptCursorWorlds", []],
      ["delivery-history-worlds", "deliveryHistoryWorlds", []],
      ["android-audit-worlds", "androidAuditWorlds", []],
      ["android-install-worlds", "androidInstallWorlds", []],
      ["android-pair-worlds", "androidPairWorlds", []],
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
      ["authority-review-worlds", "managedAuthorityReviewWorlds", []],
      ["problem-draft-worlds", "managedProblemDraftWorlds", []],
      ["agentic-change-worlds", "managedAgenticChangeWorlds", []],
      ["gad-review-worlds", "managedGadReviewWorlds", []],
      ["terminal-check-worlds", "managedTerminalCheckWorlds", []],
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
      ["browser-library-worlds", "managedBrowserLibraryWorlds", []],
      ["browser-handoff-worlds", "managedBrowserHandoffWorlds", []],
      ["mission-planning-worlds", "managedMissionPlanningWorlds", []],
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
         ${name === "ownedOperationsWorlds" ? 'export const ownedOperationsComposedWorlds = [{ id: "release-readiness-dossier", sourceGroup: "vibestudio:owned-operations:release:pending" }];' : ""}
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

test("shared program export requires the assigned skill and its actual nested stages", async (t) => {
  const { options, diagnostics, save } = await fixture(t);
  const run = diagnostics.natlangTeacher;
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, reproduce] = run.calls;
  root.record.definition.name = "runWorkflow";
  await save();
  await assert.rejects(() => exportLiveTeacherWorkflow(options), /assigned repairPanel skill/);
  const skill = structuredClone(reproduce);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "repairPanel";
  reproduce.record.parent_call_id = "skill";
  run.calls.push(skill);
  await save();
  await exportLiveTeacherWorkflow(options);
});

test("live panel export rejects a child from a different evaluation", async (t) => {
  const { options, diagnostics, save } = await fixture(t);
  diagnostics.natlangTeacher.calls[1].summary.run_id = "other";
  await save();
  await assert.rejects(() => exportLiveTeacherWorkflow(options), /different EvalDO/);
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
    ["checkTestkitRelease", skill.callId],
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
    ["matchesChannel", "inspectCheckpoint"],
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

test("incident continuation export requires both child calls, source groups, and read order", async (t) => {
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
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-early-skill` }),
    /dependent skill started before its prerequisite completed/u
  );
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
      ["build-performance-worlds", "export const buildPerformanceWorlds = [];"],
      ["tour-rehearsal-worlds", "export const tourRehearsalWorlds = [];"],
      ["explorer-probe-worlds", "export const explorerTextWorlds = [];"],
      ["gmail-compose-history-worlds", "export const gmailComposeHistoryWorlds = [];"],
      ["unit-identity-worlds", "export const unitIdentityWorlds = [];"],
      ["transcript-cursor-worlds", "export const transcriptCursorWorlds = [];"],
      ["delivery-history-worlds", "export const deliveryHistoryWorlds = [];"],
      ["android-audit-worlds", "export const androidAuditWorlds = [];"],
      ["android-install-worlds", "export const androidInstallWorlds = [];"],
      ["android-pair-worlds", "export const androidPairWorlds = [];"],
      ["publication-revision-worlds", "export const publicationRevisionWorlds = [];"],
      ["eval-recovery-worlds", "export const managedEvalRecoveryWorlds = [];"],
      ["pdf-layout-worlds", "export const managedPdfLayoutWorlds = [];"],
      ["offline-dictation-worlds", "export const managedDictationWorlds = [];"],
      ["native-suite-worlds", "export const managedNativeSuiteWorlds = [];"],
      ["git-bridge-review-worlds", "export const managedGitBridgeReviewWorlds = [];"],
      ["vcs-delivery-worlds", "export const managedVcsDeliveryWorlds = [];"],
      ["web-brief-worlds", "export const managedWebBriefWorlds = [];"],
      ["architecture-boundary-worlds", "export const managedArchitectureBoundaryWorlds = [];"],
      ["release-review-handoff-worlds", "export const managedReleaseReviewHandoffWorlds = [];"],
      ["extension-release-worlds", "export const managedExtensionReleaseWorlds = [];"],
      ["authority-review-worlds", "export const managedAuthorityReviewWorlds = [];"],
      ["problem-draft-worlds", "export const managedProblemDraftWorlds = [];"],
      ["agentic-change-worlds", "export const managedAgenticChangeWorlds = [];"],
      ["gad-review-worlds", "export const managedGadReviewWorlds = [];"],
      ["terminal-check-worlds", "export const managedTerminalCheckWorlds = [];"],
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
      ["automation-lifecycle-worlds", "export const managedAutomationWorlds = [];"],
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
      ["browser-library-worlds", "export const managedBrowserLibraryWorlds = [];"],
      ["browser-handoff-worlds", "export const managedBrowserHandoffWorlds = [];"],
      ["mission-planning-worlds", "export const managedMissionPlanningWorlds = [];"],
      ["channel-roster-worlds", "export const managedChannelRosterWorlds = [];"],
      ["panel-health-worlds", "export const managedPanelHealthWorlds = [];"],
      ["google-setup-worlds", "export const managedGoogleSetupWorlds = [];"],
      ["provenance-history-worlds", "export const managedProvenanceHistoryWorlds = [];"],
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
  assert.equal(proof.checks.independentSemanticReview, true);
  assert.deepEqual(workspaceEvidence.semanticReview.input, reviewInput);
  assert.equal(proof.calls.length, 2);
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
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
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

test("client admission export rejects substituted host ABI evidence", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "client-admission-live-working-desktop-abi-incompatible";
  const { assignment } = cases.get(name);
  entry.test.name = name;
  const { goal, source, host, runtime, workingAbi, publishedAbi, abi } = assignment;
  const operationId = "client-review";
  const request = { goal, operationId };
  const working = {
    hash: "working-manifest",
    id: "browser",
    runtime,
    abi: workingAbi,
    required: ["device-session"],
    optional: ["notifications"],
  };
  const observation = {
    operationId,
    contextId: "ctx",
    source,
    workingRevision: "application:working-client",
    mainRevision: "event:published-client",
    working,
    published: { ...working, hash: "published-manifest", abi: publishedAbi },
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
        missingRequired: [],
        untrustedRequired: [],
        deniedOptional: ["notifications"],
      },
    },
    decision: "resolve-abi",
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
  read.record.effects[0].result = ref({
    ...observation,
    host: { ...observation.host, runtimes: { [runtime]: workingAbi } },
  });
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases }),
    /host contract and build catalog/u
  );
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
      call("reviewResult", "reviewTestSuite", { execution }, result),
      call("interpretOutcome", "reviewResult", {}, result.outcome),
      call("planFollowUp", "reviewResult", {}, result.followUp),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
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
});

test("log cursor export rejects a sequence past the bounded live read", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "log-cursor-live-resume-one-repeated-failure";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const request = { goal: assignment.goal, operationId: "assigned-log-cursor" };
  const seed = { marker: "owned-log", boot: "system-boot-1", start: 50, steps: [52, 54] };
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
    throughSeq: 54,
    overflow: false,
    snapshot: { serverBootId: seed.boot, latestSeq: 54, totalCaptured: 60, records },
  };
  const decision = {
    status: "review-window",
    reason: "The existing boot still retains the assigned range.",
  };
  const finding = {
    class: "failure",
    count: 2,
    firstSeq: 52,
    lastSeq: 54,
    tag: "WorkerdManager",
    message: records[0].message,
  };
  const brief = {
    serverBootId: seed.boot,
    latestSeq: 54,
    window: { fromSeq: 52, toSeq: 54, records: 2 },
    status: "incident",
    headline: "One repeated failure",
    findings: [finding],
  };
  const report = {
    liveBoot: seed.boot,
    latestSeq: 60,
    decision,
    brief,
    next: { serverBootId: seed.boot, seq: 54 },
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
  const read = {
    service: "serverLogCursor",
    method: "observe",
    args: ref([request.operationId]),
    result: ref(observed),
  };
  const review = call("reviewLogCursor", "runWorkflow", { request }, report, [read]);
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
      call("classifyHostLogGroup", "reviewLogCursor", { group: finding }, "failure"),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  report.next.seq = 60;
  review.record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact covered records/u);
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
  const report = { receipt, decision, evidenceIds };
  diagnostics.gmailComposeHistory = {
    passed: true, seed, request, received: receipt,
    checks: { channel: true, lineage: true, disposition: true, evidence: true },
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
  const history = call("inspectComposeHistory", "runWorkflow", { request }, report, [{
    service: "gmailComposeHistory", method: "read", args: ref([request.operationId]), result: ref(receipt),
  }]);
  diagnostics.natlangTeacher = {
    ...diagnostics.natlangTeacher,
    programPath: "skills/vibestudio-workflows/runWorkflow.nl",
    rootCallIds: ["runWorkflow"],
    report,
    calls: [
      call("runWorkflow", null, {}, null), history,
      call("assessComposeState", "inspectComposeHistory", { events }, decision),
      call("checkDelivery", "assessComposeState", { state: events.at(-1).state }, decision),
      call("citeComposeHistory", "inspectComposeHistory", { events }, evidenceIds),
    ],
  };
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  evidenceIds[1] = "other-channel-event";
  history.record.output = ref(report);
  await save();
  await assert.rejects(exportLiveTeacherWorkflow({ ...options, cases }), /exact lineage and appropriate recovery/u);
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

test("delivery history export rejects a same-text message from a different channel", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  const name = "delivery-history-live-identical-note-on-other-channel";
  const { assignment } = cases.get(name);
  const pins = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pins, workspace: "system" }));
  entry.test.name = name;
  const request = { goal: assignment.goal, operationId: "assigned-receipt" };
  const receipt = { channelId: "original", messageId: "msg-1", senderId: "sender" };
  const observation = { channelId: "other", receipt, retained: [], rendered: [] };
  const canonical = {
    messageId: "msg-2",
    envelopeId: "envelope",
    sequence: 1,
    senderId: "sender",
    text: assignment.text,
  };
  const report = {
    observation,
    origin: "foreign-channel",
    consumer: "unreviewed",
    verified: false,
  };
  diagnostics.deliveryHistory = {
    passed: true,
    caseId: assignment.id,
    contextId: "ctx",
    request,
    observed: observation,
    canonical,
    retryId: null,
    decoyId: "msg-2",
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
  const review = call("reviewDeliveryHistory", "runWorkflow", { request }, report, [
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
    ],
  };
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
});

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
