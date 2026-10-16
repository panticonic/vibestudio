import { describe, expect, it } from "vitest";
import {
  createIpcResponsivenessReporter,
  type IpcResponsivenessReport,
} from "./ipcResponsiveness.js";

describe("IpcResponsivenessReporter", () => {
  it("ignores healthy calls and aggregates a burst by caller and outcome", () => {
    let now = 0;
    const reports: IpcResponsivenessReport[] = [];
    const reporter = createIpcResponsivenessReporter({
      now: () => now,
      onReport: (report) => reports.push(report),
      slowThresholdMs: 1_000,
      reportIntervalMs: 10_000,
    });

    reporter.observe({
      callerId: "shell",
      callerKind: "app",
      method: "shellPresence.heartbeat",
      outcome: "ok",
      elapsedMs: 999,
    });
    reporter.observe({
      callerId: "shell",
      callerKind: "app",
      method: "shellPresence.heartbeat",
      outcome: "ok",
      elapsedMs: 1_000,
    });
    now = 100;
    reporter.observe({
      callerId: "shell",
      callerKind: "app",
      method: "shellApproval.listPending",
      outcome: "ok",
      elapsedMs: 2_000,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      kind: "slow",
      callerId: "shell",
      count: 1,
      maxElapsedMs: 1_000,
      methods: [{ method: "shellPresence.heartbeat", count: 1 }],
    });

    now = 10_000;
    reporter.observe({
      callerId: "shell",
      callerKind: "app",
      method: "shellApproval.listPending",
      outcome: "ok",
      elapsedMs: 1_500,
    });

    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({
      kind: "slow",
      count: 2,
      maxElapsedMs: 2_000,
      methods: [{ method: "shellApproval.listPending", count: 2 }],
    });
  });

  it("keeps errors distinct from latency reports and flushes a partial burst", () => {
    let now = 0;
    const reports: unknown[] = [];
    const reporter = createIpcResponsivenessReporter({
      now: () => now,
      onReport: (report) => reports.push(report),
    });

    reporter.observe({
      callerId: "shell",
      callerKind: "app",
      method: "view.bindNativePanelSlot",
      outcome: "error",
      elapsedMs: 2,
    });
    now = 100;
    reporter.observe({
      callerId: "shell",
      callerKind: "app",
      method: "view.bindNativePanelSlot",
      outcome: "error",
      elapsedMs: 3,
    });
    reporter.flush();

    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ kind: "error", count: 1 });
    expect(reports[1]).toMatchObject({ kind: "error", count: 1, maxElapsedMs: 3 });
  });
});
