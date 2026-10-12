import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createDevLogger } from "@vibestudio/dev-log";

export interface EventLoopResponsivenessSample {
  label: string;
  /** Epoch-ms capture time for correlation with logs and bounded workloads. */
  sampledAt: number;
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
  let previousCpuUsage = process.cpuUsage();
  let previousSampleAt = performance.now();
  let lastWarningAt = 0;
  histogram.enable();

  const timer = setInterval(() => {
    const currentUtilization = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(currentUtilization, previousUtilization);
    previousUtilization = currentUtilization;
    // ELU also counts a main thread blocked in a synchronous native call as
    // active. Process CPU counters add context without starting a profiler;
    // they include worker threads and do not identify a particular JS owner.
    const currentCpuUsage = process.cpuUsage();
    const sampledAt = performance.now();
    const userCpuMs = (currentCpuUsage.user - previousCpuUsage.user) / 1_000;
    const systemCpuMs = (currentCpuUsage.system - previousCpuUsage.system) / 1_000;
    const elapsedMs = sampledAt - previousSampleAt;
    previousCpuUsage = currentCpuUsage;
    previousSampleAt = sampledAt;
    const sample: EventLoopResponsivenessSample = {
      label: options.label,
      sampledAt: Date.now(),
      intervalMs: elapsedMs,
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
          `maxMs=${sample.maxMs.toFixed(1)} utilization=${sample.utilization.toFixed(3)} ` +
          `intervalMs=${elapsedMs.toFixed(1)} userCpuMs=${userCpuMs.toFixed(1)} ` +
          `systemCpuMs=${systemCpuMs.toFixed(1)}`
      );
    }
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
