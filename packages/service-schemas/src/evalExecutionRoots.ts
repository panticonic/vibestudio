import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { executionArtifactRefSchema } from "./build.js";

/** Host-internal retention ingress for immutable eval execution artifacts. */
export const evalExecutionRootsMethods = defineServiceMethods({
  retain: {
    args: z.tuple([z.string().min(1), z.string().min(1), executionArtifactRefSchema]),
    returns: z.object({ retained: z.literal(true) }).strict(),
    description:
      "Internal host-journaled acceptance of an immutable workspace bundle retained by an EvalDO.",
    access: { sensitivity: "write" },
  },
});
