import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "owned-admission", kind: "webhook-admission", goal: "Verify the current local registration." };
const assignment = { id: "local-ticket", registration: "current-id", contextId: "owned-context", requirement: "body-limit" };
const row = { id: assignment.registration, maxBodyBytes: 4096, revokedAt: null, hasSecret: false };
const evidence = { active: [row], history: [row], witness: { contextId: assignment.contextId, registration: row.id },
  retainedDigest: "receipt-digest", rowDigest: "row-digest" };
const binding = { row, hold: null };
const assessment = { disposition: "stage-audit", reason: "The effective budget matches the approved configuration." };
const handoff = { path: "/.tmp/owned/admission-audit.json", bytes: 400, sha256: "exact-audit" };
const outcome = { assignment, evidence, binding, assessment, handoff };
const effects = [
  { service: "webhookAdmissionEvidence", method: "discover", args: [], result: assignment },
  { service: "webhookAdmissionEvidence", method: "inspect", args: [assignment.id], result: evidence },
  { service: "webhookAdmissionHandoff", method: "stage", args: [assignment.id, evidence.retainedDigest, row, assessment.disposition], result: handoff },
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
const proof = { caseId: world.id, contextId: "owned-context", goal: world.goal, ...outcome, effects,
  passed: true, checks: new Proxy({}, { get: () => true }) };
const exercise = { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "webhookAdmission", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("review", "root", "reviewWebhookAdmission", { goal: world.goal }, outcome, [effects[0]]),
    node("inspect", "review", "inspectWebhookStatus", { assignment }, evidence),
    node("read", "inspect", "readWebhookEvidence", { assignment }, evidence, [effects[1]]),
    node("match", "review", "matchRegistration", { assignment, evidence }, binding),
    node("assess", "review", "assessWebhookAdmission", { assignment, binding }, assessment),
    node("policy", "assess", "assessRequiredPolicy", { assignment, row }, assessment.disposition),
    node("stage", "review", "stageWebhookAudit", { assignment, evidence, binding, assessment }, handoff, [effects[2]]),
  ],
};
const run = record => openTemplateGoalEvidence({ provenance: { contextId: assignment.contextId },
  diagnostics: { openGoalVerification: proof } }, record, null, { assignment: world });

test("webhook admission capture binds exact retained/native identity, policy and scoped local evidence", () => {
  assert.ok(run(exercise).checks.verifiedScopedPrivateAudit);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad), /Expected exact owned webhook admission/u);
  }
  reject(bad => bad.calls[3].record.parent_call_id = "review");
  reject(bad => bad.calls[4].record.output = ref({ ...binding, row: { ...row, id: "neighbor" } }));
  reject(bad => bad.calls[6].record.output = ref("hold-body-limit"));
  reject(bad => bad.calls[7].record.effects[0].args = ref([assignment.id, "old-receipt", row, assessment.disposition]));
  reject(bad => bad.report.outcome.evidence.history[0].revokedAt = 100);
  reject(bad => bad.report.outcome.handoff.sha256 = "different-audit");
});
