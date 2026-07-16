import {
  collectTreeReachableDigests,
  hasTreeObject,
  MerkleTreeComposer,
} from "../services/blobstoreService.js";
import type { ProtectedRefStore } from "../services/protectedRefStore.js";
import type { PackageGraph } from "../buildV2/packageGraph.js";
import { EMPTY_STATE_HASH } from "@vibestudio/content-addressing";
import { normalizeRepositoryPath } from "./paths.js";
import { discoverRepos, type DiscoveredRepo } from "./repoDiscovery.js";
import { collectTreeFiles, type ContentProjectionStore } from "./contentProjectionStore.js";

export interface WorkspaceRepositoriesDeps {
  blobsDir: string;
  refs: Pick<ProtectedRefStore, "listMains">;
  contentProjection: Pick<ContentProjectionStore, "ensureStateMirrored">;
  discoverGraph(stateHash: string): Promise<PackageGraph>;
}

/**
 * Composes exact repository content-state sets into workspace-rooted CAS trees.
 * This is a content/cache primitive only: repository refs are the host
 * materialization of one semantic event, never independent revision heads.
 */
export class WorkspaceRepositories {
  private readonly composedViewCache = new Map<string, string>();
  private readonly composer: MerkleTreeComposer;

  constructor(private readonly deps: WorkspaceRepositoriesDeps) {
    this.composer = new MerkleTreeComposer(deps.blobsDir);
  }

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
      const normalized = normalizeRepositoryPath(repoPath);
      const graph = await this.deps.discoverGraph(view.stateHash);
      const node = graph
        .allNodes()
        .find((candidate) => normalizeRepositoryPath(candidate.relativePath) === normalized);
      if (!node) return [];
      const dependents = new Set<string>();
      for (const dependencyName of graph.getReverseDeps(node.name)) {
        const dependency = graph.tryGet(dependencyName);
        if (dependency) {
          dependents.add(normalizeRepositoryPath(dependency.relativePath));
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

  /** Compose an exact repository set supplied by the semantic authority. */
  async contentView(
    repositories: Array<{ repoPath: string; stateHash: string }>
  ): Promise<{ stateHash: string }> {
    return { stateHash: await this.compose(repositories) };
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

  async workspaceViewWithReposAt(
    overrides: Array<{ repoPath: string; stateHash: string | null }>
  ): Promise<string> {
    const overrideByRepo = new Map<string, string | null>();
    for (const override of overrides) {
      overrideByRepo.set(normalizeRepositoryPath(override.repoPath), override.stateHash);
    }
    const repos = this.collectMainStates().filter(
      (repo) => !overrideByRepo.has(normalizeRepositoryPath(repo.repoPath))
    );
    for (const [repoPath, stateHash] of overrideByRepo) {
      if (stateHash) repos.push({ repoPath, stateHash });
    }
    return this.compose(repos);
  }

  private collectMainStates(): Array<{ repoPath: string; stateHash: string }> {
    return this.deps.refs
      .listMains()
      .filter((record) => record.contentRoot !== EMPTY_STATE_HASH)
      .map((record) => ({ repoPath: record.repoPath, stateHash: record.contentRoot }));
  }

  private async compose(repos: Array<{ repoPath: string; stateHash: string }>): Promise<string> {
    const normalized = repos.map((repo) => ({
      repoPath: normalizeRepositoryPath(repo.repoPath),
      stateHash: repo.stateHash,
    }));
    const key = normalized
      .map((repo) => `${repo.repoPath}=${repo.stateHash}`)
      .sort()
      .join("\n");
    const cached = this.composedViewCache.get(key);
    if (cached) {
      if (await this.cachedViewIsResolvable(key, cached)) return cached;
      this.composedViewCache.delete(key);
    }

    await Promise.all(
      normalized.map((repo) => this.deps.contentProjection.ensureStateMirrored(repo.stateHash))
    );
    const { stateHash } = await this.composer.composeStateGrafts(
      normalized.map((repo) => ({ path: repo.repoPath, stateHash: repo.stateHash }))
    );
    if (this.composedViewCache.size >= 128) {
      const oldest = this.composedViewCache.keys().next().value;
      if (oldest !== undefined) this.composedViewCache.delete(oldest);
    }
    this.composedViewCache.set(key, stateHash);
    return stateHash;
  }

  private async cachedViewIsResolvable(key: string, stateHash: string): Promise<boolean> {
    try {
      // State pointers are published last, after every scaffold and graft was
      // validated. Their presence is the cheap completeness certificate; a
      // deep walk here would reintroduce O(files) work on every semantic-only
      // working-state transition.
      return await hasTreeObject(this.deps.blobsDir, stateHash);
    } catch (error) {
      console.warn(
        `[WorkspaceRepositories] dropping composed cache entry with missing backing tree: ${key}`,
        error
      );
      return false;
    }
  }
}
