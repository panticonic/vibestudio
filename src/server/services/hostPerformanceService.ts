import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  hostPerformanceMethods,
  type HostEventLoopSample,
  type WorkerdPerformanceSnapshot,
} from "@vibestudio/service-schemas/hostPerformance";

export function createHostPerformanceService(deps: {
  startedAt: number;
  eventLoopSamples: () => readonly HostEventLoopSample[];
  workerdSnapshot: () => WorkerdPerformanceSnapshot | null;
}): ServiceDefinition {
  return {
    name: "hostPerformance",
    description: "Bounded workspace host and workerd performance diagnostics",
    authority: { principals: ["user", "code", "host"] },
    methods: hostPerformanceMethods,
    handler: defineServiceHandler("hostPerformance", hostPerformanceMethods, {
      snapshot: (_ctx, [options]) => {
        const sampledAt = Date.now();
        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();
        const since = options?.since ?? Number.NEGATIVE_INFINITY;
        const limit = options?.eventLoopLimit ?? 60;
        const samples = deps
          .eventLoopSamples()
          .filter((sample) => sample.sampledAt >= since)
          .slice(-limit);
        return {
          version: 1 as const,
          sampledAt,
          startedAt: deps.startedAt,
          process: {
            pid: process.pid,
            uptimeMs: process.uptime() * 1_000,
            rssBytes: memory.rss,
            heapTotalBytes: memory.heapTotal,
            heapUsedBytes: memory.heapUsed,
            externalBytes: memory.external,
            arrayBuffersBytes: memory.arrayBuffers,
            userCpuMs: cpu.user / 1_000,
            systemCpuMs: cpu.system / 1_000,
          },
          eventLoop: { samples },
          workerd: deps.workerdSnapshot(),
        };
      },
    }),
  };
}
