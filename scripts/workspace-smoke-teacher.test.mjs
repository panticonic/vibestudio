import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "accepted-install", kind: "workspace-smoke", goal: "Verify our exact current installed launcher smoke." };
const assignment = { id: "owned", goal: world.goal, context: "owner", revision: "reviewed", subject: "navigation", mayStage: true };
const value = { mode: "goto", prefix: "@", query: "primary" };
const plan = { path: "/.tmp/owned/spec.json", digest: "exact", context: "owner", revision: "reviewed", subject: "navigation",
  exportName: "parseLauncherInput", probe: "launcher", input: { query: "@primary" }, accepted: value };
const source = { matches: 1, truncated: false, plans: [plan] };
const selection = { plan, blocker: null };
const runtime = { packageName: "@workspace/omnibox-core", exportName: plan.exportName, callable: true, value, runDigest: "runtime-receipt" };
const decision = { disposition: "accepted", mayRetain: true };
const receipt = { path: "/.tmp/owned/runtime-smoke.json", bytes: 45, sha256: "actual" };
const outcome = { assignment, source, selection, runtime, decision, receipt };
const effects = [
  { service: "workspaceSmokeEvidence", method: "discover", args: [], result: assignment },
  { service: "workspaceSmokeEvidence", method: "scan", args: [assignment.id], result: source },
  { service: "workspaceSmokeRuntime", method: "run", args: [assignment.id, plan.path, plan.digest], result: runtime },
  { service: "workspaceSmokeHandoff", method: "stage", args: [assignment.id, plan.path, runtime.runDigest], result: receipt },
];
const ref = value => {
  const text = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex") };
};
function node(id, parent, name, inputs, output, receipts = []) {
  return { callId: id, record: { parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
    output: ref(output), effects: receipts.map(({ args, result, ...rest }) => ({ ...rest, args: ref(args), result: ref(result) })) } };
}
function transcript(outcome, effects) {
  const { assignment, source, selection, runtime, decision, receipt } = outcome;
  return { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "workspaceSmoke", outcome },
    calls: [
      node("root", null, "runUserGoal", { goal: world.goal }, outcome),
      node("review", "root", "reviewWorkspaceSmoke", { goal: world.goal }, outcome),
      node("discover", "review", "discoverWorkspaceSmoke", {}, assignment, [effects[0]]),
      node("find", "review", "inspectSmokeFiles", { assignment }, source),
      node("native", "find", "readNativeSmokeFiles", { assignment }, source, [effects[1]]),
      node("pick", "review", "selectSmokeContract", { assignment, source }, selection),
      ...(selection.plan ? [
        node("run", "review", "exerciseInstalledSmoke", { assignment, plan: selection.plan }, runtime),
        node("installed", "run", "readActualSmokeResult", { assignment, plan: selection.plan }, runtime, [effects[2]]),
      ] : []),
      node("compare", "review", "compareSmokeOutput", { assignment, selection, runtime }, decision),
      ...(receipt ? [node("stage", "review", "stageWorkspaceSmoke", { assignment, selection, runtime, decision }, receipt, [effects[3]])] : []),
    ] };
}
function run(trace, proofOutcome, proofEffects) {
  return openTemplateGoalEvidence({ provenance: { contextId: assignment.context }, diagnostics: { openGoalVerification: {
    caseId: world.id, goal: world.goal, contextId: assignment.context, ...proofOutcome, effects: proofEffects,
    passed: true, checks: new Proxy({}, { get: () => true }),
  } } }, trace, null, { assignment: world });
}
test("requires both the native source scan and exact installed export before a passing handoff", () => {
  const exercise = transcript(outcome, effects);
  assert.ok(run(exercise, outcome, effects).checks.verifiedInstalledExportAndRuntime);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad, outcome, effects), /Expected exact owned source search/u);
  }
  reject(bad => bad.calls[4].record.parent_call_id = "review");
  reject(bad => bad.calls[7].record.effects[0].args = ref([assignment.id, plan.path, "different-source"]));
  reject(bad => bad.calls[8].record.inputs.runtime = ref({ ...runtime, runDigest: "different-execution" }));
  reject(bad => bad.calls[9].record.effects[0].args = ref([assignment.id, plan.path, "different-execution"]));
  reject(bad => bad.report.outcome.source.plans[0].digest = "changed");
});
test("no accepted source remains a hold without an invented installed run", () => {
  const held = { ...outcome, selection: { plan: null, blocker: "hold-source" }, runtime: null,
    decision: { disposition: "hold-source", mayRetain: false }, receipt: null };
  const observed = effects.slice(0, 2), exercise = transcript(held, observed);
  assert.ok(run(exercise, held, observed).checks.verifiedNativeSearchAndSource);
  exercise.calls.push(node("invented", "review", "exerciseInstalledSmoke", { assignment, plan }, runtime, [effects[2]]));
  assert.throws(() => run(exercise, held, observed), /Expected exact owned source search/u);
});
