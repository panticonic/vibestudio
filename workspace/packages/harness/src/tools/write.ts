/**
 * Write tool — GAD-native. Commits a whole-file write through `vcs.applyEdits`
 * (creates or overwrites; parent dirs are implicit in the content-addressed
 * tree). Disk is a projection of the head, never written directly.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { toVcsPath, type ToolVcs } from "./tool-vcs.js";

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
  bytesWritten: number;
  path: string;
}

export function createWriteTool(
  cwd: string,
  vcs: ToolVcs
): AgentTool<typeof writeSchema, WriteToolDetails> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    execute: async (_toolCallId, input, signal) => {
      const { path, content } = input;
      if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("write requires path and content");
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const relPath = toVcsPath(path, cwd);
      // A whole-file write authored against the current head: no base pinned, so
      // it fast-forwards (overwrite semantics) while concurrent edits to OTHER
      // files still merge.
      const result = await vcs.applyEdits({
        edits: [{ kind: "write", path: relPath, content: { kind: "text", text: content } }],
      });
      if (signal?.aborted) throw new Error("Operation aborted");
      if (result.status === "conflicted") {
        throw new Error(
          `Write to ${path} conflicted with a concurrent change; the merge is parked.`
        );
      }

      const out: { content: (TextContent | ImageContent)[]; details: WriteToolDetails } = {
        content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
        details: { bytesWritten: content.length, path: relPath },
      };
      return out;
    },
  };
}
