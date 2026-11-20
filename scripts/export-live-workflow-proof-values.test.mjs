import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
function ref(value) {
  const bytes = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(bytes), hash: hash(bytes) };
}
const effect = (service, method, args, result) => ({ service, method, args: ref(args), result: ref(result) });
const node = (name, calls = [], inputs = {}, output = null) => ({
  definition: { name }, outcome: "done", effects: calls,
  inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, ref(value)])),
  output: ref(output),
});

function gate(kind, skill, callable, assignment, proof, calls) {
  const world = { kind, id: kind + "-test", goal: "Complete the work within the approved scope.", ...assignment };
  const live = {
    provenance: { contextId: "owned" },
    diagnostics: { openGoalVerification: {
      caseId: world.id, contextId: "owned", goal: world.goal, passed: true,
      checks: new Proxy({}, { get: () => true }), ...proof,
    } },
  };
  return outcome => {
    const records = [node("runUserGoal", [], { goal: world.goal }), node(callable, [], { goal: world.goal }, outcome), ...calls];
    const exercise = {
      rootCallIds: ["root"],
      report: { status: "workspace-skill-reviewed", skill, outcome },
      calls: records.map((record, index) => ({ callId: index ? String(index) : "root",
        record: { ...record, parent_call_id: index ? "root" : null } })),
    };
    return openTemplateGoalEvidence(live, exercise, null, { assignment: world });
  };
}

test("terminal proof compares whole traced replies and joins native route and guide receipts", () => {
  const screen = { cols: 60, rows: 24, checked: ["2"] };
  const opened = { screen, grants: {}, note: "existing", checkOperationId: null, discoveryAvailable: true };
  const events = [{ operation: "quit", from: screen }];
  const route = { id: "service:list", sha256: "route", qualifiedName: "terminal.list" };
  const search = { query: "list terminal", result: [{ id: route.id, qualifiedName: route.qualifiedName, description: "Lists retained terminal sessions." }] };
  const guide = { dirPath: "skills/terminal", focus: ["resume"], result: {
    skillPath: "skills/terminal/SKILL.md", sha256: "guide", passages: ["Resume opens the originally retained session."],
  } };
  const rendered = "retained shift note";
  const handoff = { path: "/.tmp/terminal/handoff.json", sha256: hash(rendered) };
  const discovery = { routes: [route], guidance: [{ skillPath: guide.result.skillPath, sha256: guide.result.sha256, quote: guide.result.passages[0] }] };
  const evidence = gate("terminal-handoff", "terminalHandoff", "workOnTerminalGoal", {
    discovery: { methods: [route.id], guidance: [guide.dirPath] }, expected: { sequence: ["quit", "stage"] },
  }, { initial: screen, opened, events, stagedText: rendered, handoff,
    discovery: { routes: [route], searchReceipts: [search], loadReceipts: [guide] } }, [
    node("openTerminal", [effect("openTerminalRead", "open", [], opened)]),
    node("advanceTerminal", [effect("openTerminalLifecycle", "advance", [{ operation: "quit" }], events[0])]),
    node("stageTerminalHandoff", [effect("openTerminalHandoff", "stage", ["note"], handoff)]),
    node("discoverTerminalOptions", [
      effect("openTerminalDiscovery", "search", [search.query], search.result),
      effect("openTerminalDiscovery", "open", [route.id], route),
      effect("openTerminalDiscovery", "installed", [], [guide.dirPath]),
      effect("openTerminalDiscovery", "load", [guide.dirPath, guide.focus], guide.result),
    ]),
  ]);
  const report = { initial: screen, events, checkReport: null, discovery, handoff };
  assert.doesNotThrow(() => evidence(report));
  assert.throws(() => evidence({ ...report, discovery: { ...discovery,
    guidance: [{ ...discovery.guidance[0], quote: "A different release was approved." }] } }));
  assert.throws(() => evidence({ ...report, initial: { ...screen, cols: 120 } }));
});

test("eval handoff binds the whole original attempt and its verified artifact", () => {
  const attempt = { jobId: "job", attempt: { role: "latest", runId: "r" }, request: { operationId: "op" },
    runDigest: "current", resultDigest: "current-result" };
  const journal = { original: "r" };
  const read = { digest: "signed-digest" };
  const review = { runId: "r", effect: "confirmed", readback: read };
  const artifactText = "verified operational record";
  const artifact = { path: "/.tmp/verified", sha256: hash(artifactText) };
  const evidence = gate("eval-handoff", "evalHandoff", "workOnEvalHandoffGoal", {
    expected: { active: true, observations: [{}], use: "latest", stage: true },
  }, { attempts: [attempt], originalRuns: [{ card: attempt.attempt, runDigest: attempt.runDigest, resultDigest: attempt.resultDigest }],
    readbacks: [["r", read]], journals: [["r", journal]], retry: null, artifact, artifactText }, [
    node("discover", [effect("openEvalCatalog", "discover", [], []), effect("openEvalCatalog", "open", ["job", "r"], attempt)]),
    node("reviewEvalRecovery", [effect("evalRecoveryJournal", "observe", ["op"], journal), effect("evalRecoveryReadback", "read", ["op", read.digest], read)], { request: attempt.request }, review),
    node("stage", [effect("openEvalHandoff", "stage", ["job", "r"], artifact)]),
  ]);
  const report = { status: "reviewed", jobId: "job", trials: [{ observation: attempt, review }], decision: { action: "use", runId: "r" }, artifact };
  assert.doesNotThrow(() => evidence(report));
  assert.throws(() => evidence({ ...report, trials: [{ observation: { ...attempt, runDigest: "stale" }, review }] }));
  assert.throws(() => evidence({ ...report, artifact: { ...artifact, sha256: "unverified" } }));
});

test("program run compares native receipt records and signed scratch output", () => {
  const inspected = { evidence: { compiler: "passed" } };
  const used = { projectId: "owned", revision: 3, sampleId: "sample", id: "new-run", status: "returned" };
  const read = { id: "new-run", evidence: { source: "exact program" } };
  const review = { next: "ready" };
  const signedText = "signed contents";
  const signed = { sha256: hash(signedText) };
  const evidence = gate("program-run", "programRun", "workOnProgramRunGoal", {
    expected: { attempts: [{}], inspected: 1, project: "project", next: review.next, signed: true },
  }, { inspections: [inspected], attempts: [used], observations: [read], signed, signedText }, [
    node("runtime", [
      effect("programRunCatalog", "list", [], []), effect("programRunCatalog", "inspect", ["owned"], inspected),
      effect("programExecution", "run", [used.projectId, used.revision, used.sampleId], { id: used.id, status: used.status }),
      effect("programExecution", "read", [used.id], read), effect("programReceiptSigner", "stage", [used.id], signed),
    ]),
    node("reviewRuntimeEvidence", [], { request: read.evidence }, review),
  ]);
  const report = { status: "reviewed", review, receipts: [read], signed };
  assert.doesNotThrow(() => evidence(report));
  assert.throws(() => evidence({ ...report, receipts: [{ ...read, id: "stale" }] }));
});

test("authoring distinguishes an IR reference to null from an accepted observation", () => {
  const receipt = { review: { status: "compatible" } };
  const read = { compiler: "ok" };
  const handoffText = "exact source review";
  const handoff = { revision: hash(handoffText) };
  const evidence = gate("authoring", "authoring", "workOnAuthoringGoal", {
    expected: { candidate: "owned", baseline: null, status: receipt.review.status, stage: true },
  }, { confirmations: ["current"], receipt, readbacks: [read], handoff, handoffText }, [
    node("author", [
      effect("authoringDiscovery", "list", [], []), effect("authoringDiscovery", "open", ["foreign"], null),
      effect("authoringDiscovery", "open", ["owned"], { revision: 1 }), effect("authoringCompiler", "inspect", ["owned"], read),
      effect("authoringReviewControl", "confirm", [receipt], "current"), effect("authoringReviewControl", "stage", [receipt], handoff),
    ]),
  ]);
  const report = { status: "reviewed", receipt, artifact: handoff };
  assert.doesNotThrow(() => evidence(report));
  assert.throws(() => evidence({ ...report, receipt: { review: { status: "stale" } } }));
});

test("diagnostics distinguish independently observed checkpoint argument references", () => {
  const catalog = [{ id: "head" }, { id: "tail" }];
  const windows = catalog.map(source => ({ source, lines: [source.id] }));
  const trace = reads => [node("diagnose", [
    effect("diagnosticCatalog", "discover", [], catalog),
    ...reads.map(window => effect("diagnosticLog", "read", [window.source.id], window)),
  ])];
  const proof = { catalog, windows, handoff: null, handoffReadback: null };
  const args = ["system-diagnostics", "diagnostics", "workTowardDiagnosticGoal", {
    expected: { windows: { head: "ready", tail: "ready" }, status: "supported", stage: false },
  }, proof];
  const report = { finding: { status: "supported" }, artifact: null };
  assert.doesNotThrow(() => gate(...args, trace(windows))(report));
  assert.throws(() => gate(...args, trace([windows[0], windows[0]]))(report));
});

test("local delivery binds distinct room arguments and authentic retained readback", () => {
  const catalog = [{ id: "room-1" }, { id: "room-2" }];
  const observations = catalog.map((room, index) => ({ room, phrase: null, basis: String(index) }));
  const attempt = { attemptId: "attempt-1" };
  const readback = { roomId: "room-1", content: "accepted", acknowledged: true };
  const proof = { catalog, observations, nativeProofs: catalog.map(() => ({ passed: true })),
    boundaries: catalog.map(() => ({ joined: true })), attempt, readback };
  const evidence = gate("local-delivery", "localDelivery", "workTowardLocalDelivery", {
    expected: { reads: { first: true, second: true }, send: true, status: "delivered" },
  }, proof, [node("deliver", [
    effect("localDeliveryCatalog", "discover", [], catalog),
    ...observations.map(item => effect("localDeliveryHistory", "inspect", [item.room.id, item.phrase], item)),
    effect("localDeliverySend", "submit", ["0", readback.content], attempt),
    effect("localDeliveryReadback", "read", [attempt.attemptId], readback),
  ])]);
  const report = { status: "delivered", delivery: { attempt, readback } };
  assert.doesNotThrow(() => evidence(report));
  assert.throws(() => evidence({ ...report, delivery: { ...report.delivery, readback: { ...readback, roomId: "room-2" } } }));
});

test("reconciliation binds the candidate's report to the exact native revision window", () => {
  const window = { revision: "observed" };
  const effects = [
    { service: "reconciliationWindow", method: "read", args: [], result: window },
    { service: "reconciliationNative", method: "observe", args: ["current"], result: { head: "native" } },
  ];
  const evidence = gate("local-reconciliation", "localReconciliation", "workOnLocalReconciliationGoal", {
    expected: { status: "held", handoff: "held" },
  }, { effects, window, nativeHead: "native", artifact: null },
  [node("reconcile", effects.map(row => effect(row.service, row.method, row.args, row.result)))]);
  const report = { window, integration: { status: "held", head: "native" }, handoff: { status: "held", artifact: null } };
  assert.doesNotThrow(() => evidence(report));
  assert.throws(() => evidence({ ...report, window: { revision: "earlier" } }));
});

test("unit rollout checks the actual local commit instead of hashing a plain report value", () => {
  const discovery = [{ id: "unit" }];
  const observation = { unit: { id: "unit" } };
  const release = { status: "committed", revision: "new" };
  const evidence = gate("unit-rollout", "unitRollout", "repairWorkspaceUnit", {
    expected: { status: "released", release: true },
  }, { discoveries: [discovery], observations: [observation], readbacks: [], edits: [], candidateChecks: [],
    commits: [{ id: "unit", from: "previous", result: release }], independent: { build: { revision: "new" } } },
  [node("rollout", [effect("unitRolloutCatalog", "discover", [], discovery),
    effect("unitRolloutObserve", "inspect", ["unit"], observation),
    effect("unitRolloutCommit", "commit", ["unit", "previous"], release)])]);
  const report = { status: "released", revision: "new", release };
  assert.doesNotThrow(() => evidence(report));
  assert.throws(() => evidence({ ...report, release: { ...release, revision: "other" } }));
});
