/**
 * shellPresence service schema — active shell liveness used to decide whether
 * approval notifications should stay in-app or be delivered out of band.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const SHELL_PRESENCE_WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const shellPresenceMethods = defineServiceMethods({
  heartbeat: {
    tier: {
      tier: "open",
      session: "family",
      residency: "supervision",
      family: "shellPresence.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description: "Mark the calling shell active and return the current active-shell count.",
    args: z.tuple([]),
    returns: z.object({ activeShellCount: z.number().int().nonnegative() }).strict(),
    authority: { principals: ["user", "code", "host"] },
    access: SHELL_PRESENCE_WRITE_ACCESS,
  },
});
