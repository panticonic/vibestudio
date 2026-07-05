/**
 * hostLifecycle service — the host-process lifecycle surface for attached
 * shells, plus the idle auto-exit monitor for detached workspace servers.
 *
 * - `shutdown()` is a shell-gated graceful shutdown — the same path SIGTERM
 *   takes.
 * - `startIdleExitMonitor` is the garbage collector for detached servers:
 *   a workspace server with no connected shell/app clients AND no active
 *   background runs, continuously for the configured window, exits on its own.
 *   This is what reaps a "keep running" server once its work is done and the
 *   app is gone.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { hostLifecycleMethods } from "@vibestudio/shared/serviceSchemas/hostLifecycle";
import type { ActivityRegistry } from "./activityRegistry.js";

export const DEFAULT_IDLE_EXIT_MS = 30 * 60_000;

export function createHostLifecycleService(deps: {
  /** Graceful shutdown — the same function the SIGTERM handler calls. */
  shutdown: () => void;
}): ServiceDefinition {
  return {
    name: "hostLifecycle",
    description: "Host-process graceful shutdown for attached shells",
    policy: { allowed: ["shell", "server"] },
    methods: hostLifecycleMethods,
    handler: async (ctx, method) => {
      switch (method) {
        case "shutdown":
          if (ctx.caller.runtime.kind !== "shell" && ctx.caller.runtime.kind !== "server") {
            throw new Error("hostLifecycle.shutdown is shell-only");
          }
          // Defer past the RPC response so the caller sees the ack before the
          // sockets go down.
          setTimeout(() => deps.shutdown(), 25);
          return;
        default:
          throw new Error(`Unknown hostLifecycle method: ${method}`);
      }
    },
  };
}

export interface IdleExitMonitor {
  stop(): void;
}

/**
 * Exit the process when the server is continuously idle (no connected
 * shell/app clients and no active background runs) for `idleExitMs`.
 * `idleExitMs <= 0` disables the monitor.
 */
export function startIdleExitMonitor(deps: {
  activity: ActivityRegistry;
  hasConnectedClients: () => boolean;
  shutdown: () => void;
  idleExitMs: number;
  now?: () => number;
  /** Poll cadence override for tests. */
  checkIntervalMs?: number;
  log?: (message: string) => void;
}): IdleExitMonitor {
  if (deps.idleExitMs <= 0) return { stop: () => {} };
  const now = deps.now ?? Date.now;
  const checkIntervalMs = deps.checkIntervalMs ?? Math.min(60_000, deps.idleExitMs);
  let idleSince: number | null = null;
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const idle = !deps.hasConnectedClients() && deps.activity.getActivity().activeRuns === 0;
    if (!idle) {
      idleSince = null;
      return;
    }
    if (idleSince === null) idleSince = now();
    if (now() - idleSince >= deps.idleExitMs) {
      fired = true;
      deps.log?.(
        `[hostLifecycle] idle for ${Math.round((now() - idleSince) / 60_000)} min with no clients — exiting`
      );
      deps.shutdown();
    }
  }, checkIntervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
