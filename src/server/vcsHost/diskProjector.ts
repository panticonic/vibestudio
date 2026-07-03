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
 *  - {@link removeRepo}: drop a repo's subtree from the active context's
 *    workspace-root checkout (deleteRepo).
 *  - {@link writeConflictSummary}: sync the worktree-visible merge-conflict
 *    summary file from pending-merge DATA passed in by the caller.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  MERGE_CONFLICTS_FILE,
  VCS_ACTIVE_CONTEXT_ID,
  contextIdFromVcsHead,
  normalizeRepoPathForLog,
  validateVcsContextId,
} from "./paths.js";
import type { WorktreeStore } from "./worktreeStore.js";

interface DiskProjectorDeps {
  worktrees: WorktreeStore;
  /** The user's live workspace directory — the ACTIVE context's working tree
   *  (D2: `main` has no checkout; the workspace root IS `ctx:{activeContextId}`). */
  workspaceRoot: string;
  /** Root for context-folder working trees (`{contextsRoot}/{contextId}`). */
  contextsRoot: string;
  /** The context whose checkout is the workspace root (defaults to the
   *  well-known {@link VCS_ACTIVE_CONTEXT_ID}). Every OTHER `ctx:*` head lives
   *  under `{contextsRoot}/{contextId}`. */
  activeContextId?: string;
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

  private get activeContextId(): string {
    return this.deps.activeContextId ?? VCS_ACTIVE_CONTEXT_ID;
  }

  /**
   * Working-tree dir for a (repoPath, head). ONLY `ctx:*` heads have a checkout:
   * the ACTIVE context's subtree lives under the workspace root, every other
   * context under its `{contextsRoot}/{contextId}` folder. `main` is a pure ref
   * with no working tree (D1) — asking for its dir is a programming error.
   *
   * Single-context sync rule (D2): the workspace root is the active context's
   * ONE checkout, fed by two channels — DO working rows (`vcs.edit`) and the
   * disk scan. The DO working state is authoritative; {@link project} keeps this
   * checkout in sync with it; a scan (`snapshotDir`/`worktree.scan`) diffs disk
   * against the last projected state (the `.gad` sidecar baseline) so it adopts
   * only genuine EXTERNAL drift and never misreads an un-projected DO edit as a
   * deletion. Callers must therefore project after every `vcs.edit` before a
   * subsequent scan.
   */
  dirForRepoHead(repoPath: string | undefined, head: string): string {
    const base = head.startsWith("ctx:")
      ? contextIdFromVcsHead(head) === this.activeContextId
        ? this.deps.workspaceRoot
        : this.contextDir(contextIdFromVcsHead(head))
      : (() => {
          throw new Error(
            `No working tree for head: ${head} (main is a pure ref; only ctx:* heads have checkouts)`
          );
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

  /** Remove a repo's projection from the workspace root — the ACTIVE context's
   *  checkout (repo deletion drops the subtree from the live workspace tree). */
  async removeRepo(repoPath: string): Promise<void> {
    await fsp.rm(this.dirForRepoHead(repoPath, `ctx:${this.activeContextId}`), {
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
