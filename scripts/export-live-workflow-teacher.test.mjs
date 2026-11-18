import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
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
      ["local-messaging/worlds", "localMessagingWorlds", [{ id: "audience-hold" }]],
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
