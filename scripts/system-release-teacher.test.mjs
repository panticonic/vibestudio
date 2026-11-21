import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "retained-release", kind: "system-release", goal: "Review the exact retained acceptance evidence." };
const assignment = { id: "owned-release", current: "current-run", earlier: "old-run", required: ["handoff"], buildKey: "exact-build" };
const runs = { current: { id: assignment.current, buildKey: "exact-build" }, earlier: { id: assignment.earlier, buildKey: "yesterday" } };
const choice = { runId: assignment.current, blocker: null };
const cases = [{ name: "handoff", digest: "retained-page-digest", passed: true }];
const assessment = { disposition: "stage-acceptance", reason: "The local release has its original acknowledged evidence.", decisive: ["handoff"] };
const handoff = { path: "/.tmp/local/release-evidence.json", bytes: 300, sha256: "file-digest" };
const outcome = { assignment, runs, choice, cases, assessment, handoff };
const receipts = [
  { service: "systemReleaseEvidence", method: "discover", args: [], result: assignment },
  { service: "systemReleaseEvidence", method: "compare", args: [assignment.id], result: runs },
  { service: "systemReleaseEvidence", method: "inspectCase", args: [assignment.id, choice.runId, "handoff"], result: cases[0] },
  { service: "systemReleaseHandoff", method: "stage", args: [assignment.id, choice.runId, assessment.disposition, cases], result: handoff },
];
const ref = value => {
  const text = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex") };
};
function node(id, parent, name, inputs, output, effects = []) {
  return { callId: id, record: { parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
    output: ref(output), effects: effects.map(({ args, result, ...rest }) => ({ ...rest, args: ref(args), result: ref(result) })) } };
}
const proof = { caseId: world.id, contextId: "owned", goal: world.goal, ...outcome,
  passed: true, checks: new Proxy({}, { get: () => true }), effects: receipts };
const exercise = { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "systemRelease", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("release", "root", "reviewSystemRelease", { goal: world.goal }, outcome, [receipts[0], receipts[3]]),
    node("compare", "release", "compareRuns", { assignment }, { runs, choice }, [receipts[1]]),
    node("evaluate", "release", "evaluateCases", { assignment, choice }, { cases, assessment }, [receipts[2]]),
    node("choice", "compare", "chooseRun", { assignment, runs }, choice),
    node("classification", "evaluate", "classifyRelease", { assignment, cases }, assessment),
  ],
};
const run = record => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
  diagnostics: { openGoalVerification: proof } }, record, null, { assignment: world });

test("retained System release exports exact comparison, evaluated case proof, and private handoff", () => {
  assert.equal(run(exercise).checks.verifiedPrivateHandoff, true);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad), /Expected exact retained System release/u);
  }
  reject(bad => bad.calls[2].record.parent_call_id = "root");
  reject(bad => bad.calls[4].record.parent_call_id = "release");
  reject(bad => bad.calls[5].record.inputs.cases = ref([{ ...cases[0], digest: "other-case" }]));
  reject(bad => bad.calls[2].record.output = ref({ runs, choice: { ...choice, runId: assignment.earlier } }));
  reject(bad => bad.calls[3].record.inputs.choice = ref({ ...choice, runId: assignment.earlier }));
  reject(bad => bad.calls[3].record.effects[0].result = ref({ ...cases[0], digest: "wrong-case" }));
  reject(bad => bad.calls[1].record.effects[1].result = ref({ ...handoff, path: "other-note" }));
  reject(bad => bad.report.outcome.assessment.disposition = "report-only");
});
