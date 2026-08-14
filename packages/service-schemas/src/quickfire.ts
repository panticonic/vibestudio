/**
 * Wire schemas for the `quickfire` host service (quickfire-overlay-spec §2.4).
 *
 * Quickfire binds one panel-scoped micro-conversation to a panel SLOT (the
 * stable tree position), not to the entity occupying it: navigating inside a
 * slot keeps the conversation. A conversation dies only on a lifecycle event —
 * the user clears it, the slot closes, or it is promoted to a chat panel (which
 * transfers ownership). There is deliberately no TTL and no clock-driven
 * expiry anywhere in this surface; every timestamp below is for display only.
 */

import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

/**
 * Quickfire is driven by an explicit user gesture in the shell, or by the host
 * drain.
 *
 * `code` is in the list because the shell chrome that carries that gesture *is*
 * userland code: `QuickfireOwner` runs inside `apps/shell`, so its authorizing
 * origin is `code:apps/shell@<ev>`, never `user`. Omitting it rejected every
 * real caller ("no authority branch admits the code origin") and left only the
 * host drain able to reach the service. Admitting code is not a widening of who
 * may bind a conversation: the lifecycle methods stay gated on
 * `workspace.runtime-state.manage`, which a unit only holds if it declared and
 * was granted it at install review — the same gate `panel` uses for the shell's
 * other chrome-driven mutations.
 */
export const QUICKFIRE_POLICY: ServiceAuthorityPolicy = { principals: ["user", "host", "code"] };

const QUICKFIRE_PRESENTATION = {
  title: "Manage panel command agent conversations",
  action: "manage the command agent conversation attached to a panel",
  description: "Allows {requesterKind} to manage the command agent conversation attached to a panel.",
  group: "panels",
  // Must match every other schema that binds `workspace.runtime-state.manage`;
  // the generated host-authority catalog rejects a capability whose category
  // varies by call site.
  authorityCategory: { domain: "automation", verb: "manage" },
} as const;

/**
 * Durable mapping state, as reported to the shell.
 *
 * `promoted` is a third state beyond the spec's `fresh`/`resumed` pair: §1.4
 * requires reopening quickfire over a promoted slot to offer "continued in chat
 * panel →" plus "start a new conversation here", which the caller cannot
 * distinguish from an ordinary resume without it.
 */
export const QuickfireSessionStateSchema = z.enum(["fresh", "resumed", "promoted"]);
export type QuickfireSessionState = z.infer<typeof QuickfireSessionStateSchema>;

export const QuickfireSessionSchema = z
  .object({
    slotId: z.string().min(1),
    channelId: z.string().min(1),
    contextId: z.string().min(1),
    /** Canonical id of the agent vessel serving the channel; null before it activates. */
    agentEntityId: z.string().min(1).nullable(),
    state: QuickfireSessionStateSchema,
    /**
     * Durable envelope high-water mark for the channel. Absent when the channel
     * log cannot be read cheaply (the conversation is still honest about not
     * knowing rather than reporting a fabricated zero).
     */
    messageCount: z.number().int().nonnegative().nullable(),
    /** Epoch ms of the last durable envelope; display only, never an expiry input. */
    lastActivityAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    promotedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type QuickfireSession = z.infer<typeof QuickfireSessionSchema>;

export const QuickfireSessionSummarySchema = z
  .object({
    slotId: z.string().min(1),
    channelId: z.string().min(1),
    contextId: z.string().min(1),
    agentEntityId: z.string().min(1).nullable(),
    createdAt: z.number().int().nonnegative(),
    promotedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type QuickfireSessionSummary = z.infer<typeof QuickfireSessionSummarySchema>;

export const QuickfireSessionForInputSchema = z
  .object({
    slotId: z.string().min(1),
    /**
     * Explicitly abandon a cleared or promoted mapping and start over. The
     * promoted conversation is NOT archived — the chat panel owns it now.
     */
    fresh: z.boolean().optional(),
  })
  .strict();

export const QuickfireSlotInputSchema = z.object({ slotId: z.string().min(1) }).strict();

export const QuickfireDrainInputSchema = z
  .object({
    /** Restrict the drain to one recorded close (the slot id that closed). */
    closeId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export const QuickfireDrainResultSchema = z
  .object({
    archived: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export type QuickfireDrainResult = z.infer<typeof QuickfireDrainResultSchema>;

const lifecycleTier = {
  tier: "gated" as const,
  session: "family" as const,
  residency: "identity" as const,
  family: "quickfire.lifecycle",
  rationale:
    "Binds or releases one exact panel slot's conversation identity and the agent vessel that serves it",
};

const readTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "identity" as const,
  family: "quickfire.lifecycle",
  rationale:
    "Bounded durable enumeration of the workspace's own slot-to-conversation mappings; exposes no conversation content",
};

export const quickfireMethods = defineServiceMethods({
  sessionFor: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: QUICKFIRE_PRESENTATION,
    tier: lifecycleTier,
    description:
      "Resolve the quickfire conversation bound to a panel slot, creating its channel and agent vessel lazily on first use. Returns whether the conversation is fresh, resumed, or already promoted to a chat panel.",
    args: z.tuple([QuickfireSessionForInputSchema]),
    returns: QuickfireSessionSchema,
    authority: QUICKFIRE_POLICY,
    access: { sensitivity: "write" },
    examples: [{ args: [{ slotId: "panel:tree/root/0" }] }],
  },
  clear: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: QUICKFIRE_PRESENTATION,
    tier: lifecycleTier,
    description:
      "Detach a slot's quickfire conversation and enqueue its archival. A promoted conversation is detached without archival because the chat panel owns its lifetime.",
    args: z.tuple([QuickfireSlotInputSchema]),
    returns: z.object({ cleared: z.boolean(), archived: z.number().int().nonnegative() }).strict(),
    authority: QUICKFIRE_POLICY,
    access: { sensitivity: "destructive" },
    examples: [{ args: [{ slotId: "panel:tree/root/0" }] }],
  },
  promote: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: QUICKFIRE_PRESENTATION,
    tier: lifecycleTier,
    description:
      "Mark a slot's quickfire conversation as promoted to a chat panel. Lifecycle ownership transfers: closing the slot afterwards drops the mapping without archiving the channel.",
    args: z.tuple([QuickfireSlotInputSchema]),
    returns: QuickfireSessionSchema.nullable(),
    authority: QUICKFIRE_POLICY,
    access: { sensitivity: "write" },
    examples: [{ args: [{ slotId: "panel:tree/root/0" }] }],
  },
  list: {
    agentFacing: false,
    tier: readTier,
    description: "List the panel slots that currently hold a live quickfire conversation.",
    args: z.tuple([]),
    returns: z.array(QuickfireSessionSummarySchema),
    authority: QUICKFIRE_POLICY,
    access: { sensitivity: "read" },
    examples: [{ args: [] }],
  },
  drainCleanup: {
    agentFacing: false,
    capability: "workspace.runtime-state.manage",
    presentation: QUICKFIRE_PRESENTATION,
    tier: {
      tier: "gated" as const,
      session: "family" as const,
      residency: "supervision" as const,
      // Its own family: draining is supervision residency, and a family may not
      // mix residencies with the identity-resident binding methods above.
      family: "quickfire.cleanup",
      rationale:
        "Executes the durable archival work a closed slot already recorded, acknowledging only rows whose agent actually retired",
    },
    description:
      "Execute queued quickfire archival recorded by slot close or clear: stop the conversation's agent, unsubscribe it from its channel, retire the vessel, and acknowledge only the rows that succeeded.",
    args: z.tuple([QuickfireDrainInputSchema.optional()]),
    returns: QuickfireDrainResultSchema,
    authority: QUICKFIRE_POLICY,
    access: { sensitivity: "destructive" },
    examples: [{ args: [] }, { args: [{ closeId: "panel:tree/root/0" }] }],
  },
});
