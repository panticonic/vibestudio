import { z } from "zod";
import { CapabilityScopeSchema } from "./build.js";
import { invocationSnapshotSchema } from "./shellApproval.js";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);
const publicKey = z.string().min(40).max(256);
const generationId = z.string().regex(/^[a-f0-9]{32}$/u);
const protocolVersion = z.literal(1);
type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };
const wireValueSchema: z.ZodType<WireValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(wireValueSchema),
    z.record(wireValueSchema),
  ])
);

const sessionFactsShape = {
  parentHostId: nonEmpty,
  childHostId: nonEmpty,
  childGenerationId: generationId,
  developmentRunId: nonEmpty,
  initiatingRuntimeId: nonEmpty,
  initiatingRuntimeKind: z.enum([
    "panel",
    "app",
    "worker",
    "do",
    "extension",
    "shell",
    "server",
    "agent",
  ]),
  initiatingUserId: nonEmpty.nullable(),
};

export const attachedHostParentHelloSchema = z
  .object({
    protocolVersion,
    sessionId: nonEmpty,
    ...sessionFactsShape,
    requestedAuthorityCeiling: z.array(CapabilityScopeSchema).max(512),
    authorityCeilingDigest: sha256,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    parentRoutePublicKey: publicKey,
  })
  .strict();
export type AttachedHostParentHello = z.infer<typeof attachedHostParentHelloSchema>;

export const attachedHostTranscriptSchema = z
  .object({
    protocolVersion,
    sessionId: nonEmpty,
    ...sessionFactsShape,
    authorityCeiling: z.array(CapabilityScopeSchema).max(512),
    authorityCeilingDigest: sha256,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    parentRoutePublicKey: publicKey,
    childRoutePublicKey: publicKey,
  })
  .strict();
export type AttachedHostTranscript = z.infer<typeof attachedHostTranscriptSchema>;

export const attachedHostChildAcceptanceSchema = z
  .object({
    transcript: attachedHostTranscriptSchema,
    childSignature: signature,
  })
  .strict();
export type AttachedHostChildAcceptance = z.infer<typeof attachedHostChildAcceptanceSchema>;

export const attachedHostSessionProofSchema = attachedHostChildAcceptanceSchema
  .extend({ parentSignature: signature })
  .strict();
export type AttachedHostSessionProof = z.infer<typeof attachedHostSessionProofSchema>;

const invocationReferenceSchema = z
  .object({
    sessionId: nonEmpty,
    childGenerationId: generationId,
    developmentRunId: nonEmpty,
    ownerRuntimeId: nonEmpty,
    ownerRuntimeKind: z.enum([
      "panel",
      "app",
      "worker",
      "do",
      "extension",
      "shell",
      "server",
      "agent",
    ]),
    ownerUserId: nonEmpty.nullable(),
    requestId: nonEmpty,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type AttachedHostInvocationReference = z.infer<typeof invocationReferenceSchema>;

export const attachedHostInvocationEnvelopeSchema = z
  .object({
    protocolVersion,
    sessionId: nonEmpty,
    childGenerationId: generationId,
    messageId: z.string().regex(/^[1-9][0-9]*$/u),
    expiresAt: z.number().int().positive(),
    service: nonEmpty,
    method: nonEmpty,
    argumentsDigest: sha256,
    invocationReference: invocationReferenceSchema,
    invocationReferenceSignature: signature,
    signature,
  })
  .strict();
export type AttachedHostInvocationEnvelope = z.infer<typeof attachedHostInvocationEnvelopeSchema>;

export const attachedHostApprovalChallengeSchema = z
  .object({
    protocolVersion,
    sessionId: nonEmpty,
    childGenerationId: generationId,
    nonce: nonEmpty,
    /** Exact routed invocation identity, signed with the approval challenge. */
    requestId: nonEmpty,
    invocationSnapshot: invocationSnapshotSchema,
    invocationSnapshotDigest: sha256,
    capability: nonEmpty,
    resourceKey: nonEmpty,
    tier: z.enum(["gated", "critical"]),
    preparedOperationDigest: sha256,
    expiresAt: z.number().int().positive(),
    signature,
  })
  .strict();
export type AttachedHostApprovalChallenge = z.infer<typeof attachedHostApprovalChallengeSchema>;

export const attachedHostApprovalDecisionSchema = z
  .object({
    protocolVersion,
    sessionId: nonEmpty,
    childGenerationId: generationId,
    nonce: nonEmpty,
    invocationSnapshotDigest: sha256,
    shownPresentationDigest: sha256,
    decision: z.enum(["once", "deny"]),
    expiresAt: z.number().int().positive(),
    signature,
  })
  .strict();
export type AttachedHostApprovalDecision = z.infer<typeof attachedHostApprovalDecisionSchema>;

const attachedHostApprovalAuditEventSchema = z
  .object({
    /** Stable, opaque cursor issued by the durable protocol journal. */
    cursor: z.string().regex(/^[1-9][0-9]*$/u),
    sessionId: nonEmpty,
    developmentRunId: nonEmpty,
    childGenerationId: generationId,
    requestId: nonEmpty,
    service: nonEmpty,
    method: nonEmpty,
    invocationSnapshotDigest: sha256,
    preparedOperationDigest: sha256,
    shownPresentationDigest: sha256,
    decision: z.enum(["once", "deny"]),
    challengedAt: z.number().int().nonnegative(),
    decidedAt: z.number().int().nonnegative(),
  })
  .strict();
export type AttachedHostApprovalAuditEvent = z.infer<typeof attachedHostApprovalAuditEventSchema>;

const transportAuthority: ServiceAuthorityPolicy = { principals: ["host"] };
const bootstrapAuthority: ServiceAuthorityPolicy = { principals: ["host", "user"] };
const transportTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "transport" as const,
  family: "attachedHosts.transport",
  rationale:
    "Opaque attached-host transport; authority is enforced by exact signed session envelopes.",
};
const bootstrapTier = {
  ...transportTier,
  residency: "identity" as const,
  family: "attachedHosts.identity",
  rationale: "Mutually signed exact-generation bootstrap establishes an authenticated host identity.",
};
const auditTier = {
  ...transportTier,
  residency: "observability" as const,
  family: "attachedHosts.audit",
  rationale: "Bounded immutable approval receipts expose transport audit state.",
};
const approvalTier = {
  ...transportTier,
  residency: "grant-authority" as const,
  family: "attachedHosts.approval",
  rationale: "The canonical parent approval queue settles a child-signed authority challenge.",
};
const closeTier = {
  ...transportTier,
  residency: "supervision" as const,
  family: "attachedHosts.control",
  rationale: "Closes one exact authenticated transport route and its pending work.",
};
const ownerAuthority: ServiceAuthorityPolicy = {
  principals: ["user", "code", "session"],
};

/**
 * Generic internal transport contract. Agent-facing code sees ordinary child
 * service clients, never these bootstrap or envelope methods.
 */
export const attachedHostsMethods = defineServiceMethods({
  attachClient: {
    description:
      "Open the caller-owned live attached-host session for ordinary typed service clients.",
    args: z.tuple([z.object({ sessionId: nonEmpty }).strict()]),
    returns: z
      .object({
        sessionId: nonEmpty,
        developmentRunId: nonEmpty,
        childHostId: nonEmpty,
        childGenerationId: generationId,
        authorityCeilingDigest: sha256,
        expiresAt: z.number().int().positive(),
      })
      .strict(),
    authority: ownerAuthority,
    tier: transportTier,
    agentFacing: false,
    access: { sensitivity: "read" },
  },
  invokeAttached: {
    description: "Invoke one ordinary service method through a caller-owned attached-host session.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          service: nonEmpty,
          method: nonEmpty,
          args: z.array(z.unknown()).max(64),
        })
        .strict(),
    ]),
    returns: wireValueSchema,
    authority: ownerAuthority,
    tier: transportTier,
    agentFacing: false,
    access: { sensitivity: "write" },
  },
  listApprovalAudit: {
    description:
      "Read a bounded page of canonical terminal approval receipts for one caller-owned attached-host session.",
    args: z.tuple([
      z
        .object({
          sessionId: nonEmpty,
          after: z
            .string()
            .regex(/^[1-9][0-9]*$/u)
            .optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
    ]),
    returns: z
      .object({
        events: z.array(attachedHostApprovalAuditEventSchema),
        nextCursor: z
          .string()
          .regex(/^[1-9][0-9]*$/u)
          .nullable(),
      })
      .strict(),
    authority: ownerAuthority,
    tier: auditTier,
    agentFacing: false,
    access: { sensitivity: "read" },
  },
  bootstrapExchange: {
    description:
      "Exchange one exact-generation ordinary device bootstrap for an ephemeral attached-host route.",
    args: z.tuple([attachedHostParentHelloSchema]),
    returns: attachedHostChildAcceptanceSchema,
    authority: bootstrapAuthority,
    tier: bootstrapTier,
    agentFacing: false,
    access: { sensitivity: "write" },
  },
  bootstrapConfirm: {
    description:
      "Confirm the mutually signed transcript before the ordinary bootstrap credential is revoked.",
    args: z.tuple([attachedHostSessionProofSchema]),
    returns: z.object({ attachedHostSessionId: nonEmpty }).strict(),
    authority: bootstrapAuthority,
    tier: bootstrapTier,
    agentFacing: false,
    access: { sensitivity: "write" },
  },
  invoke: {
    description: "Deliver one signed replay-protected ordinary child service invocation.",
    args: z.tuple([
      z
        .object({
          envelope: attachedHostInvocationEnvelopeSchema,
          args: z.array(z.unknown()).max(64),
        })
        .strict(),
    ]),
    returns: wireValueSchema,
    authority: transportAuthority,
    tier: transportTier,
    agentFacing: false,
    access: { sensitivity: "write" },
  },
  presentApproval: {
    description:
      "Present a child-signed typed invocation through the parent canonical approval queue and return one exact signed decision.",
    args: z.tuple([attachedHostApprovalChallengeSchema]),
    returns: attachedHostApprovalDecisionSchema,
    authority: transportAuthority,
    tier: approvalTier,
    agentFacing: false,
    access: { sensitivity: "write" },
  },
  close: {
    description: "Close one exact attached-host route and every pending approval challenge.",
    args: z.tuple([
      z.object({ attachedHostSessionId: nonEmpty, reason: nonEmpty.max(256) }).strict(),
    ]),
    returns: z.void(),
    authority: transportAuthority,
    tier: closeTier,
    agentFacing: false,
    access: { sensitivity: "write" },
  },
});
