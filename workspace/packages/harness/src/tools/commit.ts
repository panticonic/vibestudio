/** Commit the complete local application chain into one workspace event. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type { VcsCommitResult } from "@vibestudio/service-schemas/vcs";
import {
  resolveToolWorkingState,
  toolCommandId,
  toolContextId,
  type ToolEditingVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const commitSchema = Type.Object(
  {
    message: Type.String({
      description: "Durable intent summary for the one atomic workspace event.",
    }),
    integratesEventId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Exact source event to add as parent after vcs compare reports every effective source change accounted for.",
      })
    ),
  },
  { additionalProperties: false }
);

export type CommitToolInput = Static<typeof commitSchema>;
export interface CommitToolDetails {
  result: VcsCommitResult;
}

export function createCommitTool(
  vcs: ToolEditingVcs,
  context: ToolMutationContext
): AgentTool<typeof commitSchema, CommitToolDetails> {
  return {
    name: "commit",
    label: "commit",
    description:
      "Commit the complete local application chain into one atomic workspace event. Every pending application in the context is included.",
    parameters: commitSchema,
    execute: async (_toolCallId, input, signal): Promise<AgentToolResult<CommitToolDetails>> => {
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!message) throw new Error("commit requires a non-empty message");
      if (signal?.aborted) throw new Error("Operation aborted");
      const workingHead = await resolveToolWorkingState(vcs, context);
      const result = await vcs.commit({
        contextId: toolContextId(context),
        expectedWorkingHead: workingHead,
        commandId: toolCommandId(context),
        message,
        ...(input.integratesEventId ? { integratesEventId: input.integratesEventId } : {}),
      });
      if (signal?.aborted) throw new Error("Operation aborted");

      if (result.event.kind !== "event") throw new Error("commit returned a non-event state");
      const workspaceEventId = result.event.eventId;
      const lines = [
        `Committed workspace event ${workspaceEventId} locally with ${result.committedApplicationIds.length} application${result.committedApplicationIds.length === 1 ? "" : "s"}. Protected main was not changed; publication is a separate vcs push operation.`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { result },
      };
    },
  };
}
