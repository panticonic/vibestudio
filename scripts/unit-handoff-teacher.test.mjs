import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

function ref(value) {
  const json = JSON.stringify(value);
  return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
}

function fixture() {
  const world = { id: "unit-handoff-local", kind: "unit-handoff", goal: "Review the manifest and prepare the owned icon draft." };
  const unit = { path: "extensions/testing", name: "testing", kind: "extension", description: "Own the local fixture." };
  const plan = { path: unit.path, focus: "joined", inspectLifecycle: false, stageIcon: true, requireProtectedSource: false, reason: "Use the requested extension." };
  const observation = {
    unit, revision: "working", mainRevision: "protected", manifest: null,
    designRequest: { kind: "extension-design-live", goal: world.goal, operationId: "design" },
    identityRequest: { goal: world.goal, unit, operationId: "icon", prepare: true },
  };
  const native = { decision: "ready", finding: "prerequisites-verified", evidenceIds: ["working", "protected"] };
  const design = { native, manifest: "protected-match", lifecycle: null };
  const original = { repoPath: unit.path, revision: "working", icon: null, artworkDigest: null };
  const intent = { family: "lucide", term: "bell" };
  const candidate = { choice: { family: "lucide", id: "lucide:bell" }, declaration: "./assets/icon.svg", artworkDigest: "actual" };
  const change = { repoPath: unit.path, revision: "draft", icon: candidate.declaration, artworkDigest: "actual",
    mainUnchanged: true, manifestOtherwiseUnchanged: true, changedFiles: ["package.json", "assets/icon.svg"] };
  const identity = { observed: original, intent, assessment: { candidate, next: "prepare" }, change, outcome: "prepared" };
  const outcome = { decision: "staged", plan, observation, design, identity, reason: "The candidate is ready for private review." };
  const contextId = "owned";
  const checks = Object.fromEntries(["owned_selection", "manifest_versions", "build_lifecycle",
    "catalog_and_artwork", "local_effect_and_protected_main", "conclusion"].map(check => [check, true]));
  const proof = { caseId: world.id, goal: world.goal, contextId, checks, passed: true,
    unitHandoff: { report: structuredClone(outcome), calls: [] } };
  const report = { status: "workspace-skill-reviewed", skill: "unitHandoff", outcome };
  const calls = [];
  function node(parent, name, inputs, output) {
    const id = String(calls.length);
    const record = { call_id: id, parent_call_id: parent?.call_id, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
      ...(output === undefined ? {} : { output: ref(output) }), effects: [] };
    calls.push({ callId: id, record });
    return record;
  }
  function effect(parent, service, method, args, result) {
    proof.unitHandoff.calls.push(structuredClone({ service, method, inputs: args, result }));
    const entry = { service, method, args: ref(args), result: ref(result) };
    parent.effects.push(entry);
    return entry;
  }
  const root = node(null, "runUserGoal", { goal: world.goal });
  const skill = node(root, "reviewUnitHandoffGoal", { goal: world.goal }, outcome);
  effect(skill, "unitHandoff", "discover", [], [unit]);
  effect(skill, "unitHandoff", "begin", [unit.path], observation);
  const choose = node(skill, "chooseUnit", { goal: world.goal, units: [unit] }, plan);
  const stage = { goal: world.goal, plan, observation };
  const designStage = node(skill, "reviewDesign", stage, design);
  const designNative = node(designStage, "reviewWorkspaceUnit", { request: observation.designRequest }, native);
  effect(designNative, "extensionDesignRead", "inspect", ["design"], { workingRevision: "working" });
  const identityStage = node(skill, "reviewIdentity", { ...stage, design }, identity);
  const iconNative = node(identityStage, "prepareUnitIdentity", { request: observation.identityRequest }, identity);
  effect(iconNative, "unitIdentity", "observe", ["icon"], original);
  effect(iconNative, "unitIdentity", "resolve", ["icon", intent], candidate);
  const edit = effect(iconNative, "unitIdentity", "stage", ["icon", "working", "lucide:bell"], change);
  node(skill, "completeHandoff", { ...stage, design, identity }, outcome);
  return { choose, designNative, iconNative, edit, validate() {
    return openTemplateGoalEvidence({ diagnostics: { openGoalVerification: proof }, provenance: { contextId } },
      { report, calls, rootCallIds: [root.call_id] }, world.id, { assignment: world });
  } };
}

test("binds a jointly reviewed manifest, the installed identity hierarchy and the exact staged readback", () => {
  assert.ok(fixture().validate());
});
test("rejects a different inventory or an unrelated manifest review receipt", () => {
  const invalidInventory = fixture();
  invalidInventory.choose.inputs.units = ref([]);
  assert.throws(() => invalidInventory.validate(), /Expected the assigned unit/);
  const invalidManifest = fixture();
  invalidManifest.designNative.inputs.request = ref({ operationId: "previous-design" });
  assert.throws(() => invalidManifest.validate(), /Expected the assigned unit/);
});
test("rejects a stale edit basis or a replacement installed icon result", () => {
  const stale = fixture();
  stale.edit.args = ref(["icon", "old", "lucide:bell"]);
  assert.throws(() => stale.validate(), /Expected the assigned unit/);
  const anotherIcon = fixture();
  anotherIcon.iconNative.output = ref({ outcome: "design-only" });
  assert.throws(() => anotherIcon.validate(), /Expected the assigned unit/);
});
