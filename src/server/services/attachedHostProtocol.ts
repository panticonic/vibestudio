import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type {
  CallerKind,
  CapabilityScope,
  InvocationSnapshot,
  ResourceScope,
} from "@vibestudio/rpc";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import { invocationSnapshotDigest } from "@vibestudio/shared/authority/invocationSnapshot";
import { generatedHostMethodAuthority } from "@vibestudio/shared/authority/hostAuthorityCatalog.generated";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  createTypedServiceClient,
  type ServiceCallFn,
  type ServiceMethodSchemas,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import type {
  AttachedHostApprovalChallenge,
  AttachedHostApprovalDecision,
  AttachedHostChildAcceptance,
  AttachedHostInvocationEnvelope,
  AttachedHostInvocationReference,
  AttachedHostParentHello,
  AttachedHostSessionProof,
  AttachedHostTranscript,
} from "@vibestudio/service-schemas/attachedHosts";

export type {
  AttachedHostApprovalChallenge,
  AttachedHostApprovalDecision,
  AttachedHostChildAcceptance,
  AttachedHostInvocationEnvelope,
  AttachedHostInvocationReference,
  AttachedHostParentHello,
  AttachedHostSessionProof,
  AttachedHostTranscript,
} from "@vibestudio/service-schemas/attachedHosts";

export const ATTACHED_HOST_PROTOCOL_VERSION = 1 as const;
const SESSION_DOMAIN = "vibestudio/attached-host/session/v1";
const INVOCATION_REFERENCE_DOMAIN = "vibestudio/attached-host/invocation-reference/v1";
const INVOCATION_DOMAIN = "vibestudio/attached-host/invocation/v1";
const CHALLENGE_DOMAIN = "vibestudio/attached-host/approval-challenge/v1";
const DECISION_DOMAIN = "vibestudio/attached-host/approval-decision/v1";

export type AttachedHostDecision = "once" | "deny";
export type AttachedHostTier = "gated" | "critical";

export interface AttachedHostSessionFacts {
  parentHostId: string;
  childHostId: string;
  childGenerationId: string;
  developmentRunId: string;
  initiatingRuntimeId: string;
  initiatingRuntimeKind: CallerKind;
  initiatingUserId: string | null;
}

export interface AttachedHostRelationshipFacts {
  sessionId: string;
  parentHostId: string;
  childHostId: string;
  childGenerationId: string;
  developmentRunId: string;
  ownerRuntimeId: string;
  ownerRuntimeKind: CallerKind;
  ownerUserId: string | null;
}

export interface AttachedHostSessionRecord {
  transcript: AttachedHostTranscript;
  parentSignature: string;
  childSignature: string;
  parentKeyFingerprint: string;
  childKeyFingerprint: string;
  state: "active" | "closed";
  closedReason: string | null;
  closedAt: number | null;
}

export interface AttachedHostChallengeRecord {
  challenge: AttachedHostApprovalChallenge;
  shownPresentationDigest: string | null;
  state: "pending" | "consumed" | "route-lost";
  decision: AttachedHostDecision | null;
  /** Receiver receipt time for the signed challenge. */
  challengedAt: number;
  /** Parent receipt time for the one terminal signed decision, if issued. */
  decidedAt: number | null;
}

export interface AttachedHostApprovalAuditRecord {
  /** Stable opaque cursor from the store's canonical challenge journal. */
  cursor: string;
  challenge: AttachedHostApprovalChallenge;
  shownPresentationDigest: string;
  decision: AttachedHostDecision;
  challengedAt: number;
  decidedAt: number;
}

/**
 * Durable protocol facts. Implementations must make message consumption and
 * challenge consumption atomic. Private keys and bootstrap credentials never
 * cross this boundary.
 */
export interface AttachedHostProtocolStore {
  putSession(record: AttachedHostSessionRecord): void;
  getSession(sessionId: string): AttachedHostSessionRecord | null;
  closeSession(sessionId: string, reason: string, at: number): void;
  consumeMessage(sessionId: string, messageId: string, expiresAt: number, at: number): boolean;
  putChallenge(record: AttachedHostChallengeRecord): void;
  getChallenge(sessionId: string, nonce: string): AttachedHostChallengeRecord | null;
  markChallengeShown(sessionId: string, nonce: string, presentationDigest: string): boolean;
  consumeChallenge(
    sessionId: string,
    nonce: string,
    snapshotDigest: string,
    decision: AttachedHostDecision
  ): boolean;
  /** Atomically record the one terminal decision issued by the parent. */
  recordChallengeDecision(
    sessionId: string,
    nonce: string,
    snapshotDigest: string,
    decision: AttachedHostDecision,
    decidedAt: number
  ): boolean;
  /** Ordered terminal decisions only; no invocation arguments or signatures. */
  listApprovalAudit(input: {
    sessionId: string;
    after: string | null;
    limit: number;
  }): AttachedHostApprovalAuditRecord[];
  closePendingChallenges(sessionId: string): number;
}

export interface AttachedHostLocalFacts {
  facts: AttachedHostSessionFacts;
  /**
   * Receiver-owned ceiling. The child accepts the requested ceiling only when
   * every requested scope is contained by this independently-derived policy.
   */
  authorityCeiling: readonly CapabilityScope[];
}

interface LiveSession {
  privateKey: KeyObject;
  publicKey: KeyObject;
  record: AttachedHostSessionRecord;
  nextMessageId: bigint;
}

export interface AttachedHostDispatchInput {
  relationship: AttachedHostRelationshipFacts;
  authorityCeiling: readonly CapabilityScope[];
  authorityCeilingDigest: string;
  service: string;
  method: string;
  args: unknown[];
  invocationReference: AttachedHostInvocationReference;
}

export interface AttachedHostEndpointOptions {
  role: "parent" | "child";
  store: AttachedHostProtocolStore;
  localFacts: (facts: AttachedHostSessionFacts) => AttachedHostLocalFacts;
  requiredAuthority?: (
    service: string,
    method: string,
    args: readonly unknown[]
  ) => readonly CapabilityScope[];
  dispatch?: (input: AttachedHostDispatchInput) => Promise<unknown>;
  resolveApprovalPresentation?: (
    challenge: AttachedHostApprovalChallenge
  ) => AttachedHostCanonicalApprovalPresentation | null;
  now?: () => number;
  randomId?: () => string;
}

/**
 * One endpoint of a mutually authenticated attached-host session.
 *
 * The endpoint is deliberately transport-independent: the bootstrap pairing
 * and the routed link carry these exact messages, while this class owns all
 * cryptographic, replay, ceiling, relationship, and approval invariants.
 */
export class AttachedHostEndpoint {
  private readonly live = new Map<string, LiveSession>();
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly options: AttachedHostEndpointOptions) {
    this.now = options.now ?? Date.now;
    this.randomId =
      options.randomId ??
      (() =>
        createHash("sha256")
          .update(`${Date.now()}:${process.hrtime.bigint()}:${Math.random()}`)
          .digest("hex")
          .slice(0, 32));
  }

  beginParent(input: {
    facts: AttachedHostSessionFacts;
    requestedAuthorityCeiling: readonly CapabilityScope[];
    ttlMs: number;
  }): AttachedHostParentHello {
    this.assertRole("parent");
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw protocolError("EATTACHED_EXPIRY", "Attached-host session TTL must be positive");
    }
    const local = this.options.localFacts(input.facts);
    assertSameFacts(input.facts, local.facts);
    const ceiling = normalizeCeiling(input.requestedAuthorityCeiling);
    assertCeilingContained(ceiling, local.authorityCeiling);
    const issuedAt = this.now();
    const sessionId = this.randomId();
    const keyPair = generateKeyPairSync("ed25519");
    const hello: AttachedHostParentHello = {
      protocolVersion: ATTACHED_HOST_PROTOCOL_VERSION,
      sessionId,
      ...input.facts,
      requestedAuthorityCeiling: [...ceiling],
      authorityCeilingDigest: ceilingDigest(ceiling),
      issuedAt,
      expiresAt: issuedAt + input.ttlMs,
      parentRoutePublicKey: exportPublicKey(keyPair.publicKey),
    };
    this.live.set(sessionId, {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      record: pendingRecord(hello, keyPair.publicKey),
      nextMessageId: 1n,
    });
    return hello;
  }

  acceptChild(hello: AttachedHostParentHello): AttachedHostChildAcceptance {
    this.assertRole("child");
    assertExactProtocol(hello.protocolVersion);
    assertFresh(hello.issuedAt, hello.expiresAt, this.now());
    const facts = factsFrom(hello);
    const local = this.options.localFacts(facts);
    assertSameFacts(facts, local.facts);
    const requested = normalizeCeiling(hello.requestedAuthorityCeiling);
    if (hello.authorityCeilingDigest !== ceilingDigest(requested)) {
      throw protocolError("EATTACHED_CEILING", "Attached-host ceiling digest does not match");
    }
    // A broad parent request is refused, never silently attenuated: both sides
    // must sign exactly one unambiguous ceiling.
    assertCeilingContained(requested, local.authorityCeiling);
    const keys = generateKeyPairSync("ed25519");
    const transcript: AttachedHostTranscript = {
      protocolVersion: ATTACHED_HOST_PROTOCOL_VERSION,
      sessionId: hello.sessionId,
      ...facts,
      authorityCeiling: [...requested],
      authorityCeilingDigest: ceilingDigest(requested),
      issuedAt: hello.issuedAt,
      expiresAt: hello.expiresAt,
      parentRoutePublicKey: hello.parentRoutePublicKey,
      childRoutePublicKey: exportPublicKey(keys.publicKey),
    };
    const childSignature = signature(keys.privateKey, SESSION_DOMAIN, transcript);
    const record: AttachedHostSessionRecord = {
      transcript,
      parentSignature: "",
      childSignature,
      parentKeyFingerprint: publicKeyFingerprint(hello.parentRoutePublicKey),
      childKeyFingerprint: keyFingerprint(keys.publicKey),
      state: "active",
      closedReason: null,
      closedAt: null,
    };
    this.live.set(hello.sessionId, {
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      record,
      nextMessageId: 1n,
    });
    return { transcript, childSignature };
  }

  confirmParent(acceptance: AttachedHostChildAcceptance): AttachedHostSessionProof {
    this.assertRole("parent");
    const live = this.requireLive(acceptance.transcript.sessionId);
    const transcript = acceptance.transcript;
    assertExactProtocol(transcript.protocolVersion);
    assertFresh(transcript.issuedAt, transcript.expiresAt, this.now());
    assertTranscriptMatchesPending(live.record.transcript, transcript);
    verifySignature(
      importPublicKey(transcript.childRoutePublicKey),
      SESSION_DOMAIN,
      transcript,
      acceptance.childSignature
    );
    const local = this.options.localFacts(factsFrom(transcript));
    assertSameFacts(factsFrom(transcript), local.facts);
    assertCeilingContained(transcript.authorityCeiling, local.authorityCeiling);
    if (transcript.authorityCeilingDigest !== ceilingDigest(transcript.authorityCeiling)) {
      throw protocolError("EATTACHED_CEILING", "Attached-host ceiling digest does not match");
    }
    const parentSignature = signature(live.privateKey, SESSION_DOMAIN, transcript);
    const record: AttachedHostSessionRecord = {
      transcript,
      parentSignature,
      childSignature: acceptance.childSignature,
      parentKeyFingerprint: keyFingerprint(live.publicKey),
      childKeyFingerprint: publicKeyFingerprint(transcript.childRoutePublicKey),
      state: "active",
      closedReason: null,
      closedAt: null,
    };
    live.record = record;
    this.options.store.putSession(record);
    return { ...acceptance, parentSignature };
  }

  finalizeChild(proof: AttachedHostSessionProof): AttachedHostSessionRecord {
    this.assertRole("child");
    const live = this.requireLive(proof.transcript.sessionId);
    assertTranscriptMatchesPending(live.record.transcript, proof.transcript);
    if (proof.childSignature !== live.record.childSignature) {
      throw protocolError("EATTACHED_SIGNATURE", "Child session signature was substituted");
    }
    verifySignature(
      importPublicKey(proof.transcript.parentRoutePublicKey),
      SESSION_DOMAIN,
      proof.transcript,
      proof.parentSignature
    );
    const local = this.options.localFacts(factsFrom(proof.transcript));
    assertSameFacts(factsFrom(proof.transcript), local.facts);
    assertCeilingContained(proof.transcript.authorityCeiling, local.authorityCeiling);
    const record = {
      ...live.record,
      parentSignature: proof.parentSignature,
    };
    live.record = record;
    this.options.store.putSession(record);
    return record;
  }

  createInvocation(input: {
    sessionId: string;
    service: string;
    method: string;
    args: readonly unknown[];
    requestId: string;
    ttlMs: number;
  }): AttachedHostInvocationEnvelope {
    this.assertRole("parent");
    const live = this.requireActive(input.sessionId);
    const now = this.now();
    assertFresh(now, Math.min(now + input.ttlMs, live.record.transcript.expiresAt), now);
    const transcript = live.record.transcript;
    const invocationReference: AttachedHostInvocationReference = {
      sessionId: input.sessionId,
      childGenerationId: transcript.childGenerationId,
      developmentRunId: transcript.developmentRunId,
      ownerRuntimeId: transcript.initiatingRuntimeId,
      ownerRuntimeKind: transcript.initiatingRuntimeKind,
      ownerUserId: transcript.initiatingUserId,
      requestId: input.requestId,
      issuedAt: now,
      expiresAt: Math.min(now + input.ttlMs, transcript.expiresAt),
    };
    const invocationReferenceSignature = signature(
      live.privateKey,
      INVOCATION_REFERENCE_DOMAIN,
      invocationReference
    );
    const unsigned = {
      protocolVersion: ATTACHED_HOST_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      childGenerationId: transcript.childGenerationId,
      messageId: String(live.nextMessageId++),
      expiresAt: invocationReference.expiresAt,
      service: nonEmpty(input.service, "service"),
      method: nonEmpty(input.method, "method"),
      argumentsDigest: digest(input.args),
      invocationReference,
      invocationReferenceSignature,
    };
    return {
      ...unsigned,
      signature: signature(live.privateKey, INVOCATION_DOMAIN, unsigned),
    };
  }

  async receiveInvocation(
    envelope: AttachedHostInvocationEnvelope,
    args: unknown[]
  ): Promise<unknown> {
    this.assertRole("child");
    assertExactProtocol(envelope.protocolVersion);
    const live = this.requireActive(envelope.sessionId);
    const transcript = live.record.transcript;
    const now = this.now();
    assertFresh(envelope.invocationReference.issuedAt, envelope.expiresAt, now);
    assertEnvelopeBindings(envelope, transcript);
    const parentKey = importPublicKey(transcript.parentRoutePublicKey);
    verifySignature(
      parentKey,
      INVOCATION_REFERENCE_DOMAIN,
      envelope.invocationReference,
      envelope.invocationReferenceSignature
    );
    verifySignature(parentKey, INVOCATION_DOMAIN, unsignedInvocation(envelope), envelope.signature);
    if (digest(args) !== envelope.argumentsDigest) {
      throw protocolError("EATTACHED_ARGUMENTS", "Attached-host arguments were substituted");
    }
    const message = parseMessageId(envelope.messageId);
    if (
      !this.options.store.consumeMessage(
        envelope.sessionId,
        String(message),
        envelope.expiresAt,
        now
      )
    ) {
      throw protocolError("EATTACHED_REPLAY", "Attached-host invocation was already consumed");
    }
    const required =
      this.options.requiredAuthority?.(envelope.service, envelope.method, args) ?? [];
    assertCeilingContained(required, transcript.authorityCeiling);
    const dispatch = this.options.dispatch;
    if (!dispatch) {
      throw protocolError("EATTACHED_DISPATCH", "Attached-host child dispatcher is unavailable");
    }
    return await dispatch({
      relationship: relationshipFacts(transcript),
      authorityCeiling: transcript.authorityCeiling,
      authorityCeilingDigest: transcript.authorityCeilingDigest,
      service: envelope.service,
      method: envelope.method,
      args,
      invocationReference: envelope.invocationReference,
    });
  }

  prepareApproval(input: {
    sessionId: string;
    nonce: string;
    requestId: string;
    invocationSnapshot: InvocationSnapshot;
    capability: string;
    resourceKey: string;
    tier: AttachedHostTier;
    ttlMs: number;
    /** Deliberately ignored and never serialized or signed. */
    childDisplayText?: string;
  }): AttachedHostApprovalChallenge {
    this.assertRole("child");
    const live = this.requireActive(input.sessionId);
    const expiresAt = Math.min(this.now() + input.ttlMs, live.record.transcript.expiresAt);
    const unsigned = {
      protocolVersion: ATTACHED_HOST_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      childGenerationId: live.record.transcript.childGenerationId,
      nonce: nonEmpty(input.nonce, "challenge nonce"),
      requestId: nonEmpty(input.requestId, "approval request id"),
      invocationSnapshot: input.invocationSnapshot,
      invocationSnapshotDigest: invocationSnapshotDigest(input.invocationSnapshot),
      capability: nonEmpty(input.capability, "capability"),
      resourceKey: nonEmpty(input.resourceKey, "resource key"),
      tier: input.tier,
      preparedOperationDigest: nonEmpty(
        input.invocationSnapshot.preparedStateDigest,
        "prepared operation digest"
      ),
      expiresAt,
    };
    assertChallengeSnapshotBindings(unsigned);
    const challenge: AttachedHostApprovalChallenge = {
      ...unsigned,
      signature: signature(live.privateKey, CHALLENGE_DOMAIN, unsigned),
    };
    this.options.store.putChallenge({
      challenge,
      shownPresentationDigest: null,
      state: "pending",
      decision: null,
      challengedAt: this.now(),
      decidedAt: null,
    });
    return challenge;
  }

  verifyChallenge(challenge: AttachedHostApprovalChallenge): {
    presentation: AttachedHostCanonicalApprovalPresentation;
    shownPresentationDigest: string;
  } {
    this.assertRole("parent");
    const live = this.requireActive(challenge.sessionId);
    assertFresh(live.record.transcript.issuedAt, challenge.expiresAt, this.now());
    if (challenge.childGenerationId !== live.record.transcript.childGenerationId) {
      throw protocolError("EATTACHED_GENERATION", "Approval challenge uses another generation");
    }
    if (
      invocationSnapshotDigest(challenge.invocationSnapshot) !== challenge.invocationSnapshotDigest
    ) {
      throw protocolError("EATTACHED_SUBSTITUTION", "Approval invocation snapshot was substituted");
    }
    assertChallengeSnapshotBindings(challenge);
    verifySignature(
      importPublicKey(live.record.transcript.childRoutePublicKey),
      CHALLENGE_DOMAIN,
      unsignedChallenge(challenge),
      challenge.signature
    );
    const presentation = (
      this.options.resolveApprovalPresentation ?? resolveStaticAttachedHostApprovalPresentation
    )(challenge);
    if (!presentation) {
      throw protocolError(
        "EATTACHED_PRESENTATION",
        "Parent cannot independently resolve canonical approval substance"
      );
    }
    const shownPresentationDigest = digest(presentation);
    this.options.store.putChallenge({
      challenge,
      shownPresentationDigest,
      state: "pending",
      decision: null,
      challengedAt: this.now(),
      decidedAt: null,
    });
    this.options.store.markChallengeShown(
      challenge.sessionId,
      challenge.nonce,
      shownPresentationDigest
    );
    return { presentation, shownPresentationDigest };
  }

  createDecision(input: {
    challenge: AttachedHostApprovalChallenge;
    shownPresentationDigest: string;
    decision: AttachedHostDecision;
    ttlMs: number;
  }): AttachedHostApprovalDecision {
    this.assertRole("parent");
    const live = this.requireActive(input.challenge.sessionId);
    const stored = this.options.store.getChallenge(
      input.challenge.sessionId,
      input.challenge.nonce
    );
    if (
      !stored ||
      stored.state !== "pending" ||
      stored.shownPresentationDigest !== input.shownPresentationDigest
    ) {
      throw protocolError("EATTACHED_CHALLENGE", "Approval challenge was not shown canonically");
    }
    const unsigned = {
      protocolVersion: ATTACHED_HOST_PROTOCOL_VERSION,
      sessionId: input.challenge.sessionId,
      childGenerationId: input.challenge.childGenerationId,
      nonce: input.challenge.nonce,
      invocationSnapshotDigest: input.challenge.invocationSnapshotDigest,
      shownPresentationDigest: input.shownPresentationDigest,
      decision: input.decision,
      expiresAt: Math.min(this.now() + input.ttlMs, live.record.transcript.expiresAt),
    };
    const decision = {
      ...unsigned,
      signature: signature(live.privateKey, DECISION_DOMAIN, unsigned),
    };
    if (
      !this.options.store.recordChallengeDecision(
        input.challenge.sessionId,
        input.challenge.nonce,
        input.challenge.invocationSnapshotDigest,
        input.decision,
        this.now()
      )
    ) {
      throw protocolError("EATTACHED_REPLAY", "Approval challenge already has a terminal decision");
    }
    return decision;
  }

  consumeDecision(input: {
    decision: AttachedHostApprovalDecision;
    evaluateLocally: (challenge: AttachedHostApprovalChallenge) => boolean;
    mintLocalOnce: (input: {
      challenge: AttachedHostApprovalChallenge;
      decision: AttachedHostDecision;
    }) => void;
  }): AttachedHostDecision {
    this.assertRole("child");
    const { decision } = input;
    const live = this.requireActive(decision.sessionId);
    assertExactProtocol(decision.protocolVersion);
    assertFresh(live.record.transcript.issuedAt, decision.expiresAt, this.now());
    if (decision.childGenerationId !== live.record.transcript.childGenerationId) {
      throw protocolError("EATTACHED_GENERATION", "Approval decision uses another generation");
    }
    verifySignature(
      importPublicKey(live.record.transcript.parentRoutePublicKey),
      DECISION_DOMAIN,
      unsignedDecision(decision),
      decision.signature
    );
    const stored = this.options.store.getChallenge(decision.sessionId, decision.nonce);
    if (
      !stored ||
      stored.state !== "pending" ||
      stored.challenge.invocationSnapshotDigest !== decision.invocationSnapshotDigest
    ) {
      throw protocolError("EATTACHED_REPLAY", "Approval decision has no exact pending invocation");
    }
    if (!/^[a-f0-9]{64}$/u.test(decision.shownPresentationDigest)) {
      throw protocolError("EATTACHED_SUBSTITUTION", "Approval presentation digest is malformed");
    }
    if (
      stored.shownPresentationDigest !== null &&
      stored.shownPresentationDigest !== decision.shownPresentationDigest
    ) {
      throw protocolError("EATTACHED_SUBSTITUTION", "Approval presentation digest was substituted");
    }
    if (
      stored.shownPresentationDigest === null &&
      !this.options.store.markChallengeShown(
        decision.sessionId,
        decision.nonce,
        decision.shownPresentationDigest
      )
    ) {
      throw protocolError("EATTACHED_REPLAY", "Approval challenge is no longer pending");
    }
    // Durable single-use transition happens before a grant can be exposed.
    if (
      !this.options.store.consumeChallenge(
        decision.sessionId,
        decision.nonce,
        decision.invocationSnapshotDigest,
        decision.decision
      )
    ) {
      throw protocolError("EATTACHED_REPLAY", "Approval decision was already consumed");
    }
    const locallyAllowed = input.evaluateLocally(stored.challenge);
    const effectiveDecision =
      decision.decision === "once" && locallyAllowed ? ("once" as const) : ("deny" as const);
    input.mintLocalOnce({ challenge: stored.challenge, decision: effectiveDecision });
    return effectiveDecision;
  }

  close(sessionId: string, reason: string): void {
    const live = this.live.get(sessionId);
    if (live) {
      this.options.store.closePendingChallenges(sessionId);
      this.options.store.closeSession(sessionId, reason, this.now());
      // KeyObject offers no explicit zeroize API. Dropping the only live
      // references is the strongest supported Node primitive; exported key
      // bytes are never retained.
      this.live.delete(sessionId);
    }
  }

  listApprovalAudit(input: {
    sessionId: string;
    after: string | null;
    limit: number;
  }): AttachedHostApprovalAuditRecord[] {
    this.assertRole("parent");
    return this.options.store.listApprovalAudit(input);
  }

  createServiceClient<M extends ServiceMethodSchemas>(
    sessionId: string,
    service: string,
    methods: M,
    send: (envelope: AttachedHostInvocationEnvelope, args: unknown[]) => Promise<unknown>,
    requestId: () => string = this.randomId
  ): TypedServiceClient<M> {
    this.assertRole("parent");
    const call: ServiceCallFn = async (calledService, method, args) => {
      const envelope = this.createInvocation({
        sessionId,
        service: calledService,
        method,
        args,
        requestId: requestId(),
        ttlMs: 30_000,
      });
      return await send(envelope, args);
    };
    return createTypedServiceClient(service, methods, call);
  }

  sessionRecord(sessionId: string): AttachedHostSessionRecord | null {
    return this.live.get(sessionId)?.record ?? this.options.store.getSession(sessionId);
  }

  private requireLive(sessionId: string): LiveSession {
    const live = this.live.get(sessionId);
    if (!live) {
      throw protocolError("EATTACHED_SESSION", "Unknown attached-host session");
    }
    return live;
  }

  private requireActive(sessionId: string): LiveSession {
    const live = this.requireLive(sessionId);
    if (live.record.state !== "active") {
      throw protocolError("EATTACHED_SESSION", "Attached-host session is closed");
    }
    if (this.now() >= live.record.transcript.expiresAt) {
      this.close(sessionId, "expired");
      throw protocolError("EATTACHED_EXPIRY", "Attached-host session expired");
    }
    return live;
  }

  private assertRole(role: "parent" | "child"): void {
    if (this.options.role !== role) {
      throw protocolError("EATTACHED_ROLE", `Attached-host endpoint is not the ${role}`);
    }
  }
}

export function normalizeCeiling(input: readonly CapabilityScope[]): readonly CapabilityScope[] {
  const normalized = input.map((scope) => ({
    capability: nonEmpty(scope.capability, "ceiling capability"),
    resource: normalizeResource(scope.resource),
  }));
  const byCanonical = new Map(normalized.map((scope) => [canonicalJson(scope), scope]));
  return [...byCanonical.values()].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right))
  );
}

export function ceilingDigest(input: readonly CapabilityScope[]): string {
  return digest(normalizeCeiling(input));
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * The only approval substance the parent may render. A child-provided display
 * string is absent by construction.
 */
export interface AttachedHostCanonicalApprovalPresentation {
  title: string;
  action: string;
  description: string;
  service: string;
  method: string;
  capability: string;
  resourceKey: string;
  tier: AttachedHostTier;
  invocationSnapshotDigest: string;
  preparedOperationDigest: string;
}

export function resolveStaticAttachedHostApprovalPresentation(
  challenge: AttachedHostApprovalChallenge
): AttachedHostCanonicalApprovalPresentation | null {
  const snapshot = challenge.invocationSnapshot;
  const qualifiedMethod = `${snapshot.service}.${snapshot.method}`;
  const authority = generatedHostMethodAuthority(qualifiedMethod);
  const resolvedCapability = authority?.capability;
  const resolvedTier = authority?.tier.tier;
  if (
    !resolvedCapability ||
    resolvedCapability !== challenge.capability ||
    (resolvedTier !== "gated" && resolvedTier !== "critical") ||
    resolvedTier !== challenge.tier
  ) {
    return null;
  }
  const metadata = authority.presentation;
  if (!metadata) return null;
  return {
    title: metadata.title,
    action: metadata.action,
    description: metadata.description,
    service: snapshot.service,
    method: snapshot.method,
    invocationSnapshotDigest: challenge.invocationSnapshotDigest,
    capability: challenge.capability,
    resourceKey: challenge.resourceKey,
    tier: challenge.tier,
    preparedOperationDigest: challenge.preparedOperationDigest,
  };
}

export function scopeContains(outer: CapabilityScope, inner: CapabilityScope): boolean {
  const capability = capabilityPatternCovers(outer.capability, inner.capability);
  return capability && resourceContains(outer.resource, inner.resource);
}

export function assertCeilingContained(
  requested: readonly CapabilityScope[],
  local: readonly CapabilityScope[]
): void {
  const normalizedLocal = normalizeCeiling(local);
  for (const scope of normalizeCeiling(requested)) {
    if (!normalizedLocal.some((candidate) => scopeContains(candidate, scope))) {
      throw protocolError(
        "EATTACHED_CEILING",
        `Attached-host ceiling does not admit ${scope.capability} on ${canonicalJson(scope.resource)}`
      );
    }
  }
}

function resourceContains(outer: ResourceScope, inner: ResourceScope): boolean {
  if (outer.kind === "network") return inner.kind === "network";
  if (outer.kind === "exact") return inner.kind === "exact" && outer.key === inner.key;
  if (outer.kind === "prefix") {
    if (inner.kind === "exact") return inner.key.startsWith(outer.prefix);
    return inner.kind === "prefix" && inner.prefix.startsWith(outer.prefix);
  }
  if (outer.kind === "origin") return inner.kind === "origin" && outer.origin === inner.origin;
  return inner.kind === "domain" && outer.domain === inner.domain;
}

function normalizeResource(resource: ResourceScope): ResourceScope {
  if (resource.kind === "exact") return { kind: "exact", key: nonEmpty(resource.key, "resource") };
  if (resource.kind === "prefix") {
    if (resource.prefix.includes("\0")) {
      throw protocolError("EATTACHED_CEILING", "Attached-host resource prefix is malformed");
    }
    return { kind: "prefix", prefix: resource.prefix };
  }
  if (resource.kind === "origin") {
    return { kind: "origin", origin: new URL(resource.origin).origin };
  }
  if (resource.kind === "domain") {
    return { kind: "domain", domain: nonEmpty(resource.domain, "resource domain").toLowerCase() };
  }
  return { kind: "network", value: "*" };
}

function signature(privateKey: KeyObject, domain: string, value: unknown): string {
  return sign(null, signedBytes(domain, value), privateKey).toString("base64url");
}

function verifySignature(
  publicKey: KeyObject,
  domain: string,
  value: unknown,
  encoded: string
): void {
  const signatureBytes = Buffer.from(encoded, "base64url");
  const ok =
    signatureBytes.length === 64 &&
    verify(null, signedBytes(domain, value), publicKey, signatureBytes);
  signatureBytes.fill(0);
  if (!ok) throw protocolError("EATTACHED_SIGNATURE", "Attached-host signature is invalid");
}

function signedBytes(domain: string, value: unknown): Buffer {
  return Buffer.from(`${domain}\0${canonicalJson(value)}`, "utf8");
}

function exportPublicKey(key: KeyObject): string {
  return key.export({ type: "spki", format: "der" }).toString("base64url");
}

function importPublicKey(encoded: string): KeyObject {
  try {
    return createPublicKeyFromDer(Buffer.from(encoded, "base64url"));
  } catch (cause) {
    throw protocolError("EATTACHED_KEY", "Attached-host public key is malformed", cause);
  }
}

function createPublicKeyFromDer(der: Buffer): KeyObject {
  try {
    const key = createPublicKey({ key: der, type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("route key is not Ed25519");
    }
    return key;
  } finally {
    der.fill(0);
  }
}

function keyFingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function publicKeyFingerprint(encoded: string): string {
  return keyFingerprint(importPublicKey(encoded));
}

function pendingRecord(
  hello: AttachedHostParentHello,
  parentPublicKey: KeyObject
): AttachedHostSessionRecord {
  return {
    transcript: {
      protocolVersion: hello.protocolVersion,
      sessionId: hello.sessionId,
      ...factsFrom(hello),
      authorityCeiling: hello.requestedAuthorityCeiling,
      authorityCeilingDigest: hello.authorityCeilingDigest,
      issuedAt: hello.issuedAt,
      expiresAt: hello.expiresAt,
      parentRoutePublicKey: hello.parentRoutePublicKey,
      childRoutePublicKey: "",
    },
    parentSignature: "",
    childSignature: "",
    parentKeyFingerprint: keyFingerprint(parentPublicKey),
    childKeyFingerprint: "",
    state: "active",
    closedReason: null,
    closedAt: null,
  };
}

function factsFrom(input: AttachedHostSessionFacts): AttachedHostSessionFacts {
  return {
    parentHostId: input.parentHostId,
    childHostId: input.childHostId,
    childGenerationId: input.childGenerationId,
    developmentRunId: input.developmentRunId,
    initiatingRuntimeId: input.initiatingRuntimeId,
    initiatingRuntimeKind: input.initiatingRuntimeKind,
    initiatingUserId: input.initiatingUserId,
  };
}

function relationshipFacts(transcript: AttachedHostTranscript): AttachedHostRelationshipFacts {
  return {
    sessionId: transcript.sessionId,
    parentHostId: transcript.parentHostId,
    childHostId: transcript.childHostId,
    childGenerationId: transcript.childGenerationId,
    developmentRunId: transcript.developmentRunId,
    ownerRuntimeId: transcript.initiatingRuntimeId,
    ownerRuntimeKind: transcript.initiatingRuntimeKind,
    ownerUserId: transcript.initiatingUserId,
  };
}

function assertSameFacts(
  expected: AttachedHostSessionFacts,
  actual: AttachedHostSessionFacts
): void {
  if (canonicalJson(factsFrom(expected)) !== canonicalJson(factsFrom(actual))) {
    throw protocolError(
      "EATTACHED_BINDING",
      "Attached-host owner/run/host/generation facts drifted"
    );
  }
}

function assertTranscriptMatchesPending(
  pending: AttachedHostTranscript,
  transcript: AttachedHostTranscript
): void {
  const expected = {
    ...pending,
    childRoutePublicKey: transcript.childRoutePublicKey,
  };
  if (canonicalJson(expected) !== canonicalJson(transcript)) {
    throw protocolError("EATTACHED_BINDING", "Attached-host transcript was substituted");
  }
}

function assertEnvelopeBindings(
  envelope: AttachedHostInvocationEnvelope,
  transcript: AttachedHostTranscript
): void {
  const reference = envelope.invocationReference;
  if (
    envelope.sessionId !== transcript.sessionId ||
    envelope.childGenerationId !== transcript.childGenerationId ||
    reference.sessionId !== transcript.sessionId ||
    reference.childGenerationId !== transcript.childGenerationId ||
    reference.developmentRunId !== transcript.developmentRunId ||
    reference.ownerRuntimeId !== transcript.initiatingRuntimeId ||
    reference.ownerRuntimeKind !== transcript.initiatingRuntimeKind ||
    reference.ownerUserId !== transcript.initiatingUserId ||
    reference.expiresAt !== envelope.expiresAt
  ) {
    throw protocolError("EATTACHED_BINDING", "Attached-host invocation binding does not match");
  }
}

function unsignedInvocation(
  envelope: AttachedHostInvocationEnvelope
): Omit<AttachedHostInvocationEnvelope, "signature"> {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

function unsignedChallenge(
  challenge: AttachedHostApprovalChallenge
): Omit<AttachedHostApprovalChallenge, "signature"> {
  const { signature: _signature, ...unsigned } = challenge;
  return unsigned;
}

function unsignedDecision(
  decision: AttachedHostApprovalDecision
): Omit<AttachedHostApprovalDecision, "signature"> {
  const { signature: _signature, ...unsigned } = decision;
  return unsigned;
}

function assertChallengeSnapshotBindings(
  challenge: Pick<
    AttachedHostApprovalChallenge,
    | "invocationSnapshot"
    | "invocationSnapshotDigest"
    | "capability"
    | "resourceKey"
    | "preparedOperationDigest"
  >
): void {
  const snapshot = challenge.invocationSnapshot;
  if (
    snapshot.v !== 2 ||
    invocationSnapshotDigest(snapshot) !== challenge.invocationSnapshotDigest ||
    snapshot.capability !== challenge.capability ||
    snapshot.resourceKey !== challenge.resourceKey ||
    snapshot.preparedStateDigest !== challenge.preparedOperationDigest
  ) {
    throw protocolError(
      "EATTACHED_SUBSTITUTION",
      "Approval challenge does not bind its exact prepared invocation snapshot"
    );
  }
}

function assertExactProtocol(version: number): void {
  if (version !== ATTACHED_HOST_PROTOCOL_VERSION) {
    throw protocolError("EATTACHED_VERSION", "Unsupported attached-host protocol version");
  }
}

function assertFresh(issuedAt: number, expiresAt: number, now: number): void {
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    issuedAt > now + 30_000 ||
    expiresAt <= now
  ) {
    throw protocolError("EATTACHED_EXPIRY", "Attached-host proof is expired or not yet valid");
  }
}

function parseMessageId(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw protocolError("EATTACHED_MESSAGE", "Attached-host message id is not monotonic");
  }
  return BigInt(value);
}

function nonEmpty(value: string, label: string): string {
  if (!value || value.trim() !== value) {
    throw protocolError("EATTACHED_CANONICAL", `Attached-host ${label} must be canonical`);
  }
  return value;
}

function protocolError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) });
}
