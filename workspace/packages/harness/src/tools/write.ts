/**
 * Write tool — GAD-native. Records a whole-file write as an UNCOMMITTED working
 * edit through `vcs.edit` (creates or overwrites; parent dirs are implicit in
 * the content-addressed tree). Disk is a projection of the head, never written
 * directly. It does NOT commit — seal milestones with `vcs.commit` + `vcs.push`.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import { isPlatformIgnoredVcsPath } from "@workspace/vcs-engine";
import type { RuntimeFs } from "./runtime-fs.js";
import { toVcsPath, withInvocationId, type ToolVcs } from "./tool-vcs.js";

const writeSchema = Type.Object({
  path: Type.String({
    description:
      "Workspace-relative path. Source-repo paths become uncommitted VCS edits; non-repo scratch paths are written to the caller's scoped runtime filesystem.",
  }),
  content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
  bytesWritten: number;
  path: string;
  storage: "vcs" | "scratch" | "none";
  /** A recoverable policy mismatch. No file was written. */
  diagnostic?: "platform-ignored";
  suggestedScratchPath?: string;
}

export function createWriteTool(
  cwd: string,
  vcs: ToolVcs,
  fs?: Pick<RuntimeFs, "writeFile">
): AgentTool<typeof writeSchema, WriteToolDetails> {
  return {
    name: "write",
    label: "write",
    description:
      "Write a text file. Workspace source paths become uncommitted VCS edits; ordinary non-repo paths are context-local scratch.",
    parameters: writeSchema,
    execute: async (toolCallId, input, signal) => {
      const { path, content } = input;
      if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("write requires path and content");
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const relPath = canonicalizeWorkspaceFilePath(toVcsPath(path, cwd));
      if (isPlatformIgnoredVcsPath(relPath)) {
        const basename = relPath.split("/").filter(Boolean).at(-1) ?? "output.txt";
        const suggestedScratchPath = `.tmp/${basename}`;
        return {
          content: [
            {
              type: "text",
              text:
                `No file written: ${path} is reserved for platform metadata, generated output, or secrets and cannot enter workspace VCS. ` +
                `For context-local temporary data, retry with ${suggestedScratchPath}.`,
            },
          ],
          details: {
            bytesWritten: 0,
            path: relPath,
            storage: "none",
            diagnostic: "platform-ignored",
            suggestedScratchPath,
          },
        };
      }
      const repo = splitRepoPath(relPath);
      const bareTrackedFile = relPath.length > 0 && !relPath.includes("/");
      if (!repo && !bareTrackedFile && fs) {
        await fs.writeFile(relPath, content);
        if (signal?.aborted) throw new Error("Operation aborted");
        return {
          content: [
            { type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` },
          ],
          details: { bytesWritten: content.length, path: relPath, storage: "scratch" },
        };
      }
      // A whole-file write recorded as an uncommitted working edit on the
      // current head (overwrite semantics). No commit, no build — disk reflects
      // the working content immediately, sealed later by vcs.commit. Tagged with
      // the authoring tool-call so file → edit → invocation → turn is traversable;
      // the invocationId is stamped by the shared adapter seam (T2).
      await withInvocationId(vcs, toolCallId).edit({
        edits: [{ kind: "write", path: relPath, content: { kind: "text", text: content } }],
      });
      if (signal?.aborted) throw new Error("Operation aborted");

      const out: { content: (TextContent | ImageContent)[]; details: WriteToolDetails } = {
        content: [
          { type: "text", text: `Successfully wrote ${content.length} bytes to ${relPath}` },
        ],
        details: { bytesWritten: content.length, path: relPath, storage: "vcs" },
      };
      return out;
    },
  };
}
