/**
 * Wire schemas for the `vibestudio channel` CLI group (plan §6.3).
 *
 * These are the host-facing contract the boundary allows: the CLI resolves the
 * channel Durable Object (protocol `vibestudio.channel.v1`) and relays to it —
 * the host never imports workspace code. The methods here mirror the DO surfaces
 * the CLI drives, with the field shapes the CLI shapes on top of the raw relay:
 *
 *   list    → gad-store `listChannelLogs` (durable channel-log enumeration)
 *             + per-channel `getContextId` annotation
 *   history → channel DO `getReplayAfter` (durable log read, paged client-side)
 *   send    → channel DO `sendAsCaller` (durable message as the verified caller)
 *   roster  → channel DO `getParticipants`
 *   tail    → channel DO `subscribe` + `channel:message` push (client-side)
 *
 * They are NOT registered as a host `ServiceDefinition` (there is no host
 * `channel` service — the channel is a userland DO), so they carry no policy in
 * the host policy matrix; they exist to give the CLI typed inputs/outputs from
 * the same source of truth.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

/** One channel in the workspace, as surfaced by `channel list`. */
export const channelSummarySchema = z
  .object({
    channelId: z.string(),
    /** gad log id backing the channel (`branch:channel:<channelId>`). */
    logId: z.string(),
    /** Epoch ms of the channel's first durable envelope, when known. */
    createdAt: z.number().nullable(),
    /** Context the channel is bound to (from the DO's getContextId), when resolvable. */
    contextId: z.string().nullable().optional(),
  })
  .strict();
export type ChannelSummary = z.infer<typeof channelSummarySchema>;

/** One rendered history line, distilled from a durable channel log event. */
export const channelHistoryEntrySchema = z
  .object({
    seq: z.number(),
    messageId: z.string(),
    /** Payload kind / event kind (e.g. "agentic.trajectory.v1/event", "presence"). */
    type: z.string(),
    senderId: z.string().nullable(),
    senderHandle: z.string().nullable().optional(),
    /** Best-effort plain-text body (message blocks flattened), when present. */
    text: z.string().nullable().optional(),
    /** Epoch ms. */
    ts: z.number(),
  })
  .strict();
export type ChannelHistoryEntry = z.infer<typeof channelHistoryEntrySchema>;

/** One roster member, as surfaced by `channel roster`. */
export const channelRosterEntrySchema = z
  .object({
    participantId: z.string(),
    handle: z.string().nullable().optional(),
    transport: z.string(),
    kind: z.string().nullable().optional(),
  })
  .strict();
export type ChannelRosterEntry = z.infer<typeof channelRosterEntrySchema>;

/** Addressing target for `channel send --to`. */
export const channelToTargetSchema = z
  .object({
    kind: z.enum(["all", "role", "participant"]),
    role: z.string().optional(),
    participantId: z.string().optional(),
  })
  .strict();

/** Options accepted by the channel DO `sendAsCaller` relay. */
export const channelSendOptsSchema = z
  .object({
    handle: z.string().optional(),
    to: z.array(channelToTargetSchema).optional(),
    mentions: z.array(z.string()).optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict();
export type ChannelSendOpts = z.infer<typeof channelSendOptsSchema>;

export const channelSendResultSchema = z
  .object({
    id: z.number().optional(),
    messageId: z.string(),
  })
  .strict();
export type ChannelSendResult = z.infer<typeof channelSendResultSchema>;

export const channelHistoryArgsSchema = z
  .object({
    channelId: z.string(),
    /** Return events with seq strictly greater than this (default 0 = from start). */
    after: z.number().int().nonnegative().optional(),
    /** Client-side cap on the number of rendered entries. */
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const channelMethods = defineServiceMethods({
  list: {
    args: z.tuple([]),
    returns: z.array(channelSummarySchema),
    description:
      "List the workspace's durable channels (gad-store listChannelLogs), annotated with each channel's bound context. Reflects durable truth: every channel that has received a durable envelope.",
    access: { sensitivity: "read" },
  },
  history: {
    args: z.tuple([channelHistoryArgsSchema]),
    returns: z.array(channelHistoryEntrySchema),
    description:
      "Read a channel's durable log (channel DO getReplayAfter), paged from `after` and capped at `limit`. The replay window is bounded server-side (500 events); page with `after` = the last returned seq.",
    access: { sensitivity: "read" },
  },
  send: {
    args: z.tuple([z.string(), z.string(), channelSendOptsSchema.optional()]),
    returns: channelSendResultSchema,
    description:
      "Publish a durable text message on a channel as the verified caller (channel DO sendAsCaller) — a human shell device or an autonomous agent — without joining the roster. Carries `to`/`mentions` addressing.",
    access: { sensitivity: "write" },
  },
  roster: {
    args: z.tuple([z.string()]),
    returns: z.array(channelRosterEntrySchema),
    description: "List a channel's current participants (channel DO getParticipants).",
    access: { sensitivity: "read" },
  },
});
