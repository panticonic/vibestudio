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
  const stage = branch === "stage";
  const trusted = branch !== "hold";
  const world = { id: "api-proof", kind: "api-readiness", goal: "Review the exact profile quietly.",
    expected: { action: branch } };
  const { goal } = world;
  const scope = { contextId: "context", channelId: "channel", approvals: "pregranted-only" };
  const index = { scope, profiles: [{ id: "profile" }] };
  const snapshots = [{ channelId: scope.channelId, through: 1, rows: [] }, { channelId: scope.channelId, through: 2, rows: [] }];
  const planned = { profileId: "profile", channelId: scope.channelId, through: 2, message: "message",
    reason: stage ? "ready" : trusted ? "authorization-unverified" : "stale-selection", action: branch, providerAccess: "unobserved" };
  const request = { operationId: "op", goal };
  const seenPlan = trusted ? { receipt: "op:integration", destinations: [{ id: "required" }] } : null;
  const observed = { id: "required", state: stage ? "active" : "unverified" };
  const observations = trusted ? [observed] : [];
  const audit = trusted ? { approvals: "pregranted-only", providerAccess: "unobserved", facts: [{ id: "required" }] } : null;
  const plan = { ...planned, explanation: "Current binding metadata only." };
  const review = trusted ? { request, result: { planReceipt: seenPlan.receipt, destinations: observations } } : null;
  const artifact = stage ? JSON.stringify({ plan, audit }) : null;
  const handoff = artifact ? { path: "/.tmp/handoff.json", bytes: Buffer.byteLength(artifact), sha256: hash(artifact) } : null;
  const proof = { caseId: world.id, goal, contextId: scope.contextId, passed: true, index, snapshots, planned, seenPlan, observations,
    calls: trusted ? [{ profileId: "profile", message: "message", request }] : [], audit, handoff, artifact,
    checks: { exactIntegrationFrontiers: true, trustedIntegrationSelection: true, explicitQuietIntegration: true,
      observedIntegrationLifecycles: true, groundedIntegrationDisposition: true, verifiedPrivateIntegrationNote: true,
      preservedIntegrationWorkspace: true, rejectedForeignIntegration: true },
  };
  const outcome = { plan, review, audit, handoff };
  const report = { status: "workspace-skill-reviewed", skill: "apiReadiness", outcome };
  const calls = [];
  const call = (name, fields) => {
    const record = { call_id: name, definition: { name }, outcome: "done", ...fields };
    calls.push({ callId: record.call_id, record });
    return record;
  };
  const effect = (service, method, args, result) => ({ service, method, args: ref(args), result: ref(result) });
  const root = call("runUserGoal", { inputs: { goal: ref(goal) } });
  const workflow = call("workOnApiReadinessGoal", { parent_call_id: root.call_id, inputs: { goal: ref(goal) } });
  call("chooseIntegrationProfile", { parent_call_id: workflow.call_id, inputs: { goal: ref(goal), index: ref(index) } });
  const check = call("checkIntegrationSelection", { parent_call_id: workflow.call_id,
    inputs: { earlier: ref(snapshots[0]), current: ref(snapshots[1]), index: ref(index) } });
  call("confirmTrustedSelection", { parent_call_id: check.call_id });
  call("decideApiReadiness", { parent_call_id: workflow.call_id,
    inputs: { current: ref(snapshots[1]), audit: ref(audit) }, output: ref(plan) });
  const listing = effect("quietIntegrationIndex", "list", [], index);
  call("discoverIntegrationReview", { effects: [listing] });
  const frontiers = snapshots.map(row => effect("quietIntegrationJournal", "read", [scope.channelId], row));
  call("readIntegrationSelection", { effects: frontiers });
  let matched;
  let auditEffect;
  let lookup;
  if (trusted) {
    call("openQuietIntegrationPlan", { effects: [effect("quietIntegrationProtocol", "open", ["profile", "message"], request)] });
    call("readIntegrationPlan", { effects: [effect("integrationPlanRead", "observe", [request.operationId], seenPlan)] });
    lookup = effect("integrationCredentialLookup", "resolve", [seenPlan.receipt, observed.id], observed);
    call("resolveBinding", { effects: [lookup] });
    auditEffect = effect("quietIntegrationProtocol", "audit", [request.operationId], audit);
    call("readQuietIntegrationAudit", { effects: [auditEffect] });
    const wrapper = call("reviewQuietCredentials", { parent_call_id: workflow.call_id,
      inputs: { request: ref(request) }, output: ref(review) });
    matched = call("reviewIntegration", { parent_call_id: wrapper.call_id, inputs: { request: ref(request) }, output: ref(review.result) });
  }
  const note = handoff ? effect("quietIntegrationHandoff", "stage", [{ ...outcome, handoff: null }], handoff) : null;
  if (note) call("stageIntegrationReadiness", { effects: [note] });
  return { proof, listing, frontiers, matched, auditEffect, lookup, note, validate() {
    workflow.output = ref(outcome);
    const execution = { diagnostics: { openGoalVerification: proof }, provenance: { contextId: scope.contextId } };
    return openTemplateGoalEvidence(execution, { calls, rootCallIds: [root.call_id], report }, world.id, { assignment: world });
  } };
}

test("quiet API export authenticates current trusted selection, redacted lookups and local note refs", () => {
  for (const branch of ["stage", "hold", "escalate"]) assert.doesNotThrow(fixture(branch).validate);
  const faults = [
    sample => { sample.listing.result = sample.proof.index; },
    sample => { sample.frontiers[1].result = sample.frontiers[0].result; },
    sample => { sample.matched.output.complete = false; },
    sample => { sample.auditEffect.args = ref(["different-operation"]); },
    sample => { sample.lookup.args = ref(["op:integration", "foreign-destination"]); },
    sample => { sample.note.result.hash = hash("different-note"); },
    sample => { sample.proof.artifact += "unexpected bytes"; },
  ];
  for (const fault of faults) {
    const sample = fixture("stage");
    fault(sample);
    assert.throws(sample.validate, /Expected the exact quiet integration plan/u);
  }
});
