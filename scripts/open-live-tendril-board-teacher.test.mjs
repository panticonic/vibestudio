import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

function ref(value) {
  const bytes = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(bytes), hash: createHash("sha256").update(bytes).digest("hex") };
}
const effect = (service, method, args, result) => ({ service, method, args: ref(args), result: ref(result) });
function node(callId, parent, name, inputs, output, effects = []) {
  return { callId, record: { call_id: callId, parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])), output: ref(output), effects } };
}

test("binds the installed Tendril step to native display and durable revision", () => {
  const contextId = "owned-board", goal = "Display the board and set its handoff timer to five.";
  const card = { id: "ticket", title: "Board", edition: "current" };
  const ticket = { card, platform: "headless", fields: [{ key: "minutes", shape: "integer" }], controls: [], layouts: [] };
  const available = [{ ...card, id: "older", edition: "archive" }, card];
  const step = { kind: "write", field: { key: "minutes", value: 5 } };
  const plan = { goal, platforms: ["headless"], allowPending: false, steps: [step] };
  const presentation = { deviceId: "device", slotId: "slot", state: "presented" };
  const baseline = { id: "initial", slotId: "slot", build: "board-v1", revision: 0, stored: [], displayed: [], exposed: [] };
  const current = { ...baseline, id: "current", revision: 1, stored: [step.field], displayed: [step.field] };
  const finding = { status: "verified", evidence: [baseline.id, current.id], page: current };
  const actual = { state: "verified", presentation, findings: [finding] };
  const outcome = { card, plan, actual, reason: "The rendered and stored values agree." };
  const report = { status: "workspace-skill-reviewed", skill: "liveTendrilBoard", outcome };
  const world = { kind: "live-tendril-board", id: "board", goal, fixture: { request: plan } };
  const calls = [
    node("root", null, "runUserGoal", { goal }, report),
    node("board", "root", "workOnLiveTendrilBoard", { goal }, outcome),
    node("ticket", "board", "findLiveTendrilTicket", { goal }, ticket, [
      effect("tendrilBoardDocket", "list", [], available), effect("tendrilBoardDocket", "read", [card.id], ticket),
    ]),
    node("plan", "board", "planLiveTendrilEffect", { goal, ticket }, plan),
    node("workflow", "board", "runTendril", { request: plan }, actual),
    node("present", "workflow", "openPresentation", { request: plan }, presentation,
      [effect("tendrilPresentation", "devices", [], [{ id: "device", online: true }]),
        effect("tendrilPresentation", "present", ["device"], presentation)]),
    node("steps", "workflow", "runSteps", { presentation, steps: [step] }, [finding],
      [effect("tendrilPage", "inspect", [], baseline)]),
    node("step", "steps", "reviewLiveStep", { previous: baseline, step }, finding,
      [effect("tendrilPage", "write", [step.field], current)]),
  ];
  const checks = Object.fromEntries(["exactCurrentTendrilTicket", "exactPlannedTendrilEffects", "ownedTendrilPresentation",
    "independentlyObservedRenderedAndStored", "verifiedTendrilBuildHistory", "matchedTendrilGoalReport"].map(key => [key, true]));
  const diagnostics = { openGoalVerification: { passed: true, checks, goal, caseId: world.id, contextId,
    ticket, available, outcome, native: { presentation, observed: [baseline, current] } } };
  const verify = (candidate = calls) => openTemplateGoalEvidence(
    { provenance: { contextId }, diagnostics }, { rootCallIds: ["root"], calls: candidate, report },
    undefined, { assignment: world },
  );
  assert.ok(verify().checks.independentlyObservedRenderedAndStored);
  const stale = structuredClone(calls);
  stale[7].record.inputs.previous = ref(current);
  assert.throws(() => verify(stale), /preceding native observation/u);
  const falseDisplay = structuredClone(calls);
  falseDisplay[7].record.effects[0].result = ref({ ...current, displayed: [] });
  assert.throws(() => verify(falseDisplay), /rendered and durable/u);
});
