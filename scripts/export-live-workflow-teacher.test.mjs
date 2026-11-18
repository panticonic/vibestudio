import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { exportLiveTeacherWorkflow } from "./export-live-workflow-teacher.mjs";

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
});
