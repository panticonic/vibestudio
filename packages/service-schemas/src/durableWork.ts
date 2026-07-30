import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const durableWorkTriggerSchema = z.enum(["hint", "recovery", "continuation"]);
const durableWorkQueueSchema = z.enum(["channel-delivery", "agent-inbox", "agent-effect"]);
const durableWorkSettlementSchema = z.enum(["accepted", "duplicate", "stale"]);

export const durableWorkDriverTraceSchema = z
  .object({
    at: z.number(),
    phase: z.enum([
      "hint.received",
      "claim.started",
      "claim.completed",
      "execution.started",
      "execution.completed",
      "settlement.completed",
      "execution.failed",
    ]),
    trigger: durableWorkTriggerSchema,
    queue: durableWorkQueueSchema,
    owner: z.string(),
    itemId: z.string().optional(),
    generation: z.number().int().optional(),
    durationMs: z.number().nonnegative().optional(),
    disposition: durableWorkSettlementSchema.optional(),
  })
  .strict();

export const durableWorkDriverInspectionSchema = z
  .object({
    workerId: z.string(),
    accepting: z.boolean(),
    active: z.number().int().nonnegative(),
    pendingHints: z.number().int().nonnegative(),
    activeLanes: z.array(z.string()),
    duplicateHints: z.number().int().nonnegative(),
    staleSettlements: z.number().int().nonnegative(),
    recoveryScans: z.number().int().nonnegative(),
    recoveryHits: z.number().int().nonnegative(),
    claimsByTrigger: z.record(durableWorkTriggerSchema, z.number().int().nonnegative()),
    recentTrace: z.array(durableWorkDriverTraceSchema).max(500),
  })
  .strict();

export type DurableWorkDriverInspection = z.infer<typeof durableWorkDriverInspectionSchema>;

export const durableWorkMethods = defineServiceMethods({
  inspect: {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "durableWork.read",
      rationale:
        "Payload-free bounded scheduler health and timing diagnostics; no work content or mutation is exposed",
    },
    description:
      "Return bounded, payload-free diagnostics for the host durable-work dispatcher, including hint/recovery attribution and recent phase timings.",
    args: z.tuple([]),
    returns: durableWorkDriverInspectionSchema,
    access: { sensitivity: "read" },
  },
});
