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
 *    step after edit/commit/merge/push/restore advances). Only `ctx:*` heads
 *    have a checkout — under `{contextsRoot}/{contextId}`.
 *  - {@link exportMainToSource}: the write-only dev extraction bridge — project a
 *    repo's new `main` state OUT to the source dir (`workspaceRoot/{repoPath}`)
 *    on a main advance. NOT a checkout: `main` stays a pure ref for all context
 *    logic; this is a one-way export gated on a configured dev source dir.
 *  - {@link removeRepo}: drop a repo's subtree from the source dir (deleteRepo,
 *    the extraction counterpart of {@link exportMainToSource}).
 *  - {@link writeConflictSummary}: sync the worktree-visible merge-conflict
 *    summary file from pending-merge DATA passed in by the caller.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  MERGE_CONFLICTS_FILE,
  contextIdFromVcsHead,
  normalizeRepoPathForLog,
  validateVcsContextId,
} from "./paths.js";
import type { WorktreeStore } from "./worktreeStore.js";

interface DiskProjectorDeps {
  worktrees: WorktreeStore;
  /** The persistent source dir — the one-way dev extraction target
   *  ({@link exportMainToSource}). `main` has no checkout; it is projected here
   *  write-only on an advance, never scanned back (except the boot seed). */
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

  /**
   * Working-tree dir for a (repoPath, head). ONLY `ctx:*` heads have a checkout —
   * under `{contextsRoot}/{contextId}`. `main` is a pure ref with no working tree
   * (D1) — asking for its dir is a programming error (the write-only source
   * export goes through {@link exportMainToSource}, not this path).
   */
  dirForRepoHead(repoPath: string, head: string): string {
    const base = head.startsWith("ctx:")
      ? this.contextDir(contextIdFromVcsHead(head))
      : (() => {
          throw new Error(
            `No working tree for head: ${head} (main is a pure ref; only ctx:* heads have checkouts)`
          );
        })();
    return path.join(base, ...normalizeRepoPathForLog(repoPath).split("/"));
  }

  /** The source-dir location for a repo's subtree — `workspaceRoot/{repoPath}`.
   *  The {@link exportMainToSource}/{@link removeRepo} target; NOT a context
   *  checkout (`main` is never given a `dirForRepoHead`). */
  private sourceDirForRepo(repoPath: string): string {
    return path.join(this.deps.workspaceRoot, ...normalizeRepoPathForLog(repoPath).split("/"));
  }

  /**
   * Write-only dev extraction: materialize a repo's `main` `stateHash` OUT to the
   * source dir (`workspaceRoot/{repoPath}`) so a push to `main` flows back into
   * the real monorepo checkout. Uses the same content-store→disk projection
   * primitive as {@link project} but resolves the destination directly (main has
   * no checkout mapping). `clean` removes untracked files so the export mirrors
   * the state exactly.
   */
  async exportMainToSource(repoPath: string, stateHash: string): Promise<void> {
    await this.deps.worktrees.materializeState(stateHash, this.sourceDirForRepo(repoPath), {
      clean: true,
    });
  }

  /**
   * THE follower step: project `stateHash` onto the (repoPath, head) working
   * tree — an editable, sidecar-tracked checkout from the content store.
   * `clean` also removes untracked files (working-content re-projection after
   * commit/discard); `bestEffort` swallows projection failures (disk is a
   * disposable projection — the state advance already happened).
   */
  async project(input: {
    repoPath: string;
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

  /** Remove a repo's subtree from the source dir — the extraction counterpart
   *  of {@link exportMainToSource} (repo deletion drops the subtree from the
   *  real monorepo checkout on a `main` removal). */
  async removeRepo(repoPath: string): Promise<void> {
    await fsp.rm(this.sourceDirForRepo(repoPath), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Write or remove the worktree merge-conflict summary for a head from the
   * pending-merge data the caller resolved. Non-content conflicts (mode /
   * binary / delete-vs-change) leave no in-file `<<<<<<<` markers, so this
   * file is the only worktree-visible signal. Never committed (snapshot scans
   * skip it); removed when the merge resolves or aborts (`pending: null`).
   */
  async writeConflictSummary(input: {
    repoPath: string;
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
