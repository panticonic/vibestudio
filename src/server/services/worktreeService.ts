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
import { allOf, anyOf, capability, relationship } from "@vibestudio/shared/authorization";
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
  const prepareWriterAuthority = (
    ctx: Parameters<NonNullable<ServiceDefinition["handler"]>>[0],
    method: string
  ) => {
    const writerIdentity = deps.getVcsWriterIdentity();
    const serviceCapability = `service:worktree.${method}`;
    return [
      {
        capability: serviceCapability,
        resourceKey: serviceCapability,
        requirement: writerIdentity
          ? anyOf(
              capability("host", serviceCapability),
              allOf(
                capability("code", serviceCapability),
                relationship("entity-self", `entity:${writerIdentity}`),
                relationship("workspace-member")
              )
            )
          : capability("host", serviceCapability),
      },
    ];
  };

  return {
    name: "worktree",
    description:
      "Host disk primitives: scan a working tree into the CAS (worktree.scan), project a state onto disk (worktree.project), and read build-graph dependents (worktree.dependentRepos).",
    authority: { principals: ["code", "user", "host"] },
    methods: worktreeMethods,
    authorityPreparation: {
      "worktree.scan.writer": (ctx) => prepareWriterAuthority(ctx, "scan"),
      "worktree.project.writer": (ctx) => prepareWriterAuthority(ctx, "project"),
      "worktree.dependentRepos.writer": (ctx) => prepareWriterAuthority(ctx, "dependentRepos"),
    },
    handler: defineServiceHandler("worktree", worktreeMethods, {
      scan: async (_ctx, [repoPath, head]) => deps.scan(repoPath, head),
      project: async (_ctx, [repoPath, head, stateHash]) => deps.project(repoPath, head, stateHash),
      dependentRepos: async (_ctx, [repoPath]) => deps.dependentRepos(repoPath),
    }),
  };
}
