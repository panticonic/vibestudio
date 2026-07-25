/**
 * Broadcast + delivery for the PubSub Channel DO.
 *
 * RPC participants receive events on the stream returned by `subscribe`.
 * ChannelEvent is the worker-internal durable row format. RPC clients receive
 * explicit log/control/signal envelopes; DO participants receive the same
 * envelope shape over ordered RPC calls.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/harness";
import { participantIsAgentVessel, type BroadcastEnvelope } from "./types.js";
import type { RpcChannelMessage, RpcSignalMessage } from "@workspace/pubsub";

export type StructuredDeliveryEnvelope = Extract<RpcChannelMessage, { kind: "log" | "signal" }>;

export interface BroadcastDeps {
  sql: SqlStorage;
  objectKey: string;
  deliverParticipant(participantId: string, payload: unknown): Promise<void> | void;
  enqueueDoEnvelope(participantId: string, envelope: StructuredDeliveryEnvelope): void;
}

/**
 * True if a DO participant is an agent vessel (opted into host-driven structured batch delivery).
 * RPC-style DO clients omit the flag and receive only the subscription stream.
 * Parses the stored metadata JSON and delegates to the one canonical
 * discriminator (`participantIsAgentVessel`).
 */
function participantReceivesChannelEnvelopes(metadataJson: unknown): boolean {
  if (typeof metadataJson !== "string") return false;
  try {
    return participantIsAgentVessel(JSON.parse(metadataJson) as Record<string, unknown>);
  } catch {
    return false;
  }
}

// ── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Broadcast a ChannelEvent to all participants via RPC.
 * RPC clients receive the same envelope shape as DO subscribers.
 */
export function broadcast(
  deps: BroadcastDeps,
  event: ChannelEvent,
  envelope: BroadcastEnvelope,
  senderId: string,
  structuredPublisherId = senderId
): void {
  const participants = deps.sql.exec(`SELECT id, transport, metadata FROM participants`).toArray();

  const msg =
    envelope.kind === "log"
      ? channelEventToRpcLog(event, envelope.phase ?? "live", envelope.ref)
      : channelEventToRpcSignal(event, envelope.ref);

  for (const p of participants) {
    const pid = p["id"] as string;
    const data =
      pid === senderId && envelope.ref !== undefined
        ? { channelId: deps.objectKey, message: { ...msg, ref: envelope.ref } }
        : { channelId: deps.objectKey, message: msg };

    // Agent vessels receive one structured delivery RPC per participant. Every
    // other session receives bytes on the stream that owns its lifetime.
    if (p["transport"] === "do" && participantReceivesChannelEnvelopes(p["metadata"])) {
      // A structured publisher has already accepted and journaled this event
      // in its own turn. Calling back into that same Durable Object before the
      // publish RPC can return creates a causal cycle: the recipient cannot
      // process its self-delivery until the publication that scheduled it has
      // completed. Other participants still receive the durable broadcast;
      // stream transports retain their sender echo for UI acknowledgement.
      if (pid === structuredPublisherId) continue;
      deps.enqueueDoEnvelope(
        pid,
        envelope.kind === "log"
          ? { kind: "log", phase: envelope.phase ?? "live", event }
          : channelEventToRpcSignal(event)
      );
    } else {
      void deps.deliverParticipant(pid, data);
    }
  }
}

// ── ChannelEvent builders ────────────────────────────────────────────────────

/**
 * Build a ChannelEvent from message data.
 * This is the canonical event format for both stream and DO delivery.
 */
export function buildChannelEvent(
  id: number,
  messageId: string,
  type: string,
  payloadJson: string,
  senderId: string,
  senderMetadata: Record<string, unknown> | undefined,
  ts: number,
  attachments?: Array<{ id: string; data: string; mimeType: string; name?: string; size: number }>,
  annotations?: Record<string, unknown>,
  contentIntegrity: {
    contentClass: "internal" | "external";
    externalKeys: string[];
  } = { contentClass: "internal", externalKeys: [] }
): ChannelEvent {
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payloadJson);
  } catch {
    parsedPayload = payloadJson;
  }

  const payloadObj =
    parsedPayload && typeof parsedPayload === "object"
      ? (parsedPayload as Record<string, unknown>)
      : null;
  const contentType = payloadObj?.["contentType"] as string | undefined;

  const mappedAttachments = attachments?.map((att) => ({
    id: att.id,
    type: att.mimeType?.startsWith("image/") ? "image" : "file",
    data: att.data,
    mimeType: att.mimeType,
    filename: att.name,
    size: att.size,
  }));

  return {
    id,
    messageId: messageId || `${id}`,
    type,
    payload: parsedPayload,
    senderId,
    senderMetadata,
    contentClass: contentIntegrity.contentClass,
    externalKeys: [...contentIntegrity.externalKeys],
    ...(contentType ? { contentType } : {}),
    ts,
    ...(mappedAttachments && mappedAttachments.length > 0
      ? { attachments: mappedAttachments }
      : {}),
    ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

// ── Wire encoding ────────────────────────────────────────────────────────────

export function channelEventToRpcLog(
  event: ChannelEvent,
  phase: "replay" | "live",
  ref?: number
): RpcChannelMessage {
  return {
    kind: "log",
    phase,
    event,
    ...(ref !== undefined ? { ref } : {}),
  };
}

export function channelEventToRpcSignal(event: ChannelEvent, ref?: number): RpcSignalMessage {
  return {
    kind: "signal",
    messageId: event.messageId,
    type: event.type,
    payload: event.payload,
    senderId: event.senderId,
    ts: event.ts,
    ...(ref !== undefined ? { ref } : {}),
  };
}
