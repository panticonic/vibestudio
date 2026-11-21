import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const ref = value => {
  const text = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex") };
};

function exerciseCase(held) {
  const goal = "Review the current register training and retain a private dossier if the new approval clears.";
  const request = { kind: "release-continuation", goal,
    before: [{ id: "signoff", state: "pending" }], after: [{ id: "signoff", state: "approved" }] };
  const world = { kind: "owned-operations", id: "register", goal, request,
    authority: held ? "review-only" : "local-exercise", retainWhenReady: true,
    expected: { roles: { release: { decisions: ["blocked", "ready"], evidenceIds: ["signoff"] } }, decision: "ready" } };
  const docket = { id: "docket", title: "Register", revision: "docket-revision", kind: request.kind, edition: "current" };
  const evidence = { docket, authority: world.authority, request, retainWhenReady: true };
  const available = [{ ...docket, id: "previous", edition: "retired" }, docket];
  const handle = { id: "worker", contextId: "worker-context", targetId: "owned-target", role: "release" };
  const assessment = { role: "release", decision: "ready", evidenceIds: ["signoff"], reason: "The current record confirms approval." };
  const first = { ...assessment, decision: "blocked", reason: "The retained gate is still pending." };
  const before = { revision: 1, checkpoints: [{ revision: 1, assessment: first }] };
  const after = { revision: 2, checkpoints: [...before.checkpoints, { revision: 2, assessment }] };
  const cleanup = { retiredIds: [handle.id], destroyedContextIds: [handle.contextId] };
  const handoff = { decision: "ready", evidenceIds: ["signoff"], summary: "The later record approves." };
  const operation = { kind: request.kind, handoff, handles: [handle], cleanup };
  const record = JSON.stringify({ docket, checkpoints: after.checkpoints, handoff });
  const receipt = { path: "/scratch/private.json", digest: createHash("sha256").update(record).digest("hex") };
  const outcome = { docket, operation: held ? null : operation, dossier: held ? null : receipt,
    disposition: held ? "held" : "reviewed", reason: "Verified locally." };
  const report = { status: "workspace-skill-reviewed", skill: "ownedOperations", outcome };
  const audit = {
    opened: held ? [] : [{ handle }], remainingContextIds: [], remainingEntityIds: [],
    programRequestedCleanup: !held, ...(held ? { retiredIds: [], destroyedContextIds: [] } : cleanup),
    restarts: held ? [] : [{ handle }],
    snapshots: held ? [] : [
      { handle, value: before, phase: "before-restart" }, { handle, value: before, phase: "after-restart" },
      { handle, value: after, phase: "before-cleanup" },
    ],
  };
  const effect = (service, method, args, result) => ({ service, method, args: ref(args), result: ref(result) });
  const worker = (method, args, result) => effect("ownedOperations", method, args, result);
  function node(callId, parent, name, inputs, output, effects = []) {
    return { callId, record: { call_id: callId, parent_call_id: parent, definition: { name }, outcome: "done",
      inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])), output: ref(output), effects } };
  }
  const calls = [
    node("root", null, "runUserGoal", { goal }, report),
    node("review", "root", "coordinateOwnedOperations", { goal }, outcome, held ? [] : [worker("close", [], cleanup)]),
    node("select", "review", "selectOperationsDocket", { goal }, evidence, [
      effect("operationsDocket", "list", [], available), effect("operationsDocket", "read", [docket.id, docket.revision], evidence),
    ]),
  ];
  if (!held) calls.push(
    node("release", "review", "release", { goal, before: request.before, after: request.after }, { handoff, handles: [handle] }, [
      worker("open", ["release"], handle), worker("append", [handle, 0, first], before),
      worker("restart", [handle], before), worker("append", [handle, 1, assessment], after), worker("read", [handle], after),
    ]),
    node("before", "release", "assessGate", { gates: request.before }, first),
    node("after", "release", "assessGate", { gates: request.after }, assessment),
    node("handoff", "release", "handoff", { goal, checkpoints: after.checkpoints }, handoff),
    node("retain", "review", "retainOperationsDossier", { docket, operation }, receipt,
      [effect("operationsDossier", "retain", [docket.id, docket.revision, operation], receipt)]),
  );
  const checks = Object.fromEntries(["exactCurrentOwnedDocket", "exactBoundRoleDisposition", "preservedAuthorization",
    "actualPrivateDossierReadback", "preservedWorkspaceHead"].map(name => [name, true]));
  const proof = { passed: true, contextId: "parent-context", caseId: world.id, goal, checks, audit, outcome, docket,
    artifact: outcome.dossier, effects: { list: [available], reads: [evidence], dossiers: held ? [] : [{ result: receipt, record }] } };
  const trace = { calls, report, rootCallIds: ["root"] };
  const run = (candidate = trace) => openTemplateGoalEvidence(
    { provenance: { contextId: proof.contextId }, diagnostics: { openGoalVerification: proof } },
    candidate, undefined, { assignment: world },
  );
  return { run, trace };
}

test("accepts a private release dossier only with the original docket and durable restart evidence", () => {
  const { run, trace } = exerciseCase(false);
  assert.ok(run().checks.actualPrivateDossierReadback);
  for (const invalidate of [
    trace => { trace.calls[2].record.effects[1].args = ref(["foreign-docket", "docket-revision"]); },
    trace => { trace.calls[3].record.effects[2].method = "read"; },
    trace => { trace.calls[5].record.parent_call_id = "review"; },
    trace => { trace.calls.at(-1).record.effects[0].result = ref({ path: "/wrong-private-record" }); },
  ]) {
    const bad = structuredClone(trace);
    invalidate(bad);
    assert.throws(() => run(bad), /Expected/u);
  }
});

test("accepts a review-only decision with no worker or dossier effects", () => {
  const { run, trace } = exerciseCase(true);
  assert.ok(run().checks.preservedAuthorization);
  trace.calls[1].record.effects.push({ service: "ownedOperations", method: "open" });
  assert.throws(run, /review-only/u);
});
