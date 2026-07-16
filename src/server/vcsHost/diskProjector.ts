/**
 * DiskProjector — the host's disk-projection FOLLOWER (eviction stage P5c).
 *
 * Disk projection/materialization is a permanent narrow host surface: the source export and
 * current-epoch `.context-projections/vN/*` folders are DISPOSABLE PROJECTIONS
 * of content-addressed states. This module is the ONE narrow entry point that
 * writes them. It is invoked post-operation with a state hash the VCS
 * semantics (owned by the product-sealed semantic control plane) already decided on; nothing in
 * here decides WHAT a tree should be, only WHERE a given state lands on disk
 * and how (editable context projection via the content store, sidecar-tracked).
 *
 * Entry points:
 *  - {@link projectContextRepository}: materialize one repository's exact
 *    state under an explicit semantic context directory. The API cannot encode
 *    a ref, selector, or implicit projection target.
 *  - {@link exportMainToSource}: the write-only dev extraction bridge — project a
 *    repo's new `main` state OUT to the source dir (`workspaceRoot/{repoPath}`)
 *    on a main advance. NOT a checkout: `main` stays a pure ref for all context
 *    logic; this is a one-way export gated on a configured dev source dir.
 *  - {@link removeRepo}: drop a repo's subtree from the source dir (deleteRepo,
 *    the extraction counterpart of {@link exportMainToSource}).
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { normalizeRepositoryPath, validateVcsContextId } from "./paths.js";
import type { ContentProjectionStore } from "./contentProjectionStore.js";

interface DiskProjectorDeps {
  contentProjection: ContentProjectionStore;
  /** The persistent source dir — the one-way dev extraction target
   *  ({@link exportMainToSource}). `main` has no checkout; it is projected here
   *  write-only on an advance, never scanned back (except the boot seed). */
  workspaceRoot: string;
  /** Exact current-epoch root for disposable context projections. */
  contextProjectionsRoot: string;
}

export class DiskProjector {
  constructor(private readonly deps: DiskProjectorDeps) {}

  contextDir(contextId: string): string {
    const safeId = validateVcsContextId(contextId);
    const root = path.resolve(this.deps.contextProjectionsRoot);
    const dir = path.resolve(root, safeId);
    const rel = path.relative(root, dir);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Invalid VCS context id: ${JSON.stringify(contextId)}`);
    }
    return dir;
  }

  /** Exact directory for one repository in a semantic context projection. */
  contextRepositoryDir(contextId: string, repoPath: string): string {
    return path.join(this.contextDir(contextId), ...normalizeRepositoryPath(repoPath).split("/"));
  }

  async exactContextRepositoryState(contextId: string, repoPath: string) {
    return this.deps.contentProjection.localState(this.contextRepositoryDir(contextId, repoPath), {
      exact: true,
    });
  }

  /** The source-dir location for a repo's subtree — `workspaceRoot/{repoPath}`.
   *  The {@link exportMainToSource}/{@link removeRepo} target; NOT a context
   *  projection (semantic contexts use {@link contextRepositoryDir}). */
  private sourceDirForRepo(repoPath: string): string {
    return path.join(this.deps.workspaceRoot, ...normalizeRepositoryPath(repoPath).split("/"));
  }

  /**
   * Write-only dev extraction: materialize a repo's `main` `stateHash` OUT to the
   * source dir (`workspaceRoot/{repoPath}`) so a push to `main` flows back into
   * the real monorepo checkout. Uses the same content-store→disk projection
   * primitive as {@link projectContextRepository} but resolves the destination
   * directly. `clean` removes untracked files so the export mirrors the state
   * exactly.
   */
  async exportMainToSource(repoPath: string, stateHash: string): Promise<void> {
    await this.deps.contentProjection.materializeState(stateHash, this.sourceDirForRepo(repoPath), {
      clean: true,
    });
  }

  /**
   * THE context follower step: project `stateHash` into one repository's
   * editable, sidecar-tracked context projection.
   * `clean` also removes untracked files. Projection failure is always visible
   * to the semantic authority so it can replay the generic host effect.
   */
  async projectContextRepository(input: {
    contextId: string;
    repoPath: string;
    stateHash: string;
    clean?: boolean;
  }): Promise<void> {
    const dir = this.contextRepositoryDir(input.contextId, input.repoPath);
    await this.deps.contentProjection.materializeState(
      input.stateHash,
      dir,
      input.clean ? { clean: true } : {}
    );
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
}
