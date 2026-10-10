import { canonicalEntityId } from "./runtime/entitySpec.js";
import { createReceiverRpcMethods } from "./rpcMethods.js";
/** Activation-local receivers owned by explicitly resident operations.
 * Durable state must never depend on this registry: a missing receiver means
 * the sender retains and retries its durable mailbox item. */

export type ResidentSessionReceiver = ((payload: unknown) => void | Promise<void>) & {
  /** Owner drain invokes this before awaiting deliveries so guest handlers
   * receive cancellation instead of pinning the terminal path indefinitely. */
  abortAll?: () => void;
};

/** Exact outbound authority retained by one resident operation. The owner
 * captures its already-attenuated execution transport at registration time;
 * consumers must not fall back to an ambient runtime client after the
 * callback crosses an isolate or request boundary. */
export interface ResidentSessionTransport {
  call: import("@vibestudio/rpc").RpcCaller["call"];
}

export interface ResidentSessionRegistration {
  transport: ResidentSessionTransport;
  close(): void | Promise<void>;
  /** Called only after the durable channel relationship has ended. Owner-side
   * membership catalogs must survive ordinary receiver drain/detach. */
  relationshipEnded?(): void | Promise<void>;
}

/** Owner-local registration capability. The implementation must be supplied
 * by the Durable Object activation whose identity receives channel delivery;
 * importing another bundle's module-local registry is not equivalent. */
export interface ResidentSessionRegistrar {
  registerResidentSession(
    channelId: string,
    receiver: ResidentSessionReceiver,
    relationship: { targetId: string }
  ): ResidentSessionRegistration;
}

interface ResidentReceiver {
  receiver: ResidentSessionReceiver;
  openedAt: number;
  channelTargetId: string;
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

/** Live delivery originates only from the exact admitted channel entity;
 * retained mailbox delivery is dispatched by the trusted host. */
export function assertChannelDeliverySource(
  caller: { id: string | null; kind: string | null },
  input: Pick<ResidentChannelDeliveryInput, "channelId" | "channelRef">,
  expectedChannelTargetId: string | null
): void {
  if (input.channelRef.objectKey !== input.channelId)
    throw new Error("Channel delivery identity mismatch");
  if (caller.kind === "server" || caller.kind === "shell") return;
  const expected = canonicalEntityId({
    kind: "do",
    source: input.channelRef.source,
    className: input.channelRef.className,
    key: input.channelRef.objectKey,
  });
  if (caller.kind !== "do" || caller.id !== expected || expected !== expectedChannelTargetId)
    throw new Error("Channel delivery requires its exact admitted channel owner");
}

export interface ResidentChannelInvocationInput {
  channelId: string;
  message: unknown;
}

export interface ResidentChannelCancellationInput {
  channelId: string;
  transportCallId: string;
}

/** Live callbacks belong to one actual owner activation. A facet crash or
 * eviction discards this registry with its instance, even when executable
 * module globals are shared by other Durable Objects. */
export class ResidentSessionRegistry {
  private readonly receivers = new Map<string, ResidentReceiver>();

  register(
    channelId: string,
    receiver: ResidentSessionReceiver,
    relationship: { targetId: string }
  ): () => void {
    if (this.receivers.has(channelId)) {
      throw new Error(`resident channel receiver ${channelId} is already active`);
    }
    const resident = { receiver, openedAt: Date.now(), channelTargetId: relationship.targetId };
    this.receivers.set(channelId, resident);
    return () => {
      if (this.receivers.get(channelId) === resident) this.receivers.delete(channelId);
    };
  }

  target(channelId: string): string | null {
    return this.receivers.get(channelId)?.channelTargetId ?? null;
  }

  async deliver(channelId: string, payload: unknown): Promise<void> {
    const resident = this.receivers.get(channelId);
    if (!resident) {
      throw Object.assign(new Error(`resident channel receiver ${channelId} is not active`), {
        code: "ResidentSessionUnavailable",
      });
    }
    await resident.receiver(payload);
  }

  async acceptDelivery(input: ResidentChannelDeliveryInput): Promise<{
    processed: true;
    recipientExecutionStartedAt: number;
  }> {
    const recipientExecutionStartedAt = Date.now();
    await this.deliver(input.channelId, { channelId: input.channelId, message: input.envelope });
    return { processed: true, recipientExecutionStartedAt };
  }

  async acceptInvocation(input: ResidentChannelInvocationInput): Promise<{ accepted: true }> {
    await this.deliver(input.channelId, { channelId: input.channelId, message: input.message });
    return { accepted: true };
  }

  async cancelInvocation(input: ResidentChannelCancellationInput): Promise<{ accepted: true }> {
    await this.deliver(input.channelId, {
      channelId: input.channelId,
      cancellation: { transportCallId: input.transportCallId },
    });
    return { accepted: true };
  }

  inspect(): Array<{ channelId: string; openedAt: number; ageMs: number }> {
    const now = Date.now();
    return [...this.receivers.entries()].map(([channelId, resident]) => ({
      channelId,
      openedAt: resident.openedAt,
      ageMs: Math.max(0, now - resident.openedAt),
    }));
  }
}

/** Lifecycle protocol implemented by the workspace channel receiver and used by host-owned resident sessions. */
export interface ResidentChannelLifecycle {
  detach(input: { participantId: string }): Promise<void>;
  leave(input: { participantId: string; revision: number }): Promise<void>;
  relationshipState(participantId: string): Promise<{ revision: number; active: boolean }>;
}
export const residentChannelRpcMethods = createReceiverRpcMethods<ResidentChannelLifecycle>([
  "detach",
  "leave",
  "relationshipState",
]);
