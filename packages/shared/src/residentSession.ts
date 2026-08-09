/** Activation-local receivers owned by explicitly resident operations.
 * Durable state must never depend on this registry: a missing receiver means
 * the sender retains and retries its durable mailbox item. */

export type ResidentSessionReceiver = (payload: unknown) => void | Promise<void>;

/** Exact outbound authority retained by one resident operation. The owner
 * captures its already-attenuated execution transport at registration time;
 * consumers must not fall back to an ambient runtime client after the
 * callback crosses an isolate or request boundary. */
export interface ResidentSessionTransport {
  call<R = unknown>(targetId: string, method: string, args: unknown[]): Promise<R>;
}

export interface ResidentSessionRegistration {
  transport: ResidentSessionTransport;
  close(): void | Promise<void>;
}

/** Owner-local registration capability. The implementation must be supplied
 * by the Durable Object activation whose identity receives channel delivery;
 * importing another bundle's module-local registry is not equivalent. */
export interface ResidentSessionRegistrar {
  registerResidentSession(
    channelId: string,
    receiver: ResidentSessionReceiver
  ): ResidentSessionRegistration;
}

interface ResidentReceiver {
  receiver: ResidentSessionReceiver;
  openedAt: number;
}

/** Common finite-delivery contract implemented by both host-builtin and
 * workspace Durable Object bases. Long-lived execution is the only owner of
 * the activation-local receiver; the channel retains delivery until this call
 * succeeds. */
export interface ResidentChannelDeliveryInput {
  deliveryId: string;
  channelId: string;
  channelRef: { source: string; className: string; objectKey: string };
  participantId: string;
  subscriptionRevision: number;
  eventSequence: number;
  envelope: unknown;
  agenticContext: unknown;
}

const receivers = new Map<string, ResidentReceiver>();

function key(ownerEntityId: string, channelId: string): string {
  return `${ownerEntityId}\u0000${channelId}`;
}

export function registerResidentSession(
  ownerEntityId: string,
  channelId: string,
  receiver: ResidentSessionReceiver
): () => void {
  const identity = key(ownerEntityId, channelId);
  if (receivers.has(identity)) {
    throw new Error(`resident channel receiver ${channelId} is already active`);
  }
  receivers.set(identity, { receiver, openedAt: Date.now() });
  return () => {
    if (receivers.get(identity)?.receiver === receiver) receivers.delete(identity);
  };
}

export async function deliverResidentSession(
  ownerEntityId: string,
  channelId: string,
  payload: unknown
): Promise<void> {
  const resident = receivers.get(key(ownerEntityId, channelId));
  if (!resident) {
    throw Object.assign(new Error(`resident channel receiver ${channelId} is not active`), {
      code: "ResidentSessionUnavailable",
    });
  }
  await resident.receiver(payload);
}

export async function acceptResidentChannelDelivery(
  ownerEntityId: string,
  input: ResidentChannelDeliveryInput
): Promise<{ processed: true }> {
  await deliverResidentSession(ownerEntityId, input.channelId, {
    channelId: input.channelId,
    message: input.envelope,
  });
  return { processed: true };
}

export function inspectResidentSessions(ownerEntityId: string): Array<{
  channelId: string;
  openedAt: number;
  ageMs: number;
}> {
  const prefix = `${ownerEntityId}\u0000`;
  const now = Date.now();
  return [...receivers.entries()]
    .filter(([identity]) => identity.startsWith(prefix))
    .map(([identity, resident]) => ({
      channelId: identity.slice(prefix.length),
      openedAt: resident.openedAt,
      ageMs: Math.max(0, now - resident.openedAt),
    }));
}
