import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "workspace-share-proof", kind: "workspace-share", goal: "Check the current edition's local reader scope." };
const assignment = { workspace: "owned-workspace", document: "current-object", user: "recipient", purpose: "reader-note" };
const observation = {
  object: { id: assignment.document, workspace: assignment.workspace, revision: "current-edition", digest: "current-content" },
  member: { accountRole: "root", workspaceRole: "member", active: true, revoked: false },
  invitation: { user: assignment.user, currentRevision: 3, revision: 3, inbox: "acknowledged", exact: true, action: "put", member: true },
  approval: { workspace: assignment.workspace, recipient: assignment.user, role: "reviewer", status: "approved" },
};
const finding = { decision: "stage-reader", reason: "The current reviewer scope covers this local reader note." };
const handoff = { path: "/.tmp/owned/handoff.json", bytes: 500, sha256: "exact" };
const outcome = { assignment, observation, finding, handoff };
const receipts = [
  { service: "workspaceShareEvidence", method: "discover", args: [], result: assignment },
  { service: "workspaceShareEvidence", method: "inspect", args: [assignment.document], result: observation },
  { service: "workspaceShareHandoff", method: "stage", args: [observation, finding.decision], result: handoff },
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
const proof = { caseId: world.id, contextId: "owned", goal: world.goal, assignment, observation, handoff,
  decision: finding.decision, passed: true, checks: new Proxy({}, { get: () => true }), effects: receipts };
const exercise = { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "workspaceShare", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("share", "root", "reviewWorkspaceShare", { goal: world.goal }, outcome, [receipts[0], receipts[2]]),
    node("inspect", "share", "identifyShare", { assignment }, observation, [receipts[1]]),
    node("policy", "share", "reviewSharePolicy", { observation }, finding),
  ],
};
const run = record => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
  diagnostics: { openGoalVerification: proof } }, record, null, { assignment: world });

test("workspace sharing export binds exact role, invitation version and private handoff", () => {
  assert.ok(run(exercise).checks.verifiedPrivateHandoff);
  function reject(change) {
    const bad = structuredClone(exercise);
    change(bad);
    bad.calls[1].record.output = ref(bad.report.outcome);
    assert.throws(() => run(bad), /Expected exact workspace membership/u);
  }
  reject(bad => bad.calls[2].record.parent_call_id = "root");
  reject(bad => bad.calls[3].record.inputs.observation = ref({ ...observation, wasRevoked: true }));
  reject(bad => bad.report.outcome.observation.invitation.revision = 1);
  reject(bad => bad.report.outcome.observation.approval.recipient = "other-account");
  reject(bad => bad.report.outcome.observation.object.digest = "older-edition");
  reject(bad => bad.calls[1].record.effects[1].result = ref({ ...handoff, path: "foreign-note" }));
});
