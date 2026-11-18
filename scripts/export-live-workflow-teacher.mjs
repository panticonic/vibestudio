#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const panelWorkflow = {
  family: "workspace-panel-repair",
  namespace: "vibestudio:panel-repair",
  group: "draft-navigation",
  validator: "panel-repair-oracle.ts",
  program: "skills/workspace-dev/panel-repair/repairPanel.nl",
  root: "repairPanel",
  evidence: panelEvidence,
};
const integrationWorkflow = {
  family: "workspace-vcs-integration",
  namespace: "vibestudio:workspace-integration",
  group: "settings-conflict",
  validator: "vcs-integration-oracle.ts",
  program: "skills/vibestudio-vcs/integration/integrateWorkspace.nl",
  root: "integrateWorkspace",
  evidence: integrationEvidence,
};
const unitRepairWorkflow = {
  family: "workspace-unit-repair",
  namespace: "vibestudio:unit-repair",
  group: "worker-label-normalizer",
  validator: "unit-repair-oracle.ts",
  program: "skills/workspace-dev/unit-repair/repairUnit.nl",
  root: "repairUnit",
  evidence: unitRepairEvidence,
};
export const liveTeacherCases = new Map([
  ["worker-label-repair-type-mismatch", unitRepairWorkflow],
  ["worker-label-repair-missing-helper", unitRepairWorkflow],
  ["panel-draft-unmount", panelWorkflow],
  ["panel-draft-stale-snapshot", panelWorkflow],
  ["workspace-integration-theme-locale", integrationWorkflow],
  ["workspace-integration-theme-locale-alias", integrationWorkflow],
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  const bytes = await readFile(file);
  return JSON.parse(file.endsWith(".gz") ? gunzipSync(bytes) : bytes);
}

function panelEvidence(execution, exercise) {
  const diagnostics = execution.diagnostics;
  const baseline = diagnostics.panelDraftBaseline;
  const browser = diagnostics.panelDraftVerification;
  const workspace = diagnostics.workspaceRepoFixture;
  const revisions = diagnostics.panelRepairWorkspace;
  requireEvidence(
    baseline?.checks?.preservesUnsavedDraft === false &&
      browser?.passed === true &&
      Object.values(browser.checks ?? {}).length > 0 &&
      Object.values(browser.checks).every((value) => value === true),
    "The retained browser evidence must show the draft loss before repair and all checks passing after"
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

function integrationEvidence(execution, exercise) {
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

export async function exportLiveTeacherWorkflow({ trajectory, pins, validator, out, split }) {
  const entry = await readJson(trajectory);
  const source = await readJson(pins);
  const { test, result, execution } = entry;
  const workflow = liveTeacherCases.get(test?.name);
  requireEvidence(workflow, "Unsupported live teacher scenario");
  requireEvidence(result?.passed === true && !execution?.error, "The actual system test must pass");
  const exercise = execution?.diagnostics?.natlangTeacher;
  requireEvidence(
    exercise?.trainingEligible === true &&
      !exercise.executionError &&
      !exercise.captureErrors?.length &&
      exercise.programPath === workflow.program &&
      Array.isArray(exercise.calls) &&
      Array.isArray(exercise.rootCallIds) &&
      exercise.rootCallIds.length === 1 &&
      typeof exercise.evalRunId === "string",
    "Missing eligible authored Natlang execution, run identity, or root call"
  );
  const observed = workflow.evidence(execution, exercise);
  const rootId = exercise.rootCallIds[0];
  const captured = exercise.calls;
  const root = captured.find((call) => call.callId === rootId);
  const generationTurns = (call) =>
    (call?.record?.model_turns ?? []).filter((turn) => turn.kind === "generation" && turn.reply);
  requireEvidence(
    root?.record.definition?.name === workflow.root &&
      root.record.parent_call_id === null &&
      generationTurns(root).length > 0 &&
      captured.some((call) => call.callId !== rootId && generationTurns(call).length > 0),
    `Expected the authored ${workflow.root} root and at least one actual child call`
  );
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
  const world = { instance: source.instance, run_id: source.run_id, ...observed.world };
  const validatorBytes = await readFile(validator);
  requireEvidence(
    source.validator_sha256 === hash(validatorBytes),
    "Validator source differs from the run pin"
  );
  await mkdir(out, { mode: 0o700 });
  async function bind(name, data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
    await writeFile(path.join(out, name), bytes, { mode: 0o600, flag: "wx" });
    return { path: name, sha256: hash(bytes) };
  }
  const validatorFile = await bind(workflow.validator, validatorBytes);
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
    source_groups: [`${workflow.namespace}:${workflow.group}`],
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
    },
  });
  for (const option of ["trajectory", "pins", "validator", "out", "split"]) {
    requireEvidence(values[option], `Missing --${option}`);
  }
  const manifest = await exportLiveTeacherWorkflow(values);
  console.log(path.join(values.out, manifest.path));
}
