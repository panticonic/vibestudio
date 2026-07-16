/**
 * The small, shared vocabulary for activation-local agent inspection.
 *
 * These are operational reads, not participant method invocations: they must
 * never hydrate semantic state, issue host RPC, or mutate the inspected agent.
 */
export const AGENT_INSPECTION_METHODS = [
  "getDebugState",
  "getAgentSettings",
  "inspectMethodSuspensions",
] as const;

export type AgentInspectionMethod = (typeof AGENT_INSPECTION_METHODS)[number];

export function isAgentInspectionMethod(value: string): value is AgentInspectionMethod {
  return (AGENT_INSPECTION_METHODS as readonly string[]).includes(value);
}

/** Direct AgentVessel RPC used by the channel's bounded inspection facade. */
export const AGENT_INSPECTION_RPC_METHOD = "readAgentInspection" as const;
