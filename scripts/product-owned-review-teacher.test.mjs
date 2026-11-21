import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const text = JSON.stringify(value);
  return { complete: true, hash: hash(text), bytes: Buffer.byteLength(text) };
}
const rejected = /Expected exact product-owned evidence/;

function fixture(kind, callable, skillName, outcome, witness, checks) {
  const world = { kind, id: kind + "-test", goal: "Use authorized current evidence for the private review." };
  const contextId = "owned";
  const proof = { caseId: world.id, contextId, goal: world.goal, passed: true,
    checks: Object.fromEntries(checks.map(key => [key, true])), productReview: { ...witness, report: outcome, calls: [] } };
  const calls = [];
  function node(parent, name, inputs, output) {
    const id = String(calls.length);
    const record = { call_id: id, parent_call_id: parent?.call_id, definition: { name }, outcome: "done", effects: [],
      inputs: Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, ref(value)])),
      ...(output === undefined ? {} : { output: ref(output) }) };
    calls.push({ callId: id, record });
    return record;
  }
  function effect(parent, service, method, args, result, witness = true) {
    const item = { service, method, args: ref(args), result: ref(result) };
    parent.effects.push(item);
    if (witness) proof.productReview.calls.push({ service, method, args, result });
    return item;
  }
  const root = node(null, "runUserGoal", { goal: world.goal });
  const skill = node(root, callable, { goal: world.goal }, outcome);
  return { node, effect, skill, verify() {
    return openTemplateGoalEvidence({ diagnostics: { openGoalVerification: proof }, provenance: { contextId } }, {
      report: { status: "workspace-skill-reviewed", skill: skillName, outcome }, calls, rootCallIds: [root.call_id],
    }, world.id, { assignment: world });
  } };
}
const attribution = { kind: "attribution", origin: "external-import", references: ["source", "action"],
  supportedIntent: "permission", boundary: "private" };

function google() {
  const basis = { documents: [{ path: "runbook", version: "before", text: "Old" }], authorization: "private-draft", currentRevision: "before" };
  const calendar = { decision: { status: "selected", selection: { revision: "event" }, evidence: [] }, handoff: null };
  const decision = { action: "revise", path: "runbook", approval: "permission", reason: "Current" };
  const write = { path: "runbook", status: "written", version: "after" };
  const report = { calendar, decision, attribution, write };
  const catalog = [{ id: "owned-calendar" }];
  const readback = { requested: calendar.decision.selection, observed: { status: "current", record: calendar.decision.selection } };
  const f = fixture("google-runbook", "reconcileGoogleRunbook", "googleRunbook", report,
    { bases: [basis], calendar: { passed: true, catalog, readback } },
    ["current_calendar", "runbook_authority", "exact_basis_attribution", "exact_runbook_result", "preserved_workspace"]);
  const { node, effect, skill } = f;
  effect(skill, "googleRunbook", "read", [], basis);
  const observed = node(skill, "reviewCalendar", { local: basis }, calendar);
  const calendarChild = node(observed, "workOnCalendarGoal", {}, calendar);
  effect(calendarChild, "calendarGoalCatalog", "discover", [], catalog, false);
  const exactEvent = effect(calendarChild, "calendarGoalReadback", "verify", [readback.requested], readback.observed, false);
  node(skill, "reconcileApproval", { calendar, local: basis }, decision);
  const attributed = node(skill, "attributeBasis", { local: basis }, attribution);
  node(attributed, "reviewProvenance", {}, attribution);
  const revised = node(skill, "reviseRunbook", { decision }, write);
  const proposal = { path: "runbook", version: "before", text: "Current" };
  const selected = node(revised, "chooseRevision", {}, proposal);
  effect(revised, "googleRunbook", "apply", [calendar, proposal], write);
  return { ...f, exactEvent, selected };
}

function news() {
  const desk = { id: "private-desk", revision: "current" };
  const source = { articleId: "article", digest: "exact" };
  const news = { plan: { channelId: "reader" }, briefing: { result: { status: "ready" } }, sources: [source], handoff: null };
  const plan = { action: "packet", revision: desk.revision };
  const presentation = { views: [{ id: desk.id, status: "ready", rendered: { component: "Stats" } }], omitted: [] };
  const body = JSON.stringify({ desk, presentation });
  const artifact = { path: "/.tmp/private/handoff.json", bytes: Buffer.byteLength(body), sha256: hash(body) };
  const f = fixture("news-edition-review", "prepareNewsEditionReview", "newsEditionReview",
    { desk, news, plan, presentation, artifact, attribution },
    { news: { passed: true, sources: [{ message: "source-read", value: source }] }, body },
    ["current_news_edition", "exact_desk_authority", "exact_basis_attribution", "verified_editor_packet", "preserved_workspace"]);
  const { node, effect, skill } = f;
  effect(skill, "newsEditionReview", "readDesk", [], desk);
  const reviewed = node(skill, "workOnNewsEvidenceGoal", {}, news);
  effect(reviewed, "newsEvidenceSource", "read", ["reader", "source-read"], source, false);
  node(skill, "reviewBriefing", { news }, true);
  node(skill, "choosePacket", { news, desk }, plan);
  const attributed = node(skill, "attributeBasis", { news }, attribution);
  const provenance = node(attributed, "reviewProvenance", {}, attribution);
  const designed = node(skill, "designEditorPacket", { news }, presentation);
  const rendered = node(designed, "preparePresentation", {}, presentation);
  effect(skill, "newsEditionReview", "stage", [desk, plan, news, presentation], artifact);
  return { ...f, provenance, rendered };
}

test("accepts the Calendar coordinates, attributed basis and exact local revision", () => assert.ok(google().verify()));
test("rejects a replaced Calendar readback or an unrelated revision decision", () => {
  const a = google();
  a.exactEvent.result = ref({ status: "changed" });
  assert.throws(() => a.verify(), rejected);
  const b = google();
  b.selected.output = ref({ path: "another-runbook" });
  assert.throws(() => b.verify(), rejected);
});
test("accepts the retained News source, installed presentation and exact private artifact", () => assert.ok(news().verify()));
test("rejects a replaced visual result or an unrelated provenance subtree", () => {
  const a = news();
  a.rendered.output = ref({ views: [] });
  assert.throws(() => a.verify(), rejected);
  const b = news();
  b.provenance.output = ref({ kind: "route", mechanism: "search" });
  assert.throws(() => b.verify(), rejected);
});
