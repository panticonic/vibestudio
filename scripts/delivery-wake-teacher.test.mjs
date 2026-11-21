import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "native-owned-wake", kind: "delivery-wake", goal: "Recover the exact original approved delivery." };
const assignment = { id: "owned-task", goal: world.goal, channel: "lane", recipient: "exact-receiver", revision: 5, saved: 40,
  request: "inspection", kind: "terminal", mayWake: true };
const event = { id: "exact-event", sequence: 42, name: assignment.request, kind: assignment.kind, recipients: [assignment.recipient] };
const pending = { recipient: assignment.recipient, revision: assignment.revision, after: 40, through: 42 };
const evidence = { connection: { channel: assignment.channel, context: "owned", ready: true, firstRejected: true, attempts: 2, admittedSurfaces: 1 },
  current: { id: assignment.recipient, revision: assignment.revision, active: true, attached: true }, cursor: 43, pending,
  rangeComplete: true, events: [event], mailbox: [], contextRows: 0, contextCopies: 0 };
const choice = { disposition: "advance", event };
const receipt = { event: event.id, deliveryId: "one-original-row", revision: 5, cursor: 43, newRows: 1, repeatRows: 0, contextRows: 1, contextCopies: 0 };
const outcome = { assignment, evidence, choice, receipt };
const effects = [
  { service: "deliveryWakeEvidence", method: "discover", args: [], result: assignment },
  { service: "deliveryWakeEvidence", method: "observe", args: [assignment.id], result: evidence },
  { service: "deliveryWakeAction", method: "apply", args: [assignment.id, event.id, pending], result: receipt },
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
  const { assignment, evidence, choice, receipt } = outcome;
  const match = evidence.rangeComplete && evidence.connection.ready;
  return { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "deliveryWake", outcome },
    calls: [
      node("root", null, "runUserGoal", { goal: world.goal }, outcome),
      node("review", "root", "reviewDeliveryWake", { goal: world.goal }, outcome),
      node("discover", "review", "discoverDeliveryWake", {}, assignment, [effects[0]]),
      node("observe", "review", "inspectDeliveryWake", { assignment }, evidence),
      node("native", "observe", "readNativeWake", { assignment }, evidence, [effects[1]]),
      node("choose", "review", "decideDeliveryWake", { assignment, evidence }, choice),
      ...(match ? [node("match", "choose", "matchDeliveryWakeEvent", { assignment, evidence }, { event, mailbox: null })] : []),
      ...(receipt ? [node("apply", "review", "applyDeliveryWake", { assignment, evidence, choice }, receipt, [effects[2]])] : []),
    ] };
}
function run(trace, proofOutcome, proofEffects) {
  return openTemplateGoalEvidence({ provenance: { contextId: "owned" }, diagnostics: { openGoalVerification: {
    caseId: world.id, goal: world.goal, contextId: "owned", ...proofOutcome, effects: proofEffects,
    passed: true, checks: new Proxy({}, { get: () => true }),
  } } }, trace, null, { assignment: world });
}

test("requires native reconnect and exact bound event before a single recovery", () => {
  const exercise = transcript(outcome, effects);
  assert.ok(run(exercise, outcome, effects).checks.verifiedUniqueNormalizedMailbox);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad, outcome, effects), /Expected exact owned native reconnect/u);
  }
  reject(bad => bad.calls[4].record.parent_call_id = "review");
  reject(bad => bad.calls[6].record.output = ref({ event: { ...event, recipients: ["other"] }, mailbox: null }));
  reject(bad => bad.calls[7].record.effects[0].args = ref([assignment.id, event.id, { ...pending, revision: 4 }]));
  reject(bad => bad.report.outcome.evidence.connection.admittedSurfaces = 2);
  reject(bad => bad.report.outcome.receipt.repeatRows = 1);
});
test("keeps a gapped history on hold without a fabricated subscriber conclusion", () => {
  const held = { ...outcome, evidence: { ...evidence, rangeComplete: false }, choice: { disposition: "hold-evidence", event: null }, receipt: null };
  const observed = [effects[0], { ...effects[1], result: held.evidence }], exercise = transcript(held, observed);
  assert.ok(run(exercise, held, observed).checks.verifiedSameReceiverCursor);
  exercise.calls.push(node("unauthorized", "review", "applyDeliveryWake", { assignment, evidence, choice }, receipt, [effects[2]]));
  assert.throws(() => run(exercise, held, observed), /Expected exact owned native reconnect/u);
});
