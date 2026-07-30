import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { executionArtifactRefSchema } from "./build.js";

/** Host-internal retention ingress for immutable eval execution artifacts. */
export const evalExecutionRootsMethods = defineServiceMethods({
  retain: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "evalExecutionRoots.control",
      rationale:
        "Host-internal execution-retention ingress; exact EvalDO/run/session binding and immutable artifact identity are re-derived and verified",
    },
    args: z.tuple([z.string().min(1), z.string().min(1), executionArtifactRefSchema]),
    returns: z.object({ retained: z.literal(true) }).strict(),
    description:
      "Internal host-journaled acceptance of an immutable workspace bundle retained by an EvalDO.",
    // Retention is lifecycle bookkeeping for an already admitted immutable
    // build. It changes no workspace/user state and must not make an otherwise
    // read-only eval fail while its imports are rooted for execution GC.
    access: { sensitivity: "read" },
  },
});
