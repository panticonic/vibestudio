/**
 * Tool-side adapter over the server's `vcs.*` RPC surface. The file-editing
 * tools (`edit`, `write`) commit through GAD's edit-first `applyEdits` rather
 * than writing the working tree directly — disk is a projection of the head,
 * never written behind GAD's back.
 */

import { resolveToCwd } from "./path-utils.js";

/**
 * Convert a user-supplied path (relative or absolute) to a GAD path that is
 * relative to the head root. The tool's `cwd` IS the head root, so the GAD path
 * is the path *relative to* cwd — not `cwd + path`. Works for any cwd (not just
 * "/") and rejects paths that escape the root.
 */
export function toVcsPath(path: string, cwd: string): string {
  const abs = resolveToCwd(path, cwd);
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (abs === cwd || `${abs}/` === root) return "";
  if (!abs.startsWith(root)) {
    throw new Error(`Path escapes the workspace root: ${path}`);
  }
  return abs.slice(root.length);
}

export type ToolVcsEditOp =
  | {
      kind: "replace";
      path: string;
      hunks: Array<{ start: number; end: number; oldText?: string; newText: string }>;
    }
  | { kind: "write"; path: string; content: ToolVcsFileWriteContent; mode?: number }
  | { kind: "create"; path: string; content: ToolVcsFileWriteContent; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

export type ToolVcsFileWriteContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string };

export type ToolVcsFileReadContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string };

export interface ToolVcsApplyResult {
  status: "clean" | "conflicted";
  stateHash: string;
  eventId: string | null;
  headHash: string | null;
  conflicts: Array<{ path: string; kind: string }>;
  changedPaths: string[];
}

export interface ToolVcs {
  /** Read a file at the caller's head: content + the state hash to pin. */
  readFile(path: string): Promise<{ content: ToolVcsFileReadContent; stateHash: string } | null>;
  /** Commit ops to the caller's head (server resolves head + actor). */
  applyEdits(input: {
    baseStateHash?: string;
    edits: ToolVcsEditOp[];
  }): Promise<ToolVcsApplyResult>;
}

/** Build a {@link ToolVcs} from a main-RPC call function. */
export function createToolVcs(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>
): ToolVcs {
  return {
    readFile: (path) =>
      callMain<{ content: ToolVcsFileReadContent; stateHash: string } | null>("vcs.readFile", [
        "",
        path,
      ]),
    applyEdits: (input) => callMain<ToolVcsApplyResult>("vcs.applyEdits", [input]),
  };
}
