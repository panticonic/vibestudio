import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

const closeTurnSchema = Type.Object(
  {
    noteToSelf: Type.Optional(
      Type.String({
        description:
          "Optional private rationale for why this turn is being closed without a visible response.",
      })
    ),
  },
  { additionalProperties: false }
);

export type CloseTurnInput = Static<typeof closeTurnSchema>;

export function createCloseTurnWithoutResponseTool(): AgentTool<typeof closeTurnSchema> {
  return {
    name: "close_turn_without_response",
    label: "close turn",
    description:
      "End this agent turn without sending a visible assistant response. Use when the user message or channel activity is for another agent, already handled, or does not require your intervention.",
    parameters: closeTurnSchema,
    execute: async (): Promise<AgentToolResult<undefined>> => {
      return {
        terminate: true,
        content: [{ type: "text", text: "Turn closed without visible response." }],
      } as AgentToolResult<undefined>;
    },
  };
}
