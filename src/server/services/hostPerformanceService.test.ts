import { describe, expect, it } from "vitest";
import type { HostPerformanceSnapshot } from "@vibestudio/service-schemas/hostPerformance";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createHostPerformanceService } from "./hostPerformanceService.js";

const caller = { caller: createVerifiedCaller("panel-1", "panel") };

describe("hostPerformanceService", () => {
  it("returns bounded process, event-loop, and workerd evidence", async () => {
    const service = createHostPerformanceService({
      startedAt: 100,
      eventLoopSamples: () => [
        {
          label: "workspace-server",
          sampledAt: 150,
          intervalMs: 5_000,
          utilization: 0.4,
          p50Ms: 2,
          p99Ms: 12,
          maxMs: 20,
        },
        {
          label: "workspace-server",
          sampledAt: 250,
          intervalMs: 5_000,
          utilization: 0.8,
          p50Ms: 3,
          p99Ms: 40,
          maxMs: 80,
        },
      ],
      workerdSnapshot: () => ({
        pid: 42,
        port: 8787,
        uptimeMs: 1_000,
        rssBytes: 10,
        lastRssBytes: 10,
        rssSampleCount: 1,
        rssPeakBytes: 10,
        rssGrowthBytes: 0,
        rssWindowMs: 0,
        regularWorkers: 1,
        doServices: 2,
        doObjectBuilds: 3,
        runtimeImages: 4,
        sealedDoImages: 5,
        runtimeImageRebinds: 6,
        bootGeneration: 7,
        pendingBootGeneration: null,
      }),
    });

    const result = (await service.handler(caller, "snapshot", [
      { since: 200, eventLoopLimit: 1 },
    ])) as HostPerformanceSnapshot;
    expect(result).toMatchObject({
      version: 1,
      startedAt: 100,
      process: { pid: process.pid },
      eventLoop: { samples: [{ sampledAt: 250, p99Ms: 40 }] },
      workerd: { pid: 42, rssBytes: 10, regularWorkers: 1 },
    });
    expect(result.process.rssBytes).toBeGreaterThan(0);
  });

  it("rejects unbounded sample requests", async () => {
    const service = createHostPerformanceService({
      startedAt: 100,
      eventLoopSamples: () => [],
      workerdSnapshot: () => null,
    });
    await expect(service.handler(caller, "snapshot", [{ eventLoopLimit: 241 }])).rejects.toThrow();
  });
});
