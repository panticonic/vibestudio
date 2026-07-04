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
import { ServiceAccessError } from "@vibez1/shared/serviceDispatcher";
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
  /** The pure CAS→disk projection primitive (WorkspaceVcs.projectWorktree). */
  project(repoPath: string, head: string, stateHash: string): Promise<{ stateHash: string }>;
  /** Content-derived build-graph read: repos whose unit imports `repoPath`
   *  (WorkspaceVcs.deleteDependents). Dumb data — holds no delete semantics. */
  dependentRepos(repoPath: string): Promise<string[]>;
  /** Single DO allowed to drive the worktree primitive. */
  getVcsWriterIdentity: () => string | null;
}

export function createWorktreeService(deps: WorktreeServiceDeps): ServiceDefinition {
  const assertAuthorized = (
    ctx: Parameters<NonNullable<ServiceDefinition["handler"]>>[0],
    method: string
  ): void => {
    const caller = ctx.caller;
    if (caller.runtime.kind === "shell" || caller.runtime.kind === "server") return;
    const writerIdentity = deps.getVcsWriterIdentity();
    if (
      caller.runtime.kind !== "do" ||
      writerIdentity === null ||
      caller.runtime.id !== writerIdentity
    ) {
      throw new ServiceAccessError(
        "worktree",
        method,
        caller.runtime.kind,
        `worktree.${method} is restricted to the workspace VCS store DO`
      );
    }
  };

  return {
    name: "worktree",
    description:
      "Host disk primitives: scan a working tree into the CAS (worktree.scan), project a state onto disk (worktree.project), and read build-graph dependents (worktree.dependentRepos).",
    policy: { allowed: ["do", "shell", "server"] },
    methods: worktreeMethods,
    handler: async (ctx, method, args) => {
      assertAuthorized(ctx, method);
      switch (method) {
        case "scan":
          return deps.scan(args[0] as string, args[1] as string);
        case "project":
          return deps.project(args[0] as string, args[1] as string, args[2] as string);
        case "dependentRepos":
          return deps.dependentRepos(args[0] as string);
        default:
          throw new Error(`Unknown worktree method: ${method}`);
      }
    },
  };
}
