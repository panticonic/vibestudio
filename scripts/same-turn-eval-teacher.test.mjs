import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "same-task-after-timeout", kind: "same-turn-eval", goal: "Recover the accepted current result." };
const assignment = { id: "owned-task", goal: world.goal, request: "current", revision: "accepted" };
const observation = { request: assignment.request, revision: assignment.revision, count: 12, detail: "one held row" };
const evidence = { runId: "native-attempt", scopeId: "current-scope", status: "timed-out", failureCode: "eval_deadline_exceeded",
  checkpoint: { request: observation.request, revision: observation.revision, complete: true, digest: "exact" } };
const pick = { decision: "checkpoint", reason: "complete-checkpoint" };
const recovery = { observation, scopeId: evidence.scopeId, resultDigest: "exact", recoveryRun: null, pages: 1 };
const outcome = { assignment, evidence, pick, recovery };
const effects = [
  { service: "sameTurnEvalEvidence", method: "discover", args: [], result: assignment },
  { service: "sameTurnEvalEvidence", method: "observe", args: [assignment.id], result: evidence },
  { service: "sameTurnEvalRecovery", method: "resolve", args: [assignment.id, evidence.runId, pick.decision], result: recovery },
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
  const { assignment, evidence, pick, recovery } = outcome;
  const selected = ["checkpoint", "window", "compact"].includes(pick.decision) ? pick : null;
  return { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "sameTurnEval", outcome },
    calls: [
      node("root", null, "runUserGoal", { goal: world.goal }, outcome),
      node("review", "root", "recoverSameTurnEval", { goal: world.goal }, outcome),
      node("discover", "review", "discoverSameTurnEval", {}, assignment, [effects[0]]),
      node("inspect", "review", "inspectSameTurnEval", { assignment }, evidence),
      node("read", "inspect", "readNativeEvalState", { assignment }, evidence, [effects[1]]),
      node("choose", "review", "chooseSameTurnRecovery", { assignment, evidence }, pick),
      node("candidates", "choose", "examineEvalCandidates", { assignment, evidence }, selected),
      ...(recovery ? [node("resolved", "review", "resolveSameTurnEval", { assignment, evidence, pick }, recovery, [effects[2]])] : []),
    ] };
}
function run(trace, proofOutcome, proofEffects) {
  return openTemplateGoalEvidence({ provenance: { contextId: "owned" }, diagnostics: { openGoalVerification: {
    caseId: world.id, goal: world.goal, contextId: "owned", ...proofOutcome, effects: proofEffects,
    passed: true, checks: new Proxy({}, { get: () => true }),
  } } }, trace, null, { assignment: world });
}

test("captures the original owned failure and exact useful recovery without a second eval", () => {
  const exercise = transcript(outcome, effects);
  assert.ok(run(exercise, outcome, effects).checks.verifiedUsefulResultAndBoundedRetry);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad, outcome, effects), /Expected exact owned EvalDO recovery/u);
  }
  reject(bad => bad.calls[4].record.parent_call_id = "review");
  reject(bad => bad.calls[6].record.output = ref({ decision: "compact", reason: "clean-return" }));
  reject(bad => bad.calls[7].record.effects[0].args = ref([assignment.id, "old-attempt", pick.decision]));
  reject(bad => bad.report.outcome.recovery.observation.revision = "stale");
  reject(bad => bad.report.outcome.recovery.recoveryRun = "unnecessary");
});
test("accepts a hold without inventing later work when only a partial checkpoint survived", () => {
  const held = { ...outcome, pick: { decision: "held", reason: "partial-checkpoint" }, recovery: null };
  const observed = effects.slice(0, 2), exercise = transcript(held, observed);
  assert.ok(run(exercise, held, observed).checks.preservedExactOwnedScope);
  exercise.calls.push(node("unapproved", "review", "resolveSameTurnEval", { assignment, evidence, pick }, recovery, [effects[2]]));
  assert.throws(() => run(exercise, held, observed), /Expected exact owned EvalDO recovery/u);
});
