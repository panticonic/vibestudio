import type { AuthenticatedCaller, CallerKind, RpcEnvelope, RpcMessage } from "./types.js";

export interface EnvelopeInput {
  selfId: string;
  from: string;
  target: string;
  message: RpcMessage;
  callerKind?: CallerKind | "unknown";
  caller?: AuthenticatedCaller;
  provenance?: AuthenticatedCaller[];
  idempotencyKey?: string;
  readOnly?: boolean;
}

export function authenticatedCaller(
  callerId: string,
  callerKind: CallerKind | "unknown" = "unknown"
): AuthenticatedCaller {
  return { callerId, callerKind };
}

export function originOfEnvelope(envelope: RpcEnvelope): AuthenticatedCaller {
  return envelope.provenance[0] ?? envelope.delivery.caller;
}

export function envelopeFromMessage(input: EnvelopeInput): RpcEnvelope {
  const caller = input.caller ?? authenticatedCaller(input.from, input.callerKind);
  return {
    from: input.from,
    target: input.target,
    delivery: {
      caller,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.readOnly ? { readOnly: true } : {}),
    },
    provenance: input.provenance?.length ? input.provenance : [caller],
    message: input.message,
  };
}

export function retargetEnvelope(envelope: RpcEnvelope, target: string): RpcEnvelope {
  if (envelope.target === target) return envelope;
  return { ...envelope, target };
}

function stampMessageFromId(message: RpcMessage, callerId: string): RpcMessage {
  switch (message.type) {
    case "request":
    case "event":
    case "stream-request":
    case "stream-frame":
    case "stream-cancel":
    case "request-cancel":
      return { ...message, fromId: callerId };
    case "response":
      return message;
  }
}

/**
 * Replace caller-controlled envelope identity with the principal authenticated
 * by the current transport/session. This is for trust-boundary relays such as
 * panel webview bridges: payload, target, request ids, and delivery options are
 * preserved, but identity/provenance are not accepted from the caller.
 */
export function stampEnvelopeCaller(
  envelope: RpcEnvelope,
  caller: AuthenticatedCaller
): RpcEnvelope {
  return {
    ...envelope,
    from: caller.callerId,
    delivery: {
      ...envelope.delivery,
      caller,
    },
    provenance: [caller],
    message: stampMessageFromId(envelope.message, caller.callerId),
  };
}

export function responseEnvelopeFor(
  requestEnvelope: RpcEnvelope,
  responder: AuthenticatedCaller,
  message: RpcMessage
): RpcEnvelope {
  return {
    from: requestEnvelope.target,
    target: requestEnvelope.from,
    delivery: { caller: responder },
    provenance: requestEnvelope.provenance,
    message,
  };
}
