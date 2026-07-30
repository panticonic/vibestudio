import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { evalRunEventSchema } from "./eval.js";

/** Host-internal, execution-session-authenticated live-event ingress. */
export const evalEventIngressMethods = defineServiceMethods({
  publish: {
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "evalEventIngress.mutate",
      rationale:
        "Host-internal observability ingress; exact EvalDO/run/owner session binding is re-derived by the receiver",
    },
    args: z.tuple([z.string().min(16).max(256), z.string().min(1), evalRunEventSchema]),
    returns: z.object({ delivered: z.boolean() }).strict(),
    description: "Host-internal ingress for a live event already persisted by its owning EvalDO.",
    access: { sensitivity: "write" },
  },
});
