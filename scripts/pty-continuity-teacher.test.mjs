import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "owned-attempt", kind: "pty-continuity", goal: "Resume the original terminal output." };
const nominated = { sessionId: "owned-pty", pid: 500, contextId: "owned", checkpoint: { epoch: 0, cursor: 500 }, digest: "known" };
const alternative = { ...nominated, sessionId: "earlier-pty" };
const assignment = { goal: world.goal, nominated, alternative, allowAlternative: false, mayStage: true };
const row = { sessionId: "owned-pty", pid: 500, contextId: "owned", replayDigest: "known", byteAgreement: true, exit: { code: 0, signal: null } };
const evidence = { nominated: row, alternative: null };
const choice = { sessionId: row.sessionId, blocker: null };
const decision = { disposition: "stage-good", replayDigest: "known", exitCode: 0 };
const receipt = { path: "/.tmp/owned/retained-terminal.json", bytes: 75, sha256: "exact" };
const outcome = { assignment, evidence, choice, decision, receipt };
const effects = [
  { service: "ptyContinuityEvidence", method: "discover", args: [], result: assignment },
  { service: "ptyContinuityEvidence", method: "inspect", args: [row.sessionId], result: row },
  { service: "ptyContinuityEvidence", method: "inspect", args: [alternative.sessionId], result: null },
  { service: "ptyContinuityHandoff", method: "stage", args: [row.sessionId, row.replayDigest, decision.disposition], result: receipt },
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
  return { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "ptyContinuity", outcome },
    calls: [
      node("root", null, "runUserGoal", { goal: world.goal }, outcome),
      node("review", "root", "reviewPtyContinuity", { goal: world.goal }, outcome),
      node("discover", "review", "discoverPtyReview", {}, assignment, [effects[0]]),
      node("inspect", "review", "inspectPtyReceipts", { assignment }, evidence),
      node("now", "inspect", "readPtyAttempt", { attempt: nominated }, row, [effects[1]]),
      node("old", "inspect", "readPtyAttempt", { attempt: alternative }, null, [effects[2]]),
      node("choose", "review", "choosePtyGeneration", { assignment, evidence }, outcome.choice),
      node("judge", "review", "judgePtyContinuity", { assignment, evidence, choice: outcome.choice }, outcome.decision),
      ...(outcome.choice.sessionId ? [
        node("frame", "judge", "interpretPtyFrame", { assignment, attempt: nominated, observed: row }, outcome.decision),
      ] : []),
      ...(outcome.receipt ? [node("stage", "review", "stagePtyReceipt", { observed: row, decision: outcome.decision },
        outcome.receipt, [effects[3]])] : []),
    ] };
}
function run(trace, proofOutcome, proofEffects) {
  return openTemplateGoalEvidence({ provenance: { contextId: "owned" }, diagnostics: { openGoalVerification: {
    caseId: world.id, goal: world.goal, contextId: "owned", ...proofOutcome, effects: proofEffects,
    passed: true, checks: new Proxy({}, { get: () => true }),
  } } }, trace, null, { assignment: world });
}

test("captures the exact owned nested terminal observation and scratch receipt", () => {
  const exercise = transcript(outcome, effects);
  assert.ok(run(exercise, outcome, effects).checks.verifiedScopedTerminalReceipt);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad, outcome, effects), /Expected exact owned retained terminal/u);
  }
  reject(bad => bad.calls[4].record.parent_call_id = "review");
  reject(bad => bad.calls[5].record.inputs.attempt = ref(nominated));
  reject(bad => bad.calls[8].record.inputs.observed = ref({ ...row, pid: 501 }));
  reject(bad => bad.calls[9].record.effects[0].args = ref([row.sessionId, "stale", decision.disposition]));
  reject(bad => bad.report.outcome.evidence.nominated.exit.code = 1);
});
test("retains a missing generation as a hold without a fabricated output or stage effect", () => {
  const held = { ...outcome, choice: { sessionId: null, blocker: "hold-generation" },
    decision: { disposition: "hold-generation", replayDigest: null, exitCode: null }, receipt: null };
  const observed = effects.slice(0, 3), exercise = transcript(held, observed);
  assert.ok(run(exercise, held, observed).checks.verifiedCursorAndExitClassification);
  exercise.calls.push(node("unapproved", "review", "stagePtyReceipt", { observed: row, decision }, receipt, [effects[3]]));
  assert.throws(() => run(exercise, held, observed), /Expected exact owned retained terminal/u);
});
