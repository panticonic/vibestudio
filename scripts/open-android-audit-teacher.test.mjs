import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

function valueRef(value) {
  const text = JSON.stringify(value);
  return { complete: true, hash: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
}

function call(callId, parent, name, inputs, output, effects = []) {
  return { callId, record: {
    call_id: callId, parent_call_id: parent, definition: { name }, outcome: "done",
    inputs: Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, valueRef(value)])),
    output: valueRef(output),
    effects: effects.map(({ service, method, args, result }) => ({
      service, method, args: valueRef(args), result: valueRef(result),
    })),
  } };
}

function evidence({ foreign = false, appOperation = "audit/one", status = "workspace-unverified", extraApp = false } = {}) {
  const world = {
    id: "assigned-emulator-audit", kind: "android-audit", goal: "Audit the assigned app without changing it.",
    mode: foreign ? "foreign" : "application", expectedStatus: "workspace-unverified",
  };
  const scope = { operationId: "audit/one", target: foreign ? "emulator-0" : "emulator-5554" };
  const request = { goal: world.goal, ...scope, intent: "application" };
  const observed = { target: scope.target, state: foreign ? null : "device" };
  const application = {
    target: scope.target, packageName: "app.vibestudio.mobile.internal", installed: true,
    processObserved: true, screenshotCaptured: true, screenshotBytes: 123, issues: [],
  };
  const report = {
    targetObservation: observed, targetReview: foreign ? "target-absent" : "target-ready",
    runtime: foreign ? null : { observation: application, status, image: "captured" },
  };
  const outcome = { scope, request, report };
  const envelope = { status: "workspace-skill-reviewed", skill: "androidGoalAudit", outcome };
  const calls = [
    call("root", null, "runUserGoal", { goal: world.goal }, envelope),
    call("audit", "root", "auditAndroidGoal", { goal: world.goal }, outcome),
    call("scope", "audit", "readAndroidAuditScope", { goal: world.goal }, scope,
      [{ service: "androidGoalAudit", method: "readScope", args: [world.goal], result: scope }]),
    call("plan", "audit", "planAndroidGoalAudit", { goal: world.goal, scope }, request),
    call("installed", "audit", "auditAndroidRuntime", { request }, report,
      [{ service: "androidRuntimeAudit", method: "observeTarget", args: [scope.operationId], result: observed }]),
    call("target", "installed", "reviewTarget", { observation: observed }, report.targetReview),
  ];
  if (!foreign || extraApp) calls.push(
    call("app", "installed", "reviewRuntime", { operationId: appOperation }, report.runtime,
      [{ service: "androidRuntimeAudit", method: "observeApplication", args: [appOperation], result: application }])
  );
  const proof = {
    caseId: world.id, goal: world.goal, contextId: "owned", passed: true,
    checks: { boundExactAndroidAudit: true, verifiedNativeAndroidTarget: true, verifiedNativeAndroidRuntime: true },
    scope, outcome, native: { request, observed, application: foreign ? null : application },
  };
  return openTemplateGoalEvidence({ provenance: { contextId: "owned" }, diagnostics: { openGoalVerification: proof } },
    { calls, report: envelope, rootCallIds: ["root"] }, null, { assignment: world });
}

test("binds the exact target, process and display result without inventing workspace readiness", () => {
  assert.equal(evidence().checks.verifiedNativeAndroidRuntime, true);
  assert.throws(() => evidence({ status: "workspace-ready" }), /exact runtime report/u);
  assert.throws(() => evidence({ appOperation: "audit/neighbor" }), /exact runtime report/u);
});

test("an absent exact target cannot authorize an app read", () => {
  assert.equal(evidence({ foreign: true }).checks.verifiedNativeAndroidTarget, true);
  assert.throws(() => evidence({ foreign: true, extraApp: true }), /permitted native app observation/u);
});
