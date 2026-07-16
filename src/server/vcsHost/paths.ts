/**
 * Host projection naming and platform-invariant content-path policy.
 *
 * Pure helpers with no store or disk dependencies: canonical repository and
 * context coordinates, and the host-facing name for the shared semantic path
 * predicate. The policy itself lives in one pure runtime-neutral module.
 */

import * as path from "node:path";
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import {
  assertSemanticVcsPathAdmissible,
  semanticVcsPathAdmission,
} from "@vibestudio/shared/vcs/pathAdmission";

/**
 * Validate and return one canonical workspace repository path.
 */
export function normalizeRepositoryPath(repoPath: string): string {
  // Canonical repo identity — one string backs the repository map and the
  // projection dir. Reject aliases and
  // workspace paths that are not repo ids (for example `packages` or
  // `packages/foo/bar`) rather than silently rewriting them into disk-colliding
  // identities.
  const normalized = normalizeWorkspaceRepoPath(repoPath);
  assertSemanticVcsPathAdmissible(normalized);
  return normalized;
}

/**
 * Context ids may contain slashes because runtime entity ids are hierarchical,
 * but never path traversal, absolute paths, empty path segments, or NUL bytes.
 */
export function validateVcsContextId(contextId: string): string {
  if (typeof contextId !== "string" || contextId.length === 0) {
    throw new Error("Invalid VCS context id: empty");
  }
  if (contextId.includes("\0") || contextId.includes("\\") || path.isAbsolute(contextId)) {
    throw new Error(`Invalid VCS context id: ${JSON.stringify(contextId)}`);
  }
  for (const segment of contextId.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid VCS context id: ${JSON.stringify(contextId)}`);
    }
  }
  return contextId;
}

/** Prefix a repo-relative path back to its workspace-relative location. */
export function joinRepoPrefix(repoPath: string, relPath: string): string {
  const norm = normalizeRepositoryPath(repoPath);
  return relPath ? `${norm}/${relPath}` : norm;
}

/**
 * Whether `p` is semantic workspace content. Filesystem routing uses the same
 * predicate as command admission, scans, and materialization.
 */
export function isWritableVcsPath(p: string): boolean {
  return semanticVcsPathAdmission(p).admissible;
}
