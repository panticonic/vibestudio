import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "source", kind: "transcript-surface", goal: "Retire the approved shift controls without touching the transcript card." };
const assignment = { id: "owned", channel: "thread", goal: world.goal, subject: "current controls", revision: "current", mayPublish: true };
const card = { title: "current controls", detail: "finished", status: "retired" };
const approval = { id: "approved", channel: "thread", subject: assignment.subject, revision: "current", approved: true, mode: "clear", key: "control", card, source: "exact" };
const approvals = [approval];
const replay = { channel: "thread", owner: "publisher", cursor: 4, card: null,
  bar: { key: "control", card, owner: "publisher", sequence: 4, envelope: "old", cleared: false } };
const selection = { approval, blocker: null };
const effect = "clear-bar", decision = { effect, reason: "ready" };
const receipt = { channel: "thread", basis: 4, status: "applied", envelope: "clear-envelope", sequence: 5 };
const outcome = { assignment, approvals, selection, replay, decision, receipt };
const discovered = { service: "transcriptApproval", method: "discover", args: [], result: assignment };
const listed = { service: "transcriptApproval", method: "list", args: [assignment.id], result: approvals };
const read = { service: "transcriptObservation", method: "replay", args: [assignment.id, approval.id], result: replay };
const applied = { service: "transcriptMutation", method: "apply", args: [assignment.id, approval.id, replay.cursor, effect], result: receipt };
const effects = [discovered, listed, read, applied];
function ref(value) {
  const body = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(body), hash: createHash("sha256").update(body).digest("hex") };
}
function node(id, parent, name, input, output, effects = []) {
  return { callId: id, record: { parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(input).map(([key,value]) => [key,ref(value)])), output: ref(output),
    effects: effects.map(({args,result,...effect}) => ({ ...effect,args:ref(args),result:ref(result) })) } };
}
function transcript(outcome, effects) {
  const { assignment, approvals, selection, replay, decision, receipt } = outcome;
  return { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "transcriptSurface", outcome }, calls:[
    node("root",null,"runUserGoal",{goal:world.goal},outcome),
    node("review","root","reviewTranscriptSurface",{goal:world.goal},outcome),
    node("discover","review","discoverTranscriptSurface",{},assignment,[effects[0]]),
    node("approvals","review","reviewApprovals",{assignment},approvals),
    node("records","approvals","readCurrentApprovals",{assignment},approvals,[effects[1]]),
    node("select","review","selectApprovedSurface",{assignment,approvals},selection),
    ...(replay ? [node("observe","review","inspectNativeSurface",{assignment,approval},replay),
      node("replay","observe","readChannelReplay",{assignment,approval},replay,[effects[2]])] : []),
    node("decide","review","decideTranscriptEffect",{assignment,selection,replay},decision),
    ...(receipt ? [node("apply","review","materializeTranscriptEffect",{assignment,approval,replay,decision},receipt),
      node("send","apply","mutateOwnedTranscript",{assignment,approval,replay,decision},receipt,[effects[3]])] : []),
  ] };
}
function run(flow, outcome, effects) {
  return openTemplateGoalEvidence({ provenance: { contextId: "workspace" }, diagnostics: { openGoalVerification: {
    ...outcome, effects, caseId: world.id, goal: world.goal, contextId: "workspace", passed: true, checks: new Proxy({}, { get: () => true }),
  } } }, flow, null, { assignment: world });
}

test("requires the current replay cursor, native effect, exact envelope and bound call subtree", () => {
  const good = transcript(outcome,effects);
  assert.ok(run(good,outcome,effects).checks.exactScopedTranscriptDelta);
  function reject(change) {
    const bad = structuredClone(good);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad,outcome,effects), /Expected exact owned channel/u);
  }
  const byId = (flow,id) => flow.calls.find(call => call.callId === id).record;
  reject(flow => { byId(flow,"replay").parent_call_id = "review"; });
  reject(flow => { byId(flow,"send").effects[0].args = ref([assignment.id,approval.id,2,effect]); });
  reject(flow => { flow.report.outcome.receipt.envelope = "another-channel"; });
});
test("a declined approval produces no invented native replay or mutation", () => {
  const hold = { ...outcome, selection: { approval: null, blocker: "competing" }, replay: null,
    decision: { effect: "none", reason: "competing" }, receipt: null };
  const prior = effects.slice(0,2), flow = transcript(hold,prior);
  assert.ok(run(flow,hold,prior).checks.boundCurrentTranscriptApproval);
  flow.calls.push(node("send","review","mutateOwnedTranscript",{assignment,approval,replay,decision},receipt,[applied]));
  assert.throws(() => run(flow,hold,prior), /Expected exact owned channel/u);
});
