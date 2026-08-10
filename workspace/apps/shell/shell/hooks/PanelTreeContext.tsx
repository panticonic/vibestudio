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
import { panelTreeGroupKey } from "@vibestudio/shared/panel/treeIndex";
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
  icon?: string;
  source?: string;
  favicon?: PanelNavigationState["favicon"];
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
  icon?: string;
  contextId?: string;
  runtimeEntityId?: string | null;
  buildKey?: string | null;
  parentId: string | null;
  position: number;
  selectedChildId?: string | null;
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
        ...(panel.icon ? { icon: panel.icon } : {}),
        ...(panel.source ? { source: panel.source } : {}),
        ...(panel.favicon ? { favicon: panel.favicon } : {}),
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
  localSelectedChildren: ReadonlyMap<string, string | null>,
  presentations: ReadonlyMap<string, FullPanel>
): PanelTreeViewNode {
  if (seen.has(node.slotId)) {
    throw new Error(`Panel tree cycle detected at ${node.slotId}`);
  }
  const nextSeen = new Set(seen).add(node.slotId);
  const group = { kind: "children" as const, parentSlotId: node.slotId };
  const cachedChildren = cache.getGroup(group);
  const children = cachedChildren?.nodes ?? [];
  const presentation = presentations.get(node.slotId);
  const icon = presentation?.icon ?? node.icon;
  const source = presentation?.snapshot?.source ?? node.source;
  const favicon = faviconForPresentation(presentation);
  return {
    id: node.slotId,
    title: node.title,
    owner: node.ownerUserId,
    parentId: node.parentSlotId,
    childCount: node.childCount,
    ...(icon ? { icon } : {}),
    ...(source ? { source } : {}),
    ...(favicon ? { favicon } : {}),
    children: children.map((child) =>
      nodeTree(child, cache, nextSeen, localSelectedChildren, presentations)
    ),
    childrenLoaded: cachedChildren !== null,
    childrenLoadedCount: cachedChildren?.loadedCount ?? 0,
    childrenHasMore: cachedChildren?.nextCursor !== null && cachedChildren !== null,
    selectedChildId: localSelectedChildren.has(node.slotId)
      ? (localSelectedChildren.get(node.slotId) ?? null)
      : (children[0]?.slotId ?? null),
    ...(node.placement ? { placement: node.placement } : {}),
  };
}

function faviconForPresentation(
  presentation:
    | (Pick<FullPanel, "navigation"> & {
        snapshot?: Pick<PanelSnapshot, "source">;
      })
    | undefined
): PanelNavigationState["favicon"] | undefined {
  if (!presentation) return undefined;
  if (presentation.navigation?.favicon) return presentation.navigation.favicon;
  const source = presentation.snapshot?.source;
  if (!source) return undefined;
  if (!source.startsWith("browser:")) return undefined;
  const pageUrl = presentation.navigation?.url ?? source.slice("browser:".length);
  return pageUrl ? { pageUrl, updatedAt: 0 } : undefined;
}

function hasSameTreePresentation(current: FullPanel | undefined, next: FullPanel): boolean {
  const currentFavicon = faviconForPresentation(current);
  const nextFavicon = faviconForPresentation(next);
  return (
    current?.icon === next.icon &&
    current?.snapshot?.source === next.snapshot.source &&
    currentFavicon?.pageUrl === nextFavicon?.pageUrl &&
    currentFavicon?.updatedAt === nextFavicon?.updatedAt
  );
}

export function PanelTreeProvider({ children }: { children: ReactNode }) {
  const currentAccount = useCurrentAccountProfile();
  const selfUserId = currentAccount.profile?.userId ?? null;
  const [cacheVersion, rerender] = useState(0);
  const [treeLoadError, setTreeLoadError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localSelectedChildren, setLocalSelectedChildren] = useState<Map<string, string | null>>(
    () => new Map()
  );
  const [presentations, setPresentations] = useState<Map<string, FullPanel>>(() => new Map());
  const refreshingRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const presentationRevisionRef = useRef(0);
  const presentationRevisionByPanelRef = useRef(new Map<string, number>());
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

  const mergePresentations = useCallback((nextPresentations: FullPanel[]) => {
    if (nextPresentations.length === 0) return;
    setPresentations((current) => {
      let next: Map<string, FullPanel> | null = null;
      for (const presentation of nextPresentations) {
        // Tree presentation requires the durable source projection. A
        // selection-only update still belongs in localSelectedChildren below,
        // but must not erase or invalidate an existing visual projection.
        if (!presentation.snapshot) continue;
        if (hasSameTreePresentation(current.get(presentation.id), presentation)) continue;
        next ??= new Map(current);
        next.set(presentation.id, presentation);
      }
      return next ?? current;
    });
    setLocalSelectedChildren((current) => {
      let next: Map<string, string | null> | null = null;
      for (const presentation of nextPresentations) {
        const selectedChildId = presentation.selectedChildId ?? null;
        if (current.has(presentation.id) && current.get(presentation.id) === selectedChildId) {
          continue;
        }
        next ??= new Map(current);
        next.set(presentation.id, selectedChildId);
      }
      return next ?? current;
    });
  }, []);

  const hydratePresentations = useCallback(
    async (nodes: readonly PanelTreeNode[]) => {
      if (nodes.length === 0) return;
      mergePresentations(await panel.getPresentations(nodes.map((node) => node.slotId)));
    },
    [mergePresentations]
  );

  const reconcilePins = useCallback(async () => {
    const dispatchedAt = pinSeq.current;
    const ids = await panel.listPinnedPanelIds();
    if (pinSeq.current === dispatchedAt) setPinnedPanelIds(new Set(ids));
  }, [setPinnedPanelIds]);

  const refreshTreeGroups = useCallback(
    async (options: {
      groups: readonly PanelTreeGroup[];
      refreshRootGroups: boolean;
      reconcilePinState: boolean;
    }) => {
      const sequence = ++refreshSequenceRef.current;
      refreshingRef.current = true;
      setRefreshing(true);
      try {
        const rootPage = options.refreshRootGroups ? await cache.loadRootGroups(true) : null;
        const groups = new Map<string, PanelTreeGroup>();
        for (const group of options.groups) {
          groups.set(panelTreeGroupKey(group), group);
        }
        if (rootPage) {
          for (const owner of rootPage.groups) {
            const group = { kind: "roots" as const, ownerUserId: owner.ownerUserId };
            groups.set(panelTreeGroupKey(group), group);
          }
        }
        const loaded = await Promise.all(
          [...groups.values()].map((group) => cache.loadFirst(group))
        );
        await hydratePresentations(loaded.flatMap((group) => group.nodes));
        if (options.reconcilePinState) await reconcilePins();
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
    [cache, hydratePresentations, reconcilePins]
  );

  const refreshTree = useCallback(
    () =>
      refreshTreeGroups({
        groups: [],
        refreshRootGroups: true,
        reconcilePinState: true,
      }),
    [refreshTreeGroups]
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
        const rootGroupsChanged =
          event.reset || event.groups.some((group) => group.kind === "roots");
        const groups = rootGroupsChanged
          ? [...invalidatedGroups, ...event.groups.filter((group) => group.kind === "roots")]
          : invalidatedGroups;
        void refreshTreeGroups({
          groups,
          refreshRootGroups: rootGroupsChanged,
          reconcilePinState: event.reset || event.removedSlotIds.length > 0,
        });
      },
      [cache, refreshTreeGroups]
    )
  );
  useDirectShellEvent(
    "panel-presentation-changed",
    useCallback(
      (event) => {
        if (event.revision <= presentationRevisionRef.current) return;
        presentationRevisionRef.current = event.revision;
        for (const panelId of event.panelIds) {
          presentationRevisionByPanelRef.current.set(panelId, event.revision);
        }
        void panel
          .getPresentations(event.panelIds)
          .then((presentations) => {
            // A later event only supersedes the same panel. Discarding this
            // whole batch when an unrelated panel changes loses an edge and
            // can leave that panel's presentation stale until a focus switch.
            mergePresentations(
              presentations.filter(
                (presentation) =>
                  presentationRevisionByPanelRef.current.get(presentation.id) === event.revision
              )
            );
          })
          .catch(() => {});
      },
      [mergePresentations]
    )
  );

  const loadChildren = useCallback(
    async (panelId: string) => {
      const loaded = await cache.loadFirst({
        kind: "children",
        parentSlotId: panelId as PanelSlotId,
      });
      await hydratePresentations(loaded.nodes);
    },
    [cache, hydratePresentations]
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
      const loaded = await cache.loadMore(group);
      await hydratePresentations(loaded.nodes);
    },
    [cache, hydratePresentations]
  );
  const loadMoreRootGroups = useCallback(async () => {
    const groups = await cache.loadRootGroups(false);
    const loaded = await Promise.all(
      groups.groups.map((owner) => {
        const group = { kind: "roots" as const, ownerUserId: owner.ownerUserId };
        return cache.getGroup(group) ?? cache.loadFirst(group);
      })
    );
    await hydratePresentations(loaded.flatMap((group) => group.nodes));
  }, [cache, hydratePresentations]);
  const search = useCallback(
    (query: string, cursor?: string) =>
      cache.search({ query, ...(cursor ? { cursor } : {}), limit: 50 }),
    [cache]
  );

  const treeRevision = cache.getRevision();
  const rootGroups = cache.getRootGroups().groups;
  const orderedGroups = useMemo(() => {
    const groups = [...rootGroups];
    if (!selfUserId) return groups;
    return [
      ...groups.filter((group) => group.ownerUserId === selfUserId),
      ...groups.filter((group) => group.ownerUserId !== selfUserId),
    ];
  }, [rootGroups, selfUserId]);
  const ownerGroups = useMemo(
    () =>
      orderedGroups.map((owner) => {
        const group = { kind: "roots" as const, ownerUserId: owner.ownerUserId };
        const cached = cache.getGroup(group);
        return {
          owner: owner.ownerUserId ?? "",
          rootCount: owner.rootCount,
          rootLoadedCount: cached?.loadedCount ?? 0,
          rootsHaveMore: cached !== null && cached.nextCursor !== null,
          rootPanels: (cached?.nodes ?? []).map((node) =>
            nodeTree(node, cache, new Set(), localSelectedChildren, presentations)
          ),
        };
      }),
    [cache, cacheVersion, localSelectedChildren, orderedGroups, presentations, treeRevision]
  );
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
  const allRootPanels = useMemo(
    () => ownerGroups.flatMap((group) => group.rootPanels),
    [ownerGroups]
  );
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
    treeRevision,
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
    ...(node.icon ? { icon: node.icon } : {}),
    ...(node.source ? { source: node.source } : {}),
    ...(node.favicon ? { favicon: node.favicon } : {}),
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
  const nextRequestRef = useRef(0);
  const appliedRequestRef = useRef(0);
  const appliedHostViewRevisionRef = useRef(0);
  const applyPresentation = useCallback(
    (presentation: Awaited<ReturnType<typeof panel.getPresentation>>, request: number) => {
      if (!presentation || presentation.id !== panelId) return;
      // Event-driven and initial reads can overlap. Request start order is not
      // presentation order: an earlier request can finish its durable refresh
      // after a later one and therefore carry the newer native view. Order
      // primarily by the host's monotonic view revision, using request order
      // only to break ties between projections of the same native view.
      if (presentation.hostViewRevision < appliedHostViewRevisionRef.current) return;
      if (
        presentation.hostViewRevision === appliedHostViewRevisionRef.current &&
        request < appliedRequestRef.current
      )
        return;
      appliedHostViewRevisionRef.current = presentation.hostViewRevision;
      appliedRequestRef.current = request;
      const source = presentation.snapshot.source;
      setValue({
        id: presentation.id,
        title: presentation.title,
        ...(presentation.icon ? { icon: presentation.icon } : {}),
        contextId: presentation.snapshot.contextId,
        runtimeEntityId: presentation.runtimeEntityId,
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
  const refreshPresentation = useCallback(() => {
    if (!panelId) return;
    const request = ++nextRequestRef.current;
    void panel
      .getPresentation(panelId)
      .then((presentation) => applyPresentation(presentation, request))
      .catch(() => {});
  }, [applyPresentation, panelId]);
  useDirectShellEvent(
    "panel-presentation-changed",
    useCallback(
      (event) => {
        if (!panelId || !event.panelIds.includes(panelId)) return;
        refreshPresentation();
      },
      [panelId, refreshPresentation]
    )
  );
  useShellEvent(
    "panel-tree-invalidated",
    useCallback(
      (event) => {
        if (!panelId) return;
        if (!event.reset && !event.changedSlotIds.includes(panelId)) return;
        // The durable tree transition is the level-triggered lifecycle signal.
        // Refresh the addressed presentation even when a transient activation
        // or lease event raced ahead of local registry hydration.
        refreshPresentation();
      },
      [panelId, refreshPresentation]
    )
  );
  useEffect(() => {
    let cancelled = false;
    if (!panelId) {
      setValue(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const request = ++nextRequestRef.current;
    void panel
      .getPresentation(panelId)
      .then((presentation) => {
        if (!cancelled) applyPresentation(presentation, request);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyPresentation, panelId]);
  // A presentation belongs to exactly one durable slot. Keep an earlier
  // response cached while the next address loads, but never expose it under a
  // different panel id: consumers use readiness from this value to decide
  // which native WebContentsView may own the pane.
  const currentValue = value?.id === panelId ? value : null;
  return {
    panel: currentValue,
    loading: Boolean(panelId) && (loading || currentValue === null),
  };
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
      .then(async (path) => {
        if (cancelled) return;
        const nodes = path?.nodes.slice(0, -1) ?? [];
        const presentations = await panel.getPresentations(nodes.map((node) => node.slotId));
        const presentationsById = new Map(presentations.map((entry) => [entry.id, entry]));
        if (cancelled) return;
        setAncestors(
          nodes.map((node, index) => {
            const presentation = presentationsById.get(node.slotId);
            const source = presentation?.snapshot?.source ?? node.source;
            const favicon = faviconForPresentation(presentation);
            return {
              id: node.slotId,
              title: node.title,
              ...((presentation?.icon ?? node.icon)
                ? { icon: presentation?.icon ?? node.icon }
                : {}),
              ...(source ? { source } : {}),
              ...(favicon ? { favicon } : {}),
              depth: nodes.length - index,
            };
          })
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
