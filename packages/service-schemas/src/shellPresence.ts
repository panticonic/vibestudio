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
    description: "Mark the calling shell active and return the current active-shell count.",
    args: z.tuple([]),
    returns: z.object({ activeShellCount: z.number().int().nonnegative() }).strict(),
    authority: { principals: ["user", "code", "host"] },
    access: SHELL_PRESENCE_WRITE_ACCESS,
  },
});
