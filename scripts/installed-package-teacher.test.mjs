import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "installed-package-proof", kind: "installed-package", goal: "Restore the approved records package field." };
const request = { goal: world.goal, operationId: "exact-plan", target: "workers/natlang-records", suite: "native", mode: "inspect" };
const assignment = { operationId: "package-scope", source: request.target, scope: { workingDigest: "before", baselineDigest: "baseline" } };
const observed = { workingRevision: "before", workingDigest: "before", baselineDigest: "baseline", suiteRequest: request };
const repair = { status: "restored", observation: { ...observed, workingRevision: "after", workingDigest: "after" } };
const plan = { target: request.target, suite: "native", runtime: "native", stateHash: "actual-current-state", contextId: "owned" };
const verification = { plan, decision: { next: "report-plan", route: { runtime: "native", nativeApproval: true } }, execution: null, result: null };
const finding = { decision: "restore-approved-field", reason: "The current protected package attests the missing runtime dependency." };
const outcome = { assignment, observed, finding, repair, verification };
const receipts = [
  { service: "installedPackageRead", method: "discover", args: [], result: assignment },
  { service: "installedPackageRead", method: "inspect", args: [assignment.operationId], result: observed },
  { service: "installedPackageChange", method: "restore", args: [assignment.operationId, observed.workingRevision, observed.workingDigest], result: repair },
  { service: "testSuitePlanRead", method: "resolve", args: [request.operationId], result: plan },
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
const proof = { contextId: "owned", caseId: world.id, goal: world.goal, assignment, observed, repair, plan,
  decision: finding.decision, passed: true, checks: new Proxy({}, { get: () => true }), effects: receipts };
const exercise = { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "installedPackage", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("package", "root", "reviewInstalledPackage", { goal: world.goal }, outcome, receipts.slice(0, 3)),
    node("verify", "package", "reviewVerification", { observed: repair.observation }, verification),
    node("suite", "verify", "reviewTestSuite", { request }, verification, receipts.slice(3)),
  ],
};
const run = record => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
  diagnostics: { openGoalVerification: proof } }, record, null, { assignment: world });

test("installed package proof binds exact restoration and native plan trajectory", () => {
  assert.ok(run(exercise).checks.exactStateVerificationPlan);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad), /Expected exact package baseline/u);
  }
  reject(bad => bad.calls[3].record.parent_call_id = "root");
  reject(bad => bad.calls[2].record.inputs.observed = ref(observed));
  reject(bad => bad.report.outcome.verification.plan.stateHash = "pre-repair");
  reject(bad => bad.report.outcome.verification.decision.route.nativeApproval = false);
  reject(bad => bad.report.outcome.assignment.scope.baselineDigest = "foreign");
  reject(bad => bad.report.outcome.repair.observation.workingDigest = "unverified");
  reject(bad => bad.calls[3].record.effects[0].service = "testSuiteVerificationRun");
});
