import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";
const world = { id: "deployed-interface-proof", kind: "deployed-interface", goal: "Review the installed worker boundary." };
const survey = { subjects: [{ id: "owned" }], review: { source: "workers/workspace-source", revision: "current", definition: "exact" } };
const request = { goal: world.goal, operationId: "owned-route", concern: "workspace-history", proposedOwner: "semantic-vcs" };
const observation = { subject: survey.subjects[0], authoredDigest: "exact", architecture: request,
  deployed: { state: "bound", buildKey: "owned-build", effectiveVersion: "active-ev", diagnosticMethod: { name: "status" } } };
const route = { receipt: "owned-route", source: survey.review.source };
const declaration = { hash: "exact" };
const architecture = { provider: { route, declaration, consistent: true }, ownership: { owner: "semantic-vcs" }, decision: "retain-boundary" };
const finding = { decision: "deployed-method-confirmed", reason: "The exact artifact establishes status." };
const handoff = { path: "/.tmp/verified/handoff.json", bytes: 600, sha256: "retained" };
const outcome = { survey, observation, architecture, finding, handoff };
const effects = [
  { service: "interfaceEvidence", method: "discover", args: [], result: survey },
  { service: "interfaceEvidence", method: "inspect", args: ["owned"], result: observation },
  { service: "architectureProviderRead", method: "resolve", args: ["owned-route"], result: route },
  { service: "architectureProviderRead", method: "declaration", args: ["owned-route"], result: declaration },
  { service: "interfaceReviewHandoff", method: "stage", args: [observation, finding.decision], result: handoff },
];
const ref = value => {
  const bytes = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(bytes), hash: createHash("sha256").update(bytes).digest("hex") };
};
function node(id, parent, name, inputs, out, calls = []) {
  return { callId: id, record: {
    parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
    output: ref(out), effects: calls.map(({ args, result, ...rest }) => ({ ...rest, args: ref(args), result: ref(result) })),
  } };
}
const proof = { contextId: "owned", caseId: world.id, goal: world.goal, survey, observation, architecture, handoff,
  decision: finding.decision, passed: true, checks: new Proxy({}, { get: () => true }), effects };
const exercise = {
  rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "deployedInterface", outcome },
  calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("review", "root", "reviewDeployedInterface", { goal: world.goal }, outcome, [effects[0], effects[1], effects[4]]),
    node("architecture", "review", "reviewArchitectureBoundary", { request }, architecture, [effects[2], effects[3]]),
  ],
};
const run = candidate => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
  diagnostics: { openGoalVerification: proof } }, candidate, null, { assignment: world });
test("deployed interface proof binds raw outcome and trajectory references", () => {
  assert.ok(run(exercise).checks.verifiedExactProviderBoundary);
  const rejected = mutate => {
    const candidate = structuredClone(exercise);
    mutate(candidate);
    candidate.calls[1].record.output = ref(candidate.report.outcome);
    assert.throws(() => run(candidate), /Expected exact interface evidence/u);
  };
  rejected(value => value.calls[2].record.parent_call_id = "root");
  rejected(value => value.calls[2].record.inputs.request = ref({ ...request, operationId: "foreign" }));
  rejected(value => value.report.outcome.survey.review.revision = "stale");
  rejected(value => value.report.outcome.observation.deployed.buildKey = "other-build");
  rejected(value => value.calls[1].record.effects[1].args = ref(["same-name-foreign-source"]));
  rejected(value => value.calls[1].record.effects[2].result = ref({ ...handoff, path: "unowned" }));
});
