import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "extension-dossier-proof", kind: "extension-dossier", goal: "Check a retained PDF release." };
const request = { goal: world.goal, operationId: "exact-operation", method: "probe" };
const assignment = { request, purpose: "rollback", owner: { name: "@workspace-extensions/pdf-ingest",
  source: "extensions/pdf-ingest", candidateTree: "current-tree", grant: "local-rollback-dossier", retainedBuild: "owned-build" } };
const review = { source: { observation: { workingTree: "current-tree", publishedTree: "protected-tree" } },
  runtime: { observation: { activeEv: "active-version", pendingApproval: "extension.update" } } };
const candidate = { delta: { workingDigest: "current-digest", publishedDigest: "protected-digest" }, compatibility: "verification-needed" };
const history = { current: { buildKey: "active-build" }, previous: [{ buildKey: "owned-build" }],
  requested: { buildKey: "owned-build" }, requestedBuildVerified: true, receiverMatches: true };
const finding = { decision: "record-retained-rollback", reason: "The exact prior release is independently retained." };
const dossier = { path: "/.tmp/owned/handoff.json", bytes: 700, sha256: "dossier-digest" };
const outcome = { assignment, review, candidate, history, finding, dossier };
const receipts = [
  { service: "extensionDossierRead", method: "discover", args: [], result: assignment },
  { service: "extensionReleaseRead", method: "source", args: [request.operationId], result: review.source.observation },
  { service: "extensionReleaseRead", method: "runtime", args: [request.operationId], result: review.runtime.observation },
  { service: "extensionDossierRead", method: "candidate", args: [request.operationId], result: candidate.delta },
  { service: "extensionDossierRead", method: "history", args: [request.operationId], result: history },
  { service: "extensionDossierWrite", method: "stage", args: [finding.decision], result: dossier },
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
const proof = { contextId: "owned", caseId: world.id, goal: world.goal, assignment, review, candidate, history, dossier,
  decision: finding.decision, passed: true, checks: new Proxy({}, { get: () => true }), effects: receipts };
const exercise = { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "extensionDossier", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("dossier", "root", "reviewExtensionDossier", { goal: world.goal }, outcome, [receipts[0], ...receipts.slice(3)]),
    node("release", "dossier", "reviewExtensionRelease", { request }, review, receipts.slice(1, 3)),
  ],
};
const run = record => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
  diagnostics: { openGoalVerification: proof } }, record, null, { assignment: world });

test("extension dossier proof compares raw package and grant with exact trajectory references", () => {
  assert.ok(run(exercise).checks.reconciledNativeReleaseHistory);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad), /Expected exact extension package/u);
  }
  reject(bad => bad.calls[2].record.parent_call_id = "root");
  reject(bad => bad.calls[2].record.inputs.request = ref({ ...request, operationId: "different-operation" }));
  reject(bad => bad.report.outcome.assignment.owner.candidateTree = "stale-tree");
  reject(bad => bad.report.outcome.history.requested.buildKey = "evicted-build");
  reject(bad => bad.calls[2].record.effects[0].result = ref({ workingTree: "foreign" }));
  reject(bad => bad.calls[1].record.effects[3].result = ref({ ...dossier, path: "unowned" }));
});
