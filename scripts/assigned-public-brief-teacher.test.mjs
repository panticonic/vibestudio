import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const text = JSON.stringify(value);
  return { complete: true, hash: hash(text), bytes: Buffer.byteLength(text) };
}

function fixture(held = false) {
  const source = "https://example.com/";
  const second = "https://www.iana.org/help/example-domains";
  const world = {
    kind: "assigned-public-brief",
    id: "test-brief",
    goal: "Use the two assigned documents to advise our handbook editor.",
    sources: [source, second],
    facts: held ? [] : [{ source, pattern: "documentation examples" }],
    conclusions: held ? [] : [/permission/u],
  };
  const contextId = "private-context";
  const retrievedAt = Date.UTC(2026, 10, 21);
  const request = { goal: world.goal, sources: world.sources, retrievedAt };
  const head = "You may use this domain in documentation examples without needing permission.";
  const reads = world.sources.map(url => ({ requested: url, page: {
    title: new URL(url).hostname, url, digest: hash(head), head, headBytes: Buffer.byteLength(head),
    size: Buffer.byteLength(head), session: "public", truncated: false,
  } }));
  const brief = { question: world.goal, status: held ? "insufficient" : "answered", statements: held ? [] : [
    { text: "Use this example without permission.", cites: [
      { url: source, title: reads[0].page.title, quote: head, retrieved: "2026-11-21", published: null },
    ] },
  ], notRead: [] };
  const outcome = { decision: held ? "held" : "supported", brief };
  const shared = {
    caseId: world.id, contextId, request, reads, tails: [], passed: true,
    cache: reads.map(({ requested, page }) => ({ requested, verified: true, digest: page.digest, size: page.size, visible: page.head })),
    checks: { assigned: true, continuations: true, cache: true, outcome: true, citations: true },
  };
  const proof = {
    caseId: world.id, contextId, goal: world.goal, passed: true,
    checks: { exact_assigned_urls: true, verified_cache: true, exact_citations: true, grounded_decision: true },
    assignedPublicBrief: { outcome, binding: { sources: world.sources, request }, shared },
  };
  const calls = [];
  function node(parent, name, inputs, output) {
    const id = String(calls.length);
    const record = {
      call_id: id, parent_call_id: parent?.call_id, definition: { name }, outcome: "done", effects: [],
      inputs: Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, ref(value)])),
      ...(output === undefined ? {} : { output: ref(output) }),
    };
    calls.push({ callId: id, record });
    return record;
  }
  function effect(parent, service, method, args, result) {
    const item = { service, method, args: ref(args), result: ref(result) };
    parent.effects.push(item);
    return item;
  }
  const root = node(null, "runUserGoal", { goal: world.goal });
  const assignedSources = node(root, "answerFromAssignedPublicSources", { goal: world.goal }, outcome);
  const selected = node(assignedSources, "selectAssignedSources", { goal: world.goal }, world.sources);
  const binding = effect(assignedSources, "publicBrief", "bind", [world.sources], request);
  const assigned = node(assignedSources, "writeAssignedBrief", { request }, brief);
  const research = node(assigned, "researchBrief", { question: world.goal, sources: world.sources, retrievedAt }, brief);
  node(research, "findEvidence", {});
  if (!held) node(research, "writeBrief", {});
  const fetches = reads.map(({ requested, page }) =>
    effect(research, "web", "fetch", [{ url: requested, session: "public" }], page));
  return { world, proof, outcome, selected, binding, assignedSources, assigned, research, fetches, verify() {
    return openTemplateGoalEvidence({ diagnostics: { openGoalVerification: proof }, provenance: { contextId } }, {
      report: { status: "workspace-skill-reviewed", skill: "publicBrief", outcome }, calls, rootCallIds: [root.call_id],
    }, world.id, { assignment: world });
  } };
}

test("accepts a directly fetched answer and an independently fetched insufficient-evidence hold", () => {
  assert.ok(fixture().verify());
  assert.ok(fixture(true).verify());
});

test("rejects reordered or substituted selected URL inputs", () => {
  const reordered = fixture();
  reordered.binding.args = ref([[...reordered.world.sources].reverse()]);
  assert.throws(() => reordered.verify(), /exact ordered URLs/u);
  const substituted = fixture();
  substituted.selected.output = ref(["https://unassigned.example/"]);
  assert.throws(() => substituted.verify(), /exact ordered URLs/u);
});

test("rejects a dropped fetch receipt or a new search effect", () => {
  const missing = fixture();
  missing.fetches[0].result = ref({ session: "public", digest: "wrong" });
  assert.throws(() => missing.verify(), /actual fetched page/u);
  const searched = fixture();
  searched.research.effects.push({ service: "web", method: "search" });
  assert.throws(() => searched.verify(), /exact assigned public URLs/u);
});

test("rejects a forged citation or an unjustified approval on the held evidence", () => {
  const forged = fixture();
  forged.outcome.brief.statements[0].cites[0].quote = "Anyone who uses this domain is guaranteed legal approval.";
  forged.assignedSources.output = ref(forged.outcome);
  forged.assigned.output = ref(forged.outcome.brief);
  forged.research.output = ref(forged.outcome.brief);
  assert.throws(() => forged.verify(), /citations must quote/u);
  const held = fixture(true);
  held.outcome.decision = "supported";
  held.assignedSources.output = ref(held.outcome);
  assert.throws(() => held.verify(), /preserve the installed outcome/u);
});
