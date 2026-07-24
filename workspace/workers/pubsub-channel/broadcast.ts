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
import type { RpcChannelMessage, RpcSignalMessage } from "@workspace/pubsub";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";

export type StructuredDeliveryEnvelope = Extract<
  RpcChannelMessage,
  { kind: "log" | "signal" }
>;

/** Structured envelopes are small control-plane deliveries, never
 * long-running methods. A wedged recipient must release the channel alarm so
 * the durable outbox can retry and other participants can continue. */
export const STRUCTURED_DELIVERY_TIMEOUT_MS = 15_000;

export interface BroadcastDeps {
  sql: SqlStorage;
  rpc: Pick<RpcClient, "call">;
  objectKey: string;
  deliverParticipant(participantId: string, payload: unknown): Promise<void> | void;
  enqueueDoEnvelope(participantId: string, envelope: StructuredDeliveryEnvelope): void;
}

/** Delivery chains for ordered DO delivery. Resets on hibernation — safe because
 *  agent DOs handle ordering via their own checkpoints. */
const deliveryChains = new Map<string, Promise<void>>();
const closingDeliveryChains = new Set<string>();
const activeDeliveryControllers = new Map<string, AbortController>();

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

/**
 * Release the transport resources owned by one live activation while retaining
 * its durable channel membership. Unlike closeDeliveryChain(), this cancels
 * the active callback instead of draining it: lifecycle preparation can be
 * invoked by the same recipient, so waiting for that callback would create a
 * cross-DO reentrancy cycle.
 *
 * The lane stays closed until the replacement activation subscribes.
 */
export async function releaseDeliveryChain(
  channelId: string,
  participantId: string
): Promise<void> {
  const key = deliveryKey(channelId, participantId);
  closingDeliveryChains.add(key);
  activeDeliveryControllers.get(key)?.abort(
    new Error(`Participant activation released: ${participantId}`)
  );
  const pending = deliveryChains.get(key);
  if (!pending) {
    deliveryChains.delete(key);
    activeDeliveryControllers.delete(key);
    return;
  }
  // Cancellation is advisory. A transport may not observe AbortSignal until
  // its old workerd generation disappears, so lifecycle release must not wait
  // for the callback it is trying to terminate. Keep the ordered lane promise
  // installed: if a replacement reopens before the old request rejects, its
  // first delivery stays ordered behind that terminal instead of racing it.
  void pending
    .finally(() => {
      if (deliveryChains.get(key) === pending) deliveryChains.delete(key);
    })
    .catch(() => {});
}

/** Re-open a transport lane when a replacement activation subscribes. */
export function reopenDeliveryChain(channelId: string, participantId: string): void {
  closingDeliveryChains.delete(deliveryKey(channelId, participantId));
}

/** Clean up delivery state after the participant row has been deleted. */
export function cleanupDeliveryChain(channelId: string, participantId: string): void {
  const key = deliveryKey(channelId, participantId);
  activeDeliveryControllers.get(key)?.abort(
    new Error(`Participant delivery state removed: ${participantId}`)
  );
  activeDeliveryControllers.delete(key);
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
  return serializeByKey(deliveryChains, key, async () => {
    if (closingDeliveryChains.has(key)) return;
    const controller = new AbortController();
    activeDeliveryControllers.set(key, controller);
    try {
      await deps.rpc.call(participantId, "onChannelEnvelope", [deps.objectKey, envelope], {
        signal: controller.signal,
        timeoutMs: STRUCTURED_DELIVERY_TIMEOUT_MS,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      const handled = onFatalDelivery?.(err as { code?: string });
      if (!handled) console.error(`[Channel] delivery failed for ${participantId}:`, err);
    } finally {
      if (activeDeliveryControllers.get(key) === controller) {
        activeDeliveryControllers.delete(key);
      }
    }
  });
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
