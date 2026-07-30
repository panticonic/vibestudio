/**
 * hostLifecycle service method schemas.
 *
 * Host-process lifecycle surface for attached shells: an explicit graceful
 * shutdown (the shell-gated counterpart of SIGTERM).
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const SHUTDOWN_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};

export const hostLifecycleMethods = defineServiceMethods({
  shutdown: {
    capability: "application.shutdown",
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "hostLifecycle.control",
      rationale: "G5: host infrastructure plumbing; §2 default {code, session} family",
    },
    presentation: {
      title: "Shut down the workspace host",
      action: "shut down the workspace host",
      description: "Allows {requesterKind} to shut down the workspace host.",
      group: "host",
      authorityCategory: {
        domain: "computer",
        verb: "act",
      },
    },
    description:
      "Gracefully shut down the workspace server process (same path as SIGTERM). Shell-only.",
    args: z.tuple([]),
    returns: z.void(),
    access: SHUTDOWN_ACCESS,
  },
});
