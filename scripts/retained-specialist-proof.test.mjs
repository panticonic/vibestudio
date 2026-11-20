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
  const world = { id: "specialist-proof", kind: "specialist-handoff", goal: "Verify the original specialist's result.",
    expected: { action: usable ? "stage" : "hold", history: usable ? true : null } };
  const goal = world.goal;
  const scope = { channelId: "owned", contextId: "context", taskId: "task", parentRevision: "r1" };
  const index = { scope, agents: [{ handle: "events", specialty: "Persisted events", availability: "member", participantId: "worker" }] };
  const snapshots = [{ channelId: scope.channelId, through: 1, rows: [] }, { channelId: scope.channelId, through: 3, rows: [] }];
  const text = "Change the persisted reply event kind.";
  const artifact = usable ? { digest: hash(text), bytes: Buffer.byteLength(text), text } : null;
  const result = usable ? { owner: "packages/agentic-protocol", consumers: ["workers/pubsub-channel"] } : null;
  const observed = { state: "member", participantId: "worker" };
  const request = { goal, channelId: scope.channelId, contextId: scope.contextId, handle: "events", action: "inspect", options: null };
  const membership = usable ? { request, report: { status: "observed", ...observed } } : null;
  const history = usable ? { goal: text, units: { owner: result.owner, consumers: result.consumers, blockers: [] },
    result: { persistedContract: true, retainedHistoryChecks: ["Review retained original events."] } } : null;
  const independent = { handle: usable ? "events" : null, channelId: scope.channelId, taskId: scope.taskId, through: 3,
    artifact, action: world.expected.action };
  const plan = { ...independent, explanation: "Verify the original." };
  const handoffText = usable ? JSON.stringify({ plan, history }) : null;
  const handoff = usable ? { path: "/.tmp/handoff.json", bytes: Buffer.byteLength(handoffText), sha256: hash(handoffText) } : null;
  const proof = {
    caseId: world.id, contextId: scope.contextId, goal, passed: true, index, snapshots, independent, result,
    membershipReads: usable ? [{ request, observed }] : [],
    artifactReads: usable ? [{ message: "original", value: artifact }] : [],
    handoff, artifact: handoffText,
    checks: { exactCurrentSpecialist: true, exactSpecialistFrontiers: true, exactOriginalAttempt: true, verifiedArtifactAndImpact: true,
      exactSpecialistHandoff: true, preservedSpecialistContext: true, rejectedForeignSpecialist: true },
  };
  const report = { status: "workspace-skill-reviewed", skill: "specialistHandoff", outcome: { plan, membership, history, handoff } };
  const calls = [];
  function call(name, options) {
    const record = { call_id: name, definition: { name }, outcome: "done", ...options };
    calls.push({ callId: name, record });
    return record;
  }
  function effect(service, method, args, result) {
    return { service, method, args: ref(args), result: ref(result) };
  }
  const root = call("runUserGoal", { inputs: { goal: ref(goal) } });
  const skill = call("workOnSpecialistHandoffGoal", { parent_call_id: root.call_id, inputs: { goal: ref(goal) } });
  const listing = effect("ownedSpecialistIndex", "list", [], index);
  call("discoverCurrentSpecialists", { effects: [listing] });
  const reads = snapshots.map(snapshot => effect("ownedSpecialistRun", "read", [scope.channelId], snapshot));
  call("readRetainedSpecialistRun", { effects: reads });
  call("chooseCurrentSpecialist", { parent_call_id: skill.call_id, inputs: { goal: ref(goal), index: ref(index) } });
  const joined = call("checkSpecialistReceipt", { parent_call_id: skill.call_id,
    inputs: { scope: ref(scope), snapshot: ref(snapshots[1]), membership: ref(membership?.report ?? null) } });
  call("decideSpecialistHandoff", { parent_call_id: skill.call_id,
    inputs: { goal: ref(goal), current: ref(snapshots[1]) }, output: ref(plan) });
  let inspection;
  let reviewer;
  let original;
  let stage;
  if (usable) {
    const manage = call("manageChannelAgent", { parent_call_id: skill.call_id, inputs: { request: ref(request) },
      output: ref(membership.report) });
    inspection = call("inspect", { parent_call_id: manage.call_id, effects: [effect("channelAgentRead", "read", [request], observed)] });
    call("locateOriginalAttempt", { parent_call_id: joined.call_id });
    call("checkResultIdentity", { parent_call_id: joined.call_id });
    const wrapper = call("reviewSpecialistHistory", { parent_call_id: skill.call_id,
      inputs: { result: ref(result), original: ref(artifact) }, output: ref(history) });
    reviewer = call("reviewHistory", { parent_call_id: wrapper.call_id,
      inputs: { goal: ref(text), units: ref(history.units) }, output: ref(history.result) });
    original = effect("ownedSpecialistArtifact", "read", [scope.channelId, "original"], artifact);
    call("readOriginalSpecialistArtifact", { effects: [original] });
    stage = effect("ownedSpecialistHandoff", "stage", [plan, history], handoff);
    call("stageSpecialistHandoff", { effects: [stage] });
  }
  const execution = { diagnostics: { openGoalVerification: proof }, provenance: { contextId: scope.contextId } };
  return { proof, listing, reads, inspection, reviewer, original, stage, report, validate() {
    skill.output = ref(report.outcome);
    return openTemplateGoalEvidence(execution, { calls, rootCallIds: [root.call_id], report }, world.id, { assignment: world });
  } };
}

test("specialist export authenticates current member, exact original artifact, retained review and local handoff", () => {
  assert.doesNotThrow(fixture(true).validate);
  assert.doesNotThrow(fixture(false).validate);

  const tamper = [
    row => { row.listing.result = row.proof.index; },
    row => { row.reads[1].result = row.reads[0].result; },
    row => { row.inspection.effects[0].result.hash = hash("foreign participant"); },
    row => { row.reviewer.output.complete = false; },
    row => { row.original.args = ref(["owned", "different-result"]); },
    row => { row.report.outcome.membership = { ...row.report.outcome.membership, report: { status: "observed", state: "member", participantId: "foreign" } }; },
    row => { row.stage.args = ref([row.report.outcome.plan, null]); },
    row => { row.proof.artifact += "changed"; },
  ];
  for (const mutate of tamper) {
    const sample = fixture(true);
    mutate(sample);
    assert.throws(sample.validate, /Expected currently observed specialist identity/u);
  }
});
