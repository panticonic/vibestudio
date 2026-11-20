import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const bytes = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(bytes), hash: hash(bytes) };
}
function fixture(branch) {
  const stage = branch === "stage";
  const allowed = branch !== "revoked";
  const world = { id: "news-proof", kind: "news-evidence", goal: "Review the owned archive and cadence.",
    expected: { action: stage ? "stage" : "hold" } };
  const { goal } = world;
  const scope = { channelId: "owned", contextId: "context", generation: "gen" };
  const index = { scope, topics: [{ id: "topic", title: "Bridge repairs" }] };
  const snapshots = [{ channelId: scope.channelId, through: 1, rows: [] }, { channelId: scope.channelId, through: 2, rows: [] }];
  const planFacts = { channelId: "owned", through: 2, topic: "topic", action: world.expected.action,
    reason: stage ? "grounded-development" : allowed ? "primary-read-missing" : "reader-revoked" };
  const plan = { ...planFacts, explanation: "The exact retained evidence is recorded." };
  const schedule = { input: { kind: "schedule", intent: { kind: "manual" } }, result: { status: "ready" } };
  const readers = allowed ? ["inbox", "archive"].map(kind => ({
    selection: kind === "archive" ? { kind, query: "Bridge repairs" } : { kind },
    input: { kind: "reader", view: kind },
    result: { status: "ready", findings: [{ code: "loaded-to-end", evidenceIds: [kind] }] },
  })) : [];
  const value = stage ? { message: "original", text: "Bridge repairs remain on schedule", digest: "digest" } : null;
  const sourceRecords = allowed ? [{ message: "original", value }] : [];
  const briefing = allowed ? { input: { kind: "briefing", id: "edition" }, result: { status: stage ? "ready" : "attention" } } : null;
  const sources = value ? [value] : [];
  const artifact = stage ? JSON.stringify({ sources, plan }) : null;
  const handoff = artifact ? { sha256: hash(artifact), bytes: Buffer.byteLength(artifact), path: "/.tmp/handoff.json" } : null;
  const proof = {
    index, snapshots, caseId: world.id, goal, contextId: scope.contextId, passed: true,
    independent: { plan: planFacts, schedule, briefing, boundary: { reason: allowed ? "verified-reader" : "reader-revoked" } },
    reads: readers.map(({ selection, input }) => ({ selection, input })),
    sources: sourceRecords, handoff, artifact,
    checks: { exactNewsFrontiers: true, exactNewsAuthority: true, exactNewsReaderWindows: true, independentlyReadNewsSources: true,
      exactNewsCadence: true, groundedNewsEdition: true, verifiedPrivateNewsHandoff: true, preservedNewsWorkspace: true, rejectedNewsRetarget: true },
  };
  const outcome = { plan, readers, schedule, briefing, sources, handoff };
  const report = { status: "workspace-skill-reviewed", skill: "newsEvidence", outcome };
  const calls = [];
  const call = (name, fields) => {
    const record = { call_id: name + "-" + calls.length, definition: { name }, outcome: "done", ...fields };
    calls.push({ callId: record.call_id, record });
    return record;
  };
  const effect = (service, method, args, result) => ({ service, method, args: ref(args), result: ref(result) });
  const root = call("runUserGoal", { inputs: { goal: ref(goal) } });
  const workflow = call("workOnNewsEvidenceGoal", { parent_call_id: root.call_id, inputs: { goal: ref(goal) } });
  const listing = effect("newsEvidenceIndex", "list", [], index);
  call("discoverOwnedNewsEvidence", { effects: [listing] });
  const frontier = snapshots.map(snapshot => effect("newsEvidenceJournal", "read", [scope.channelId], snapshot));
  call("readNewsEvidenceFrontier", { effects: frontier });
  call("chooseNewsCoverage", { parent_call_id: workflow.call_id, inputs: { goal: ref(goal), index: ref(index) } });
  call("checkNewsReaderBoundary", { parent_call_id: workflow.call_id,
    inputs: { earlier: ref(snapshots[0]), current: ref(snapshots[1]), index: ref(index) } });
  function bind(parent, wrapperName, name, witness) {
    const wrapper = call(wrapperName, { parent_call_id: parent.call_id, output: ref(witness) });
    return call(name, { parent_call_id: wrapper.call_id, inputs: { input: ref(witness.input) }, output: ref(witness.result) });
  }
  const owner = bind(workflow, "reviewNewsOwnerCadence", "reviewSchedule", schedule);
  const windows = readers.map(reader => {
    bind(workflow, "reviewNewsReaderWindow", "readReader", reader);
    return effect("newsEvidenceReader", "read", [scope.channelId, reader.selection], reader.input);
  });
  if (windows.length) call("readNewsEvidenceView", { effects: windows });
  const originals = sourceRecords.map(source => effect("newsEvidenceSource", "read", [scope.channelId, source.message], source.value));
  if (originals.length) call("readNewsArticleBytes", { effects: originals });
  if (briefing) {
    const ground = call("groundNewsEdition", { parent_call_id: workflow.call_id, inputs: { current: ref(snapshots[1]) } });
    bind(ground, "reviewNewsDevelopments", "synthesizeBriefing", briefing);
  }
  call("decideNewsEvidenceHandoff", { parent_call_id: workflow.call_id,
    inputs: { current: ref(snapshots[1]), briefing: ref(briefing) }, output: ref(plan) });
  const write = handoff ? effect("newsEvidenceHandoff", "stage", [{ ...outcome, handoff: null }], handoff) : null;
  if (write) call("stageNewsEvidenceNote", { effects: [write] });
  const execution = { diagnostics: { openGoalVerification: proof }, provenance: { contextId: scope.contextId } };
  return { listing, frontier, proof, owner, windows, originals, write, validate() {
    workflow.output = ref(report.outcome);
    return openTemplateGoalEvidence(execution, { calls, rootCallIds: [root.call_id], report }, world.id, { assignment: world });
  } };
}

test("retained News export matches complete refs for the exact private evidence", () => {
  for (const branch of ["stage", "missing", "revoked"]) assert.doesNotThrow(fixture(branch).validate);
  const negatives = [
    sample => { sample.listing.result = sample.proof.index; },
    sample => { sample.frontier[1].result = sample.frontier[0].result; },
    sample => { sample.windows[1].args = ref(["foreign", { kind: "archive", query: "Bridge repairs" }]); },
    sample => { sample.owner.output.complete = false; },
    sample => { sample.originals[0].args = ref(["owned", "obsolete"]); },
    sample => { sample.write.result.hash = hash("other-artifact"); },
    sample => { sample.proof.artifact += "new bytes"; },
  ];
  for (const mutate of negatives) {
    const sample = fixture("stage");
    mutate(sample);
    assert.throws(sample.validate, /Expected the exact retained News reader/u);
  }
});
