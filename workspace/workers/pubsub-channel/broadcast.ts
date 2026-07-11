/**
 * Broadcast + delivery for the PubSub Channel DO.
 *
 * All participants (panels and DOs) receive events via RPC emit.
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
  rpc: Pick<RpcClient, "call" | "emit">;
  objectKey: string;
}

/** Delivery chains for ordered DO delivery. Resets on hibernation — safe because
 *  agent DOs handle ordering via their own checkpoints. */
const deliveryChains = new Map<string, Promise<void>>();

/** Per-subscriber emit chains. Used to serialize `rpc.emit` calls to the same
 *  subscriber in FIFO order without blocking the caller — awaiting each emit
 *  inline would deadlock against RPC transport backpressure (the subscriber
 *  is typically parked on an outstanding RPC call when replay runs). */
const emitChains = new Map<string, Promise<void>>();

function deliveryKey(channelId: string, participantId: string): string {
  return `${channelId}\u0000${participantId}`;
}

/**
 * True if a DO participant is an agent vessel (opted into structured `onChannelEnvelope` delivery).
 * RPC-style DO clients omit the flag and receive only the `channel:message` event stream. Parses the
 * stored metadata JSON and delegates to the one canonical discriminator (`participantIsAgentVessel`).
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
 * Queue an `rpc.emit` to `subscriberId` behind any previously queued emits to
 * the same subscriber. Returns the tail of the chain for callers that want to
 * wait until every enqueued emit has drained (e.g. subscribe handlers that
 * need `ready` to land after replay before they return).
 */
export function queueEmit(
  deps: BroadcastDeps,
  subscriberId: string,
  payload: unknown,
  onFatalDelivery?: (err: { code?: string }) => boolean | void
): Promise<void> {
  const key = deliveryKey(deps.objectKey, subscriberId);
  return serializeByKey(emitChains, key, () =>
    deps.rpc.emit(subscriberId, "channel:message", payload).catch((err) => {
      onFatalDelivery?.(err as { code?: string });
    })
  );
}

/** Clean up delivery chain for a participant that unsubscribed. */
export function cleanupDeliveryChain(channelId: string, participantId: string): void {
  const key = deliveryKey(channelId, participantId);
  deliveryChains.delete(key);
  emitChains.delete(key);
}

/** Queue an ordered structured envelope delivery to a DO participant. */
export function queueDoEnvelope(
  deps: BroadcastDeps,
  participantId: string,
  envelope: RpcChannelMessage,
  onFatalDelivery?: (err: { code?: string }) => boolean | void
): Promise<void> {
  const key = deliveryKey(deps.objectKey, participantId);
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
    .exec(
      `SELECT p.id, p.transport, p.metadata, s.delivery_id
       FROM participants p
       JOIN participant_sessions s ON s.participant_id = p.id`
    )
    .toArray();

  const msg =
    envelope.kind === "log"
      ? channelEventToRpcLog(event, envelope.phase ?? "live", envelope.ref)
      : channelEventToRpcSignal(event, envelope.ref);

  const structuredDelivered = new Set<string>();
  for (const p of participants) {
    const pid = p["id"] as string;
    const deliveryId = p["delivery_id"] as string;
    // A failed emit is not authoritative evidence that the logical participant
    // left. Its independently-heartbeating session is evicted by the channel's
    // single alarm after the liveness window, which also records durable
    // offline/last-seen state.
    const ignoreTransientDeliveryFailure = () => true;
    const data =
      pid === senderId && envelope.ref !== undefined
        ? { channelId: deps.objectKey, message: { ...msg, ref: envelope.ref } }
        : { channelId: deps.objectKey, message: msg };

    // Route through the per-subscriber emit chain so replay emits queued
    // during a concurrent subscribe stay ahead of live broadcasts.
    void queueEmit(deps, deliveryId, data, ignoreTransientDeliveryFailure);

    // Additionally deliver the STRUCTURED envelope (onChannelEnvelope) — but ONLY
    // to DO participants that opted into it (agent vessels set
    // `receivesChannelEnvelopes`). RPC-style DO clients (e.g. the eval's
    // connectViaRpc) consume the `channel:message` emit above and have no
    // onChannelEnvelope handler, so pushing it to them just 500s the delivery.
    if (
      p["transport"] === "do" &&
      participantReceivesChannelEnvelopes(p["metadata"]) &&
      !structuredDelivered.has(pid)
    ) {
      structuredDelivered.add(pid);
      void queueDoEnvelope(
        deps,
        pid,
        envelope.kind === "log"
          ? { kind: "log", phase: envelope.phase ?? "live", event }
          : channelEventToRpcSignal(event),
        ignoreTransientDeliveryFailure
      );
    }
  }
}

// ── ChannelEvent builders ────────────────────────────────────────────────────

/**
 * Build a ChannelEvent from message data.
 * This is the canonical event format for both RPC emit and DO delivery.
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
  annotations?: Record<string, unknown>
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
