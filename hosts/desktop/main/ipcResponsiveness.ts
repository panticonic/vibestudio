export type IpcRpcOutcome = "ok" | "error";

export interface IpcResponsivenessSample {
  callerId: string;
  callerKind: string;
  method: string;
  outcome: IpcRpcOutcome;
  elapsedMs: number;
}

export interface IpcResponsivenessReport {
  kind: "error" | "slow";
  callerId: string;
  callerKind: string;
  count: number;
  maxElapsedMs: number;
  methods: ReadonlyArray<{ method: string; count: number }>;
}

interface Bucket {
  kind: IpcResponsivenessReport["kind"];
  callerId: string;
  callerKind: string;
  count: number;
  maxElapsedMs: number;
  methodCounts: Map<string, number>;
  lastReportedAt: number;
  hasReported: boolean;
}

export interface IpcResponsivenessReporter {
  observe(sample: IpcResponsivenessSample): void;
  flush(): void;
}

/**
 * Aggregate repeated IPC failures and latency violations into one report per
 * caller and outcome during a short window. A blocked main loop otherwise
 * makes queued heartbeats and polling calls all report the same underlying
 * stall as separate warnings.
 */
export function createIpcResponsivenessReporter(options: {
  onReport: (report: IpcResponsivenessReport) => void;
  now?: () => number;
  slowThresholdMs?: number;
  reportIntervalMs?: number;
}): IpcResponsivenessReporter {
  const now = options.now ?? Date.now;
  const slowThresholdMs = options.slowThresholdMs ?? 1_000;
  const reportIntervalMs = options.reportIntervalMs ?? 10_000;
  const buckets = new Map<string, Bucket>();

  const report = (bucket: Bucket): void => {
    const methods = [...bucket.methodCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([method, count]) => ({ method, count }));
    options.onReport({
      kind: bucket.kind,
      callerId: bucket.callerId,
      callerKind: bucket.callerKind,
      count: bucket.count,
      maxElapsedMs: bucket.maxElapsedMs,
      methods,
    });
  };

  const createBucket = (
    kind: Bucket["kind"],
    sample: IpcResponsivenessSample,
    timestamp: number
  ): Bucket => ({
    kind,
    callerId: sample.callerId,
    callerKind: sample.callerKind,
    count: 0,
    maxElapsedMs: 0,
    methodCounts: new Map(),
    lastReportedAt: timestamp,
    hasReported: false,
  });

  return {
    observe(sample): void {
      const kind: Bucket["kind"] | null =
        sample.outcome === "error" ? "error" : sample.elapsedMs >= slowThresholdMs ? "slow" : null;
      if (!kind) return;

      const timestamp = now();
      const key = `${sample.callerKind}\u0000${sample.callerId}\u0000${kind}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = createBucket(kind, sample, timestamp);
        buckets.set(key, bucket);
      }

      bucket.count += 1;
      bucket.maxElapsedMs = Math.max(bucket.maxElapsedMs, sample.elapsedMs);
      bucket.methodCounts.set(sample.method, (bucket.methodCounts.get(sample.method) ?? 0) + 1);

      if (!bucket.hasReported || timestamp - bucket.lastReportedAt >= reportIntervalMs) {
        report(bucket);
        bucket.count = 0;
        bucket.maxElapsedMs = 0;
        bucket.methodCounts.clear();
        bucket.lastReportedAt = timestamp;
        bucket.hasReported = true;
      }
    },

    flush(): void {
      for (const bucket of buckets.values()) {
        if (bucket.count === 0) continue;
        report(bucket);
        bucket.count = 0;
        bucket.maxElapsedMs = 0;
        bucket.methodCounts.clear();
        bucket.lastReportedAt = now();
      }
    },
  };
}
