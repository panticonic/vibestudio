/**
 * The small, shared vocabulary for activation-local agent inspection.
 *
 * These are operational reads, not participant method invocations: they must
 * never hydrate semantic state, issue host RPC, or mutate the inspected agent.
 */
import { z } from "zod";

export const AGENT_INSPECTION_METHODS = [
  "getDebugState",
  "getAgentSettings",
  "inspectMethodSuspensions",
] as const;

export type AgentInspectionMethod = (typeof AGENT_INSPECTION_METHODS)[number];

export function isAgentInspectionMethod(value: string): value is AgentInspectionMethod {
  return (AGENT_INSPECTION_METHODS as readonly string[]).includes(value);
}

/** A channel's read-only inspection request; `participantId` defaults to the
 * channel's sole Durable Object agent participant. */
export const AgentInspectionRequestSchema = z
  .object({
    participantId: z.string().trim().min(1).optional(),
    method: z.enum(AGENT_INSPECTION_METHODS),
  })
  .strict();
export type AgentInspectionRequest = z.infer<typeof AgentInspectionRequestSchema>;

export const AgentInspectionResultSchema = z
  .object({
    participantId: z.string(),
    channelId: z.string(),
    method: z.enum(AGENT_INSPECTION_METHODS),
    result: z.unknown(),
    isError: z.boolean().optional(),
    roster: z
      .object({
        present: z.boolean(),
        transport: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();
export type AgentInspectionResult = z.infer<typeof AgentInspectionResultSchema>;

/** Direct AgentVessel RPC used by the channel's bounded inspection facade. */
export const AGENT_INSPECTION_RPC_METHOD = "readAgentInspection" as const;
