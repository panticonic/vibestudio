import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world = { id: "source-attribution-local", kind: "source-attribution", goal: "Explain the current rule and retain a private note if authorized." };
const context = "context:local";
const assignment = { id: "owned", goal: world.goal, scope: "projects/owned", mayRetain: true,
  candidates: [{ id: "source-1", path: "src/owned.txt", name: "Current rule" }] };
const file = { candidate: assignment.candidates[0], state: "event:native", file: "stable-file", coordinateKind: "utf16", digest: "content",
  fragments: [{ id: "line-1", start: 0, end: 11, text: "rule active" }] };
const selected = { candidate: "source-1", fragment: "line-1" };
const root = { ref: "root-1", kind: "work-unit", label: "edit", intent: "Allow the new pickup window", tier: "stated", externalSource: null };
const trace = { state: file.state, file: file.file, fragment: selected.fragment, truncated: false,
  spans: [{ id: "source-1:line-1:1", start: 0, end: 11, boundary: "authored", intentTier: "stated", paths: [], work: root.ref,
    command: "root-2", externalSource: null }] };
const evidence = [{ selected, trace, roots: [root] }];
const conclusion = { disposition: "supported", claims: [{ fragment: selected.fragment, span: trace.spans[0].id,
  origin: "native", intent: root.intent, refs: [root.ref] }] };
const receipt = { state: file.state, status: "retained", path: "/.tmp/owned/source-attribution.json", sha256: "stored" };
const outcome = { assignment, files: [file], evidence, conclusion, receipt };
const discovered = { service: "sourceOriginEvidence", method: "discover", args: [], result: assignment };
const fileRead = { service: "sourceOriginEvidence", method: "read", args: [assignment.id, selected.candidate], result: file };
const traced = { service: "sourceOriginGraph", method: "trace", args: [assignment.id, file.state, selected.candidate, selected.fragment], result: trace };
const inspected = { service: "sourceOriginGraph", method: "inspect", args: [assignment.id, root.ref], result: root };
const retained = { service: "sourceOriginReceipt", method: "retain", args: [assignment.id, file.state, conclusion], result: receipt };
const nativeEffects = [discovered, fileRead, traced, inspected, retained];
function ref(value) {
  const text = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex") };
}
function node(id, parent, name, inputs, output, effects = []) {
  return { callId: id, record: { parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([key,value]) => [key,ref(value)])), output: ref(output),
    effects: effects.map(({ args, result, ...rest }) => ({ ...rest,args:ref(args),result:ref(result) })) } };
}
function transcript(outcome, effects) {
  const { assignment, files, evidence, conclusion, receipt } = outcome;
  return { rootCallIds: ["root"], report: { status: "workspace-skill-reviewed", skill: "sourceAttribution", outcome }, calls: [
    node("root", null, "runUserGoal", { goal: world.goal }, outcome),
    node("review", "root", "reviewSourceAttribution", { goal: world.goal }, outcome),
    node("discover", "review", "discoverSourceAttribution", {}, assignment, [effects[0]]),
    node("read", "review", "inspectCurrentSource", { assignment, candidate: selected.candidate }, files[0] ?? null),
    node("file", "read", "readOwnedFile", { assignment, candidate: selected.candidate }, files[0] ?? null, [effects[1]]),
    ...evidence.flatMap(item => [
      node("trace", "review", "traceSelectedSource", { assignment, file, selected }, item),
      node("native", "trace", "traceOwnedRange", { assignment, file, selected }, item.trace, [effects[2]]),
      node("causal", "trace", "inspectOwnedRoot", { assignment, ref: root.ref }, root, [effects[3]]),
    ]),
    node("explain", "review", "explainSourceOrigin", { goal: world.goal, files, evidence }, conclusion),
    ...(receipt ? [node("stage", "review", "reviewAttributionHandoff", { assignment, files, evidence, conclusion }, receipt),
      node("write", "stage", "writeOwnedReceipt", { assignment, state: receipt.state, conclusion }, receipt, [effects[4]])] : []),
  ] };
}
function run(exercise, outcome, effects) {
  return openTemplateGoalEvidence({ provenance: { contextId: context }, diagnostics: { openGoalVerification: {
    caseId: world.id, goal: world.goal, contextId: context, ...outcome, effects, passed: true,
    checks: new Proxy({}, { get: () => true }),
  } } }, exercise, null, { assignment: world });
}

test("retained attribution requires selected range, exact causal root and actual local write", () => {
  const good = transcript(outcome, nativeEffects);
  assert.equal(run(good,outcome,nativeEffects).checks.tracedExactGraphOwner,true);
  const reject = alter => {
    const changed = structuredClone(good);
    alter(changed);
    changed.calls[1].record.output = ref(changed.report.outcome);
    assert.throws(() => run(changed,outcome,nativeEffects), /Expected exact native source attribution/u);
  };
  const byId = (exercise,id) => exercise.calls.find(call => call.callId === id).record;
  reject(exercise => { byId(exercise,"causal").parent_call_id = "review"; });
  reject(exercise => { byId(exercise,"native").effects[0].args = ref([assignment.id,file.state,selected.candidate,"line-2"]); });
  reject(exercise => { byId(exercise,"write").inputs.state = ref("event:stale"); });
  reject(exercise => { exercise.report.outcome.conclusion.claims[0].intent = "Unsupported new intent"; });
});

test("absence remains unverifiable without an invented graph read or receipt", () => {
  const held = { assignment, files: [], evidence: [], conclusion: { disposition: "unverifiable", claims: [] }, receipt: null };
  const effects = [discovered,{ ...fileRead, result: null }];
  const good = transcript(held,effects);
  assert.equal(run(good,held,effects).checks.readExactCurrentSource,true);
  good.calls.push(node("write", "review", "writeOwnedReceipt", { assignment, state: receipt.state, conclusion }, receipt, [retained]));
  assert.throws(() => run(good,held,effects), /Expected exact native source attribution/u);
});
