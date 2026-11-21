import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

function ref(value) {
  const bytes = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(bytes), hash: createHash("sha256").update(bytes).digest("hex") };
}
function effect(service, method, args, result) {
  return { service, method, args: ref(args), result: ref(result) };
}
function node(callId, parent, name, inputs, output, effects = []) {
  return { callId, record: { call_id: callId, parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])), output: ref(output), effects } };
}
function caseTrace(verified) {
  const contextId = "owned-context";
  const goal = "Check the saved review before we continue from its current workspace.";
  const observed = { serverId: "server", bootId: "current", workspaceId: "workspace" };
  const request = { goal, operationId: "operation", serverId: "server", workspaceId: verified ? "workspace" : "retired" };
  const docket = { id: "docket", name: "Review", revision: "retained", current: true };
  const available = [{ id: "older", name: "Review archive", revision: "previous", current: false }, docket];
  const selected = { docket, request };
  const gateway = { observed, verdict: verified ? "verified" : "workspace-mismatch",
    layer: verified ? "healthy" : "workspace-routing", next: verified ? "accept-identity" : "refresh-workspace-reach" };
  const scope = verified ? { gateway: observed, credential: { kind: "device" }, operation: "inspect", selectors: { binding: { contextId } } } : null;
  const expected = verified ? { source: "binding", contextId, status: "usable", action: "run-assigned-command", gateway: observed } : null;
  const outcome = { status: verified ? "reviewed" : "held", docket, gateway, continuation: expected, reason: "Checked the exact workspace." };
  const report = { status: "workspace-skill-reviewed", skill: "cliRoute", outcome };
  const world = { kind: "cli-route", id: "retained-docket", goal, gateway: gateway.verdict };
  const calls = [
    node("root", null, "runUserGoal", { goal }, report),
    node("main", "root", "recoverCliRoute", { goal }, outcome),
    node("select", "main", "selectCliDocket", { goal }, selected, [
      effect("cliRouteDocket", "list", [], available), effect("cliRouteDocket", "read", [docket.id, docket.revision], selected),
    ]),
    node("gateway", "main", "reviewRemoteRoute", { request }, gateway),
    node("identity", "gateway", "readGatewayIdentity", { operationId: request.operationId }, observed,
      [effect("remoteGatewayIdentity", "observe", [request.operationId], observed)]),
    node("route", "gateway", "routeHandoff", { verdict: gateway.verdict, layer: gateway.layer }, gateway.next),
  ];
  if (verified) calls.push(
    node("scope", "main", "planCliContinuation", { request }, expected,
      [effect("remoteCliScope", "evidence", [request.operationId], scope)]),
    node("precedence", "scope", "selectContextSource", { selectors: scope.selectors }, scope.selectors.binding),
    node("assessment", "scope", "assessCliContext", { gateway: observed }, expected.status),
    node("check", "scope", "chooseCliAction", { status: expected.status }, expected.action),
  );
  const checks = Object.fromEntries(["independentlyObservedCurrentCliDocket", "exactAuthenticatedCliGateway",
    "boundAuthorizedCliContinuation", "preservedReadOnlyContinuation", "matchedCliRouteDisposition"].map(key => [key, true]));
  const diagnostics = { openGoalVerification: { caseId: world.id, contextId, goal, passed: true, checks,
    docket, observed, selected, available, scope, expected, outcome } };
  const trace = { rootCallIds: ["root"], calls, report };
  return { trace, run: (candidate = trace) =>
    openTemplateGoalEvidence({ provenance: { contextId }, diagnostics }, candidate, undefined, { assignment: world }) };
}

test("requires both installed native reviews with the exact same retained invocation", () => {
  const { trace, run } = caseTrace(true);
  assert.ok(run().checks.exactAuthenticatedCliGateway);
  for (const edit of [
    trace => { trace.calls[2].record.effects[1].args = ref(["older", "retained"]); },
    trace => { trace.calls[4].record.effects[0].result = ref({ bootId: "wrong" }); },
    trace => { trace.calls[6].record.effects[0].args = ref(["other-operation"]); },
    trace => { trace.calls[8].record.parent_call_id = "main"; },
  ]) {
    const bad = structuredClone(trace);
    edit(bad);
    assert.throws(() => run(bad), /Expected/u);
  }
});

test("keeps scope unread after the current gateway and saved workspace disagree", () => {
  const { trace, run } = caseTrace(false);
  assert.ok(run().checks.boundAuthorizedCliContinuation);
  trace.calls[3].record.effects.push(effect("remoteCliScope", "evidence", ["operation"], {}));
  assert.throws(run, /without scope reads/u);
});
