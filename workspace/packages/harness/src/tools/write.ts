/** Ergonomic whole-file authoring facade over the canonical mutation engine. */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import {
  mutateFiles,
  mutationResultText,
  type SemanticFileMutationDetails,
} from "./file-mutation.js";
import { isWorkspaceReadReceipt, workspaceReadReceiptSchema } from "./workspace-read-receipt.js";
import type { RuntimeFs } from "./runtime-fs.js";
import type { ToolEditingVcs, ToolMutationContext } from "./tool-vcs.js";

const writeSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description:
        "File to create or replace. Managed source paths must be inside an existing workspace repository; use .tmp/<name> for context-local scratch data.",
    }),
    content: Type.String({ description: "Complete UTF-8 text content for the resulting file." }),
    receipt: Type.Optional(workspaceReadReceiptSchema),
    createOnly: Type.Optional(
      Type.Boolean({
        description: "Require the path to be absent; return a conflict instead of overwriting.",
      })
    ),
    mode: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 0o777,
        description: "Resulting POSIX permission bits for a managed file, such as 420 for 0644.",
      })
    ),
    intent: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Purpose not already evident from the request. Stored as stated semantic VCS intent for managed files.",
      })
    ),
  },
  { additionalProperties: false }
);

export type WriteToolInput = Static<typeof writeSchema>;
export type WriteToolDetails = SemanticFileMutationDetails;

export function createWriteTool(
  cwd: string,
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  fs?: Pick<RuntimeFs, "readFile" | "writeFile">
): AgentTool<typeof writeSchema, WriteToolDetails> {
  return {
    name: "write",
    label: "Write file",
    description:
      "Create or replace one complete text file. Managed files are authored as a state-checked semantic VCS work unit tied to this invocation and optional stated intent; .tmp files are explicitly reported as scratch. Pass receipt from read to reject stale overwrites, or createOnly: true to require an absent path. Identical content is an unchanged success. Use edit for a targeted text change and apply_patch for an atomic multi-file transaction.",
    parameters: writeSchema,
    cancellationMode: "settle",
    execute: async (_toolCallId, input, signal): Promise<AgentToolResult<WriteToolDetails>> => {
      const { path, content } = input;
      if (typeof path !== "string" || typeof content !== "string") {
        throw Object.assign(new Error("write requires path and content"), {
          code: "InvalidFileMutation",
        });
      }
      if (input.receipt !== undefined && !isWorkspaceReadReceipt(input.receipt)) {
        throw Object.assign(
          new Error("write receipt must be the complete object returned by read"),
          {
            code: "InvalidWorkspaceReadReceipt",
          }
        );
      }
      const details = await mutateFiles(
        cwd,
        vcs,
        context,
        {
          operations: [
            {
              kind: "write",
              path,
              content,
              ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
              ...(input.createOnly ? { createOnly: true } : {}),
              ...(input.mode !== undefined ? { mode: input.mode } : {}),
            },
          ],
          ...(input.intent ? { intent: input.intent } : {}),
        },
        signal,
        fs
      );
      return { content: [{ type: "text", text: mutationResultText(details) }], details };
    },
  };
}
