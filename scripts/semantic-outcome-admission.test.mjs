import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import templateConfig from "../src/dev/developmentTemplateConfig.cjs";
import { loadLiveTeacherCases, openOutcomeGoalEvidence } from "./export-live-workflow-teacher.mjs";

const ref = value => {
  const json = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(json), hash: createHash("sha256").update(json).digest("hex") };
};

test("every authored open goal registers the outcome admission function and its actual semantic entry", async () => {
  const { checkouts } = templateConfig.requireDevelopmentTemplateCheckouts(path.resolve(import.meta.dirname, ".."));
  const entries = JSON.parse(await readFile(path.join(checkouts.base, "skills/open-user-goal/entries.json"), "utf8"));
  const { semanticTaskEntry } = await import(pathToFileURL(path.join(checkouts.base, "skills/open-user-goal/entrypoints.ts")));
  const cases = await loadLiveTeacherCases(checkouts);
  const goals = [...cases.values()].filter(workflow => workflow.interaction === "open-user-goal");
  assert.ok(goals.length > 0);
  assert.deepEqual([...new Set(goals.map(workflow => workflow.assignment.kind))].sort(), Object.keys(entries).sort());
  for (const workflow of goals) {
    assert.equal(workflow.evidence, openOutcomeGoalEvidence, workflow.assignment.id);
    const expected = semanticTaskEntry(workflow.assignment.kind, workflow.assignment.goal, workflow.assignment);
    assert.equal(workflow.program, expected.program);
    assert.equal(workflow.root, expected.callable);
    assert.equal(workflow.entry.callable, expected.callable);
    assert.equal(workflow.entry.program, expected.program);
  }
});

test("semantic application admission accepts arbitrary internal decompositions without weakening state authenticity", () => {
  const goal = "Review the optional provider status within the authorized scope.";
  const result = { plan: { action: "hold", explanation: "Provider status remains unobserved." }, review: null, audit: null, handoff: null };
  const entry = { program: "skills/open-user-goal/workOnApiReadinessGoal.nl", callable: "workOnApiReadinessGoal", arguments: { goal } };
  const proof = { passed: true, caseId: "readiness", contextId: "owned", goal, entry, actualResult: result,
    checks: { groundedInNativeReadback: true, preservedAuthorizedScope: true } };
  const execution = { provenance: { contextId: "owned" }, diagnostics: { openGoalVerification: proof } };
  const workflow = { entry, assignment: { kind: "api-readiness", id: proof.caseId, goal } };
  const root = { callId: "root", record: { definition: { name: entry.callable }, inputs: { goal: ref(goal) }, output: ref(result) } };
  const call = (name, id) => ({ callId: id, record: { parent_call_id: "root", definition: { name }, outcome: "done" } });
  for (const children of [[], [call("resolveCurrentReadiness", "a")],
    [call("refreshIndependentEvidence", "b"), call("resolveCurrentReadiness", "a"), call("refreshIndependentEvidence", "c")]]) {
    const exercise = { rootCallIds: ["root"], entry, calls: [root, ...children] };
    assert.deepEqual(openOutcomeGoalEvidence(execution, exercise, "readiness", workflow).checks, proof.checks);
  }
  const exercise = { rootCallIds: ["root"], entry, calls: [root] };
  const deny = () => openOutcomeGoalEvidence(execution, exercise, "readiness", workflow);
  root.record.output = ref({ ...result, handoff: { path: "invented" } });
  assert.throws(deny, /independently verified outcomes/);
  root.record.output = ref(result);
  proof.checks.preservedAuthorizedScope = false;
  assert.throws(deny, /independently verified outcomes/);
  proof.checks.preservedAuthorizedScope = true;
  execution.provenance.contextId = "foreign";
  assert.throws(deny, /independently verified outcomes/);
  execution.provenance.contextId = "owned";
  root.record.inputs.goal = ref("A different task");
  assert.throws(deny, /independently verified outcomes/);
});
