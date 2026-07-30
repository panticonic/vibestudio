import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import type { AuthorityRow } from "@vibestudio/shared/authority/authorityRows";
import {
  AUTHORITY_DOMAINS,
  AUTHORITY_VERBS,
} from "@vibestudio/shared/authority/authorityDomains";

/** Shared authority wire primitives live with the authority service schema so
 * consumers do not create an initialization cycle between build and approval. */
export const AuthorityResourceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), key: z.string() }).strict(),
  z.object({ kind: z.literal("prefix"), prefix: z.string() }).strict(),
  z.object({ kind: z.literal("origin"), origin: z.string() }).strict(),
  z.object({ kind: z.literal("domain"), domain: z.string() }).strict(),
  z.object({ kind: z.literal("network"), value: z.literal("*") }).strict(),
]);

export const authorityRowSchema = z
  .object({
    capability: z.string(),
    domain: z.enum(
      Object.keys(AUTHORITY_DOMAINS) as [
        keyof typeof AUTHORITY_DOMAINS,
        ...(keyof typeof AUTHORITY_DOMAINS)[],
      ]
    ),
    verb: z.enum(
      Object.keys(AUTHORITY_VERBS) as [
        keyof typeof AUTHORITY_VERBS,
        ...(keyof typeof AUTHORITY_VERBS)[],
      ]
    ),
    action: z.string(),
    resource: z.string(),
    resourceScope: AuthorityResourceScopeSchema,
    tier: z.enum(["gated", "critical"]),
    statement: z.enum(["declared", "allowed", "snapshot", "prospective"]),
    state: z.enum(["active", "suspended", "locked"]).optional(),
    provenance: z
      .object({
        source: z.enum(["manifest", "approval", "profile", "mission", "receiver"]),
        decidedAt: z.number().optional(),
        decidedBy: z.string().optional(),
        surface: z.string().optional(),
        lineageClasses: z.array(z.string()).readonly().optional(),
      })
      .strict(),
    flags: z
      .object({
        lineageTainted: z.boolean().optional(),
        irreversible: z.boolean().optional(),
        newInDiff: z.boolean().optional(),
        removedInDiff: z.boolean().optional(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<AuthorityRow>;

const EVERY_ORIGIN: ServiceAuthorityPolicy = {
  principals: ["host", "user", "code", "session", "mission"],
};

const leafSchema = z
  .object({
    capability: z.string(),
    resourceKey: z.string(),
    status: z.enum(["granted", "consumable-once", "acquirable", "denied"]),
    tier: z.enum(["open", "gated", "critical"]),
    failure: z
      .object({
        reasonCode: z.enum([
          "approval-required",
          "mission-change-required",
          "user-denied",
          "receiver-rejected",
          "fixed-code-not-requested",
          "invalid-session",
          "invalid-attestation",
          "receiver-undeclared",
          "attestation-required",
          "attestation-invalid",
          "eval-read-only",
        ]),
        reason: z.string(),
        capability: z.string().optional(),
        resourceKey: z.string().optional(),
        remediation: z
          .object({
            kind: z.enum([
              "request-user-approval",
              "request-mission-change",
              "update-installed-code-manifest",
              "declare-rpc-receiver",
              "use-admitted-principal",
              "satisfy-relationship",
              "refresh-session",
              "respect-denial",
              "use-writable-session",
              "retry-through-host",
            ]),
            message: z.string(),
            request: z
              .object({
                capability: z.string(),
                resource: z.object({ kind: z.literal("exact"), key: z.string() }).strict(),
                tier: z.enum(["gated", "critical"]),
              })
              .strict()
              .optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const authorityMethods = defineServiceMethods({
  awaitDecision: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "authority.control",
      rationale:
        "An acquisition owner may wait on its existing human-decision lifecycle; the wait grants nothing",
    },
    description: "Wait without a deadline for one acquisition owned by this session.",
    args: z.tuple([z.object({ acquisitionId: z.string().min(1) }).strict()]),
    returns: z
      .object({
        state: z.enum(["decided", "closed"]),
        decision: z.enum(["once", "session", "version", "deny"]).optional(),
      })
      .strict(),
    authority: EVERY_ORIGIN,
    access: { sensitivity: "read" },
  },
  preflight: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "authority.control",
      rationale:
        "Pure authority inspection; it neither prompts, mints, consumes, nor invokes a handler",
    },
    description:
      "Dry-run a service method's complete authority contract without prompting or consuming authority.",
    args: z.tuple([
      z
        .object({
          service: z.string().min(1),
          method: z.string().min(1),
          args: z.array(z.unknown()),
        })
        .strict(),
    ]),
    returns: z
      .object({
        decision: z.enum(["allowed", "acquirable", "denied"]),
        leaves: z.array(leafSchema),
        severityPreview: z.enum(["routine", "sensitive", "critical"]).optional(),
        wouldPrompt: z
          .object({
            cardType: z.enum(["permission.gated", "permission.outside", "confirm.critical"]),
            renderedAction: z.string(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    authority: EVERY_ORIGIN,
    access: { sensitivity: "read" },
  },
});
