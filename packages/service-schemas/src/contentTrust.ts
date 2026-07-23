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
    description: "Report whether the context-integrity cutover is active.",
    args: z.tuple([]),
    returns: z.object({ ready: z.boolean(), grandfatherRoot: z.string().nullable() }).strict(),
    authority: USER_HOST,
    access: { sensitivity: "read" },
  },
  list: {
    description: "List exact content vouches and future-content trust policies.",
    args: z.tuple([]),
    returns: z.array(trustRecordSchema),
    authority: USER_HOST,
    access: { sensitivity: "read" },
  },
  vouch: {
    description: "Trust one exact content-addressed lineage key.",
    args: z.tuple([z.object({ key: z.string(), viaPrompt: z.string().optional() }).strict()]),
    returns: z.object({ id: z.string() }).strict(),
    authority: USER_HOST,
    access: { sensitivity: "admin" },
  },
  addPolicy: {
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
    description: "Revoke an exact content vouch or trust policy for future resolutions.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
    authority: USER_HOST,
    access: { sensitivity: "destructive" },
  },
});
