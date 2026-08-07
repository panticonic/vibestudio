import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createDevLogger } from "@vibestudio/dev-log";

export interface EventLoopResponsivenessSample {
  label: string;
  intervalMs: number;
  utilization: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function startEventLoopResponsivenessMonitor(options: {
  label: string;
  intervalMs?: number;
  warnP99Ms?: number;
  onSample?: (sample: EventLoopResponsivenessSample) => void;
}): () => void {
  const intervalMs = options.intervalMs ?? 5_000;
  const warnP99Ms = options.warnP99Ms ?? 50;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const log = createDevLogger(`EventLoop:${options.label}`);
  let previousUtilization = performance.eventLoopUtilization();
  let lastWarningAt = 0;
  histogram.enable();

  const timer = setInterval(() => {
    const currentUtilization = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(currentUtilization, previousUtilization);
    previousUtilization = currentUtilization;
    const sample: EventLoopResponsivenessSample = {
      label: options.label,
      intervalMs,
      utilization: delta.utilization,
      p50Ms: histogram.percentile(50) / 1_000_000,
      p99Ms: histogram.percentile(99) / 1_000_000,
      maxMs: histogram.max / 1_000_000,
    };
    histogram.reset();
    options.onSample?.(sample);
    if (sample.p99Ms >= warnP99Ms && Date.now() - lastWarningAt >= 60_000) {
      lastWarningAt = Date.now();
      log.warn(
        `responsiveness budget exceeded p99Ms=${sample.p99Ms.toFixed(1)} ` +
          `maxMs=${sample.maxMs.toFixed(1)} utilization=${sample.utilization.toFixed(3)}`
      );
    } else if (log.isVerbose()) {
      log.verbose(
        `sample p50Ms=${sample.p50Ms.toFixed(1)} p99Ms=${sample.p99Ms.toFixed(1)} ` +
          `maxMs=${sample.maxMs.toFixed(1)} utilization=${sample.utilization.toFixed(3)}`
      );
    }
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
