import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "retained-batch", kind: "log-follower", goal: "Resume the original admitted host log follow." };
const assignment = { id: "owned-watch", goal: world.goal, saved: { boot: "current-boot", seq: 3 }, mayStage: true };
const row = { seq: 5, lane: "owned", request: "current", state: "committed", detail: "retained" };
const duplicateText = { ...row, seq: 9 };
const capture = { boot: assignment.saved.boot, epoch: "watch", opened: true, canceled: true, query: [row], live: [row, duplicateText],
  catchupThrough: 6, witnessedThrough: 10, lastSeen: 10 };
const joined = { continuity: "continued", boot: capture.boot, through: 10, rows: [row, duplicateText], duplicates: [5] };
const finding = { state: "committed", citations: [5, 9] };
const decision = { ...finding, stage: true };
const receipt = { path: "/.tmp/owned/retained-log-follow.json", bytes: 40, sha256: "exact" };
const outcome = { assignment, capture, joined, decision, receipt };
const effects = [
  { service: "logFollowerEvidence", method: "discover", args: [], result: assignment },
  { service: "logFollowerEvidence", method: "observe", args: [assignment.id], result: capture },
  { service: "logFollowerHandoff", method: "stage", args: [assignment.id, joined, decision], result: receipt },
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
  const { assignment, capture, joined, decision, receipt } = outcome;
  const merged = ["continued", "fresh"].includes(joined.continuity);
  return { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "logFollower", outcome },
    calls: [
      node("root", null, "runUserGoal", { goal: world.goal }, outcome),
      node("review", "root", "reviewLogFollower", { goal: world.goal }, outcome),
      node("discover", "review", "discoverLogFollower", {}, assignment, [effects[0]]),
      node("observe", "review", "observeLogFollower", { assignment }, capture),
      node("native", "observe", "readNativeFollow", { assignment }, capture, [effects[1]]),
      node("reconcile", "review", "reconcileLogFollower", { assignment, capture }, joined),
      ...(merged ? [node("merge", "reconcile", "mergeLogRows", { assignment, capture }, joined)] : []),
      node("classify", "review", "classifyLogOperation", { assignment, joined }, decision),
      ...(merged ? [node("effect", "classify", "findCurrentLogEffect", { assignment, rows: joined.rows }, finding)] : []),
      ...(receipt ? [node("stage", "review", "stageLogFollower", { assignment, joined, decision }, receipt, [effects[2]])] : []),
    ] };
}
function run(trace, proofOutcome, proofEffects) {
  return openTemplateGoalEvidence({ provenance: { contextId: "owned" }, diagnostics: { openGoalVerification: {
    caseId: world.id, goal: world.goal, contextId: "owned", ...proofOutcome, effects: proofEffects,
    passed: true, checks: new Proxy({}, { get: () => true }),
  } } }, trace, null, { assignment: world });
}

test("requires both native channels, exact duplicate identity and approved local receipt", () => {
  const exercise = transcript(outcome, effects);
  assert.ok(run(exercise, outcome, effects).checks.verifiedScopedLogFollowReceipt);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad, outcome, effects), /Expected exact native server-log watch/u);
  }
  reject(bad => bad.calls[4].record.parent_call_id = "review");
  reject(bad => bad.calls[4].record.effects[0].args = ref(["different-stream"]));
  reject(bad => bad.calls[6].record.output = ref({ ...joined, duplicates: [9] }));
  reject(bad => bad.calls[8].record.inputs.rows = ref([row]));
  reject(bad => bad.calls[9].record.inputs.joined = ref({ ...joined, boot: "other" }));
  reject(bad => bad.report.outcome.joined.rows.pop());
});
test("keeps a held native watcher without a fabricated join or staged handoff", () => {
  const held = { ...outcome, capture: { ...capture, lastSeen: capture.catchupThrough },
    joined: { continuity: "hold-stream", boot: capture.boot, through: null, rows: [], duplicates: [] },
    decision: { state: "unobserved", citations: [], stage: false }, receipt: null };
  const observed = [effects[0], { ...effects[1], result: held.capture }], exercise = transcript(held, observed);
  assert.ok(run(exercise, held, observed).checks.verifiedClosedBoundedWatch);
  exercise.calls.push(node("unauthorized", "review", "stageLogFollower", { assignment, joined, decision }, receipt, [effects[2]]));
  assert.throws(() => run(exercise, held, observed), /Expected exact native server-log watch/u);
});
