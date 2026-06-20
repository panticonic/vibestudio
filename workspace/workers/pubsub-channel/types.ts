/**
 * Types for the PubSub Channel DO.
 */

import { z } from "zod";
import type { ChannelEvent, SendMessageOptions } from "@workspace/harness";
import type { ChannelReplayEnvelope } from "@workspace/pubsub";

const METHOD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESERVED_METHOD_NAMES = new Set(["read", "edit", "write", "grep", "find", "ls"]);

/**
 * Subscribe-time participant metadata validation (WS2 §8.4). Unknown keys flow
 * through to stored metadata; entries in `methods` without a string `name`
 * keep today's unknown-shape tolerance.
 */
export const participantMetadataSchema = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
    handle: z.string().regex(METHOD_NAME_PATTERN).optional(),
    roles: z.array(z.string()).optional(),
    methods: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(METHOD_NAME_PATTERN, {
                message:
                  "method names must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/",
              })
              .refine((name) => !RESERVED_METHOD_NAMES.has(name), {
                message:
                  "method name collides with a built-in tool name (read, edit, write, grep, find, ls)",
              })
              .optional(),
          })
          .passthrough()
      )
      .optional(),
    contextId: z.string().optional(),
    channelConfig: z.record(z.string(), z.unknown()).optional(),
    replay: z.boolean().optional(),
    sinceId: z.number().int().nonnegative().optional(),
    replayMessageLimit: z.number().int().positive().optional(),
    // Opt-in: this participant handles the STRUCTURED `onChannelEnvelope` delivery
    // (set by agent vessels). DO participants that omit it (RPC-style clients like
    // the eval's connectViaRpc) receive only the `channel:message` event stream.
    receivesChannelEnvelopes: z.boolean().optional(),
  })
  .passthrough();

/** Result from subscribing a DO participant. */
export interface SubscribeResult {
  ok: boolean;
  channelConfig?: Record<string, unknown>;
  envelope: ChannelReplayEnvelope;
}

/** Participant info stored in the participants table. */
export interface ParticipantInfo {
  id: string;
  metadata: Record<string, unknown>;
  transport: "rpc" | "do";
  connectedAt: number;
}

/**
 * THE participant-capability discriminator. An "agent vessel" implements `onMethodCall` (synchronous
 * DO method dispatch) AND opts into structured `onChannelEnvelope` delivery — both marked by the
 * `receivesChannelEnvelopes` flag SubscriptionManager sets at subscribe. Everything else — panels
 * (WS `rpc`) and RPC-style *connectionless DO* clients (the eval's `connectViaRpc` / HeadlessSession,
 * whose participant id is just the host DO's id) — settles method calls the RPC way: the broadcast
 * `started` event + `submitMethodResult`.
 *
 * Use THIS for any *behavioral* decision (method-call dispatch, pending-call redelivery, fork-cloning,
 * structured-envelope delivery) — NOT the `transport` ("do"/"rpc") field, which only names the
 * EVENT-delivery mechanism (postToDO vs WS) and is classified purely by participant-id shape. A
 * connectionless DO client is `transport === "do"` yet is NOT an agent vessel.
 */
export function participantIsAgentVessel(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return metadata?.["receivesChannelEnvelopes"] === true;
}

/** Channel config (mirrors PubSub client ChannelConfig). */
export interface ChannelConfig {
  title?: string;
  /** True when the title came from an explicit title command. */
  titleExplicit?: boolean;
  approvalLevel?: number;
  /** Multi-agent conversation policy: "open" | "directed" | "moderated". */
  conversationPolicy?: string;
  /** Cap on consecutive agent-to-agent replies in one causal chain. */
  agentHopLimit?: number;
  /** Named channel policies (fixed registry); default agentic.conversation.v1. */
  policies?: string[];
  [key: string]: unknown;
}

/** Presence event payload stored in messages table. */
export interface PresencePayload {
  action: "join" | "leave" | "update";
  metadata: Record<string, unknown>;
  leaveReason?: "graceful" | "disconnect" | "replaced";
}

/** Metadata passed alongside a ChannelEvent to broadcast(). */
export interface BroadcastEnvelope {
  kind: "log" | "signal";
  phase?: "replay" | "live";
  ref?: number;
}

/** Attachment stored in messages table (JSON). */
export interface StoredAttachment {
  id: string;
  data: string;  // base64
  mimeType: string;
  name?: string;
  size: number;
}

/** Event delivered to agent DOs via callDoTarget. Same as ChannelEvent from harness/types. */
export type { ChannelEvent, SendMessageOptions };
