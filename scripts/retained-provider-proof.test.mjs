import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const json = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(json), hash: hash(json) };
}
function effect(service, method, args, result) {
  return { service, method, args: ref(args), result: ref(result) };
}
function fixture(ready) {
  const world = { id: "provider-proof", kind: "provider-handoff", goal: "Check the original proof.", expected: { stage: ready } };
  const request = { id: "approval", provider: "proof", operation: "read", audience: "editors", revision: "r1" };
  const card = { channelId: "owned", request, viewer: "linked-agent" };
  const queue = { source: "workspace", kind: "snapshot", ids: [] };
  const observed = { coverage: "complete", surfaces: [{ source: "workspace", state: "visible", ids: [] }],
    location: { status: "absent", source: null } };
  const earlier = { channelId: card.channelId, through: 1, rows: [{ record: { kind: "queue", receipt: queue } }] };
  const text = "Original proof retained";
  const digest = hash(text);
  const current = ready ? { ...earlier, through: 2, rows: [...earlier.rows, {
    messageId: "original", record: { kind: "result", request, state: "committed", digest },
  }] } : earlier;
  const output = ready ? { digest, sha256: digest, text, bytes: Buffer.byteLength(text) } : null;
  const plan = { channelId: card.channelId, through: current.through, requestId: request.id,
    disposition: ready ? "ready" : "held", resultMessage: ready ? "original" : null, output };
  const approval = {
    request: { goal: world.goal, caller: card.viewer, approvalId: request.id, earlier: [queue], later: [queue] },
    result: { transition: "not-listed", earlier: observed, later: observed },
  };
  const delivery = {
    request: { kind: "delivery", goal: world.goal, channelId: card.channelId, channelAccepted: ready,
      originMatched: ready, durableCount: Number(ready), recipientsResolved: ready, membershipVerified: ready,
      replayMeaningMatches: ready, settlement: ready ? "delivered" : "pending", accountedRetry: false },
    result: { kind: "delivery", basis: card.channelId, ready,
      blockers: ready ? [] : ["accepted", "origin", "durable-count", "replay", "membership", "addressing", "settlement"] },
  };
  const artifact = ready ? JSON.stringify({ request, output }) : null;
  const handoff = artifact && { path: "/.tmp/handoff.json", bytes: Buffer.byteLength(artifact), sha256: hash(artifact) };
  const listedCards = [card];
  const proof = { card, listedCards, snapshots: [earlier, current], outputs: ready ? [{ message: "original", result: output }] : [],
    expectedTransition: "not-listed", handoff, artifact };
  const calls = [];
  function add(name, details) {
    const record = { definition: { name }, call_id: name, outcome: "done", ...details };
    calls.push({ callId: record.call_id, record });
    return record;
  }
  const root = add("runUserGoal", { inputs: { goal: ref(world.goal) } });
  const skill = add("workOnProviderHandoffGoal", { parent_call_id: root.call_id, inputs: { goal: ref(world.goal) } });
  const listing = effect("retainedConversationIndex", "list", [], listedCards);
  add("discoverRetainedConversations", { effects: [listing] });
  add("readProviderConversation", { effects: [earlier, current].map(snapshot =>
    effect("retainedConversationState", "read", [card.channelId], snapshot)) });
  const bind = (wrapper, reviewer, review) => {
    add(wrapper, { parent_call_id: skill.call_id, output: ref(review) });
    return add(reviewer, { parent_call_id: wrapper, inputs: { request: ref(review.request) }, output: ref(review.result) });
  };
  const approvalCall = bind("reviewRetainedApproval", "reviewApprovalTransition", approval);
  const deliveryCall = bind("reviewRetainedDelivery", "reviewConversation", delivery);
  const readback = ready ? effect("retainedProviderOutput", "read", [card.channelId, "original"], output) : null;
  if (readback) add("readProviderOutput", { effects: [readback] });
  if (ready) add("stageProviderHandoff", { effects: [effect("retainedProviderHandoff", "stage", [plan], handoff)] });

  const exercise = { calls, rootCallIds: [root.call_id],
    report: { status: "workspace-skill-reviewed", skill: "providerHandoff", outcome: { plan, handoff, reviews: { approval, delivery } } } };
  const contextId = "owned-workspace";
  Object.assign(proof, { passed: true, goal: world.goal, caseId: world.id, contextId, checks: {
    exactApprovalVisibility: true, discoveredOwnedConversation: true, exactRetainedProviderFrontier: true,
    exactProviderAttributionAndResult: true, independentProviderOutput: true, exactScopedHandoff: true,
    protectedOwnedProviderWorkspace: true, rejectedUnownedEvidence: true,
  } });
  const execution = { diagnostics: { openGoalVerification: proof }, provenance: { contextId } };
  return { proof, exercise, approvalCall, deliveryCall, listing, readback, validate() {
    skill.output = ref(exercise.report.outcome);
    return openTemplateGoalEvidence(execution, exercise, world.id, { assignment: world });
  } };
}

test("retained provider proof authenticates complete references and independently scoped values", () => {
  assert.doesNotThrow(fixture(true).validate);
  assert.doesNotThrow(fixture(false).validate);

  const altered = [
    ({ listing, proof }) => { listing.result = proof.listedCards; },
    ({ approvalCall }) => { approvalCall.inputs.request.complete = false; },
    ({ deliveryCall }) => { deliveryCall.output.hash = hash("foreign delivery"); },
    ({ exercise, approvalCall }) => {
      const witness = exercise.report.outcome.reviews.approval;
      witness.request.caller = "device-account";
      approvalCall.inputs.request = ref(witness.request);
      exercise.calls.find(({ record }) => record.call_id === "reviewRetainedApproval").record.output = ref(witness);
    },
    ({ readback }) => { readback.args = ref(["owned", "different-message"]); },
    ({ proof }) => { proof.artifact += "\nForged bytes"; },
  ];
  for (const mutate of altered) {
    const sample = fixture(true);
    mutate(sample);
    assert.throws(sample.validate, /Expected exact retained native conversation snapshots/u);
  }
});
