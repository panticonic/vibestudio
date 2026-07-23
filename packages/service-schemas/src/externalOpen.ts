/**
 * externalOpen service schema — approval-gated opening of URLs in the host
 * OS browser. The server attaches the handler in
 * src/server/services/externalOpenService.ts. Data types live in
 * `@vibestudio/shared/externalOpen`; the schema mirrors them type-checked.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import type { OpenExternalOptions, OpenExternalResult } from "@vibestudio/shared/externalOpen";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";

export const EXTERNAL_OPEN_CAPABILITY = "external.open" as const;
export const EXTERNAL_OPEN_AUTHORITY_RESOLVER = "externalOpen.openExternal.target" as const;

// Opening the system browser is a side-effecting action; for code callers
// (panel/app/worker/do) it is approval-gated and the open happens only after
// the user approves, so it carries an `approval` entry and write sensitivity.
const OPEN_EXTERNAL_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
  approval: [
    {
      when: "caller is panel/app/worker/do",
      capability: EXTERNAL_OPEN_CAPABILITY,
      operation: { kind: "browser", verb: "Open external browser" },
      grantScopes: ["once", "session", "version"],
      reason: "Opening URLs in the system browser from code requires user consent.",
    },
  ],
};

export const openExternalOptionsSchema = z
  .object({
    expectedRedirectUri: z
      .string()
      .optional()
      .describe(
        "Expected OAuth redirect URI; when set, the target URL is validated as an allowed OAuth external URL."
      ),
  })
  .strict() satisfies z.ZodType<OpenExternalOptions>;

export const openExternalResultSchema = z.object({
  approvalDecision: z.enum(["once", "session", "version"]).optional(),
}) satisfies z.ZodType<OpenExternalResult>;

export const externalOpenMethods = defineServiceMethods({
  openExternal: {
    description:
      "Open an http(s) or mailto URL in the host OS browser; approval-gated for code callers, returning the persisted approval decision when one was made.",
    args: z.tuple([z.string(), openExternalOptionsSchema.optional()]),
    returns: openExternalResultSchema,
    authority: {
      requirement: requirementForPrincipals(["user", "host", "code"], EXTERNAL_OPEN_CAPABILITY),
      resource: { kind: "literal", key: EXTERNAL_OPEN_CAPABILITY },
      prepared: {
        resolver: EXTERNAL_OPEN_AUTHORITY_RESOLVER,
        leaves: [
          {
            capability: EXTERNAL_OPEN_CAPABILITY,
            requirement: { kind: "selected", principals: ["code"] },
            tier: "gated",
          },
        ],
      },
    },
    access: OPEN_EXTERNAL_ACCESS,
    examples: [
      { args: ["https://example.com"] },
      {
        args: [
          "https://accounts.example.com/oauth/authorize",
          { expectedRedirectUri: "https://app.local/callback" },
        ],
      },
    ],
  },
});
