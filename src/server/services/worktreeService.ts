/**
 * worktree service — the RPC surface over the host's disk-scan PRIMITIVE
 * (`worktree.scan`). A single pure operation the gad-store DO drives: read a
 * (repoPath, head) working tree into the content store and return its
 * content-addressed `{ stateHash, files }`.
 *
 * It holds NO VCS semantics — no commit, no ref advance, no gad-log append, no
 * DO round trip. It is the disk-side twin of the `blobstore`/`refs` primitives:
 * the DO composes it with those to hold all the VCS semantics itself.
 */

import type { ServiceDefinition } from "@vibez1/shared/serviceDefinition";
import { worktreeMethods } from "@vibez1/shared/serviceSchemas/worktree";

export interface WorktreeServiceDeps {
  /** The pure disk→CAS scan primitive (WorkspaceVcs.scanWorktree). */
  scan(
    repoPath: string,
    head: string
  ): Promise<{
    stateHash: string;
    files: Array<{ path: string; contentHash: string; size: number; mode: number }>;
  }>;
}

export function createWorktreeService(deps: WorktreeServiceDeps): ServiceDefinition {
  return {
    name: "worktree",
    description: "Host disk-scan primitive: read a working tree into the CAS (worktree.scan).",
    policy: { allowed: ["do", "shell", "server"] },
    methods: worktreeMethods,
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "scan":
          return deps.scan(args[0] as string, args[1] as string);
        default:
          throw new Error(`Unknown worktree method: ${method}`);
      }
    },
  };
}
