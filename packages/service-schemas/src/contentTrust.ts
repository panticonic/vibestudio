import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

const USER_HOST: ServiceAuthorityPolicy = { principals: ["user", "host"] };

const trustRecordSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["vouch", "policy"]),
    subject: z.string(),
    decidedBy: z.string(),
    decidedAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .strict();

export const contentTrustMethods = defineServiceMethods({
  status: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.control",
      rationale: "Human governance read of the one-way context-integrity cutover",
    },
    description: "Report whether the context-integrity cutover is active.",
    args: z.tuple([]),
    returns: z.object({ ready: z.boolean(), grandfatherRoot: z.string().nullable() }).strict(),
    authority: USER_HOST,
    access: { sensitivity: "read" },
  },
  list: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.read",
      rationale: "Human governance read; sessions cannot inspect the workspace trust ledger",
    },
    description: "List exact content vouches and future-content trust policies.",
    args: z.tuple([]),
    returns: z.array(trustRecordSchema),
    authority: USER_HOST,
    access: { sensitivity: "read" },
  },
  vouch: {
    capability: "content.trust.vouch",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.control",
      rationale: "An exact content-addressed vouch changes future context classification",
    },
    presentation: {
      title: "Remember this outside content as safe",
      action: "mark this exact outside content as safe",
      description: "Remember this outside content so it won't need review again.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Trust one exact content-addressed lineage key.",
    args: z.tuple([z.object({ key: z.string(), viaPrompt: z.string().optional() }).strict()]),
    returns: z.object({ id: z.string() }).strict(),
    authority: USER_HOST,
    access: { sensitivity: "admin" },
  },
  addPolicy: {
    capability: "content.trust.policy.manage",
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.control",
      rationale:
        "A future-content trust policy changes the authority meaning of content that has not yet been observed",
    },
    presentation: {
      title: "Always trust matching outside content",
      action: "always trust matching outside content",
      description: "Allows {requesterKind} to always trust matching outside content.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Trust future versions from one exact package name or repository remote.",
    args: z.tuple([
      z
        .object({
          patternKind: z.enum(["pkg-name", "repo-remote"]),
          patternKey: z.string(),
          ceremony: z.record(z.unknown()),
        })
        .strict(),
    ]),
    returns: z.object({ id: z.string() }).strict(),
    authority: USER_HOST,
    access: { sensitivity: "admin" },
  },
  revoke: {
    capability: "content.trust.policy.manage",
    tier: {
      tier: "critical",
      session: "codeOnly",
      residency: "grant-authority",
      family: "contentTrust.retire",
      rationale:
        "Revocation changes which external content may enter future internal-context sessions",
    },
    presentation: {
      title: "Remove a content-trust decision",
      action: "remove a content-trust decision",
      description: "Allows {requesterKind} to remove a content-trust decision.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Revoke an exact content vouch or trust policy for future resolutions.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
    authority: USER_HOST,
    access: { sensitivity: "destructive" },
  },
});
