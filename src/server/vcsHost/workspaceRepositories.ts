import { collectTreeReachableDigests, mirrorWorktreeTree } from "../services/blobstoreService.js";
import type { ProtectedRefStore } from "../services/protectedRefStore.js";
import type { PackageGraph } from "../buildV2/packageGraph.js";
import { EMPTY_STATE_HASH } from "@vibestudio/shared/contentTree/worktreeHash";
import { normalizeRepoPathForLog } from "./paths.js";
import { discoverRepos, type DiscoveredRepo } from "./repoDiscovery.js";
import { collectTreeFiles, type WorktreeStore } from "./worktreeStore.js";

export interface WorkspaceRepositoriesDeps {
  blobsDir: string;
  refs: Pick<ProtectedRefStore, "listMains">;
  worktrees: Pick<WorktreeStore, "ensureStateMirrored">;
  discoverGraph(stateHash: string): Promise<PackageGraph>;
}

/**
 * Owns the live repository catalog and workspace-rooted composed views.
 *
 * Repo mains remain independently versioned subtree states. This collaborator
 * is the one place that projects those refs into the workspace identity space,
 * caches the content-addressed composition, and derives deletion impact.
 */
export class WorkspaceRepositories {
  private readonly composedViewCache = new Map<string, string>();

  constructor(private readonly deps: WorkspaceRepositoriesDeps) {}

  async discover(): Promise<DiscoveredRepo[]> {
    const repoStates = this.collectMainStates();
    if (repoStates.length === 0) return [];
    const composed = await this.compose(repoStates);
    const files = await collectTreeFiles(this.deps.blobsDir, composed);
    if (files === null) {
      throw new Error(`discoverRepos: composed view ${composed} not resolvable`);
    }
    return discoverRepos(files.map((file) => file.path));
  }

  /**
   * Repos whose build units directly depend on the selected repo. Discovery
   * failures are non-blocking because this data only enriches the severe
   * deletion approval prompt.
   */
  async deletionDependents(repoPath: string): Promise<string[]> {
    try {
      const view = await this.workspaceView();
      const normalized = normalizeRepoPathForLog(repoPath);
      const graph = await this.deps.discoverGraph(view.stateHash);
      const node = graph
        .allNodes()
        .find((candidate) => normalizeRepoPathForLog(candidate.relativePath) === normalized);
      if (!node) return [];
      const dependents = new Set<string>();
      for (const dependencyName of graph.getReverseDeps(node.name)) {
        const dependency = graph.tryGet(dependencyName);
        if (dependency) {
          dependents.add(normalizeRepoPathForLog(dependency.relativePath));
        }
      }
      dependents.delete(normalized);
      return [...dependents].sort();
    } catch {
      return [];
    }
  }

  async workspaceView(): Promise<{ stateHash: string }> {
    return { stateHash: await this.compose(this.collectMainStates()) };
  }

  /** Reachable CAS objects held only by cached composed views, for GC rooting. */
  async collectCachedReachableDigests(): Promise<{
    contentDigests: string[];
    treeDigests: string[];
  }> {
    const contentDigests = new Set<string>();
    const treeDigests = new Set<string>();
    for (const [key, stateHash] of this.composedViewCache) {
      try {
        const reachable = await collectTreeReachableDigests(this.deps.blobsDir, stateHash);
        if (!reachable) {
          this.composedViewCache.delete(key);
          continue;
        }
        for (const digest of reachable.contentDigests) contentDigests.add(digest);
        for (const digest of reachable.treeDigests) treeDigests.add(digest);
      } catch (error) {
        console.warn(
          `[WorkspaceRepositories] dropping composed cache entry during GC root collection: ${key}`,
          error
        );
        this.composedViewCache.delete(key);
      }
    }
    return {
      contentDigests: [...contentDigests],
      treeDigests: [...treeDigests],
    };
  }

  workspaceViewWithRepoAt(repoPath: string, stateHash: string | null): Promise<string> {
    return this.workspaceViewWithReposAt([{ repoPath, stateHash }]);
  }

  async workspaceViewWithReposAt(
    overrides: Array<{ repoPath: string; stateHash: string | null }>
  ): Promise<string> {
    const overrideByRepo = new Map<string, string | null>();
    for (const override of overrides) {
      overrideByRepo.set(normalizeRepoPathForLog(override.repoPath), override.stateHash);
    }
    const repos = this.collectMainStates().filter(
      (repo) => !overrideByRepo.has(normalizeRepoPathForLog(repo.repoPath))
    );
    for (const [repoPath, stateHash] of overrideByRepo) {
      if (stateHash) repos.push({ repoPath, stateHash });
    }
    return this.compose(repos);
  }

  private collectMainStates(): Array<{ repoPath: string; stateHash: string }> {
    return this.deps.refs
      .listMains()
      .filter((record) => record.stateHash !== EMPTY_STATE_HASH)
      .map((record) => ({ repoPath: record.repoPath, stateHash: record.stateHash }));
  }

  private async compose(repos: Array<{ repoPath: string; stateHash: string }>): Promise<string> {
    if (repos.length === 0) {
      await mirrorWorktreeTree(this.deps.blobsDir, []);
      return EMPTY_STATE_HASH;
    }
    const key = repos
      .map((repo) => `${normalizeRepoPathForLog(repo.repoPath)}=${repo.stateHash}`)
      .sort()
      .join("\n");
    const cached = this.composedViewCache.get(key);
    if (cached) {
      if (await this.cachedViewIsResolvable(key, cached)) return cached;
      this.composedViewCache.delete(key);
    }

    const files: Array<{ path: string; contentHash: string; mode: number }> = [];
    for (const repo of repos) {
      await this.deps.worktrees.ensureStateMirrored(repo.stateHash);
      const listing = await collectTreeFiles(this.deps.blobsDir, repo.stateHash);
      if (listing === null) {
        throw new Error(
          `WorkspaceRepositories: repo ${repo.repoPath} state ${repo.stateHash} is not resolvable`
        );
      }
      const prefix = normalizeRepoPathForLog(repo.repoPath);
      for (const file of listing) {
        files.push({
          path: `${prefix}/${file.path}`,
          contentHash: file.contentHash,
          mode: file.mode,
        });
      }
    }
    const { stateHash } = await mirrorWorktreeTree(this.deps.blobsDir, files);
    if (this.composedViewCache.size >= 128) {
      const oldest = this.composedViewCache.keys().next().value;
      if (oldest !== undefined) this.composedViewCache.delete(oldest);
    }
    this.composedViewCache.set(key, stateHash);
    return stateHash;
  }

  private async cachedViewIsResolvable(key: string, stateHash: string): Promise<boolean> {
    try {
      return (await collectTreeReachableDigests(this.deps.blobsDir, stateHash)) !== null;
    } catch (error) {
      console.warn(
        `[WorkspaceRepositories] dropping composed cache entry with missing backing tree: ${key}`,
        error
      );
      return false;
    }
  }
}
