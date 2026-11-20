import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

test("retained build proof requires an exact revision and the actual performance child", () => {
  const world = { id: "retained-proof", kind: "build-incident", goal: "Check the current retained build of the panel." };
  const subject = { source: "panels/owned", revision: "current", owner: "owner", title: "Panel" };
  const checkpoint = { id: "checkpoint", revision: "current", source: subject.source };
  const review = { observation: { source: subject.source, stateHash: "state", status: "ok" } };
  const request = { operationId: "op", goal: world.goal };
  const outcome = { subject, current: { checkpoint, review }, baseline: null, handoff: null };
  const effects = [
    { service: "buildIncidentCatalog", method: "discover", args: [], result: { subject, checkpoints: [checkpoint] } },
    { service: "buildIncidentCatalog", method: "open", args: [checkpoint.id], result: { checkpoint, request } },
    { service: "buildPerformance", method: "observe", args: [request.operationId], result: review.observation },
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
  const proof = { contextId: "owned", caseId: world.id, goal: world.goal, subject, passed: true,
    checks: new Proxy({}, { get: () => true }), current: checkpoint, baseline: null, handoff: null, effects };
  const exercise = {
    rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "buildIncident", outcome },
    calls: [
      node("root", null, "runUserGoal", { goal: world.goal }, outcome),
      node("incident", "root", "reviewRetainedBuildIncident", { goal: world.goal }, outcome, effects.slice(0, 2)),
      node("profile", "incident", "reviewBuildPerformance", { request }, review, effects.slice(2)),
    ],
  };
  const run = candidate => openTemplateGoalEvidence({ provenance: { contextId: "owned" },
    diagnostics: { openGoalVerification: proof } }, candidate, null, { assignment: world });
  assert.ok(run(exercise).checks.nativeObservationAndProvenance);
  const skipped = structuredClone(exercise);
  skipped.calls[2].record.parent_call_id = "root";
  assert.throws(() => run(skipped));
  const stale = structuredClone(exercise);
  stale.report.outcome.current.checkpoint.revision = "older";
  stale.calls[1].record.output = ref(stale.report.outcome);
  assert.throws(() => run(stale));
  const wrong = structuredClone(exercise);
  wrong.calls[2].record.effects[0].result = ref({ ...review.observation, source: "panels/neighbor" });
  assert.throws(() => run(wrong));
  console.log("The actual exporter joined native profile ancestry and rejected stale source, wrong provenance, and skipped child calls.");
});
