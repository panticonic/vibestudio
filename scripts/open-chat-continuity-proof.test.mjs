import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const text = JSON.stringify(value);
  return { complete: true, hash: hash(text), bytes: Buffer.byteLength(text) };
}
function fixture(status, write) {
  const world = { id: "chat-proof", kind: "chat-continuity", goal: "Recover our release discussion in the current room.", status };
  const channelId = "active-room";
  const receipt = { channelId, messageId: "message-123", text: "Review the release evidence.", senderId: "owner" };
  const row = { id: receipt.messageId, sender: receipt.senderId, text: receipt.text };
  const index = { scopes: [{ id: channelId }, { id: "archived-room" }], original: receipt };
  const plan = { channelId, requireWorker: true, note: write ? "continuity.json" : null };
  const opening = { channelId, through: 1, receipt, rows: [row], worker: { participantId: "original" } };
  const current = { ...opening, through: 3, worker: { participantId: status === "held" ? "replacement" : "original" } };
  const request = { kind: "delivery", goal: world.goal, channelId, replayMeaningMatches: status !== "held" };
  const review = { status: status === "held" ? "held" : "delivered" };
  const evidence = { request, review };
  const decision = { status, write, explanation: "Review matched the retained chat context." };
  const artifact = write ? JSON.stringify({ scope: "private-local", current, evidence }) : null;
  const handoff = artifact ? { digest: hash(artifact), messageId: receipt.messageId, channelId, through: current.through } : null;
  const checks = Object.fromEntries(["exactOwnedChatSelection", "exactChatFrontiers", "independentDurableChatReceipt",
    "exactFirstPartyChatProjection", "exactNativeChatWorker", "groundedChatDeliveryReview", "groundedChatContinuityDisposition",
    "verifiedPrivateChatHandoff", "preservedChatWorkspace", "rejectedChatRetarget"].map(check => [check, true]));
  const proof = { caseId: world.id, goal: world.goal, contextId: "owned", passed: true, checks, index, plan,
    frames: [opening, current], evidence, decision, handoff, artifact };
  const outcome = { plan, opening, current, evidence, disposition: decision, handoff };
  const report = { status: "workspace-skill-reviewed", skill: "chatContinuity", outcome };
  const calls = [];
  function node(name, parent, fields = {}) {
    const record = { call_id: String(calls.length), parent_call_id: parent?.call_id, definition: { name }, outcome: "done", ...fields };
    calls.push({ callId: record.call_id, record });
    return record;
  }
  const root = node("runUserGoal", null, { inputs: { goal: ref(world.goal) } });
  const skill = node("workOnChatContinuity", root, { inputs: { goal: ref(world.goal) }, output: ref(outcome) });
  function effect(name, service, method, args, result) {
    const event = { service, method, args: ref(args), result: ref(result) };
    node(name, skill, { effects: [event] });
    return event;
  }
  const listed = effect("discoverChatContinuity", "chatContinuityIndex", "list", [], index);
  node("chooseChatContinuity", skill, { inputs: { goal: ref(world.goal), index: ref(index) }, output: ref(plan) });
  const reads = proof.frames.map(frame => effect("observeChatContinuity", "chatContinuityState", "read", [channelId], frame));
  const reviewed = node("reviewChatContinuity", skill, { inputs: {
    goal: ref(world.goal), index: ref(index), plan: ref(plan), opening: ref(opening), current: ref(current),
  }, output: ref(evidence) });
  const installed = node("reviewConversation", reviewed, { inputs: { request: ref(request) }, output: ref(review) });
  const child = node("reviewDelivery", installed);
  node("decideChatContinuity", skill, { inputs: {
    goal: ref(world.goal), plan: ref(plan), opening: ref(opening), current: ref(current), evidence: ref(evidence),
  }, output: ref(decision) });
  const staged = handoff && effect("stageChatContinuityNote", "chatContinuityHandoff", "stage", [{ ...outcome, handoff: null }], handoff);
  return { proof, reads, listed, installed, child, staged, validate() {
    return openTemplateGoalEvidence({ diagnostics: { openGoalVerification: proof }, provenance: { contextId: "owned" } },
      { report, calls, rootCallIds: [root.call_id] }, world.id, { assignment: world });
  }};
}

test("chat export binds both first-party frontiers, the installed review and the exact private note", () => {
  for (const branch of [["ready", true], ["held", true], ["held", false], ["ready", false]]) {
    assert.doesNotThrow(fixture(...branch).validate);
  }
  for (const change of [
    x => { x.listed.result.complete = false; },
    x => { x.reads[1].result = x.reads[0].result; },
    x => { x.reads[1].args = ref(["archived-room"]); },
    x => { x.installed.inputs.request = ref({ kind: "delivery", replayMeaningMatches: false }); },
    x => { x.installed.output = x.proof.evidence.review; },
    x => { x.child.parent_call_id = "unrelated"; },
    x => { x.staged.result.hash = hash("other receipt"); },
    x => { x.proof.artifact += " "; },
  ]) {
    const entry = fixture("ready", true);
    change(entry);
    assert.throws(entry.validate, /Expected exact first-party chat/u);
  }
});
