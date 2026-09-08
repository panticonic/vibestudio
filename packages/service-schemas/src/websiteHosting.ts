import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const document = z
  .object({ runtimeId: z.string().min(1), documentId: z.string().min(16).max(256) })
  .strict();
const tier = {
  tier: "open",
  session: "family",
  residency: "grant-authority",
  family: "websiteHosting.control",
  rationale:
    "Authenticated presentation hosts attest and retire their own browser documents; each method verifies live presentation ownership.",
} as const;

export const websiteHostingMethods = defineServiceMethods({
  list: {
    website: {
      kind: "closed",
      reason: "Connection inventory is trusted workspace chrome metadata.",
    },
    tier,
    description: "Read the live connection states displayed by workspace chrome.",
    args: z.tuple([]),
    returns: z.array(
      z.object({
        runtimeId: z.string(),
        slotId: z.string().nullable(),
        documentId: z.string(),
        origin: z.string(),
        connected: z.boolean(),
      })
    ),
    authority: { principals: ["user"] },
    access: { sensitivity: "read" },
  },
  begin: {
    website: {
      kind: "closed",
      reason: "Only authenticated presentation hosts may attest and connect browser documents.",
    } as const,
    tier,
    description: "Attest the current top-level browser document from its native presentation host.",
    args: z.tuple([document.extend({ origin: z.string().url() }).strict()]),
    returns: z.void(),
    authority: { principals: ["user"] },
    access: { sensitivity: "write" },
  },
  connect: {
    website: {
      kind: "closed",
      reason: "Only authenticated presentation hosts may attest and connect browser documents.",
    } as const,
    tier,
    description: "Request workspace connection for the attested browser document.",
    args: z.tuple([document]),
    returns: z.boolean(),
    authority: { principals: ["user"] },
    access: { sensitivity: "write" },
  },
  forget: {
    website: {
      kind: "closed",
      reason: "Only trusted presentation controls may forget website access.",
    },
    tier,
    description:
      "Forget saved access for this website in this workspace and disconnect its live documents.",
    args: z.tuple([document]),
    returns: z.void(),
    authority: { principals: ["user"] },
    access: { sensitivity: "write" },
  },
  end: {
    website: {
      kind: "closed",
      reason: "Only authenticated presentation hosts may attest and connect browser documents.",
    } as const,
    tier,
    description: "Retire a browser document and all of its live RPC authority.",
    args: z.tuple([document]),
    returns: z.void(),
    authority: { principals: ["user"] },
    access: { sensitivity: "write" },
  },
});
