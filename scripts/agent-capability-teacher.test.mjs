import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "agent-capability-proof", kind: "agent-capability", goal: "Check the original action before retrying." };
const approval = { notebook: "owned", revision: "current", mode: "retry" };
const current = { attempt: { id: "latest", notebook: "owned", revision: "current" }, runId: "original",
  runDigest: "admitted", resultDigest: "original-result", notebook: { revision: "current", saved: false },
  failure: { code: "guest_execution_failed" }, console: { sha256: "retained-console" } };
const prior = { attempt: { id: "prior", notebook: "owned", revision: "earlier" }, runId: "earlier" };
const assignment = { notebook: "owned", revision: "current", approval, attempts: [current.attempt, prior.attempt], task: "retry" };
const evidence = { current, prior };
const finding = { decision: "retry-exact-step", reason: "The admitted run did not save anything, and the original local prerequisite is now ready." };
const continuation = { original: current.runId, runId: "new", runDigest: "new-admission", resultDigest: "exact-new-result",
  valueDigest: "current-value", revision: "current" };
const outcome = { assignment, evidence, finding, continuation };
const receipts = [
  { service: "agentCapabilityEvidence", method: "discover", args: [], result: assignment },
  { service: "agentCapabilityEvidence", method: "inspect", args: ["latest"], result: current },
  { service: "agentCapabilityEvidence", method: "inspect", args: ["prior"], result: prior },
  { service: "agentCapabilityContinue", method: "apply", args: ["latest", "original-result", "current", "retry-exact-step"], result: continuation },
];
const ref = value => {
  const text = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex") };
};
function node(id, parent, name, inputs, out, effects = []) {
  return { callId: id, record: { parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
    output: ref(out), effects: effects.map(({ args, result, ...rest }) => ({ ...rest, args: ref(args), result: ref(result) })) } };
}
const proof = { contextId: "owned", caseId: world.id, goal: world.goal, assignment, evidence, continuation,
  decision: finding.decision, passed: true, checks: new Proxy({}, { get: () => true }), effects: receipts };
const exercise = { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "agentCapability", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("capability", "root", "recoverAgentCapability", { goal: world.goal }, outcome, [receipts[0], receipts[3]]),
    node("compare", "capability", "inspectAttempt", { assignment }, evidence, receipts.slice(1, 3)),
    node("decision", "capability", "decideContinuation", { evidence }, finding),
  ],
};
const run = record => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
  diagnostics: { openGoalVerification: proof } }, record, null, { assignment: world });

test("agent capability export binds current and prior native receipts to the scoped retry", () => {
  assert.ok(run(exercise).checks.verifiedExactContinuation);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad), /Expected exact admitted agent action/u);
  }
  reject(bad => bad.calls[2].record.parent_call_id = "root");
  reject(bad => bad.calls[3].record.inputs.evidence = ref({ current: prior, prior: current }));
  reject(bad => bad.report.outcome.evidence.current.console.sha256 = "older-console");
  reject(bad => bad.report.outcome.evidence.current.runDigest = "foreign-admission");
  reject(bad => bad.report.outcome.continuation.original = "earlier");
  reject(bad => bad.calls[1].record.effects[1].args = ref(["latest", "stale", "current", "retry-exact-step"]));
});
