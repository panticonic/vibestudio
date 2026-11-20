import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const bytes = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(bytes), hash: hash(bytes) };
}
function fixture(usable) {
  const world = { id: "dictation-proof", kind: "dictation-handoff", goal: "Verify the retained wording.",
    expected: { action: usable ? "stage-correction" : "hold" } };
  const thread = { threadId: "current", draftId: "draft", baseline: "r1" };
  const capture = { kind: "capture", captureId: "take" };
  const acknowledgment = { kind: "acknowledgment", captureId: "take" };
  const snapshots = [{ threadId: "current", through: 1, rows: [] }, { threadId: "current", through: 3, rows: [
    { messageId: "capture", record: capture }, { messageId: "ack", record: acknowledgment },
  ] }];
  const transcript = usable ? { text: "Check the second entrance", language: "en", model: "whistle" } : null;
  const exactDraft = usable ? { status: "draft", text: transcript.text } : null;
  const independent = { threadId: thread.threadId, draftId: thread.draftId, through: 3, captureId: "take",
    segmentMessages: usable ? ["segment-1"] : [], draftRevision: "r1", acknowledgementMessage: "ack",
    transcript, action: world.expected.action, reason: usable ? "verified" : "language-conflict" };
  const plan = { ...independent, explanation: "Review the retained evidence." };
  const review = usable ? { transcript, presentation: "verbatim", goal: world.goal, result: exactDraft } : null;
  const artifact = usable ? JSON.stringify({ transcript }) : null;
  const handoff = usable ? { path: "/.tmp/handoff.json", bytes: Buffer.byteLength(artifact), sha256: hash(artifact) } : null;
  const proof = {
    caseId: world.id, contextId: "owned", goal: world.goal, passed: true, thread, listed: [thread], snapshots,
    independent, exactDraft, artifact, handoff,
    checks: { exactOwnedDictation: true, verifiedDictationFrontiers: true, exactDictationSelection: true,
      exactInstalledDraft: true, verifiedLocalCorrection: true, preservedDraftAndMain: true, rejectedForeignDictation: true },
  };
  const report = { status: "workspace-skill-reviewed", skill: "dictationHandoff", outcome: { plan, review, handoff } };
  const calls = [];
  function record(name, options) {
    const call = { call_id: name, definition: { name }, outcome: "done", ...options };
    calls.push({ callId: name, record: call });
    return call;
  }
  function effect(service, method, args, result) {
    return { service, method, args: ref(args), result: ref(result) };
  }
  const root = record("runUserGoal", { inputs: { goal: ref(world.goal) } });
  const skill = record("workOnDictationHandoffGoal", { parent_call_id: root.call_id, inputs: { goal: ref(world.goal) } });
  const listed = effect("retainedDictationIndex", "list", [], proof.listed);
  record("discoverDictationThreads", { effects: [listed] });
  const reads = snapshots.map(snapshot => effect("retainedDictationState", "read", [thread.threadId], snapshot));
  record("readDictationThread", { effects: reads });
  const scoped = { thread: ref(thread), current: ref(snapshots[1]) };
  const reconcile = record("reconcileDictationSegments", { parent_call_id: skill.call_id,
    inputs: { ...scoped, goal: ref(world.goal), earlier: ref(snapshots[0]) } });
  const origin = record("resolveDictationProvenance", { parent_call_id: reconcile.call_id, inputs: scoped });
  if (usable) record("assembleAcknowledgedText", { parent_call_id: reconcile.call_id,
    inputs: { ...scoped, capture: ref(capture), acknowledgment: ref(acknowledgment) } });
  record("decideDictationHandoff", { parent_call_id: skill.call_id,
    inputs: { ...scoped, goal: ref(world.goal), review: ref(review) }, output: ref(plan) });
  let prepared;
  let stage;
  if (review) {
    const reviewer = record("reviewRetainedDictation", { parent_call_id: skill.call_id,
      inputs: { goal: ref(world.goal), transcript: ref(transcript) }, output: ref(review) });
    prepared = record("prepareDraft", { parent_call_id: reviewer.call_id,
      inputs: { capturedText: ref(transcript), presentation: ref("verbatim"), goal: ref(world.goal) }, output: ref(exactDraft) });
    stage = effect("retainedDictationHandoff", "stage", [plan, exactDraft], handoff);
    record("stageDictationCorrection", { effects: [stage] });
  }
  const execution = { diagnostics: { openGoalVerification: proof }, provenance: { contextId: proof.contextId } };
  const exercise = { calls, rootCallIds: [root.call_id], report };
  return { proof, report, listed, origin, prepared, reads, stage, validate() {
    skill.output = ref(report.outcome);
    return openTemplateGoalEvidence(execution, exercise, world.id, { assignment: world });
  } };
}

test("retained dictation proof binds native receipts and installed transcript review through ValueRefs", () => {
  assert.doesNotThrow(fixture(true).validate);
  assert.doesNotThrow(fixture(false).validate);
  const mutations = [
    row => { row.listed.result = row.proof.listed; },
    row => { row.reads[1].result = row.reads[0].result; },
    row => { row.origin.parent_call_id = "different-reconciler"; },
    row => { row.prepared.inputs.capturedText.complete = false; },
    row => { row.prepared.inputs.presentation = ref("punctuated"); },
    row => { row.report.outcome.review = { ...row.report.outcome.review, goal: "A different goal" }; },
    row => { row.stage.args = ref([row.report.outcome.plan, { status: "draft", text: "Changed before stage" }]); },
    row => { row.proof.artifact += "tampered"; },
  ];
  for (const mutate of mutations) {
    const sample = fixture(true);
    mutate(sample);
    assert.throws(sample.validate, /Expected exact native dictation frontiers/u);
  }
});
