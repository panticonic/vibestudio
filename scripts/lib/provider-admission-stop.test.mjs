import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { providerAdmissionStop } from "./provider-admission-stop.mjs";
import { collectionInterruption } from "./live-teacher-interruption.mjs";
const names = Array.from({ length: 64 }, (_, i) => `TEST-case-${i}`);
function summary() {
  return {
    status: "cancelled",
    total: 4,
    passed: 2,
    failed: 2,
    errored: 0,
    failedTests: names.slice(0, 2),
    admissionStopped: {
      reason: "provider-transport-outage",
      queuedTests: names.slice(4),
      evidence: [
        {
          caseName: names[0],
          callId: "TEST-call",
          kind: "generation",
          model: "TEST:local-no-inference",
          errorSha256: "a".repeat(64),
          circuitOpen: false,
        },
      ],
    },
  };
}
test("retains the exact64-case pending/finished partition and original failures", async () => {
  const value = summary(),
    selected = providerAdmissionStop(value, names);
  assert.equal(selected.queuedTests.size, 60);
  assert.deepEqual(selected.completedTests, names.slice(0, 4));
  const root = await mkdtemp(path.join(tmpdir(), "provider-admission-"));
  const signals = new EventEmitter();
  const interruption = collectionInterruption({ out: root, cases: names, processSignals: signals });
  try {
    interruption.stopAdmission("Native provider transport outage stopped admission");
    interruption.complete(selected.completedTests);
    for (const name of selected.queuedTests) interruption.defer(name, "provider-outage-unstarted");
    assert.equal(interruption.signal.aborted, false);
    assert.equal(interruption.requested, true);
    const retained = JSON.parse(
      await readFile(path.join(root, "collection-interruption.json"), "utf8")
    );
    assert.equal(retained.mode, "drain");
    assert.deepEqual(retained.completedCases, names.slice(0, 4));
    assert.equal(retained.interruptedCases.length, 60);
    assert.ok(
      Object.values(retained.interruptedReasons).every(
        (reason) => reason === "provider-outage-unstarted"
      )
    );
  } finally {
    interruption.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
for (const kind of [
  "duplicate",
  "foreign",
  "contradict-failure",
  "wrong-count",
  "wrong-status",
  "missing-native-hash",
  "missing-evidence",
  "unknown-reason",
])
  test(`rejects ${kind} provider admission partition`, () => {
    const s = summary();
    if (kind === "duplicate") s.admissionStopped.queuedTests.push(names[4]);
    if (kind === "foreign") s.admissionStopped.queuedTests[0] = "foreign";
    if (kind === "contradict-failure") s.failedTests.push(names[4]);
    if (kind === "wrong-count") s.total = 5;
    if (kind === "wrong-status") s.status = "completed";
    if (kind === "missing-native-hash") s.admissionStopped.evidence[0].errorSha256 = "fake";
    if (kind === "missing-evidence") s.admissionStopped.evidence = [];
    if (kind === "unknown-reason") s.admissionStopped.reason = "model-returned-outage";
    assert.throws(() => providerAdmissionStop(s, names), /contradicts/);
  });
test("ordinary completed summaries retain normal behavior", () =>
  assert.equal(providerAdmissionStop({ status: "completed" }, names), null));
