import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const text = JSON.stringify(value);
  return { complete: true, hash: hash(text), bytes: Buffer.byteLength(text) };
}

function example(authorized) {
  const world = { id: "testkit-closeout-demo", kind: "testkit-closeout", goal: "Compare teardown after the timeout.",
    disposition: "cleared", lane: authorized ? "clear" : "off" };
  const pair = { current: { label: "current", receipt: "ctx:current" }, prior: { label: "prior", receipt: "ctx:prior" } };
  const actual = [
    { receipt: pair.current.receipt, outcome: "timeout", protectedUnchanged: true, remaining: [] },
    { receipt: pair.prior.receipt, outcome: "passed", protectedUnchanged: true, remaining: [{ id: "prior-residue" }] },
  ];
  const evidence = (index) => ({
    receipt: actual[index].receipt, testOutcome: actual[index].outcome,
    inventory: index ? "registered-residue" : "clear",
    release: { decision: index ? "revise" : "confirmed", finding: index ? "testkit-release-failed" : "testkit-released",
      evidenceIds: [actual[index].receipt + ":deferred"] },
    remainingIds: actual[index].remaining.map(({ id }) => id),
  });
  const current = evidence(0), prior = evidence(1);
  const decision = { status: "cleared", currentRemaining: [], note: authorized, explanation: "Current inventory is clear." };
  const artifact = authorized ? JSON.stringify({ scope: "private-local", current, prior, decision }) : null;
  const handoff = artifact ? { path: "/.tmp/private/closeout-review.json", sha256: hash(artifact), bytes: Buffer.byteLength(artifact) } : null;
  const outcome = { pair, current, prior, decision, handoff };
  const calls = [];
  const node = (name, parent, evidence = {}) => {
    const record = { call_id: String(calls.length), parent_call_id: parent?.call_id,
      outcome: "done", definition: { name }, ...evidence };
    calls.push({ callId: record.call_id, record });
    return record;
  };
  function effect(parent, name, service, method, args, result) {
    const row = { service, method, args: ref(args), result: ref(result) };
    node(name, parent, { effects: [row] });
    return row;
  }
  const root = node("runUserGoal", null, { inputs: { goal: ref(world.goal) } });
  const skill = node("compareTestkitCloseouts", root, { inputs: { goal: ref(world.goal) }, output: ref(outcome) });
  effect(skill, "discoverCloseoutAttempts", "testkitCloseout", "nominate", [world.goal], pair);
  const reviewed = ["current", "prior"].map((name, index) => {
    const parent = node("readAttempt", skill, { inputs: { goal: ref(world.goal), attempt: ref(pair[name]) }, output: ref(outcome[name]) });
    const receipt = pair[name].receipt;
    const review = node("reviewLiveCleanup", parent, { inputs: { request: ref({ goal: world.goal, receipt }) }, output: ref(outcome[name]) });
    const read = effect(review, "readCleanup", "testkitCleanup", "inspect", [receipt], actual[index]);
    node("readOutcome", review);
    node("reviewSessionTest", review);
    const inventory = node("inspectInventory", review);
    return { read, inventory };
  });
  const deciding = node("decideCloseout", skill, { inputs: { goal: ref(world.goal), pair: ref(pair), current: ref(current), prior: ref(prior) },
    output: ref(decision) });
  const staged = authorized
    ? effect(skill, "stageCloseoutEvidence", "testkitCloseout", "stage", [{ ...outcome, handoff: null }], handoff)
    : null;
  const proof = { caseId: world.id, contextId: "ctx", goal: world.goal, passed: true, pair, actual, report: outcome, artifact,
    checks: { exactNominatedTestkitAttempts: true, separatedActualCurrentAndPrior: true, separateReleaseAndObservedResidue: true,
      exactUserAcceptanceDecision: true, verifiedPrivateCloseout: true } };
  return {
    reviewed, deciding, staged, proof,
    check() {
      return openTemplateGoalEvidence({ diagnostics: { openGoalVerification: proof }, provenance: { contextId: "ctx" } }, {
        calls, rootCallIds: [root.call_id], report: { status: "workspace-skill-reviewed", skill: "testkitCloseout", outcome },
      }, world.id, { assignment: world });
    },
  };
}

test("open Testkit closeout requires exact nested attempt evidence and a scoped private handoff", () => {
  for (const authorized of [true, false]) assert.doesNotThrow(example(authorized).check);
  const corruptions = [
    ({ reviewed }) => { reviewed[0].read.result = reviewed[1].read.result; },
    ({ reviewed }) => { reviewed[0].inventory.parent_call_id = "unrelated"; },
    ({ deciding }) => { deciding.inputs.prior = deciding.inputs.current; },
    ({ staged }) => { staged.args = ref([]); },
    ({ proof }) => { proof.artifact += " "; },
  ];
  for (const corrupt of corruptions) {
    const source = example(true);
    corrupt(source);
    assert.throws(source.check, /Expected the exact Testkit attempt records/u);
  }
});
