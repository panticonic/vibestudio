import { describe, expect, it, vi } from "vitest";
import type { HostPerformanceSnapshot } from "@vibestudio/service-schemas/hostPerformance";

vi.mock("@workspace/runtime", () => ({ rpc: { call: vi.fn() } }));

import { summarizeHostSpan } from "./performance.js";

function snapshot(overrides: {
  rss: number;
  heap: number;
  userCpu: number;
  systemCpu: number;
  workerdRss: number;
  p99: number;
  max: number;
}): HostPerformanceSnapshot {
  return {
    version: 1,
    sampledAt: 200,
    startedAt: 1,
    process: {
      pid: 1,
      uptimeMs: 1_000,
      rssBytes: overrides.rss,
      heapTotalBytes: 100,
      heapUsedBytes: overrides.heap,
      externalBytes: 0,
      arrayBuffersBytes: 0,
      userCpuMs: overrides.userCpu,
      systemCpuMs: overrides.systemCpu,
    },
    eventLoop: {
      samples: [
        {
          label: "workspace-server",
          sampledAt: 200,
          intervalMs: 5_000,
          utilization: 0.5,
          p50Ms: 2,
          p99Ms: overrides.p99,
          maxMs: overrides.max,
        },
      ],
    },
    workerd: {
      pid: 2,
      port: 8787,
      uptimeMs: 1_000,
      rssBytes: overrides.workerdRss,
      lastRssBytes: overrides.workerdRss,
      rssSampleCount: 1,
      rssPeakBytes: overrides.workerdRss,
      rssGrowthBytes: 0,
      rssWindowMs: 0,
      regularWorkers: 3,
      doServices: 4,
      doObjectBuilds: 5,
      runtimeImages: 6,
      sealedDoImages: 7,
      runtimeImageRebinds: 0,
      bootGeneration: 1,
      pendingBootGeneration: null,
    },
  };
}

describe("performance summaries", () => {
  it("derives process deltas and event-loop maxima without raw host access", () => {
    const before = snapshot({
      rss: 100,
      heap: 40,
      userCpu: 10,
      systemCpu: 5,
      workerdRss: 70,
      p99: 1,
      max: 2,
    });
    const after = snapshot({
      rss: 160,
      heap: 55,
      userCpu: 24,
      systemCpu: 9,
      workerdRss: 90,
      p99: 12,
      max: 30,
    });

    expect(summarizeHostSpan(before, after, 250)).toEqual({
      elapsedMs: 250,
      server: {
        rssDeltaBytes: 60,
        heapUsedDeltaBytes: 15,
        userCpuMs: 14,
        systemCpuMs: 4,
      },
      workerd: {
        rssDeltaBytes: 20,
        rssBytes: 90,
        rssPeakBytes: 90,
        regularWorkers: 3,
        doServices: 4,
      },
      eventLoop: {
        sampleCount: 1,
        maxP99Ms: 12,
        maxDelayMs: 30,
        maxUtilization: 0.5,
      },
    });
  });
});
