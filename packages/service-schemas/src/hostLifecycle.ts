/**
 * hostLifecycle service method schemas.
 *
 * Host-process lifecycle surface for attached shells: an explicit graceful
 * shutdown (the shell-gated counterpart of SIGTERM).
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/servicePolicy";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const SHUTDOWN_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};

export const hostLifecycleMethods = defineServiceMethods({
  shutdown: {
    description:
      "Gracefully shut down the workspace server process (same path as SIGTERM). Shell-only.",
    args: z.tuple([]),
    returns: z.void(),
    access: SHUTDOWN_ACCESS,
  },
});
