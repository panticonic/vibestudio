/**
 * Broadcast + delivery for the PubSub Channel DO.
 *
 * RPC participants receive events on the stream returned by `subscribe`.
 * ChannelEvent is the worker-internal durable row format. RPC clients receive
 * explicit log/control/signal envelopes; DO participants receive the same
 * envelope shape over ordered RPC calls.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { RpcClient } from "@vibestudio/rpc";
import type { ChannelEvent } from "@workspace/harness";
import { participantIsAgentVessel, type BroadcastEnvelope } from "./types.js";
import type { RpcChannelMessage } from "@workspace/pubsub";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";

export interface BroadcastDeps {
  sql: SqlStorage;
  rpc: Pick<RpcClient, "call">;
  objectKey: string;
  deliverParticipant(participantId: string, payload: unknown): Promise<void> | void;
}

/** Delivery chains for ordered DO delivery. Resets on hibernation — safe because
 *  agent DOs handle ordering via their own checkpoints. */
const deliveryChains = new Map<string, Promise<void>>();
const closingDeliveryChains = new Set<string>();

function deliveryKey(channelId: string, participantId: string): string {
  return `${channelId}\u0000${participantId}`;
}

/**
 * True if a DO participant is an agent vessel (opted into structured `onChannelEnvelope` delivery).
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

/**
 * Stop accepting new deliveries and await the participant's ordered lane.
 * Membership/context teardown must not race an already accepted envelope.
 */
export async function closeDeliveryChain(
  channelId: string,
  participantId: string
): Promise<void> {
  const key = deliveryKey(channelId, participantId);
  closingDeliveryChains.add(key);
  const pending = deliveryChains.get(key);
  if (pending) await pending;
  if (deliveryChains.get(key) === pending) deliveryChains.delete(key);
}

/** Clean up delivery state after the participant row has been deleted. */
export function cleanupDeliveryChain(channelId: string, participantId: string): void {
  const key = deliveryKey(channelId, participantId);
  deliveryChains.delete(key);
  closingDeliveryChains.delete(key);
}

/** Queue an ordered structured envelope delivery to a DO participant. */
export function queueDoEnvelope(
  deps: BroadcastDeps,
  participantId: string,
  envelope: RpcChannelMessage,
  onFatalDelivery?: (err: { code?: string }) => boolean | void
): Promise<void> {
  const key = deliveryKey(deps.objectKey, participantId);
  if (closingDeliveryChains.has(key)) return Promise.resolve();
  return serializeByKey(deliveryChains, key, () =>
    deps.rpc
      .call(participantId, "onChannelEnvelope", [deps.objectKey, envelope])
      .then(() => {})
      .catch((err) => {
        const handled = onFatalDelivery?.(err as { code?: string });
        if (!handled) console.error(`[Channel] delivery failed for ${participantId}:`, err);
      })
  );
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
  senderId: string
): void {
  const participants = deps.sql
    .exec(`SELECT id, transport, metadata FROM participants`)
    .toArray();

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
    if (
      p["transport"] === "do" &&
      participantReceivesChannelEnvelopes(p["metadata"])
    ) {
      void queueDoEnvelope(
        deps,
        pid,
        envelope.kind === "log"
          ? { kind: "log", phase: envelope.phase ?? "live", event }
          : channelEventToRpcSignal(event),
        // A retired entity is ordinary roster lag and is reconciled elsewhere.
        // Every other delivery failure is actionable: swallowing EACCES or an
        // infrastructure error leaves the recipient's durable turn unopened
        // while the sender believes the message was delivered.
        (err) => err.code === "DO_NOT_CREATED"
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

export function channelEventToRpcSignal(event: ChannelEvent, ref?: number): RpcChannelMessage {
  return {
    kind: "signal",
    type: event.type,
    payload: event.payload,
    senderId: event.senderId,
    ts: event.ts,
    ...(ref !== undefined ? { ref } : {}),
  };
}
