export type OrdinaryQuitServerDecision = "keep" | "stop" | "prompt";

/**
 * Resolve the local hub's lifecycle before Electron begins asynchronous quit
 * cleanup. A hub belonging to a disposable developer instance owns state the
 * supervisor is about to delete, so ordinary quit always stops it. An
 * unattended shutdown sets its decision before this policy is consulted.
 */
export function ordinaryQuitServerDecision(options: {
  ownsLocalHub: boolean;
  disposableInstance: boolean;
  rememberedKeepServer: boolean | null;
}): OrdinaryQuitServerDecision {
  if (!options.ownsLocalHub) return "keep";
  if (options.disposableInstance) return "stop";
  if (options.rememberedKeepServer === null) return "prompt";
  return options.rememberedKeepServer ? "keep" : "stop";
}
