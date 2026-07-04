import type {
  ActorRef,
  AgenticEvent,
  ApprovalPayload,
  ChannelForkedPayload,
  CustomStartedPayload,
  ExternalEnvelopeObservedPayload,
  ExternalParticipantObservedPayload,
  InvocationPayload,
  MessageTypeRegisteredPayload,
  ParticipantKind,
  ParticipantRef,
  ParticipantSelector,
} from "./events.js";
import { PARTICIPANT_KINDS } from "./events.js";

const PUBLIC_METADATA_KEYS = [
  "kind",
  "type",
  "name",
  "displayName",
  "handle",
  "typing",
  "executionMode",
  "activeModel",
] as const;

export interface PublicMethodSummary {
  name: string;
  streaming?: boolean;
  menu?: Record<string, unknown>;
}

export type PublicParticipantMetadata = Partial<Record<(typeof PUBLIC_METADATA_KEYS)[number], string | number | boolean>> & {
  methods?: PublicMethodSummary[];
};

export type PrivateParticipantMetadata = PublicParticipantMetadata & Record<string, unknown>;

export function publicParticipantMetadata(
  metadata?: Record<string, unknown> | null
): PublicParticipantMetadata | undefined {
  if (!metadata) return undefined;
  const out: PublicParticipantMetadata = {};
  for (const key of PUBLIC_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  const methods = publicMethodSummaries(metadata["methods"]);
  if (methods.length > 0) out["methods"] = methods;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function participantRefFromMetadata(
  participantId: string,
  metadata?: Record<string, unknown> | null
): ParticipantRef {
  const publicMetadata = publicParticipantMetadata(metadata);
  const declaredKind = publicMetadata?.["kind"] ?? publicMetadata?.["type"];
  const kind = participantKindFromMetadata(participantId, declaredKind);
  const displayName = typeof publicMetadata?.["name"] === "string"
    ? publicMetadata["name"]
    : typeof publicMetadata?.["displayName"] === "string"
      ? publicMetadata["displayName"]
      : undefined;
  return {
    kind,
    id: participantId,
    participantId,
    ...(displayName ? { displayName } : {}),
    ...(publicMetadata ? { metadata: publicMetadata } : {}),
  };
}

export function publicActorRef<T extends ActorRef>(actor: T): T {
  const publicMetadata = publicParticipantMetadata(actor.metadata);
  const { metadata: _metadata, ...rest } = actor;
  return {
    ...rest,
    ...(publicMetadata ? { metadata: publicMetadata } : {}),
  } as T;
}

export function publicParticipantRef(participant: ParticipantRef): ParticipantRef {
  return publicActorRef(participant);
}

export function isParticipantKind(kind: unknown): kind is ParticipantKind {
  return PARTICIPANT_KINDS.includes(kind as ParticipantKind);
}

export function isParticipantRef(value: unknown): value is ParticipantRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isParticipantKind(record["kind"]) && typeof record["id"] === "string";
}

export function participantRefFromActor(actor: ActorRef): ParticipantRef {
  if (isParticipantKind(actor.kind)) {
    return actor as ParticipantRef;
  }
  return {
    kind: "external",
    id: actor.id,
    ...(actor.displayName ? { displayName: actor.displayName } : {}),
    metadata: {
      ...(actor.metadata ?? {}),
      principalKind: actor.kind,
    },
    ...(actor.participantId ? { participantId: actor.participantId } : {}),
  };
}

export function sanitizeAgenticEventParticipantRefs<T extends AgenticEvent>(event: T): T {
  return {
    ...event,
    actor: publicActorRef(event.actor),
    payload: sanitizePayloadParticipantRefs(event.kind, event.payload),
  } as T;
}

function publicMethodSummaries(value: unknown): PublicMethodSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((method) => {
    if (!method || typeof method !== "object" || Array.isArray(method)) return [];
    const record = method as Record<string, unknown>;
    if (typeof record["name"] !== "string") return [];
    const summary: PublicMethodSummary = {
      name: record["name"],
    };
    if (typeof record["streaming"] === "boolean") summary.streaming = record["streaming"];
    if (record["menu"] && typeof record["menu"] === "object" && !Array.isArray(record["menu"])) {
      summary.menu = record["menu"] as Record<string, unknown>;
    }
    return [summary];
  });
}

function sanitizePayloadParticipantRefs(kind: AgenticEvent["kind"], payload: AgenticEvent["payload"]): AgenticEvent["payload"] {
  switch (kind) {
    case "invocation.started":
      return sanitizeInvocationPayload(payload as InvocationPayload);
    case "approval.requested":
    case "approval.resolved":
      return sanitizeApprovalPayload(payload as ApprovalPayload);
    case "messageType.registered":
      return sanitizeMessageTypeRegisteredPayload(payload as MessageTypeRegisteredPayload);
    case "custom.started":
      return sanitizeCustomStartedPayload(payload as CustomStartedPayload);
    case "external.envelope_observed":
      return sanitizeExternalEnvelopeObservedPayload(payload as ExternalEnvelopeObservedPayload);
    case "external.participant_observed":
      return sanitizeExternalParticipantObservedPayload(payload as ExternalParticipantObservedPayload);
    case "channel.forked":
      return sanitizeChannelForkedPayload(payload as ChannelForkedPayload);
    default:
      return payload;
  }
}

function sanitizeChannelForkedPayload(payload: ChannelForkedPayload): ChannelForkedPayload {
  return {
    ...payload,
    actor: publicParticipantRef(payload.actor),
  };
}

function sanitizeInvocationPayload(payload: InvocationPayload): InvocationPayload {
  if (!("transport" in payload) || payload.transport?.kind !== "channel") return payload;
  return {
    ...payload,
    transport: {
      ...payload.transport,
      target: publicParticipantRef(payload.transport.target),
    },
  };
}

function sanitizeApprovalPayload(payload: ApprovalPayload): ApprovalPayload {
  if ("question" in payload) {
    return {
      ...payload,
      ...(payload.requestedBy ? { requestedBy: publicActorRef(payload.requestedBy) } : {}),
      ...(isParticipantRef(payload.approver) ? { approver: publicParticipantRef(payload.approver) } : {}),
    };
  }
  return {
    ...payload,
    resolvedBy: publicActorRef(payload.resolvedBy),
  };
}

function sanitizeMessageTypeRegisteredPayload(payload: MessageTypeRegisteredPayload): MessageTypeRegisteredPayload {
  return {
    ...payload,
    ...(payload.registeredBy ? { registeredBy: publicActorRef(payload.registeredBy) } : {}),
  };
}

function sanitizeCustomStartedPayload(payload: CustomStartedPayload): CustomStartedPayload {
  return {
    ...payload,
    ...(payload.by ? { by: publicActorRef(payload.by) } : {}),
  };
}

function sanitizeExternalEnvelopeObservedPayload(
  payload: ExternalEnvelopeObservedPayload
): ExternalEnvelopeObservedPayload {
  return {
    ...payload,
    from: publicParticipantRef(payload.from),
  };
}

function sanitizeExternalParticipantObservedPayload(
  payload: ExternalParticipantObservedPayload
): ExternalParticipantObservedPayload {
  return {
    ...payload,
    participant: publicParticipantRef(payload.participant),
  };
}

function participantKindFromMetadata(
  participantId: string,
  declaredKind: unknown
): ParticipantKind {
  if (
    declaredKind === "user" ||
    declaredKind === "agent" ||
    declaredKind === "system" ||
    declaredKind === "panel" ||
    declaredKind === "external"
  ) {
    return declaredKind;
  }
  if (participantId === "system") return "system";
  if (participantId.startsWith("panel:")) return "panel";
  if (participantId.startsWith("do:")) return "agent";
  return "external";
}
