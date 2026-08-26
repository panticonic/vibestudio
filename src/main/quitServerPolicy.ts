export type OrdinaryQuitServerDecision = "keep" | "stop" | "prompt";

/**
 * Resolve the local hub's lifecycle before Electron begins asynchronous quit
 * cleanup. An ephemeral development hub is disposable command-owned state, so
 * ordinary quit always stops it and lets the hub remove its workspace. An
 * unattended shutdown sets its decision before this policy is consulted.
 */
export function ordinaryQuitServerDecision(options: {
  ownsLocalHub: boolean;
  ephemeralWorkspace: boolean;
  rememberedKeepServer: boolean | null;
}): OrdinaryQuitServerDecision {
  if (!options.ownsLocalHub) return "keep";
  if (options.ephemeralWorkspace) return "stop";
  if (options.rememberedKeepServer === null) return "prompt";
  return options.rememberedKeepServer ? "keep" : "stop";
}
