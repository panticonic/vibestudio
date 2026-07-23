/**
 * corsApproval service schema — approval-gated CORS response header
 * relaxation. Single source of truth for the wire contract; the server
 * attaches the handler in src/server/services/corsApprovalService.ts.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";

export const CORS_RESPONSE_CAPABILITY = "network.response.read" as const;
export const CORS_RESPONSE_AUTHORITY_RESOLVER = "corsApproval.authorize.target" as const;

// `authorize` may prompt the user for cross-origin response access (a network
// approval gate scoped to the target origin), so it carries an `approval`
// entry and write sensitivity rather than `readonly`.
const AUTHORIZE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
  approval: [
    {
      capability: CORS_RESPONSE_CAPABILITY,
      operation: { kind: "network", verb: "Read cross-origin response" },
      grantScopes: ["once", "session", "version"],
      reason: "Reading CORS-protected responses from another origin requires user consent.",
    },
  ],
};

export const authorizeCorsSchema = z
  .object({
    targetUrl: z
      .string()
      .min(1)
      .describe("Absolute http(s) URL whose origin's CORS-protected responses should be readable."),
    requestOrigin: z
      .string()
      .min(1)
      .optional()
      .describe("Origin making the request, surfaced in the approval prompt; defaults to unknown."),
  })
  .strict();

export type AuthorizeCorsRequest = z.infer<typeof authorizeCorsSchema>;

// `decision` mirrors Exclude<GrantedDecision, "deny"> from the approval queue.
export const corsApprovalResultSchema = z.object({
  allowed: z.boolean(),
  decision: z.enum(["once", "session", "version"]).optional(),
  reason: z.string().optional(),
});

export type CorsApprovalResult = z.infer<typeof corsApprovalResultSchema>;

export const corsApprovalMethods = defineServiceMethods({
  authorize: {
    description:
      "Request approval to read CORS-protected responses from a target origin; may prompt the user and returns whether access was granted (with the persisted decision scope).",
    args: z.tuple([authorizeCorsSchema]),
    returns: corsApprovalResultSchema,
    authority: {
      requirement: requirementForPrincipals(["code"], CORS_RESPONSE_CAPABILITY),
      resource: { kind: "literal", key: CORS_RESPONSE_CAPABILITY },
      prepared: {
        resolver: CORS_RESPONSE_AUTHORITY_RESOLVER,
        leaves: [
          {
            capability: CORS_RESPONSE_CAPABILITY,
            requirement: { kind: "selected", principals: ["code"] },
            tier: "gated",
          },
        ],
      },
    },
    access: AUTHORIZE_ACCESS,
    examples: [
      { args: [{ targetUrl: "https://api.example.com/data", requestOrigin: "https://app.local" }] },
    ],
  },
});
