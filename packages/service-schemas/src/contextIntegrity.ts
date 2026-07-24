import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { allOf, relationship, requirementForPrincipals } from "@vibestudio/shared/authorization";

function boundSessionAuthority(method: "ingest" | "fact" | "explain") {
  const capability = `service:contextIntegrity.${method}`;
  return {
    requirement: allOf(
      requirementForPrincipals(["code"], capability),
      relationship("agent-binding")
    ),
    resource: { kind: "literal" as const, key: capability },
  };
}
const fact = z
  .object({
    class: z.enum(["internal", "external", "not-applicable"]),
    latchEpoch: z.number().int().nonnegative(),
    externalKeys: z.array(z.string()),
  })
  .strict();

export const contextIntegrityMethods = defineServiceMethods({
  ingest: {
    description:
      "Record content entering this agent session through a registered ingestion chokepoint.",
    args: z.tuple([
      z
        .object({
          key: z.string().min(1),
          via: z.string().min(1),
          classification: z.enum(["external", "derived"]),
        })
        .strict(),
    ]),
    returns: fact,
    authority: boundSessionAuthority("ingest"),
    access: { sensitivity: "write" },
  },
  fact: {
    description: "Read this session's monotone context-integrity latch.",
    args: z.tuple([]),
    returns: fact,
    authority: boundSessionAuthority("fact"),
    access: { sensitivity: "read" },
  },
  explain: {
    description:
      "Explain one verified outside-lineage coordinate currently present in this session, returning a bounded page of exact leaf members and trust decisions.",
    args: z.tuple([
      z
        .object({
          key: z.string().min(1).optional(),
          cursor: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict()
        .optional(),
    ]),
    returns: z
      .object({
        key: z.string(),
        aggregate: z.boolean(),
        memberCount: z.number().int().positive(),
        digestVerified: z.literal(true),
        session: z
          .object({
            class: z.literal("external"),
            firstSeen: z.string(),
            via: z.string(),
            count: z.number().int().positive(),
          })
          .strict(),
        items: z.array(z.object({ key: z.string(), trusted: z.boolean() }).strict()),
        pageInfo: z
          .object({
            offset: z.number().int().nonnegative(),
            limit: z.number().int().positive(),
            hasMore: z.boolean(),
            nextCursor: z.string().nullable(),
          })
          .strict(),
      })
      .strict(),
    authority: boundSessionAuthority("explain"),
    access: { sensitivity: "read" },
  },
});
