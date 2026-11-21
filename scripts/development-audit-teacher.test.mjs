import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "exact-checkpoint", kind: "development-audit", goal: "Review the interrupted retained development build." };
const assignment = { goal: world.goal, requested: "requested-run", alternate: "alternate-run", approval: "exact-snapshot" };
const row = { id: assignment.requested, snapshot: assignment.approval, updatedAt: 200, state: "requires-repair",
  journal: [{ sequence: 3, kind: "diagnostic", code: "CHECKPOINT", snapshot: assignment.approval }] };
const observed = { requested: row, alternate: null };
const choice = { runId: row.id, blocker: null };
const assessment = { disposition: "keep-repair", decisiveSequences: [3] };
const receipt = { runId: row.id, snapshot: row.snapshot, updatedAt: 201, sequence: 4, attention: "kept" };
const outcome = { assignment, observed, choice, assessment, receipt };
const effects = [
  { service: "developmentAuditEvidence", method: "discover", args: [], result: assignment },
  { service: "developmentAuditEvidence", method: "read", args: [row.id], result: row },
  { service: "developmentAuditEvidence", method: "read", args: [assignment.alternate], result: null },
  { service: "developmentAuditKeep", method: "keep", args: [row.id, row.snapshot, row.updatedAt], result: receipt },
];
const ref = value => {
  const text = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex") };
};
function node(id, parent, name, inputs, output, receipts = []) {
  return { callId: id, record: { parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
    output: ref(output), effects: receipts.map(({ args, result, ...rest }) => ({ ...rest, args: ref(args), result: ref(result) })) } };
}
function transcript(outcome, effects) {
  return { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "developmentAudit", outcome },
    calls: [
      node("root", null, "runUserGoal", { goal: world.goal }, outcome),
      node("review", "root", "reviewDevelopmentAudit", { goal: world.goal }, outcome),
      node("discover", "review", "discoverDevelopmentAudit", {}, assignment, [effects[0]]),
      node("inspect", "review", "inspectDevelopmentRuns", { assignment }, observed),
      node("current", "inspect", "readDevelopmentRun", { id: row.id }, row, [effects[1]]),
      node("alternate", "inspect", "readDevelopmentRun", { id: assignment.alternate }, null, [effects[2]]),
      node("choose", "review", "chooseDevelopmentRun", { assignment, observed }, outcome.choice),
      node("assess", "review", "assessDevelopmentRepair", { assignment, observed, choice: outcome.choice }, outcome.assessment),
      ...(outcome.choice.runId ? [node("checkpoint", "assess", "assessRetainedCheckpoint", { assignment, run: row }, outcome.assessment)] : []),
      ...(outcome.receipt ? [node("keep", "review", "keepDevelopmentRepair", { run: row }, outcome.receipt, [effects[3]])] : []),
    ] };
}
function run(trace, proofOutcome, proofEffects) {
  return openTemplateGoalEvidence({ provenance: { contextId: "owned-context" }, diagnostics: { openGoalVerification: {
    caseId: world.id, goal: world.goal, contextId: "owned-context", ...proofOutcome, effects: proofEffects,
    passed: true, checks: new Proxy({}, { get: () => true }),
  } } }, trace, null, { assignment: world });
}

test("captures native run ownership, exact nested cursor evidence and approved keep receipt", () => {
  const exercise = transcript(outcome, effects);
  assert.ok(run(exercise, outcome, effects).checks.verifiedOwnedRepairTransition);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad, outcome, effects), /Expected exact owned native development journal/u);
  }
  reject(bad => bad.calls[2].record.effects[0].method = "read");
  reject(bad => bad.calls[4].record.parent_call_id = "review");
  reject(bad => bad.calls[5].record.inputs.id = ref(row.id));
  reject(bad => bad.calls[8].record.inputs.run = ref({ ...row, updatedAt: 100 }));
  reject(bad => bad.calls[9].record.effects[0].args = ref([row.id, row.snapshot, 100]));
  reject(bad => bad.report.outcome.observed.requested.journal[0].sequence = 11);
});
test("records a hold without invented checkpoint policy call or mutation effects when approval has drifted", () => {
  const held = { ...outcome, choice: { runId: null, blocker: "hold-stale-approval" },
    assessment: { disposition: "hold-stale-approval", decisiveSequences: [] }, receipt: null };
  const evidence = effects.slice(0, 3), exercise = transcript(held, evidence);
  assert.ok(run(exercise, held, evidence).checks.matchedRepairReadiness);
  exercise.calls.push(node("unapproved-keep", "review", "keepDevelopmentRepair", { run: row }, receipt, [effects[3]]));
  assert.throws(() => run(exercise, held, evidence), /Expected exact owned native development journal/u);
});
