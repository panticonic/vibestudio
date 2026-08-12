/**
 * Bounded read-only process/resource diagnostics for userland profilers.
 * Aggregate counters replace `/proc`, `ps`, and other host escape hatches.
 */

import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const byteCount = z.number().int().nonnegative();
const nullableByteCount = byteCount.nullable();

export const HostEventLoopSampleSchema = z
  .object({
    label: z.string(),
    sampledAt: z.number(),
    intervalMs: z.number().positive(),
    utilization: z.number().nonnegative(),
    p50Ms: z.number().nonnegative(),
    p99Ms: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
  })
  .strict();
export type HostEventLoopSample = z.infer<typeof HostEventLoopSampleSchema>;

export const WorkerdPerformanceSnapshotSchema = z
  .object({
    pid: z.number().int().positive().nullable(),
    port: z.number().int().positive().nullable(),
    uptimeMs: z.number().nonnegative().nullable(),
    rssBytes: nullableByteCount,
    lastRssBytes: nullableByteCount,
    rssSampleCount: z.number().int().nonnegative(),
    rssPeakBytes: nullableByteCount,
    rssGrowthBytes: z.number().int().nullable(),
    rssWindowMs: z.number().nonnegative().nullable(),
    regularWorkers: z.number().int().nonnegative(),
    doServices: z.number().int().nonnegative(),
    doObjectBuilds: z.number().int().nonnegative(),
    runtimeImages: z.number().int().nonnegative(),
    sealedDoImages: z.number().int().nonnegative(),
    runtimeImageRebinds: z.number().int().nonnegative(),
    bootGeneration: z.number().int().nonnegative(),
    pendingBootGeneration: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type WorkerdPerformanceSnapshot = z.infer<typeof WorkerdPerformanceSnapshotSchema>;

export const HostPerformanceSnapshotSchema = z
  .object({
    version: z.literal(1),
    sampledAt: z.number(),
    startedAt: z.number(),
    process: z
      .object({
        pid: z.number().int().positive(),
        uptimeMs: z.number().nonnegative(),
        rssBytes: byteCount,
        heapTotalBytes: byteCount,
        heapUsedBytes: byteCount,
        externalBytes: byteCount,
        arrayBuffersBytes: byteCount,
        userCpuMs: z.number().nonnegative(),
        systemCpuMs: z.number().nonnegative(),
      })
      .strict(),
    eventLoop: z.object({ samples: z.array(HostEventLoopSampleSchema) }).strict(),
    workerd: WorkerdPerformanceSnapshotSchema.nullable(),
  })
  .strict();
export type HostPerformanceSnapshot = z.infer<typeof HostPerformanceSnapshotSchema>;

export const hostPerformanceMethods = defineServiceMethods({
  snapshot: {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "hostPerformance.read",
      rationale:
        "Bounded read-only host and workerd resource counters; no process control or host filesystem access.",
    },
    description:
      "Capture workspace-server memory/CPU counters, retained event-loop responsiveness samples, and workerd RSS/occupancy. Pass since to correlate samples with one workload.",
    args: z.tuple([
      z
        .object({
          since: z.number().optional(),
          eventLoopLimit: z.number().int().positive().max(240).optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: HostPerformanceSnapshotSchema,
    access: { sensitivity: "read" },
    examples: [{ args: [{ since: 1_700_000_000_000, eventLoopLimit: 60 }] }],
  },
});
