import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { PanelTreeCache } from "@vibestudio/shell-core/panelTreeCache";
import type { PanelSlotId } from "@vibestudio/shared/panel/ids";
import type {
  PanelTreeGroup,
  PanelTreeNode,
  PanelTreePlacementHint,
  PanelTreeSearchPage,
} from "@vibestudio/shared/panel/treeIndex";
import type {
  DescendantSiblingGroup,
  PanelAncestor,
  PanelArtifacts,
  PanelExplicitState,
  PanelNavigationState,
  PanelSnapshot,
  PanelSummary,
} from "@vibestudio/shared/types";
import { panel } from "../client.js";
import { useShellEvent } from "../useShellEvent.js";
import { useDirectShellEvent } from "../useDirectShellEvent.js";
import { pinMutationSeqAtom, pinnedPanelIdsAtom } from "../../state/appModeAtoms.js";
import { useCurrentAccountProfile } from "./useAccountProfiles.js";

export type { DescendantSiblingGroup, PanelAncestor, PanelSummary };

export interface PanelTreeViewNode {
  id: string;
  title: string;
  owner: string | null;
  parentId: string | null;
  childCount: number;
  children: PanelTreeViewNode[];
  /** Whether the first bounded child page has been queried. */
  childrenLoaded?: boolean;
  childrenLoadedCount?: number;
  childrenHasMore?: boolean;
  selectedChildId: string | null;
  placement?: PanelTreePlacementHint;
}

export interface FullPanel {
  id: string;
  title: string;
  contextId: string;
  buildKey?: string | null;
  parentId: string | null;
  position: number;
  selectedChildId: string | null;
  snapshot: PanelSnapshot;
  artifacts: PanelArtifacts;
  state?: PanelExplicitState;
  navigation?: PanelNavigationState;
  path?: string;
  sourceRepo?: string;
  injectHostThemeVariables?: boolean;
  hostViewRevision?: number;
}

export interface FlattenedPanel {
  id: string;
  parentId: string | null;
  depth: number;
  index: number;
  panel: PanelSummary;
  collapsed: boolean;
}

export function flattenTree(
  panels: readonly PanelTreeViewNode[],
  collapsedIds: Set<string>,
  parentId: string | null = null,
  depth = 0,
  result: FlattenedPanel[] = []
): FlattenedPanel[] {
  panels.forEach((panel, index) => {
    const collapsed = collapsedIds.has(panel.id);
    result.push({
      id: panel.id,
      parentId,
      depth,
      index,
      panel: {
        id: panel.id,
        title: panel.title,
        childCount: panel.childCount,
        position: index,
      },
      collapsed,
    });
    if (!collapsed) flattenTree(panel.children, collapsedIds, panel.id, depth + 1, result);
  });
  return result;
}

export function findParentAtDepth(
  items: FlattenedPanel[],
  fromIndex: number,
  targetDepth: number
): string | null {
  if (targetDepth === 0) return null;
  for (let index = fromIndex - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.depth === targetDepth - 1) return item.id;
    if (item && item.depth < targetDepth - 1) return item.parentId;
  }
  return null;
}

export function getProjection(
  items: FlattenedPanel[],
  activeId: string,
  overId: string,
  dragOffset: number,
  indentationWidth: number
): { depth: number; parentId: string | null } {
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const overIndex = items.findIndex((item) => item.id === overId);
  if (activeIndex < 0 || overIndex < 0) return { depth: 0, parentId: null };
  const active = items[activeIndex]!;
  const previous = activeIndex < overIndex ? items[overIndex] : items[Math.max(0, overIndex - 1)];
  const next = activeIndex < overIndex ? items[overIndex + 1] : items[overIndex];
  const desired = active.depth + Math.round(dragOffset / indentationWidth);
  const maxDepth = previous ? previous.depth + 1 : 0;
  const minDepth = next?.depth ?? 0;
  const depth = Math.max(minDepth, Math.min(desired, maxDepth));
  if (depth === 0) return { depth, parentId: null };
  if (previous && depth > previous.depth) return { depth, parentId: previous.id };
  if (previous && depth === previous.depth) return { depth, parentId: previous.parentId };
  return { depth, parentId: findParentAtDepth(items, overIndex + 1, depth) };
}

export function removeChildrenOf(items: FlattenedPanel[], ids: string[]): FlattenedPanel[] {
  const excluded = new Set(ids);
  return items.filter((item) => {
    if (item.parentId && excluded.has(item.parentId)) {
      excluded.add(item.id);
      return false;
    }
    return true;
  });
}

interface PanelTreeContextValue {
  allRootPanels: PanelTreeViewNode[];
  panelMap: Map<string, PanelTreeViewNode>;
  parentMap: Map<string, string | null>;
  ownerGroups: Array<{
    owner: string;
    rootCount: number;
    rootLoadedCount?: number;
    rootsHaveMore?: boolean;
    rootPanels: PanelTreeViewNode[];
  }>;
  selfUserId: string | null;
  selfIdentityError: string | null;
  treeLoadError: string | null;
  initialized: boolean;
  refreshing: boolean;
  treeRevision: number;
  refreshTree(): Promise<void>;
  loadChildren(panelId: string): Promise<void>;
  loadSelectionPath(panelId: string, maxDepth: number): Promise<void>;
  loadMore(group: PanelTreeGroup): Promise<void>;
  loadMoreRootGroups(): Promise<void>;
  hasMoreRootGroups: boolean;
  search(query: string, cursor?: string): Promise<PanelTreeSearchPage>;
}

const PanelTreeContext = createContext<PanelTreeContextValue | null>(null);

function usePanelTreeContext(): PanelTreeContextValue {
  const value = useContext(PanelTreeContext);
  if (!value) throw new Error("usePanelTreeContext must be used within a PanelTreeProvider");
  return value;
}

export function usePanelTree(): PanelTreeContextValue {
  return usePanelTreeContext();
}

function nodeTree(
  node: PanelTreeNode,
  cache: PanelTreeCache,
  seen: Set<string>,
  localSelectedChildren: ReadonlyMap<string, string | null>
): PanelTreeViewNode {
  if (seen.has(node.slotId)) {
    throw new Error(`Panel tree cycle detected at ${node.slotId}`);
  }
  const nextSeen = new Set(seen).add(node.slotId);
  const group = { kind: "children" as const, parentSlotId: node.slotId };
  const cachedChildren = cache.getGroup(group);
  const children = cachedChildren?.nodes ?? [];
  return {
    id: node.slotId,
    title: node.title,
    owner: node.ownerUserId,
    parentId: node.parentSlotId,
    childCount: node.childCount,
    children: children.map((child) => nodeTree(child, cache, nextSeen, localSelectedChildren)),
    childrenLoaded: cachedChildren !== null,
    childrenLoadedCount: cachedChildren?.loadedCount ?? 0,
    childrenHasMore: cachedChildren?.nextCursor !== null && cachedChildren !== null,
    selectedChildId: localSelectedChildren.has(node.slotId)
      ? (localSelectedChildren.get(node.slotId) ?? null)
      : (children[0]?.slotId ?? null),
    ...(node.placement ? { placement: node.placement } : {}),
  };
}

export function PanelTreeProvider({ children }: { children: ReactNode }) {
  const currentAccount = useCurrentAccountProfile();
  const selfUserId = currentAccount.profile?.userId ?? null;
  const [, rerender] = useState(0);
  const [treeLoadError, setTreeLoadError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localSelectedChildren, setLocalSelectedChildren] = useState<Map<string, string | null>>(
    () => new Map()
  );
  const refreshingRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const setPinnedPanelIds = useSetAtom(pinnedPanelIdsAtom);
  const pinMutationSeq = useAtomValue(pinMutationSeqAtom);
  const pinSeq = useRef(pinMutationSeq);
  pinSeq.current = pinMutationSeq;
  const cacheRef = useRef<PanelTreeCache | null>(null);
  cacheRef.current ??= new PanelTreeCache(
    {
      rootGroups: (input) => panel.getRootGroups(input),
      page: (input) => panel.getTreePage(input),
      path: (slotId) => panel.getTreePath(slotId),
      search: (input) => panel.searchTree(input),
    },
    { pageSize: 50, maxGroups: 64, maxNodes: 2_000, maxPaths: 128 }
  );
  const cache = cacheRef.current;

  useEffect(() => cache.subscribe(() => rerender((value) => value + 1)), [cache]);

  const reconcilePins = useCallback(async () => {
    const dispatchedAt = pinSeq.current;
    const ids = await panel.listPinnedPanelIds();
    if (pinSeq.current === dispatchedAt) setPinnedPanelIds(new Set(ids));
  }, [setPinnedPanelIds]);

  const refreshTree = useCallback(
    async (invalidatedGroups: readonly PanelTreeGroup[] = []) => {
      const sequence = ++refreshSequenceRef.current;
      refreshingRef.current = true;
      setRefreshing(true);
      try {
        const groups = await cache.loadRootGroups(true);
        await Promise.all([
          ...groups.groups.map((group) =>
            cache.loadFirst({ kind: "roots", ownerUserId: group.ownerUserId })
          ),
          ...invalidatedGroups.map((group) => cache.loadFirst(group)),
        ]);
        await reconcilePins();
        setTreeLoadError(null);
        setInitialized(true);
      } catch (error) {
        setTreeLoadError(error instanceof Error ? error.message : String(error));
        setInitialized(true);
      } finally {
        if (refreshSequenceRef.current === sequence) {
          refreshingRef.current = false;
          setRefreshing(false);
        }
      }
    },
    [cache, reconcilePins]
  );

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useShellEvent(
    "panel-tree-invalidated",
    useCallback(
      (event) => {
        // Cache invalidation emits synchronously. Publish the refresh
        // transaction before that emission so consumers never interpret the
        // deliberately stale/missing query page as a durable tree deletion.
        refreshingRef.current = true;
        setRefreshing(true);
        const invalidatedGroups = cache.invalidate(event);
        void refreshTree(invalidatedGroups);
      },
      [cache, refreshTree]
    )
  );
  useDirectShellEvent(
    "panel-presentation-changed",
    useCallback((event) => {
      void Promise.all(
        event.panelIds.map(async (panelId) => ({
          panelId,
          presentation: await panel.getPresentation(panelId),
        }))
      )
        .then((updates) => {
          setLocalSelectedChildren((current) => {
            const next = new Map(current);
            for (const { panelId, presentation } of updates) {
              next.set(panelId, presentation?.selectedChildId ?? null);
            }
            return next;
          });
        })
        .catch(() => {});
    }, [])
  );

  const loadChildren = useCallback(
    async (panelId: string) => {
      await cache.loadFirst({ kind: "children", parentSlotId: panelId as PanelSlotId });
    },
    [cache]
  );
  const loadSelectionPath = useCallback(
    async (panelId: string, maxDepth: number) => {
      const selections = new Map<string, string | null>();
      let currentId: string | null = panelId;
      for (let depth = 0; currentId && depth < maxDepth; depth++) {
        const presentation = await panel.getPresentation(currentId);
        const selectedChildId = presentation?.selectedChildId ?? null;
        selections.set(currentId, selectedChildId);
        if (!selectedChildId) break;

        const group = {
          kind: "children" as const,
          parentSlotId: currentId as PanelSlotId,
        };
        let page = await cache.loadFirst(group);
        while (!page.nodes.some((node) => node.slotId === selectedChildId) && page.nextCursor) {
          page = await cache.loadMore(group);
        }
        if (!page.nodes.some((node) => node.slotId === selectedChildId)) break;
        currentId = selectedChildId;
      }
      setLocalSelectedChildren((current) => {
        const next = new Map(current);
        for (const [parentId, selectedChildId] of selections) {
          next.set(parentId, selectedChildId);
        }
        return next;
      });
    },
    [cache]
  );
  const loadMore = useCallback(
    async (group: PanelTreeGroup) => {
      await cache.loadMore(group);
    },
    [cache]
  );
  const loadMoreRootGroups = useCallback(async () => {
    const groups = await cache.loadRootGroups(false);
    await Promise.all(
      groups.groups.map((owner) => {
        const group = { kind: "roots" as const, ownerUserId: owner.ownerUserId };
        return cache.getGroup(group) ? Promise.resolve() : cache.loadFirst(group);
      })
    );
  }, [cache]);
  const search = useCallback(
    (query: string, cursor?: string) =>
      cache.search({ query, ...(cursor ? { cursor } : {}), limit: 50 }),
    [cache]
  );

  const rootGroups = cache.getRootGroups().groups;
  const orderedGroups = useMemo(() => {
    const groups = [...rootGroups];
    if (!selfUserId) return groups;
    return [
      ...groups.filter((group) => group.ownerUserId === selfUserId),
      ...groups.filter((group) => group.ownerUserId !== selfUserId),
    ];
  }, [rootGroups, selfUserId]);
  const ownerGroups = orderedGroups.map((owner) => {
    const group = { kind: "roots" as const, ownerUserId: owner.ownerUserId };
    return {
      owner: owner.ownerUserId ?? "",
      rootCount: owner.rootCount,
      rootLoadedCount: cache.getGroup(group)?.loadedCount ?? 0,
      rootsHaveMore: cache.getGroup(group)?.nextCursor !== null && cache.getGroup(group) !== null,
      rootPanels: (cache.getGroup(group)?.nodes ?? []).map((node) =>
        nodeTree(node, cache, new Set(), localSelectedChildren)
      ),
    };
  });
  useEffect(() => {
    const retained: PanelTreeGroup[] = orderedGroups.map((owner) => ({
      kind: "roots",
      ownerUserId: owner.ownerUserId,
    }));
    const visit = (node: PanelTreeViewNode) => {
      if (node.childCount > 0 && node.children.length > 0) {
        retained.push({ kind: "children", parentSlotId: node.id });
        node.children.forEach(visit);
      }
    };
    ownerGroups.forEach((owner) => owner.rootPanels.forEach(visit));
    cache.retainGroups(retained);
  }, [cache, orderedGroups, ownerGroups]);
  const allRootPanels = ownerGroups.flatMap((group) => group.rootPanels);
  const { panelMap, parentMap } = useMemo(() => {
    const panels = new Map<string, PanelTreeViewNode>();
    const parents = new Map<string, string | null>();
    const visit = (node: PanelTreeViewNode) => {
      panels.set(node.id, node);
      parents.set(node.id, node.parentId);
      node.children.forEach(visit);
    };
    allRootPanels.forEach(visit);
    return { panelMap: panels, parentMap: parents };
  }, [allRootPanels]);

  const value: PanelTreeContextValue = {
    allRootPanels,
    panelMap,
    parentMap,
    ownerGroups,
    selfUserId,
    selfIdentityError: currentAccount.error,
    treeLoadError,
    initialized: initialized && currentAccount.settled,
    refreshing: refreshingRef.current || refreshing,
    treeRevision: cache.getRevision(),
    refreshTree,
    loadChildren,
    loadSelectionPath,
    loadMore,
    loadMoreRootGroups,
    hasMoreRootGroups: cache.getRootGroups().nextCursor !== null,
    search,
  };
  return <PanelTreeContext.Provider value={value}>{children}</PanelTreeContext.Provider>;
}

function summary(node: PanelTreeViewNode, position: number): PanelSummary {
  return {
    id: node.id,
    title: node.title,
    childCount: node.childCount,
    position,
  };
}

export function useRootPanels(): { panels: PanelSummary[]; loading: boolean } {
  const { allRootPanels, initialized } = usePanelTreeContext();
  return {
    panels: allRootPanels.map(summary),
    loading: !initialized,
  };
}

export function useFullPanel(panelId: string | null): {
  panel: FullPanel | null;
  loading: boolean;
} {
  const [value, setValue] = useState<FullPanel | null>(null);
  const [loading, setLoading] = useState(Boolean(panelId));
  const applyPresentation = useCallback(
    (presentation: Awaited<ReturnType<typeof panel.getPresentation>>) => {
      if (!presentation || presentation.id !== panelId) return;
      const source = presentation.snapshot.source;
      setValue({
        id: presentation.id,
        title: presentation.title,
        contextId: presentation.snapshot.contextId,
        buildKey: presentation.buildKey,
        parentId: presentation.parentId,
        position: presentation.position,
        selectedChildId: presentation.selectedChildId ?? null,
        snapshot: presentation.snapshot,
        artifacts: presentation.artifacts,
        state: presentation.state,
        navigation: presentation.navigation,
        path: source,
        sourceRepo: source,
        injectHostThemeVariables: true,
        hostViewRevision: presentation.hostViewRevision,
      });
      setLoading(false);
    },
    [panelId]
  );
  useDirectShellEvent(
    "panel-presentation-changed",
    useCallback(
      (event) => {
        if (!panelId || !event.panelIds.includes(panelId)) return;
        void panel
          .getPresentation(panelId)
          .then(applyPresentation)
          .catch(() => {});
      },
      [applyPresentation, panelId]
    )
  );
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    if (!panelId) {
      setValue(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const refreshUntilTerminal = async () => {
      try {
        const presentation = await panel.getPresentation(panelId);
        if (cancelled) return;
        if (!presentation) {
          timer = window.setTimeout(refreshUntilTerminal, 250);
          return;
        }
        applyPresentation(presentation);
        const buildState = presentation.artifacts.buildState;
        if (buildState !== "ready" && buildState !== "error") {
          timer = window.setTimeout(refreshUntilTerminal, 250);
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(refreshUntilTerminal, 1_000);
      }
    };
    void refreshUntilTerminal();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [applyPresentation, panelId]);
  return { panel: value, loading };
}

export function useSiblings(panelId: string | null): {
  siblings: PanelSummary[];
  loading: boolean;
} {
  const { panelMap, parentMap, allRootPanels, loadChildren, initialized } = usePanelTreeContext();
  const parentId = panelId ? (parentMap.get(panelId) ?? null) : null;
  useEffect(() => {
    if (parentId) void loadChildren(parentId);
  }, [loadChildren, parentId]);
  const siblings = parentId ? (panelMap.get(parentId)?.children ?? []) : allRootPanels;
  return { siblings: siblings.map(summary), loading: !initialized };
}

export function useAncestors(panelId: string | null): {
  ancestors: PanelAncestor[];
  loading: boolean;
} {
  const [ancestors, setAncestors] = useState<PanelAncestor[]>([]);
  const [loading, setLoading] = useState(Boolean(panelId));
  useEffect(() => {
    let cancelled = false;
    if (!panelId) {
      setAncestors([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void panel
      .getTreePath(panelId)
      .then((path) => {
        if (cancelled) return;
        const nodes = path?.nodes.slice(0, -1) ?? [];
        setAncestors(
          nodes.map((node, index) => ({
            id: node.slotId,
            title: node.title,
            depth: nodes.length - index,
          }))
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [panelId]);
  return { ancestors, loading };
}

export const DEFAULT_DESCENDANT_DEPTH = 3;

export function useDescendantSiblingGroups(
  panelId: string | null,
  maxDepth = DEFAULT_DESCENDANT_DEPTH
): { groups: DescendantSiblingGroup[]; loading: boolean } {
  const { panelMap, initialized, loadSelectionPath } = usePanelTreeContext();
  const selectionPathKey = (() => {
    const path: Array<string | null> = [];
    let node = panelId ? panelMap.get(panelId) : undefined;
    for (let depth = 0; node && depth < maxDepth; depth++) {
      path.push(node.id, node.selectedChildId);
      node = node.selectedChildId ? panelMap.get(node.selectedChildId) : undefined;
    }
    return path.join("\0");
  })();
  useEffect(() => {
    if (panelId) void loadSelectionPath(panelId, maxDepth).catch(() => {});
  }, [loadSelectionPath, maxDepth, panelId, selectionPathKey]);

  const groups: DescendantSiblingGroup[] = [];
  let current = panelId ? panelMap.get(panelId) : undefined;
  for (let depth = 1; current && depth <= maxDepth && current.children.length > 0; depth++) {
    const selectedId = current.selectedChildId;
    if (!selectedId) break;
    groups.push({
      depth,
      parentId: current.id,
      selectedId,
      siblings: current.children.map(summary),
    });
    current = panelMap.get(selectedId);
  }
  return { groups, loading: !initialized };
}
