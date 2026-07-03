/**
 * DiskProjector — the host's disk-projection FOLLOWER (eviction stage P5c).
 *
 * "Disk projection/materialization when needed" is a permanent host surface
 * (see docs/blob-addressed-cleanly.md, Target Shape): the working trees under
 * the workspace root and the `.contexts/*` folders are DISPOSABLE PROJECTIONS
 * of content-addressed states. This module is the ONE narrow entry point that
 * writes them. It is invoked post-operation with a state hash the VCS
 * semantics (now userland — the gad-store DO) already decided on; nothing in
 * here decides WHAT a tree should be, only WHERE a given state lands on disk
 * and how (editable checkout via the content store, sidecar-tracked).
 *
 * Entry points:
 *  - {@link project}: materialize a (repoPath, head) at a state (the follower
 *    step after edit/commit/merge/push/restore advances).
 *  - {@link removeRepo}: drop a repo's main-worktree projection (deleteRepo).
 *  - {@link writeConflictSummary}: sync the worktree-visible merge-conflict
 *    summary file from pending-merge DATA passed in by the caller.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  MERGE_CONFLICTS_FILE,
  VCS_MAIN_HEAD,
  contextIdFromVcsHead,
  normalizeRepoPathForLog,
  validateVcsContextId,
} from "./paths.js";
import type { WorktreeStore } from "./worktreeStore.js";

interface DiskProjectorDeps {
  worktrees: WorktreeStore;
  /** The user's live workspace directory (main head working tree). */
  workspaceRoot: string;
  /** Root for context-folder working trees (`{contextsRoot}/{contextId}`). */
  contextsRoot: string;
}

/** A pending merge's disk-visible facts (data in, disk out — no store reads here). */
interface ConflictSummaryInfo {
  theirsHead?: string | undefined;
  conflicts: Array<{ path: string; kind: string }>;
}

const CONFLICT_KIND_HELP: Record<string, string> = {
  content: "text conflict — resolve the `<<<<<<<` / `>>>>>>>` markers in the file",
  binary: "binary conflict — ours was kept; replace it with the intended version",
  "delete-vs-change":
    "deleted on one side, changed on the other — the change was kept; delete the file if the deletion was intended",
  mode: "file mode (executable bit) diverged — verify and `chmod` as intended",
};

/** Human-readable worktree summary of a pending merge's conflicts. */
function renderConflictSummary(
  head: string,
  theirsHead: string | undefined,
  conflicts: Array<{ path: string; kind: string }>
): string {
  const lines = [
    `# Merge conflicts on \`${head}\``,
    "",
    theirsHead ? `Merging \`${theirsHead}\` into \`${head}\`.` : "",
    "",
    "Resolve each path below, then commit on this head to complete the merge,",
    "or abort the merge to discard it. This file is auto-generated and is not",
    "itself committed.",
    "",
  ];
  for (const c of conflicts) {
    lines.push(`- **${c.kind}** \`${c.path}\` — ${CONFLICT_KIND_HELP[c.kind] ?? c.kind}`);
  }
  lines.push("");
  return lines.join("\n");
}

export class DiskProjector {
  constructor(private readonly deps: DiskProjectorDeps) {}

  contextDir(contextId: string): string {
    const safeId = validateVcsContextId(contextId);
    const root = path.resolve(this.deps.contextsRoot);
    const dir = path.resolve(root, safeId);
    const rel = path.relative(root, dir);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Invalid VCS context id: ${JSON.stringify(contextId)}`);
    }
    return dir;
  }

  /** Working-tree dir for a (repoPath, head): a repo's subtree under the
   *  workspace root (main) or under its context folder (`ctx:*`). */
  dirForRepoHead(repoPath: string | undefined, head: string): string {
    const base =
      head === VCS_MAIN_HEAD
        ? this.deps.workspaceRoot
        : head.startsWith("ctx:")
          ? this.contextDir(contextIdFromVcsHead(head))
          : (() => {
              throw new Error(`No working tree for head: ${head}`);
            })();
    return repoPath ? path.join(base, ...normalizeRepoPathForLog(repoPath).split("/")) : base;
  }

  /**
   * THE follower step: project `stateHash` onto the (repoPath, head) working
   * tree — an editable, sidecar-tracked checkout from the content store.
   * `clean` also removes untracked files (working-content re-projection after
   * commit/discard); `bestEffort` swallows projection failures (disk is a
   * disposable projection — the state advance already happened).
   */
  async project(input: {
    repoPath?: string | undefined;
    head: string;
    stateHash: string;
    clean?: boolean;
    bestEffort?: boolean;
  }): Promise<void> {
    const dir = this.dirForRepoHead(input.repoPath, input.head);
    const run = this.deps.worktrees.materializeState(
      input.stateHash,
      dir,
      input.clean ? { clean: true } : {}
    );
    if (input.bestEffort) {
      await run.catch(() => {});
      return;
    }
    await run;
  }

  /** Remove a repo's projection under the workspace root (repo deletion). */
  async removeRepo(repoPath: string): Promise<void> {
    await fsp.rm(this.dirForRepoHead(repoPath, VCS_MAIN_HEAD), { recursive: true, force: true });
  }

  /**
   * Write or remove the worktree merge-conflict summary for a head from the
   * pending-merge data the caller resolved. Non-content conflicts (mode /
   * binary / delete-vs-change) leave no in-file `<<<<<<<` markers, so this
   * file is the only worktree-visible signal. Never committed (snapshot scans
   * skip it); removed when the merge resolves or aborts (`pending: null`).
   */
  async writeConflictSummary(input: {
    repoPath?: string | undefined;
    head: string;
    pending: ConflictSummaryInfo | null;
  }): Promise<void> {
    const file = path.join(this.dirForRepoHead(input.repoPath, input.head), MERGE_CONFLICTS_FILE);
    if (input.pending && input.pending.conflicts.length > 0) {
      await fsp.writeFile(
        file,
        renderConflictSummary(input.head, input.pending.theirsHead, input.pending.conflicts),
        "utf8"
      );
    } else {
      await fsp.rm(file, { force: true });
    }
  }
}
