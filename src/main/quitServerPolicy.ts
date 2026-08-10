export type OrdinaryQuitServerDecision = "keep" | "stop" | "prompt";

/**
 * Resolve the local hub's lifecycle before Electron begins asynchronous quit
 * cleanup. Keeping an ephemeral development hub must be an explicit decision
 * on this quit, never an inherited persistent preference. Unattended shutdown
 * sets its decision before this policy is consulted.
 */
export function ordinaryQuitServerDecision(options: {
  ownsLocalHub: boolean;
  ephemeralWorkspace: boolean;
  rememberedKeepServer: boolean | null;
}): OrdinaryQuitServerDecision {
  if (!options.ownsLocalHub) return "keep";
  if (options.ephemeralWorkspace) return "prompt";
  if (options.rememberedKeepServer === null) return "prompt";
  return options.rememberedKeepServer ? "keep" : "stop";
}
