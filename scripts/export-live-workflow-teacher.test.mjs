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
      ["automation-lifecycle-worlds", "managedAutomationWorlds", [{ id: "stale", status: "held" }]],
      [
        "publication-preflight-worlds",
        "managedPublicationWorlds",
        [{ id: "caption", expectedBlockers: ["missing-presentation"] }],
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
        ],
      ],
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
        [{ id: "quiet-garden", expected: ["supported", "supported"] }],
      ],
      [
        "checklist-worlds",
        "managedChecklistWorlds",
        [{ id: "restart", request: { continuation: "restart" }, expected: [[], ["1"], ["1"]] }],
      ],
      [
        "onboarding-worlds",
        "managedSetupWorlds",
        [{ id: "retired", expected: { status: "invalid-selection", route: null } }],
      ],
      [
        "verified-memory-worlds",
        "managedMemoryWorlds",
        [{ id: "retired", expected: { status: "missing-source" } }],
      ],
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
         ${name === "ownedOperationsWorlds" ? 'export const ownedOperationsComposedWorlds = [{ id: "release-readiness-dossier", sourceGroup: "vibestudio:owned-operations:release:pending" }];' : ""}`
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
  const cleanPdf = cases.get("pdf-intake-live-page-missing");
  assert.equal(cleanPdf.root, "extractPdfEvidence");
  assert.equal(cleanPdf.expectedStatus, "missing-pages");
  assert.deepEqual(cleanPdf.pages, [1, 5]);
  const review = cases.get("authoring-live-old-reference");
  assert.equal(review.root, "reviewProgram");
  assert.equal(review.comparedBaseline, true);
  assert.equal(review.expectedStatus, "baseline-rejected");
  const memory = cases.get("verified-memory-live-retired");
  assert.equal(memory.root, "recallDecision");
  assert.equal(memory.workspace, "personal");
  assert.equal(memory.expectedStatus, "missing-source");
  assert.equal(cases.get("news-live-sample").workspace, "news");
  assert.equal(cases.get("google-setup-live-sample").workspace, "google-workspace");
  assert.equal(cases.get("local-model-compare-live-sample").root, "prepareLocalModel");
  assert.equal(cases.get("host-log-audit-live-sample").root, "investigateSystem");
  assert.equal(cases.get("runtime-program-live-sample").root, "reviewRuntimeEvidence");
  assert.equal(cases.get("provenance-history-live-sample").root, "reviewProvenance");
  assert.equal(cases.get("spectrolite-live-sample").workspace, "spectrolite");
  assert.equal(cases.get("grimoire-live-quiet-garden").workspace, "examples");
  const checklist = cases.get("terminal-checklist-live-restart");
  assert.equal(checklist.root, "verifyChecklist");
  assert.equal(checklist.expectedContinuation, "restart");
  assert.deepEqual(checklist.expectedScreens, [[], ["1"], ["1"]]);
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

test("Google setup export binds the measured viewport to the authored check", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "google-setup-live-narrow-owner-review";
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
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
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
});

test("News export rejects findings that cite a different schedule owner", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "news-live-baseline-dual-cadence";
  const world = cases.get(entry.test.name);
  const run = diagnostics.natlangTeacher;
  run.report = {
    status: "ready",
    findings: [
      { code: "poll-confirmed", evidenceIds: ["poll-owner"] },
      { code: "briefing-confirmed", evidenceIds: ["briefing-owner"] },
    ],
  };
  run.programPath = "skills/vibestudio-workflows/runWorkflow.nl";
  const [root, leaf] = run.calls;
  root.record.definition.name = "runWorkflow";
  const skill = structuredClone(leaf);
  skill.callId = skill.summary.call_id = "skill";
  skill.record.definition.name = "reviewNews";
  leaf.record.parent_call_id = "skill";
  run.calls.push(skill);
  diagnostics.managedNews = {
    contextId: "ctx",
    verification: {
      passed: true,
      checks: { matchesReport: true, matchesState: true },
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
        owner: { id: "reader" },
        poll: { id: "poll-owner" },
        briefing: { id: "briefing-owner" },
      })),
    },
  };
  const pinned = JSON.parse(await readFile(options.pins, "utf8"));
  await writeFile(options.pins, JSON.stringify({ ...pinned, workspace: "news" }));
  await save();
  await exportLiveTeacherWorkflow({ ...options, cases });
  run.report.findings[1].evidenceIds = ["another-reader"];
  await save();
  await assert.rejects(
    exportLiveTeacherWorkflow({ ...options, cases, out: `${options.out}-different-owner` }),
    /News findings must match the assigned channel observations and Missions owners/u
  );
});

test("Spectrolite export rejects a preview from another canonical revision", async (t) => {
  const { options, diagnostics, entry, save } = await fixture(t);
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(
    path.resolve(import.meta.dirname, "..")
  );
  const cases = await loadLiveTeacherCases(checkouts);
  entry.test.name = "spectrolite-live-release-handoff";
  const run = diagnostics.natlangTeacher;
  const world = cases.get(entry.test.name);
  run.report = {
    findings: world.checks.map((check, index) => ({
      check,
      code: world.expected[index],
      detail: world.documentPath,
      evidenceIds: ["ctx:vault", "ctx:document", ...(check === "preview" ? ["ctx:preview"] : [])],
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
      },
      checks: Object.fromEntries(
        [
          "canonicalDocument",
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
      ["verified-memory-worlds", "export const managedMemoryWorlds = [];"],
      ["onboarding-worlds", "export const managedSetupWorlds = [];"],
      ["checklist-worlds", "export const managedChecklistWorlds = [];"],
      ["grimoire-worlds", "export const managedGrimoireWorlds = [];"],
      ["spectrolite-worlds", "export const managedSpectroliteWorlds = [];"],
      ["news-worlds", "export const managedNewsWorlds = [];"],
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
