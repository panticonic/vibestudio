#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const supportedCases = new Set(["panel-draft-unmount", "panel-draft-stale-snapshot"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  const bytes = await readFile(file);
  return JSON.parse(file.endsWith(".gz") ? gunzipSync(bytes) : bytes);
}

export async function exportLivePanelTeacher({ trajectory, pins, validator, out, split }) {
  const entry = await readJson(trajectory);
  const source = await readJson(pins);
  const { test, result, execution } = entry;
  const diagnostics = execution?.diagnostics;
  const exercise = diagnostics?.natlangTeacher;
  const baseline = diagnostics?.panelDraftBaseline;
  const browser = diagnostics?.panelDraftVerification;
  const workspace = diagnostics?.workspaceRepoFixture;
  const revisions = diagnostics?.panelRepairWorkspace;
  requireEvidence(supportedCases.has(test?.name), "Unsupported panel repair scenario");
  requireEvidence(result?.passed === true && !execution.error, "The actual system test must pass");
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
    exercise?.report?.status === "verified" &&
      typeof exercise.report.revision === "string" &&
      exercise.programPath === "skills/workspace-dev/panel-repair/repairPanel.nl" &&
      revisions?.before &&
      revisions?.after &&
      exercise.report.revision === JSON.stringify(revisions.after) &&
      JSON.stringify(revisions.before) !== JSON.stringify(revisions.after) &&
      Array.isArray(exercise.calls) &&
      Array.isArray(exercise.rootCallIds) &&
      exercise.rootCallIds.length === 1 &&
      typeof exercise.evalRunId === "string",
    "Missing actual authored Natlang repair report, run identity, or root call"
  );
  const rootId = exercise.rootCallIds[0];
  const captured = exercise.calls;
  const root = captured.find((call) => call.callId === rootId);
  const generationTurns = (call) =>
    (call?.record?.model_turns ?? []).filter((turn) => turn.kind === "generation" && turn.reply);
  requireEvidence(
    root?.record.definition?.name === "repairPanel" &&
      root.record.parent_call_id === null &&
      generationTurns(root).length > 0 &&
      captured.some((call) => call.callId !== rootId && generationTurns(call).length > 0),
    "Expected the authored repairPanel root and at least one actual child call"
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

  const taskId = `vibestudio:panel-repair:${test.name}`;
  const world = {
    instance: source.instance,
    run_id: source.run_id,
    context_id: workspace.contextId,
    seed_revision: workspace.taskBaseEventId,
  };
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
  const validatorFile = await bind("panel-repair-oracle.ts", validatorBytes);
  const workspaceFile = await bind("workspace.json", {
    fixture: workspace,
    revisions,
    verifiedRevision: exercise.report.revision,
    browserBinding: browser.browserBinding,
    pins: source,
  });
  const browserFile = await bind("cdp.json", { baseline, candidate: browser });
  const calls = [];
  for (const [index, call] of captured.entries())
    calls.push(await bind(`call-${index}.json`, call));
  const verification = await bind("verification.json", {
    schema: "natlang.live-task-verification/1",
    task_id: taskId,
    run_id: source.run_id,
    world,
    status: "passed",
    checks: browser.checks,
    validator: validatorFile,
    root_call_ids: [rootId],
    calls: captured.map(({ callId, summary }) => ({
      call_id: callId,
      owner_kind: summary.owner_kind,
      owner_key: summary.owner_key,
      run_id: summary.run_id,
    })),
    evidence: [
      { kind: "workspace", ...workspaceFile },
      { kind: "cdp", ...browserFile },
    ],
  });
  return bind("manifest.json", {
    schema: "natlang.live-teacher-task/1",
    id: taskId,
    family: "workspace-panel-repair",
    split,
    source_namespace: "vibestudio:panel-repair",
    source_ids: [taskId],
    source_groups: ["vibestudio:panel-repair:draft-navigation"],
    source_revisions: sourceRevisions,
    code,
    learner_kinds: ["natlang-executor"],
    world,
    required_effect_kinds: ["workspace", "cdp"],
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
  const manifest = await exportLivePanelTeacher(values);
  console.log(path.join(values.out, manifest.path));
}
