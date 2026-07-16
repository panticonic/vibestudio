import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

export interface ShellPresenceInternal {
  isAnyShellActive(maxAgeMs?: number): boolean;
  markActive(callerId: string): void;
  getActiveShellCount(maxAgeMs?: number): number;
  status(maxAgeMs?: number): {
    reachable: boolean;
    activeApproverCount: number;
    maxAgeMs: number;
  };
}

export interface ShellPresenceServiceResult {
  definition: ServiceDefinition;
  internal: ShellPresenceInternal;
}

export function createShellPresenceService(
  deps: {
    now?: () => number;
    defaultMaxAgeMs?: number;
  } = {}
): ShellPresenceServiceResult {
  const now = deps.now ?? (() => Date.now());
  const defaultMaxAgeMs = deps.defaultMaxAgeMs ?? 6_000;
  const activeShells = new Map<string, number>();

  function prune(maxAgeMs = defaultMaxAgeMs): void {
    const cutoff = now() - maxAgeMs;
    for (const [callerId, lastSeenAt] of activeShells) {
      if (lastSeenAt < cutoff) {
        activeShells.delete(callerId);
      }
    }
  }

  const internal: ShellPresenceInternal = {
    isAnyShellActive(maxAgeMs = defaultMaxAgeMs) {
      prune(maxAgeMs);
      return activeShells.size > 0;
    },

    markActive(callerId) {
      activeShells.set(callerId, now());
    },

    getActiveShellCount(maxAgeMs = defaultMaxAgeMs) {
      prune(maxAgeMs);
      return activeShells.size;
    },

    status(maxAgeMs = defaultMaxAgeMs) {
      prune(maxAgeMs);
      return {
        reachable: activeShells.size > 0,
        activeApproverCount: activeShells.size,
        maxAgeMs,
      };
    },
  };

  const methods = {
    heartbeat: {
      description: "Mark the authenticated shell or CLI approval surface as active",
      args: z.tuple([]),
      access: { sensitivity: "write" as const },
    },
    status: {
      description: "Report whether any approval-capable client is currently reachable",
      args: z.tuple([]),
      returns: z
        .object({
          reachable: z.boolean(),
          activeApproverCount: z.number().int().nonnegative(),
          maxAgeMs: z.number().int().positive(),
        })
        .strict(),
      access: { sensitivity: "read" as const },
    },
  };

  const definition: ServiceDefinition = {
    name: "shellPresence",
    description: "Tracks active shell clients for push notification delivery decisions",
    authority: { principals: ["user", "code", "host"] },
    methods,
    handler: defineServiceHandler("shellPresence", methods, {
      heartbeat: (ctx) => {
        internal.markActive(ctx.caller.runtime.id);
        return { activeShellCount: internal.getActiveShellCount() };
      },
      status: () => internal.status(),
    }),
  };

  return { definition, internal };
}
