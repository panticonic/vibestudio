import { app } from "electron";
import type { ViewManager } from "./viewManager.js";
import { createDevLogger } from "@vibestudio/dev-log";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("MemoryMonitor");

const DEFAULT_LOG_INTERVAL_MS = 60_000;

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorStarted = false;
let _viewManager: ViewManager | null = null;
let pressureHandler: ((summary: string) => void) | null = null;
let lastPressureNoticeAt = 0;
const DEFAULT_PRESSURE_MB = 1_024;
const PRESSURE_NOTICE_COOLDOWN_MS = 10 * 60_000;

export function setMemoryMonitorViewManager(vm: ViewManager | null): void {
  _viewManager = vm;
}

export function setMemoryPressureHandler(handler: ((summary: string) => void) | null): void {
  pressureHandler = handler;
}

type MemorySnapshotOptions = {
  reason?: string;
  thresholdMb?: number;
  pressureThresholdMb?: number;
  /** Sample for pressure without writing periodic diagnostics to the log. */
  silent?: boolean;
};

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function truncate(value: string, max = 60): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export async function logMemorySnapshot(options: MemorySnapshotOptions = {}): Promise<void> {
  if (!_viewManager) return;
  const vm = _viewManager;
  const viewIds = vm.getViewIds();
  if (viewIds.length === 0) return;

  let metrics: Electron.ProcessMetric[];
  try {
    metrics = app.getAppMetrics();
  } catch {
    return; // No metrics available outside Electron
  }
  const metricsByPid = new Map(metrics.map((metric) => [metric.pid, metric]));

  const entries = await Promise.all(
    viewIds.map(async (id) => {
      const contents = vm.getWebContents(id);
      if (!contents) return null;

      const pid = contents.getOSProcessId();
      const metric = metricsByPid.get(pid);
      if (!metric) return null;

      const memKb = metric.memory.workingSetSize;
      const memMb = memKb / 1024;

      return {
        id: truncate(id, 40),
        mb: Math.round(memMb * 10) / 10,
        url: truncate(contents.getURL() || "(empty)", 80),
      };
    })
  );

  const nonNull = entries.filter(Boolean);
  if (nonNull.length === 0) return;

  const sortedByMem = nonNull.sort((a, b) => (b?.mb ?? 0) - (a?.mb ?? 0));

  const pressureThreshold = options.pressureThresholdMb ?? DEFAULT_PRESSURE_MB;
  const largest = sortedByMem[0];
  if (
    largest &&
    largest.mb >= pressureThreshold &&
    Date.now() - lastPressureNoticeAt >= PRESSURE_NOTICE_COOLDOWN_MS
  ) {
    lastPressureNoticeAt = Date.now();
    pressureHandler?.(
      `${largest.id} is using about ${Math.round(largest.mb)} MB. Close or unload unused panels if the app feels slow.`
    );
  }

  if (options.silent) return;

  const logThresholdMb = options.thresholdMb ?? 0;
  const logEntries =
    logThresholdMb > 0
      ? sortedByMem.filter((entry) => assertPresent(entry).mb >= logThresholdMb)
      : sortedByMem;
  if (logEntries.length === 0) return;

  const mainMetric = metrics.find((m) => m.type === "Browser");
  const mainMb = mainMetric ? Math.round((mainMetric.memory.workingSetSize / 1024) * 10) / 10 : "?";

  const reason = options.reason ? `[${options.reason}]` : "";
  const lines = logEntries.map(
    (e) =>
      `  ${assertPresent(e).mb.toString().padStart(7)}MB  ${assertPresent(e).id.padEnd(42)} ${assertPresent(e).url}`
  );
  log.info(`Memory snapshot ${reason}\n  Main: ${mainMb}MB\n${lines.join("\n")}`);
}

export function startMemoryMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;

  const intervalMs = parsePositiveInt(process.env["VIBESTUDIO_MEMORY_LOG_MS"]) ?? 0;
  const logOnce = process.env["VIBESTUDIO_MEMORY_LOG_ONCE"] === "1";
  const thresholdMb = parsePositiveInt(process.env["VIBESTUDIO_MEMORY_LOG_THRESHOLD_MB"]) ?? 0;
  const pressureThresholdMb =
    parsePositiveInt(process.env["VIBESTUDIO_MEMORY_PRESSURE_MB"]) ?? DEFAULT_PRESSURE_MB;

  if (logOnce) {
    void logMemorySnapshot({ reason: "startup", thresholdMb, pressureThresholdMb });
  }

  const effectiveInterval = intervalMs > 0 ? intervalMs : DEFAULT_LOG_INTERVAL_MS;
  monitorTimer = setInterval(() => {
    void logMemorySnapshot({
      reason: "interval",
      thresholdMb,
      pressureThresholdMb,
      silent: logOnce || intervalMs <= 0,
    });
  }, effectiveInterval);

  if (!logOnce) {
    void logMemorySnapshot({
      reason: "startup",
      thresholdMb,
      pressureThresholdMb,
      silent: intervalMs <= 0,
    });
  }
}

export function stopMemoryMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  monitorStarted = false;
}
