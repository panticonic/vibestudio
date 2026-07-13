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

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceAccessError } from "@vibestudio/shared/serviceDispatcher";
import { worktreeMethods } from "@vibestudio/service-schemas/worktree";

export interface WorktreeServiceDeps {
  /** The pure disk→CAS scan primitive (WorkspaceVcs.scanWorktree). */
  scan(
    repoPath: string,
    head: string
  ): Promise<{
    stateHash: string;
    files: Array<{ path: string; contentHash: string; size: number; mode: number }>;
    skipped: Array<{ path: string; kind: string }>;
    wipedRepo: boolean;
  }>;
  /** The pure CAS→disk projection primitive (WorkspaceVcs.projectWorktree). */
  project(repoPath: string, head: string, stateHash: string): Promise<{ stateHash: string }>;
  /** Content-derived build-graph read: repos whose unit imports `repoPath`
   *  (WorkspaceRepositories.deletionDependents). Dumb data — holds no delete semantics. */
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
    handler: defineServiceHandler("worktree", worktreeMethods, {
      scan: (ctx, [repoPath, head]) => {
        assertAuthorized(ctx, "scan");
        return deps.scan(repoPath, head);
      },
      project: (ctx, [repoPath, head, stateHash]) => {
        assertAuthorized(ctx, "project");
        return deps.project(repoPath, head, stateHash);
      },
      dependentRepos: (ctx, [repoPath]) => {
        assertAuthorized(ctx, "dependentRepos");
        return deps.dependentRepos(repoPath);
      },
    }),
  };
}
