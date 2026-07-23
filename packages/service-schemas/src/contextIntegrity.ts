import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  allOf,
  relationship,
  requirementForPrincipals,
} from "@vibestudio/shared/authorization";

function boundSessionAuthority(method: "ingest" | "fact") {
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
});
