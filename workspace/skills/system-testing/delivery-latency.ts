/** Calibrated 2026-08-10 from isolated cold and warm managed-instance runs
 * after moving the origin ahead of durable append/projection work. Observed
 * maxima were 22,001ms for publish -> recipient execution and 19,680ms for
 * result -> caller settlement; 30s is the next measured histogram ceiling and
 * is shared by all spans so newly exercised provider routes are gated too. */
export const CHANNEL_DELIVERY_LATENCY_BASELINE_MS = {
  "publish-to-recipient-execution": 30_000,
  "call-to-provider-execution": 30_000,
  "result-to-caller-settlement": 30_000,
} as const;

type Metric = keyof typeof CHANNEL_DELIVERY_LATENCY_BASELINE_MS;

export function channelDeliveryLatencyViolations(diagnostics: Record<string, unknown>): string[] {
  const channel = diagnostics["channelDelivery"] as
    | { deliveryLifecycle?: { latencyHistogram?: unknown } }
    | undefined;
  const rows = channel?.deliveryLifecycle?.latencyHistogram;
  if (!channel) return [];
  if (!Array.isArray(rows)) return ["channel delivery latency histogram is unavailable"];
  const maximums = new Map<Metric, number>();
  const violations: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      violations.push("channel delivery latency histogram contains a malformed row");
      continue;
    }
    const metric = (row as { metric?: unknown }).metric;
    const maximum = (row as { maximum_ms?: unknown }).maximum_ms;
    if (typeof metric !== "string" || !(metric in CHANNEL_DELIVERY_LATENCY_BASELINE_MS)) continue;
    if (typeof maximum !== "number" || !Number.isFinite(maximum) || maximum < 0) {
      violations.push(`${metric}: invalid maximum_ms`);
      continue;
    }
    const typedMetric = metric as Metric;
    maximums.set(typedMetric, Math.max(maximums.get(typedMetric) ?? 0, maximum));
  }
  violations.push(
    ...[...maximums].flatMap(([metric, maximum]) => {
      const budget = CHANNEL_DELIVERY_LATENCY_BASELINE_MS[metric];
      return maximum > budget ? [`${metric}: ${maximum}ms exceeds ${budget}ms baseline`] : [];
    })
  );
  return violations;
}
