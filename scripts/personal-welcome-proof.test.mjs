import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const bytes = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(bytes), hash: hash(bytes) };
}
function fixture(branch) {
  const world = { id: "welcome-proof", kind: "personal-welcome", goal: "Review the current owned resource.",
    expected: { action: branch === "setup" ? "stage" : branch === "absent" ? "hold" : "report" } };
  const { goal } = world;
  const scope = { channelId: "owned", contextId: "context", revision: "r1", mayStage: branch === "setup" };
  const resourceId = branch === "absent" ? null : "resource";
  const index = { scope, resources: resourceId ? [{ id: resourceId, scope: "owned", sender: "system" }] : [] };
  const snapshots = [{ channelId: scope.channelId, through: 1, rows: [] }, { channelId: scope.channelId, through: 2, rows: [] }];
  const probeRequest = branch === "probe" ? { goal, operationId: "current-op" } : null;
  const resolution = resourceId ? { resourceId, probe: probeRequest } : null;
  const ownerRead = branch === "setup" ? { receipt: "current-receipt", rows: [], route: { capabilityId: resourceId } } : null;
  const setup = ownerRead ? { request: { goal, intent: "selection" }, result: { ...ownerRead, status: "route-client" } } : null;
  const frame = { storedScene: "opening", notesVisible: false };
  const tour = branch === "tour" ? { stop: { topic: goal, scene: { id: "opening" }, notes: false },
    frame, sceneCount: 6, result: { frame, stage: "verified" } } : null;
  const probeInput = probeRequest ? { digest: hash("text"), bytes: 4 } : null;
  const probeRun = probeRequest ? { plan: { expectedDigest: probeInput.digest }, receipt: { file: { removed: true } } } : null;
  const probe = probeRequest ? { request: probeRequest, result: { input: probeInput, ...probeRun } } : null;
  const action = world.expected.action;
  const facts = { channelId: scope.channelId, through: 2, action, resourceId };
  const plan = { ...facts, explanation: "Current observation retained." };
  const reviews = { setup, tour, probe };
  const artifact = action === "stage" ? JSON.stringify(reviews) : null;
  const handoff = artifact ? { path: "/.tmp/handoff.json", bytes: Buffer.byteLength(artifact), sha256: hash(artifact) } : null;
  const proof = { caseId: world.id, contextId: scope.contextId, goal, passed: true, index, snapshots, resolution, ownerRead,
    independent: { plan: facts, setup, tour, probeRequired: !!probe }, probeInput, probeRun, handoff, artifact,
    checks: { exactWelcomeResource: true, exactWelcomeFrontiers: true, exactWelcomeDecision: true, verifiedWelcomeOwner: true,
      verifiedWelcomeTour: true, verifiedWelcomeRetry: true, exactWelcomeHandoff: true, preservedWelcomeContext: true,
      rejectedForeignWelcome: true },
  };
  const report = { status: "workspace-skill-reviewed", skill: "personalWelcome", outcome: { plan, reviews, handoff } };
  const calls = [];
  const call = (name, props) => {
    const record = { call_id: name, definition: { name }, outcome: "done", ...props };
    calls.push({ callId: name, record });
    return record;
  };
  const effect = (service, method, args, result) => ({ service, method, args: ref(args), result: ref(result) });
  const root = call("runUserGoal", { inputs: { goal: ref(goal) } });
  const skill = call("workOnPersonalWelcomeGoal", { parent_call_id: root.call_id, inputs: { goal: ref(goal) } });
  const selected = call("chooseWelcomeResource", { parent_call_id: skill.call_id,
    inputs: { goal: ref(goal), index: ref(index) } });
  call("discoverWelcomeResources", { effects: [effect("welcomeResourceIndex", "list", [], index)] });
  const reads = snapshots.map(snapshot => effect("welcomeReceiptStore", "read", [scope.channelId], snapshot));
  call("readWelcomeFrontier", { effects: reads });
  const route = resourceId ? effect("welcomeResourceResolution", "resolve", [resourceId], resolution) : null;
  if (route) call("resolveWelcomeResource", { effects: [route] });
  const joined = call("reconcileWelcomeEvidence", { parent_call_id: skill.call_id,
    inputs: { earlier: ref(snapshots[0]), current: ref(snapshots[1]), index: ref(index), resolved: ref(resolution) } });
  if (resourceId) {
    call("chooseCurrentReceipt", { parent_call_id: joined.call_id });
    call("reviewWelcomeAuthority", { parent_call_id: joined.call_id });
  }
  call("decideWelcomeNextStep", { parent_call_id: skill.call_id,
    inputs: { current: ref(snapshots[1]), reviews: ref(reviews) }, output: ref(plan) });
  const witness = (wrapperName, name, review, inputs, props = {}) => {
    const wrapper = call(wrapperName, { parent_call_id: skill.call_id, output: ref(review) });
    return call(name, { parent_call_id: wrapper.call_id, inputs, output: ref(review.result), ...props });
  };
  const owner = setup ? effect("onboardingRead", "inspect", [], ownerRead) : null;
  const setupCall = setup ? witness("reviewWelcomeSetup", "planSetup", setup, { request: ref(setup.request) }) : null;
  if (owner) call("readOwnerSnapshot", { parent_call_id: setupCall.call_id, effects: [owner] });
  const tourCall = tour ? witness("reviewWelcomeTour", "verifyTourStop", tour,
    { stop: ref(tour.stop), frame: ref(tour.frame), sceneCount: ref(tour.sceneCount) }) : null;
  const retry = probeRequest ? [
    effect("explorerTextProbe", "input", [probeRequest.operationId], probeInput),
    effect("explorerTextProbe", "run", [probeRequest.operationId, probeRun.plan], probeRun.receipt),
  ] : [];
  if (probe) witness("retryWelcomeProbe", "probeWorkspaceText", probe, { request: ref(probeRequest) }, { effects: retry });
  const write = handoff ? effect("welcomeLocalHandoff", "stage", [plan, reviews], handoff) : null;
  if (write) call("stageWelcomeNextStep", { effects: [write] });
  const execution = { diagnostics: { openGoalVerification: proof }, provenance: { contextId: scope.contextId } };
  return { selected, reads, route, proof, owner, tourCall, retry, write, validate() {
    skill.output = ref(report.outcome);
    return openTemplateGoalEvidence(execution, { calls, rootCallIds: [root.call_id], report }, world.id, { assignment: world });
  } };
}

test("Personal welcome exporter binds complete refs to current owner, tour and local retry proof", () => {
  for (const branch of ["setup", "tour", "probe", "absent"]) assert.doesNotThrow(fixture(branch).validate);
  const mutations = [
    ["setup", sample => { sample.selected.inputs.index = sample.proof.index; }],
    ["setup", sample => { sample.reads[1].result = sample.reads[0].result; }],
    ["setup", sample => { sample.route.result.complete = false; }],
    ["setup", sample => { sample.owner.result = ref({ receipt: "prior" }); }],
    ["tour", sample => { sample.tourCall.inputs.sceneCount = ref(5); }],
    ["probe", sample => { sample.retry[1].args = ref(["prior-operation", sample.proof.probeRun.plan]); }],
    ["setup", sample => { sample.write.result.hash = hash("foreign artifact"); }],
    ["setup", sample => { sample.proof.artifact += "extra bytes"; }],
  ];
  for (const [branch, mutate] of mutations) {
    const sample = fixture(branch);
    mutate(sample);
    assert.throws(sample.validate, /Expected the exact Personal welcome frontier/u);
  }
});
