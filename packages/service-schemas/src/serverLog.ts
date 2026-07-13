/**
 * serverLog service method schemas.
 *
 * Read-only inspection of the workspace server's own host log stream (every
 * console/dev-log line the server process emits), captured in a per-boot
 * ring buffer with structured metadata. Secrets (pairing codes, tokens) are
 * redacted at capture time, so this surface is safe for userland callers.
 *
 * Live tailing: subscribe to the `server-log:append` event
 * (`events.subscribe("server-log:append")`) — the server pushes
 * `{ records: ServerLogRecord[] }` batches; dedupe/catch up by `seq` using
 * `query({ sinceSeq })`.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/servicePolicy";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

export const ServerLogLevelSchema = z.enum(["verbose", "info", "warn", "error"]);
export type ServerLogLevel = z.infer<typeof ServerLogLevelSchema>;

export const ServerLogRecordSchema = z.object({
  /** Monotonic per-boot sequence number — the streaming dedupe/catch-up cursor. */
  seq: z.number().int(),
  /** Epoch ms capture time. */
  timestamp: z.number(),
  level: ServerLogLevelSchema,
  /** Subsystem tag parsed from the conventional `[Tag]` log prefix. */
  tag: z.string().optional(),
  message: z.string(),
  /** Structured trailing log args (JSON-safe). */
  fields: z.array(z.unknown()).optional(),
  pid: z.number().int(),
});
export type ServerLogRecord = z.infer<typeof ServerLogRecordSchema>;

/** Envelope constants describing the emitting server process. */
const ServerLogEnvelopeSchema = z.object({
  records: z.array(ServerLogRecordSchema),
  /** Highest seq captured so far — pass as `sinceSeq` to catch up. */
  latestSeq: z.number().int(),
  workspaceId: z.string(),
  serverBootId: z.string(),
  pid: z.number().int(),
  /** Epoch ms when this server boot started capturing. */
  startedAt: z.number(),
});

export const ServerLogQuerySchema = z.object({
  /** Only records with seq > sinceSeq (streaming catch-up cursor). */
  sinceSeq: z.number().int().optional(),
  /** Epoch-ms lower bound (inclusive). */
  since: z.number().optional(),
  /** Epoch-ms upper bound (inclusive). */
  until: z.number().optional(),
  /** Minimum level: verbose < info < warn < error. */
  level: ServerLogLevelSchema.optional(),
  /** Exact subsystem tag (see stats().byTag for the live tag list). */
  tag: z.string().max(64).optional(),
  /** Case-insensitive substring match on the message. */
  contains: z.string().max(256).optional(),
  /** Max records (default 500, max 5000). Keeps the MOST RECENT matches. */
  limit: z.number().int().min(1).max(5000).optional(),
});

const ServerLogStatsSchema = z.object({
  bufferSize: z.number().int(),
  totalCaptured: z.number().int(),
  oldestSeq: z.number().int().nullable(),
  latestSeq: z.number().int(),
  byLevel: z.record(ServerLogLevelSchema, z.number().int()),
  byTag: z.array(z.object({ tag: z.string(), count: z.number().int() })),
});

export const serverLogMethods = defineServiceMethods({
  query: {
    description:
      "Query the server host log ring buffer with filters (sinceSeq cursor, time range, min level, subsystem tag, substring). Returns the most recent matches in ascending seq order plus process metadata (workspaceId, serverBootId, pid, latestSeq).",
    args: z.tuple([ServerLogQuerySchema.optional()]),
    returns: ServerLogEnvelopeSchema,
    access: READ_ACCESS,
    examples: [
      { args: [{ level: "warn", limit: 100 }] },
      { args: [{ tag: "Server", contains: "shutdown" }] },
      { args: [{ sinceSeq: 1234 }] },
    ],
  },
  tail: {
    description:
      "Return the last N server host log records (default 500) in ascending seq order — the starting snapshot for a live tail; then subscribe to the server-log:append event and dedupe by seq.",
    args: z.tuple([z.number().int().min(1).max(5000).optional()]),
    returns: ServerLogEnvelopeSchema,
    access: READ_ACCESS,
    examples: [{ args: [200] }],
  },
  stats: {
    description:
      "Aggregate stats over the captured server host logs: buffer occupancy, total captured this boot, counts by level, and the top subsystem tags.",
    args: z.tuple([]),
    returns: ServerLogStatsSchema,
    access: READ_ACCESS,
    examples: [{ args: [] }],
  },
});
