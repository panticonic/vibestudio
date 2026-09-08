import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { webhookIngressSubscriptionSchema } from "./webhookIngress.js";

const hostOnly: ServiceAuthorityPolicy = { principals: ["host"] };
const gated = (sensitivity: "read" | "write") => ({
  capability: "webhooks.manage",
  authority: hostOnly,
  tier: {
    tier: "gated" as const,
    session: "family" as const,
    rationale: "Host-only durable webhook subscription state.",
  },
  access: { sensitivity },
});

export const webhookEngineMethods = defineServiceMethods({
  create: {
    website: {"kind":"closed","reason":"The webhookEngine receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    ...gated("write"),
    description: "Create one fully prepared webhook subscription.",
    args: z.tuple([
      webhookIngressSubscriptionSchema.omit({
        subscriptionId: true,
        createdAt: true,
        updatedAt: true,
      }),
    ]),
    returns: webhookIngressSubscriptionSchema,
  },
  get: {
    website: {"kind":"closed","reason":"The webhookEngine receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    ...gated("read"),
    description: "Read one webhook subscription by identifier.",
    args: z.tuple([z.string().min(1)]),
    returns: webhookIngressSubscriptionSchema.nullable(),
  },
  list: {
    website: {"kind":"closed","reason":"The webhookEngine receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    ...gated("read"),
    description: "List webhook subscriptions, optionally for one exact owner.",
    args: z.union([z.tuple([]), z.tuple([z.string().min(1)])]),
    returns: z.array(webhookIngressSubscriptionSchema),
  },
  replace: {
    website: {"kind":"closed","reason":"The webhookEngine receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    ...gated("write"),
    description: "Replace one fully prepared webhook subscription.",
    args: z.tuple([webhookIngressSubscriptionSchema]),
    returns: z.void(),
  },
});
