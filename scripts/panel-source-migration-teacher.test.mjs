import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "panel-source-migration-proof", kind: "panel-source-migration", goal: "Finish the existing panel's local cutover." };
const assignment = { id: "authorized-cutover", repository: "owned-repo", original: "panels/old", destination: "panels/current" };
const observed = { repository: assignment.repository, workingRevision: "original-head", current: "panels/old", consumerDigest: "original-guide",
  consumerLinks: [{ source: "panels/old", scope: "working", compatible: true, value: "original-state-args" }] };
const mid = { ...observed, workingRevision: "moved-head", current: "panels/current" };
const aligned = { ...mid, workingRevision: "aligned-head", manifestDigest: "new-package-manifest" };
const current = { ...aligned, workingRevision: "updated-head", consumerDigest: "updated-guide" };
const finding = { decision: "move-and-update", reason: "The approved destination and existing callers use the same schema." };
const move = { observation: mid, status: "moved" };
const identity = { observation: aligned, status: "aligned" };
const consumers = { observation: current, status: "updated" };
const outcome = { assignment, observed, finding, move, identity, consumers, current };
const receipts = [
  { service: "panelMigrationEvidence", method: "discover", args: [], result: assignment },
  { service: "panelMigrationEvidence", method: "inspect", args: [assignment.id], result: observed },
  { service: "panelMigrationChange", method: "move", args: [assignment.id, observed.workingRevision], result: move },
  { service: "panelMigrationChange", method: "align", args: [assignment.id, mid.workingRevision, "old-package-manifest"], result: identity },
  { service: "panelMigrationChange", method: "update", args: [assignment.id, aligned.workingRevision, aligned.consumerDigest], result: consumers },
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
const proof = { caseId: world.id, contextId: "owned", goal: world.goal, assignment, observed, current, move, identity, consumers,
  decision: finding.decision, passed: true, checks: new Proxy({}, { get: () => true }), effects: receipts };
const exercise = { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "panelSourceMigration", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("migration", "root", "migratePanelSource", { goal: world.goal }, outcome, [receipts[0], receipts[2], receipts[3], receipts[4]]),
    node("inspect", "migration", "inspectMigration", { assignment }, observed, [receipts[1]]),
    node("plan", "migration", "planMigration", { assignment, observed }, finding),
  ],
};
const run = record => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
  diagnostics: { openGoalVerification: proof } }, record, null, { assignment: world });

test("panel relocation export binds exact source, compatible current links, and state-protected changes", () => {
  assert.ok(run(exercise).checks.verifiedExactPlacement);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad), /Expected exact semantic panel relocation/u);
  }
  reject(bad => bad.calls[2].record.parent_call_id = "root");
  reject(bad => bad.calls[3].record.inputs.observed = ref({ ...observed, workingRevision: "unreviewed-head" }));
  reject(bad => bad.report.outcome.assignment.repository = "neighbor");
  reject(bad => bad.report.outcome.observed.consumerLinks[0].value = "different-state-argument");
  reject(bad => bad.calls[1].record.effects[1].args = ref(["other-assignment", observed.workingRevision]));
  reject(bad => bad.calls[1].record.effects[2].args = ref([assignment.id, mid.workingRevision, "stale-package-manifest"]));
  reject(bad => bad.calls[1].record.effects[3].result = ref({ ...consumers, status: "state-changed" }));
});
