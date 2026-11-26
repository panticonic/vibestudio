/** Accept only the canonical joined-run queue partition, never infer from absent raw. */
export function providerAdmissionStop(summary, names) {
  const stop = summary?.admissionStopped;
  if (stop == null) return null;
  const batch = new Set(names);
  const pending = stop.queuedTests;
  const evidence = stop.evidence;
  if (
    summary.status !== "cancelled" ||
    stop.reason !== "provider-transport-outage" ||
    !Array.isArray(pending) ||
    new Set(pending).size !== pending.length ||
    pending.some((name) => !batch.has(name)) ||
    !Array.isArray(evidence) ||
    !evidence.length ||
    evidence.some(
      (row) =>
        !batch.has(row.caseName) ||
        pending.includes(row.caseName) ||
        typeof row.callId !== "string" ||
        !row.callId ||
        !["generation", "score"].includes(row.kind) ||
        typeof row.model !== "string" ||
        !row.model ||
        !/^[a-f0-9]{64}$/u.test(row.errorSha256) ||
        typeof row.circuitOpen !== "boolean"
    ) ||
    !Number.isSafeInteger(summary.total) ||
    summary.total + pending.length !== batch.size ||
    summary.passed + summary.failed + summary.errored !== summary.total ||
    (summary.failedTests ?? []).some((name) => pending.includes(name))
  )
    throw new Error("Provider admission stop contradicts the exact joined batch");
  return {
    evidence,
    queuedTests: new Set(pending),
    completedTests: names.filter((name) => !pending.includes(name)),
  };
}
