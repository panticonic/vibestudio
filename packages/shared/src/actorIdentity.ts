/**
 * Private identity carried by a strict shared actor envelope.
 *
 * Actor envelopes deliberately expose only their stable protocol fields.
 * Host-verified account identity is a private provenance claim, so it lives in
 * metadata and is removed by the agentic protocol's public metadata allowlist.
 */
export interface ActorAccountSubject {
  userId: string;
}

export interface ActorWithMetadata {
  metadata?: Record<string, unknown>;
}

const ACCOUNT_SUBJECT_METADATA_KEY = "accountSubject";

/** Attach a verified account subject without inventing a new actor wire field. */
export function withPrivateAccountSubject<T extends object>(
  actor: T,
  subject: ActorAccountSubject | null | undefined
): T & ActorWithMetadata {
  if (!subject?.userId) return actor;
  const existingMetadata = (actor as ActorWithMetadata).metadata;
  return {
    ...actor,
    metadata: {
      ...(existingMetadata ?? {}),
      [ACCOUNT_SUBJECT_METADATA_KEY]: { userId: subject.userId },
    },
  };
}

/** Read the private verified subject from an actor envelope, if present. */
export function privateAccountSubject(
  actor: ActorWithMetadata | null | undefined
): ActorAccountSubject | undefined {
  const value = actor?.metadata?.[ACCOUNT_SUBJECT_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const userId = (value as Record<string, unknown>)["userId"];
  return typeof userId === "string" && userId.length > 0 ? { userId } : undefined;
}
