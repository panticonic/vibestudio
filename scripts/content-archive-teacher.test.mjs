import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "archive-review", kind: "content-archive", goal: "Restore the approved local document." };
const assignment = { id: "auth", repository: "owned", primary: "immutable-tree", previous: "stale-tree", permitted: ["README.md"] };
const observation = { workingRevision: "reviewed", repository: assignment.repository,
  primary: { ref: assignment.primary, coherent: true, rootTreeHash: "exact-tree" },
  working: [{ path: assignment.permitted[0], digest: "previous-member", state: "old" }] };
const archive = { ref: assignment.primary, reason: "Matches the approved immutable edition." };
const plan = { action: "restore", paths: assignment.permitted, reason: "The working document is from the previous edition." };
const receipt = { status: "restored", workingRevision: "updated", application: { id: "one-edit", changes: ["file-change"] } };
const outcome = { assignment, observation, archive, plan, receipt };
const effects = [
  { service: "contentArchiveEvidence", method: "discover", args: [], result: assignment },
  { service: "contentArchiveEvidence", method: "inspect", args: [assignment.id], result: observation },
  { service: "contentArchiveChange", method: "restore", args: [assignment.id, archive.ref, observation.workingRevision, plan.paths], result: receipt },
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
const proof = { caseId: world.id, contextId: "owned", goal: world.goal, ...outcome, effects,
  passed: true, checks: new Proxy({}, { get: () => true }) };
const exercise = { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "contentArchive", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("archive", "root", "recoverContentArchive", { goal: world.goal }, outcome, [effects[0]]),
    node("inspect", "archive", "inspectArchive", { assignment }, observation),
    node("choose", "archive", "chooseEdition", { assignment, observation }, archive),
    node("plan", "archive", "planRestoration", { assignment, observation, archive }, plan),
    node("apply", "archive", "applyArchive", { assignment, observation, archive, plan }, receipt, [effects[2]]),
    node("read", "inspect", "readArchiveEvidence", { assignment }, observation, [effects[1]]),
    node("diff", "plan", "analyzeWorking", { assignment, observation }, { paths: plan.paths, collision: false, coedit: false }),
  ],
};
const run = record => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
  diagnostics: { openGoalVerification: proof } }, record, null, { assignment: world });

test("content archive capture preserves exact tree, working scope and atomic application", () => {
  assert.equal(run(exercise).checks.verifiedAtomicReceipt, true);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad), /Expected exact content archive selection/u);
  }
  reject(bad => bad.calls[2].record.parent_call_id = "root");
  reject(bad => bad.calls[6].record.parent_call_id = "archive");
  reject(bad => bad.calls[7].record.output = ref({ paths: [], collision: false, coedit: false }));
  reject(bad => bad.calls[3].record.output = ref({ ...archive, ref: assignment.previous }));
  reject(bad => bad.calls[4].record.inputs.observation = ref({ ...observation, workingRevision: "old-head" }));
  reject(bad => bad.calls[5].record.effects[0].args = ref([assignment.id, archive.ref, observation.workingRevision, ["foreign.md"]]));
  reject(bad => bad.report.outcome.receipt.application.id = "different-mutation");
});
