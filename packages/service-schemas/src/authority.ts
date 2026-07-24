import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

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
