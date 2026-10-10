import { z } from "zod";
import { defineReceiverServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { DURABLE_WORK_QUEUES } from "@vibestudio/shared/durableWork";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

const queueSchema = z.enum(DURABLE_WORK_QUEUES);
const claimRequestSchema = z
  .object({
    workerId: z.string().min(1),
    trigger: z.enum(["hint", "recovery", "continuation"]).optional(),
    now: z.number(),
    limit: z.number().int().positive(),
  })
  .strict();
const durableWorkPayloadSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]);
const claimSchema = z
  .object({
    itemId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1),
    createdAt: z.number(),
    attempt: z.number().int().positive(),
    // Queue owners define the queue-specific payload; the common host scheduler
    // treats it as opaque and dispatches it only to the owning execution path.
    payload: durableWorkPayloadSchema,
  })
  .strict();
const settleRequestSchema = z
  .object({
    workerId: z.string().min(1),
    itemId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    outcome: z.unknown(),
  })
  .strict();
const settlementSchema = z.enum(["accepted", "duplicate", "stale"]);
const hostOwnerAuthority = {
  capability: "workspace.runtime-state.manage",
  authority: { principals: ["host"] },
} satisfies { capability: string; authority: ServiceAuthorityPolicy };
const ownerWorkMethods = {
  adoptDurableWorkWorker: {
    ...hostOwnerAuthority,
    website: {
      kind: "closed",
      reason: "Durable-work adoption is an internal host lifecycle operation.",
    } as const,
    tier: {
      tier: "open" as const,
      session: "family" as const,
      rationale: "Host-owned durable-work lease recovery.",
    },
    description: "Adopt outstanding durable-work leases for the current host worker generation.",
    args: z.tuple([z.string().min(1)]),
    returns: z.object({ adopted: z.boolean(), previousWorkerId: z.string().nullable() }).strict(),
    access: { sensitivity: "write" as const },
  },
  claimReadyWork: {
    ...hostOwnerAuthority,
    website: {
      kind: "closed",
      reason: "Durable-work claims are an internal host scheduler operation.",
    } as const,
    tier: {
      tier: "open" as const,
      session: "family" as const,
      rationale: "Host-owned durable-work queue scheduling.",
    },
    description: "Claim eligible durable work from one queue owner.",
    args: z.tuple([queueSchema, claimRequestSchema]),
    returns: z.array(claimSchema),
    access: { sensitivity: "write" as const },
  },
  settleReadyWork: {
    ...hostOwnerAuthority,
    website: {
      kind: "closed",
      reason: "Durable-work settlement is an internal host scheduler operation.",
    } as const,
    tier: {
      tier: "open" as const,
      session: "family" as const,
      rationale: "Host-owned durable-work queue scheduling.",
    },
    description: "Settle a previously claimed durable-work item.",
    args: z.tuple([queueSchema, settleRequestSchema]),
    returns: settlementSchema,
    access: { sensitivity: "write" as const },
  },
  failReadyWork: {
    ...hostOwnerAuthority,
    website: {
      kind: "closed",
      reason: "Durable-work retry scheduling is an internal host scheduler operation.",
    } as const,
    tier: {
      tier: "open" as const,
      session: "family" as const,
      rationale: "Host-owned durable-work queue scheduling.",
    },
    description: "Record a failed durable-work attempt for retry or stale-claim handling.",
    args: z.tuple([
      queueSchema,
      z
        .object({
          workerId: z.string().min(1),
          itemId: z.string().min(1),
          generation: z.number().int().nonnegative(),
          error: z.unknown().optional(),
        })
        .strict(),
    ]),
    returns: z.union([z.object({ retryAt: z.number() }).strict(), z.literal("stale")]),
    access: { sensitivity: "write" as const },
  },
  durableWorkStatus: {
    ...hostOwnerAuthority,
    website: {
      kind: "closed",
      reason: "Durable-work readiness is an internal host scheduler operation.",
    } as const,
    tier: {
      tier: "open" as const,
      session: "family" as const,
      rationale: "Host-owned durable-work readiness reconciliation.",
    },
    description: "Read queue readiness and recovery scheduling from a durable-work owner.",
    args: z.tuple([]),
    returns: z
      .object({ readyQueues: z.array(queueSchema), nextRecoveryAt: z.number().nullable() })
      .strict(),
    access: { sensitivity: "read" as const },
  },
};

export const durableWorkOwnerMethods = defineReceiverServiceMethods(ownerWorkMethods);
export type DurableWorkOwnerMethods = typeof durableWorkOwnerMethods;
