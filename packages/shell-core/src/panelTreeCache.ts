import {
  panelTreeGroupKey,
  type PanelTreeGroup,
  type PanelTreeInvalidation,
  type PanelTreeNode,
  type PanelTreePage,
  type PanelTreePath,
  type PanelTreeRootGroupPage,
  type PanelTreeSearchInput,
  type PanelTreeSearchPage,
} from "@vibestudio/shared/panel/treeIndex";

export interface PanelTreeQuerySource {
  rootGroups(input: { cursor?: string; limit?: number }): Promise<PanelTreeRootGroupPage>;
  page(input: { group: PanelTreeGroup; cursor?: string; limit?: number }): Promise<PanelTreePage>;
  path(slotId: string): Promise<PanelTreePath | null>;
  search(input: PanelTreeSearchInput): Promise<PanelTreeSearchPage>;
}

export interface PanelTreeCachedGroup {
  group: PanelTreeGroup;
  nodes: readonly PanelTreeNode[];
  loadedCount: number;
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

export interface PanelTreeCacheSnapshot {
  revision: number;
  rootGroups: PanelTreeRootGroupPage;
  groups: Array<{
    group: PanelTreeGroup;
    revision: number;
    nodes: PanelTreeNode[];
    nextCursor: string | null;
  }>;
}

interface MutableGroup {
  group: PanelTreeGroup;
  revision: number;
  nodes: PanelTreeNode[];
  loadedCount: number;
  nextCursor: string | null;
  loading: boolean;
  loadingGeneration: number | null;
  error: string | null;
  touched: number;
}

/**
 * Shared bounded read model for desktop and mobile panel-tree browsers.
 *
 * Pages are bounded query results. Runtime/focus state does not live here.
 * Invalidation advances the generation but retains the last coherent pages
 * while their owner refetches, so consumers never mistake an in-flight query
 * for a durable tree deletion.
 */
export class PanelTreeCache {
  private readonly groups = new Map<string, MutableGroup>();
  private readonly paths = new Map<string, { value: PanelTreePath; touched: number }>();
  private readonly listeners = new Set<() => void>();
  private retainedGroupKeys = new Set<string>();
  private clock = 0;
  private revision = 0;
  private generation = 0;
  private rootGroupsLoadingGeneration: number | null = null;
  private rootGroups: PanelTreeRootGroupPage = {
    revision: 0,
    groups: [],
    nextCursor: null,
  };

  constructor(
    private readonly source: PanelTreeQuerySource,
    private readonly options: {
      pageSize?: number;
      maxGroups?: number;
      maxNodes?: number;
      maxNodesPerGroup?: number;
      maxPaths?: number;
      maxPathNodes?: number;
      maxRootGroups?: number;
    } = {}
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(): number {
    return this.revision;
  }

  getRootGroups(): PanelTreeRootGroupPage {
    return this.rootGroups;
  }

  /**
   * Capture only one coherent, bounded tree projection. A revision mismatch is
   * deliberately not serialised: local startup state is a snapshot, never a
   * merge log, so a changing tree is fetched normally on the next launch.
   */
  snapshot(): PanelTreeCacheSnapshot | null {
    if (this.rootGroups.revision !== this.revision) return null;
    const groups = [...this.groups.values()];
    if (groups.some((group) => group.loading || group.revision !== this.revision)) return null;
    return {
      revision: this.revision,
      rootGroups: {
        ...this.rootGroups,
        groups: this.rootGroups.groups.map((group) => ({ ...group })),
      },
      groups: groups.map((group) => ({
        group: { ...group.group },
        revision: group.revision,
        nodes: group.nodes.map((node) => ({ ...node })),
        nextCursor: group.nextCursor,
      })),
    };
  }

  /** Restore a previously validated coherent projection before reconciliation. */
  restore(snapshot: PanelTreeCacheSnapshot): void {
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      snapshot.rootGroups.revision !== snapshot.revision ||
      snapshot.groups.some((group) => group.revision !== snapshot.revision)
    ) {
      throw new Error("Panel-tree snapshot is not revision-coherent");
    }
    this.generation += 1;
    this.groups.clear();
    this.paths.clear();
    this.revision = snapshot.revision;
    this.rootGroups = {
      ...snapshot.rootGroups,
      groups: snapshot.rootGroups.groups
        .slice(0, this.options.maxRootGroups ?? 256)
        .map((group) => ({ ...group })),
    };
    for (const entry of snapshot.groups.slice(0, this.options.maxGroups ?? 64)) {
      const key = panelTreeGroupKey(entry.group);
      if (this.groups.has(key)) throw new Error(`Duplicate panel-tree snapshot group: ${key}`);
      const nodes = entry.nodes.slice(0, this.maxNodesPerGroup()).map((node) => ({ ...node }));
      this.groups.set(key, {
        group: { ...entry.group },
        revision: entry.revision,
        nodes,
        loadedCount: nodes.length,
        nextCursor: entry.nextCursor,
        loading: false,
        loadingGeneration: null,
        error: null,
        touched: ++this.clock,
      });
    }
    this.evict();
    this.emit();
  }

  retainGroups(groups: readonly PanelTreeGroup[]): void {
    const maxGroups = this.options.maxGroups ?? 64;
    this.retainedGroupKeys = new Set(
      groups.slice(Math.max(0, groups.length - maxGroups)).map(panelTreeGroupKey)
    );
    this.evict();
  }

  async loadRootGroups(reset = false): Promise<PanelTreeRootGroupPage> {
    const generation = this.generation;
    if (this.rootGroupsLoadingGeneration === generation) return this.rootGroups;
    const cursor = reset ? undefined : (this.rootGroups.nextCursor ?? undefined);
    if (!reset && this.rootGroups.groups.length > 0 && !cursor) return this.rootGroups;
    this.rootGroupsLoadingGeneration = generation;
    try {
      const page = await this.source.rootGroups({
        ...(cursor ? { cursor } : {}),
        limit: this.options.pageSize ?? 50,
      });
      if (generation !== this.generation) return this.rootGroups;
      this.acceptRevision(page.revision);
      this.rootGroups = {
        revision: page.revision,
        groups: (reset ? page.groups : [...this.rootGroups.groups, ...page.groups]).slice(
          0,
          this.options.maxRootGroups ?? 256
        ),
        nextCursor:
          (reset ? page.groups.length : this.rootGroups.groups.length + page.groups.length) >=
          (this.options.maxRootGroups ?? 256)
            ? null
            : page.nextCursor,
      };
      this.emit();
      return this.rootGroups;
    } finally {
      if (this.rootGroupsLoadingGeneration === generation) {
        this.rootGroupsLoadingGeneration = null;
      }
    }
  }

  getGroup(group: PanelTreeGroup): PanelTreeCachedGroup | null {
    const cached = this.groups.get(panelTreeGroupKey(group));
    if (!cached) return null;
    cached.touched = ++this.clock;
    return cached;
  }

  async loadFirst(group: PanelTreeGroup): Promise<PanelTreeCachedGroup> {
    const generation = this.generation;
    const key = panelTreeGroupKey(group);
    const existing = this.groups.get(key);
    if (existing?.loading && existing.loadingGeneration === generation) return existing;
    const target: MutableGroup = existing ?? {
      group,
      revision: 0,
      nodes: [],
      loadedCount: 0,
      nextCursor: null,
      loading: false,
      loadingGeneration: null,
      error: null,
      touched: ++this.clock,
    };
    target.loading = true;
    target.loadingGeneration = generation;
    target.error = null;
    this.groups.set(key, target);
    this.emit();
    try {
      const page = await this.source.page({
        group,
        limit: this.pageSize(),
      });
      if (generation !== this.generation) return target;
      this.acceptRevision(page.revision);
      target.revision = page.revision;
      target.nodes = page.nodes.slice(0, this.maxNodesPerGroup());
      target.loadedCount = page.nodes.length;
      target.nextCursor = page.nextCursor;
    } catch (error) {
      if (generation === this.generation && target.loadingGeneration === generation) {
        target.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      if (target.loadingGeneration === generation) {
        target.loading = false;
        target.loadingGeneration = null;
        target.touched = ++this.clock;
      }
      this.evict();
      this.emit();
    }
    return target;
  }

  async loadMore(group: PanelTreeGroup): Promise<PanelTreeCachedGroup> {
    const generation = this.generation;
    const key = panelTreeGroupKey(group);
    const cached = this.groups.get(key);
    if (!cached) return this.loadFirst(group);
    if (cached.loading) {
      return cached.loadingGeneration === generation ? cached : this.loadFirst(group);
    }
    if (!cached.nextCursor) return cached;
    cached.loading = true;
    cached.loadingGeneration = generation;
    cached.error = null;
    this.emit();
    let revisionChanged = false;
    try {
      const page = await this.source.page({
        group,
        cursor: cached.nextCursor,
        limit: this.pageSize(),
      });
      if (generation !== this.generation) return cached;
      this.acceptRevision(page.revision);
      if (page.revision !== cached.revision) {
        revisionChanged = true;
      } else {
        const seen = new Set(cached.nodes.map((node) => node.slotId));
        const additions = page.nodes.filter((node) => !seen.has(node.slotId));
        cached.nodes.push(...additions);
        cached.loadedCount += additions.length;
        const excess = cached.nodes.length - this.maxNodesPerGroup();
        if (excess > 0) cached.nodes.splice(0, excess);
        cached.nextCursor = page.nextCursor;
      }
    } catch (error) {
      if (generation === this.generation && cached.loadingGeneration === generation) {
        cached.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      if (cached.loadingGeneration === generation) {
        cached.loading = false;
        cached.loadingGeneration = null;
        cached.touched = ++this.clock;
      }
      this.evict();
      this.emit();
    }
    if (revisionChanged) {
      this.groups.delete(key);
      return this.loadFirst(group);
    }
    return cached;
  }

  async loadPath(slotId: string): Promise<PanelTreePath | null> {
    const generation = this.generation;
    const cached = this.paths.get(slotId);
    if (cached && cached.value.revision === this.revision) {
      cached.touched = ++this.clock;
      return cached.value;
    }
    if (cached) this.paths.delete(slotId);
    const path = await this.source.path(slotId);
    if (generation !== this.generation) return null;
    if (!path) return null;
    this.acceptRevision(path.revision);
    this.paths.set(slotId, { value: path, touched: ++this.clock });
    this.evict();
    this.emit();
    return path;
  }

  search(input: PanelTreeSearchInput): Promise<PanelTreeSearchPage> {
    return this.source.search(input);
  }

  invalidate(event: PanelTreeInvalidation): PanelTreeGroup[] {
    if (event.revision <= this.revision) return [];
    const missedRevision = this.revision !== 0 && event.revision !== this.revision + 1;
    this.revision = event.revision;
    this.generation += 1;
    const loadedGroups = [...this.groups.values()].map((entry) => entry.group);
    if (event.reset || missedRevision) {
      this.paths.clear();
      this.emit();
      return loadedGroups;
    }
    const changed = new Set([...event.changedSlotIds, ...event.removedSlotIds]);
    for (const [slotId, path] of this.paths) {
      if (path.value.nodes.some((node) => changed.has(node.slotId))) this.paths.delete(slotId);
    }
    this.emit();
    const affectedKeys = new Set(event.groups.map(panelTreeGroupKey));
    return loadedGroups.filter((group) => affectedKeys.has(panelTreeGroupKey(group)));
  }

  clear(): void {
    this.generation += 1;
    this.groups.clear();
    this.paths.clear();
    this.rootGroups = { revision: 0, groups: [], nextCursor: null };
    this.revision = 0;
    this.emit();
  }

  private acceptRevision(revision: number): void {
    if (revision > this.revision) this.revision = revision;
  }

  private maxNodesPerGroup(): number {
    return Math.max(
      1,
      Math.min(this.options.maxNodesPerGroup ?? 500, this.options.maxNodes ?? 2_000)
    );
  }

  private pageSize(): number {
    return Math.min(this.options.pageSize ?? 50, this.maxNodesPerGroup());
  }

  private evict(): void {
    const maxGroups = this.options.maxGroups ?? 64;
    const maxNodes = this.options.maxNodes ?? 2_000;
    const maxPaths = this.options.maxPaths ?? 128;
    const maxPathNodes = this.options.maxPathNodes ?? 4_000;
    const oldestGroup = () => {
      const candidates = [...this.groups.entries()].filter(([, value]) => !value.loading);
      return (
        candidates
          .filter(([key]) => !this.retainedGroupKeys.has(key))
          .sort((a, b) => a[1].touched - b[1].touched)[0] ??
        candidates.sort((a, b) => a[1].touched - b[1].touched)[0]
      );
    };
    let nodes = [...this.groups.values()].reduce((sum, value) => sum + value.nodes.length, 0);
    while (this.groups.size > maxGroups || nodes > maxNodes) {
      const oldest = oldestGroup();
      if (!oldest) break;
      nodes -= oldest[1].nodes.length;
      this.groups.delete(oldest[0]);
    }
    let pathNodes = [...this.paths.values()].reduce(
      (sum, path) => sum + path.value.nodes.length,
      0
    );
    while (this.paths.size > maxPaths || pathNodes > maxPathNodes) {
      const oldest = [...this.paths.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!oldest) break;
      pathNodes -= oldest[1].value.nodes.length;
      this.paths.delete(oldest[0]);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
