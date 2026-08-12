/**
 * PanelDrawer -- Drawer content showing the panel tree as a FlatList.
 *
 * Structure:
 *   [workspace header: name + connection status]
 *   [search field -- filters panels by title]
 *   [Pinned section]
 *   [owner-grouped panel forest]
 *   [footer: Settings]
 *
 * Renders the canonical owner-grouped panel forest with explicit owner bands.
 * Long-press opens the themed action sheet with per-command descriptions.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  Pressable,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useDrawerStatus } from "@react-navigation/drawer";
import { useAtomValue, useSetAtom } from "jotai";
import { panelTreeRevisionAtom, shellClientAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { activePanelIdAtom, pinnedPanelIdsAtom } from "../state/navigationAtoms";
import { pushToastAtom } from "../state/toastAtoms";
import { showActionSheetAtom, type ActionSheetItem } from "../state/actionSheetAtoms";
import { savePinnedPanelIds } from "../shellCore/pinnedPanels";
import { PanelTreeItem } from "./PanelTreeItem";
import { VibestudioLogo } from "./VibestudioLogo";
import { isBrowserPanelSource } from "@vibestudio/shared/panelChrome";
import { type PanelCommandId } from "@vibestudio/shared/panelCommands";
import { copyToClipboard, openExternalUrl } from "../services/nativeCapabilities";
import {
  buildMobilePanelForestRows,
  presentMobilePanelRow,
  type MobilePanelTreeGroup,
  type MobilePanelTreeNode,
  type MobilePanelForestRow,
} from "../shellCore/panelForest";
import { useVisibleAccountProfiles } from "../hooks/useVisibleAccountProfiles";
import { hairline, radius, spacing, type } from "../design/tokens";
import {
  Archive,
  Copy,
  CopyPlus,
  ExternalLink,
  Pin,
  PinOff,
  Search,
  Settings,
  X,
  type IconComponent,
} from "../design/icons";

interface PanelDrawerProps {
  /** Called when a panel is selected; parent should close the drawer */
  onSelectPanel: (panelId: string) => void;
}

/** Icons + short explanations for the shared panel commands (discoverability). */
const COMMAND_PRESENTATION: Partial<
  Record<PanelCommandId, { icon: IconComponent; description: string }>
> = {
  "copy-address": { icon: Copy, description: "Copy this panel's address" },
  "open-external": { icon: ExternalLink, description: "Open in your device browser" },
  duplicate: { icon: CopyPlus, description: "Open another copy as a new root panel" },
  "toggle-pin": { icon: Pin, description: "Pinned panels stay loaded in the background" },
  archive: { icon: Archive, description: "Remove from the tree (recoverable on desktop)" },
};

function findPanelById(panels: MobilePanelTreeNode[], panelId: string): MobilePanelTreeNode | null {
  for (const panel of panels) {
    if (panel.id === panelId) return panel;
    const child = findPanelById(panel.children, panelId);
    if (child) return child;
  }
  return null;
}

export function PanelDrawer({ onSelectPanel }: PanelDrawerProps) {
  const pushToast = useSetAtom(pushToastAtom);
  const showActionSheet = useSetAtom(showActionSheetAtom);
  const shellClient = useAtomValue(shellClientAtom);
  const panelTreeRevision = useAtomValue(panelTreeRevisionAtom);
  const setPanelTreeRevision = useSetAtom(panelTreeRevisionAtom);
  const colors = useAtomValue(themeColorsAtom);
  const connectionStatus = useAtomValue(connectionStatusAtom);
  const activePanelId = useAtomValue(activePanelIdAtom);
  const pinnedPanelIds = useAtomValue(pinnedPanelIdsAtom);
  const setPinnedPanelIds = useSetAtom(pinnedPanelIdsAtom);
  const navigation = useNavigation();
  const drawerVisible = useDrawerStatus() === "open";
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MobilePanelTreeNode[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [loadingIndexPage, setLoadingIndexPage] = useState(false);
  const [loadingGroupKey, setLoadingGroupKey] = useState<string | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(
    () => shellClient?.panels.treeCache.subscribe(() => setCacheVersion((value) => value + 1)),
    [shellClient]
  );
  const groups = useMemo<MobilePanelTreeGroup[]>(() => {
    if (!shellClient) return [];
    const cache = shellClient.panels.treeCache;
    const branch = (
      node: import("@vibestudio/shared/panel/treeIndex").PanelTreeNode
    ): MobilePanelTreeNode => {
      const children = cache.getGroup({ kind: "children", parentSlotId: node.slotId })?.nodes ?? [];
      const childGroup = cache.getGroup({ kind: "children", parentSlotId: node.slotId });
      return {
        id: node.slotId,
        title: node.title,
        parentId: node.parentSlotId,
        owner: node.ownerUserId,
        icon: node.icon,
        source: node.source,
        kind: node.kind,
        childCount: node.childCount,
        childrenLoadedCount: childGroup?.loadedCount ?? 0,
        childrenHaveMore: childGroup?.nextCursor !== null && childGroup !== null,
        children: children.map(branch),
      };
    };
    return cache.getRootGroups().groups.map((group) => ({
      owner: group.ownerUserId ?? "",
      rootCount: group.rootCount,
      rootLoadedCount:
        cache.getGroup({ kind: "roots", ownerUserId: group.ownerUserId })?.loadedCount ?? 0,
      rootsHaveMore:
        cache.getGroup({ kind: "roots", ownerUserId: group.ownerUserId })?.nextCursor !== null &&
        cache.getGroup({ kind: "roots", ownerUserId: group.ownerUserId }) !== null,
      rootPanels: (
        cache.getGroup({ kind: "roots", ownerUserId: group.ownerUserId })?.nodes ?? []
      ).map(branch),
    }));
  }, [cacheVersion, panelTreeRevision, shellClient]);
  useEffect(() => {
    if (!shellClient) return;
    const retained: import("@vibestudio/shared/panel/treeIndex").PanelTreeGroup[] = groups.map(
      (group) => ({
        kind: "roots",
        ownerUserId: group.owner || null,
      })
    );
    const visit = (node: MobilePanelTreeNode) => {
      if (node.childCount > 0 && node.children.length > 0) {
        retained.push({ kind: "children", parentSlotId: node.id });
        node.children.forEach(visit);
      }
    };
    groups.forEach((group) => group.rootPanels.forEach(visit));
    shellClient.panels.treeCache.retainGroups(retained);
  }, [groups, shellClient]);
  const panelRoots = useMemo(() => groups.flatMap((group) => group.rootPanels), [groups]);
  const ownerIds = useMemo(() => groups.map((group) => group.owner).filter(Boolean), [groups]);
  const ownerProfiles = useVisibleAccountProfiles(shellClient, ownerIds, drawerVisible);

  // Build the collapsed set from the shell client's registry
  const collapsedIds = useMemo(() => {
    if (!shellClient) return new Set<string>();
    return new Set(shellClient.panels.getCollapsedIds());
  }, [shellClient, panelTreeRevision]);

  const forestRows = useMemo(
    () =>
      buildMobilePanelForestRows(
        groups,
        collapsedIds,
        shellClient?.currentUserId ?? null,
        ownerProfiles
      ),
    [collapsedIds, groups, ownerProfiles, shellClient]
  );

  const trimmedQuery = query.trim().toLowerCase();
  useEffect(() => {
    if (!shellClient || !trimmedQuery) {
      setSearchResults([]);
      setSearchCursor(null);
      return;
    }
    setSearchResults([]);
    setSearchCursor(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      void shellClient.panels.treeCache
        .search({ query: trimmedQuery, limit: 100 })
        .then((results) => {
          if (!cancelled) {
            setSearchResults(
              results.hits.map(({ node, ancestors, ancestorsTruncated }) => ({
                id: node.slotId,
                title:
                  ancestors.length > 0
                    ? `${ancestorsTruncated ? "… › " : ""}${ancestors
                        .map((ancestor) => ancestor.title)
                        .join(" › ")} › ${node.title}`
                    : node.title,
                parentId: node.parentSlotId,
                owner: node.ownerUserId,
                icon: node.icon,
                source: node.source,
                kind: node.kind,
                childCount: node.childCount,
                children: [],
              }))
            );
            setSearchCursor(results.nextCursor);
          }
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [panelTreeRevision, shellClient, trimmedQuery]);

  const handleLoadMoreIndex = useCallback(async () => {
    if (!shellClient || loadingIndexPage) return;
    setLoadingIndexPage(true);
    try {
      if (trimmedQuery && searchCursor) {
        const results = await shellClient.panels.treeCache.search({
          query: trimmedQuery,
          cursor: searchCursor,
          limit: 100,
        });
        const seen = new Set(searchResults.map((panel) => panel.id));
        const additions = results.hits
          .filter(({ node }) => !seen.has(node.slotId))
          .map(({ node, ancestors, ancestorsTruncated }) => ({
            id: node.slotId,
            title:
              ancestors.length > 0
                ? `${ancestorsTruncated ? "… › " : ""}${ancestors
                    .map((ancestor) => ancestor.title)
                    .join(" › ")} › ${node.title}`
                : node.title,
            parentId: node.parentSlotId,
            owner: node.ownerUserId,
            icon: node.icon,
            source: node.source,
            kind: node.kind,
            childCount: node.childCount,
            children: [],
          }))
          .slice(0, Math.max(0, 500 - searchResults.length));
        const next = [...searchResults, ...additions];
        setSearchResults(next);
        setSearchCursor(next.length >= 500 ? null : results.nextCursor);
      } else if (!trimmedQuery && shellClient.panels.treeCache.getRootGroups().nextCursor) {
        await shellClient.panels.treeCache.loadRootGroups(false);
      }
    } finally {
      setLoadingIndexPage(false);
    }
  }, [loadingIndexPage, searchCursor, searchResults, shellClient, trimmedQuery]);

  // Search collapses the hierarchy into a flat match list; otherwise prepend a
  // "Pinned" band above the owner-grouped forest.
  const flatItems = useMemo<MobilePanelForestRow[]>(() => {
    if (trimmedQuery) {
      return searchResults.map((panel) => ({
        kind: "panel" as const,
        panel,
        depth: 0,
        isCollapsed: true,
      }));
    }
    if (pinnedPanelIds.size === 0) return forestRows;
    const pinnedRows = forestRows.filter(
      (row) => row.kind === "panel" && pinnedPanelIds.has(row.panel.id)
    );
    if (pinnedRows.length === 0) return forestRows;
    return [
      { kind: "owner", owner: "__pinned__", label: "Pinned", color: colors.primary },
      ...pinnedRows.map((row) => ({ ...row, depth: 0, isCollapsed: true })),
      ...forestRows,
    ] as MobilePanelForestRow[];
  }, [colors.primary, forestRows, pinnedPanelIds, searchResults, trimmedQuery]);

  const handleLoadMore = useCallback(
    async (row: Extract<MobilePanelForestRow, { kind: "load-more" }>) => {
      if (!shellClient || loadingGroupKey) return;
      setLoadingGroupKey(row.groupKey);
      try {
        await shellClient.panels.treeCache.loadMore(
          row.parentSlotId === null
            ? { kind: "roots", ownerUserId: row.ownerUserId ?? null }
            : { kind: "children", parentSlotId: row.parentSlotId as never }
        );
      } catch (error) {
        pushToast({
          title: "Could not load older panels",
          message: error instanceof Error ? error.message : "Try again.",
          tone: "danger",
        });
      } finally {
        setLoadingGroupKey(null);
      }
    },
    [loadingGroupKey, pushToast, shellClient]
  );

  const handleRefresh = useCallback(async () => {
    if (!shellClient) return;
    setRefreshing(true);
    try {
      // Re-init forces a fresh fetch from the server
      await shellClient.panels.refresh();
      setPanelTreeRevision(shellClient.panels.treeCache.getRevision());
    } catch (error) {
      pushToast({
        title: "Could not refresh panels",
        message: error instanceof Error ? error.message : "Try again.",
        tone: "danger",
      });
    } finally {
      setRefreshing(false);
    }
  }, [pushToast, shellClient, setPanelTreeRevision]);

  const handlePanelPress = useCallback(
    (panelId: string) => {
      onSelectPanel(panelId);
    },
    [onSelectPanel]
  );

  const handleToggleCollapse = useCallback(
    (panelId: string, collapsed: boolean) => {
      if (!shellClient) return;
      void shellClient.panels.setCollapsed(panelId, collapsed);
      if (!collapsed) {
        void shellClient.panels.treeCache.loadFirst({
          kind: "children",
          parentSlotId: panelId as never,
        });
      }
    },
    [shellClient]
  );

  const handleArchive = useCallback(
    async (panelId: string) => {
      if (!shellClient) return;
      try {
        await shellClient.panels.archive(panelId);
        await shellClient.panels.refresh();
      } catch (error) {
        pushToast({
          title: "Could not archive panel",
          message: error instanceof Error ? error.message : "Try again.",
          tone: "danger",
        });
        throw error;
      }
    },
    [pushToast, shellClient]
  );

  const togglePanelPin = useCallback(
    (panelId: string) => {
      setPinnedPanelIds((prev) => {
        const next = new Set(prev);
        if (next.has(panelId)) next.delete(panelId);
        else next.add(panelId);
        const workspaceId = shellClient?.workspaceId;
        if (workspaceId) void savePinnedPanelIds(workspaceId, [...next]);
        return next;
      });
    },
    [setPinnedPanelIds, shellClient]
  );

  const performPanelCommand = useCallback(
    (command: PanelCommandId, panelId: string) => {
      if (!shellClient) return;

      switch (command) {
        case "toggle-pin":
          togglePanelPin(panelId);
          return;
        case "copy-address":
          void shellClient.panels.observe(panelId).then((observation) => {
            copyToClipboard(observation.source);
            pushToast({
              title: "Address copied",
              message: observation.source,
              tone: "success",
            });
          });
          return;
        case "open-external":
          void shellClient.panels.observe(panelId).then((observation) => {
            if (!isBrowserPanelSource(observation.source)) return;
            const url = observation.source.slice("browser:".length);
            if (/^https?:\/\//i.test(url)) void openExternalUrl(url);
          });
          return;
        case "duplicate":
          void shellClient.panels.observe(panelId).then((observation) => {
            const create = isBrowserPanelSource(observation.source)
              ? shellClient.panels.createBrowserUrlPanel(
                  null,
                  observation.source.slice("browser:".length),
                  { focus: true }
                )
              : shellClient.panels.createRootPanel(observation.source);
            return create.then((result) => onSelectPanel(result.id));
          });
          return;
        case "archive":
          void shellClient.panels
            .archive(panelId)
            .then(() => shellClient.panels.refresh())
            .catch((error: unknown) =>
              pushToast({
                title: "Could not archive panel",
                message: error instanceof Error ? error.message : "Try again.",
                tone: "danger",
              })
            );
          return;
        default:
          onSelectPanel(panelId);
      }
    },
    [onSelectPanel, pushToast, shellClient, togglePanelPin]
  );

  const handlePanelLongPress = useCallback(
    (panelId: string) => {
      const panel = findPanelById(panelRoots, panelId);
      if (!panel) return;
      const isPinned = pinnedPanelIds.has(panelId);
      const commands: Array<{ id: PanelCommandId; label: string }> = [
        { id: "copy-address", label: "Copy address" },
        { id: "open-external", label: "Open externally" },
        { id: "duplicate", label: "Duplicate" },
        { id: "toggle-pin", label: isPinned ? "Unpin" : "Pin" },
        { id: "archive", label: "Archive" },
      ];
      const items: ActionSheetItem[] = commands.map((command) => {
        const presentation = COMMAND_PRESENTATION[command.id];
        return {
          id: command.id,
          label: command.label,
          description: presentation?.description,
          icon: command.id === "toggle-pin" && isPinned ? PinOff : presentation?.icon,
          tone: command.id === "archive" ? "danger" : "default",
        };
      });
      showActionSheet({
        title: panel.title,
        items,
        onSelect: (id) => performPanelCommand(id as PanelCommandId, panelId),
      });
    },
    [panelRoots, performPanelCommand, pinnedPanelIds, showActionSheet]
  );

  const handleSettingsPress = useCallback(() => {
    navigation.getParent()?.navigate("Settings" as never);
  }, [navigation]);

  const resolveBrowserFavicon = useCallback(
    (url: string) => shellClient?.panels.getPageFaviconDataUrl(url) ?? Promise.resolve(null),
    [shellClient]
  );

  const renderItem = useCallback(
    ({ item }: { item: MobilePanelForestRow }) => {
      if (item.kind === "owner") {
        return (
          <View style={styles.ownerHeader} accessibilityRole="header">
            <View
              style={[styles.ownerDot, { backgroundColor: item.color ?? colors.textTertiary }]}
            />
            <Text style={[type.section, styles.ownerLabel, { color: colors.textTertiary }]}>
              {item.label}
            </Text>
          </View>
        );
      }
      if (item.kind === "load-more") {
        return (
          <Pressable
            onPress={() => void handleLoadMore(item)}
            disabled={loadingGroupKey !== null}
            accessibilityRole="button"
            accessibilityLabel={`Load older panels (${item.remaining} remaining)`}
            style={[styles.loadMore, { paddingLeft: spacing.lg + item.depth * 18 }]}
          >
            <Text style={[type.caption, { color: colors.primary }]}>
              {loadingGroupKey === item.groupKey
                ? "Loading…"
                : `Load older panels (${item.remaining})`}
            </Text>
          </Pressable>
        );
      }
      const panelItem = presentMobilePanelRow(item, Boolean(trimmedQuery));
      return (
        <PanelTreeItem
          item={panelItem}
          isActive={panelItem.id === activePanelId}
          isPinned={pinnedPanelIds.has(panelItem.id)}
          colors={colors}
          serverUrl={shellClient?.serverUrl ?? ""}
          resolveBrowserFavicon={resolveBrowserFavicon}
          onPress={handlePanelPress}
          onLongPress={handlePanelLongPress}
          onToggleCollapse={handleToggleCollapse}
          onArchive={handleArchive}
        />
      );
    },
    [
      activePanelId,
      pinnedPanelIds,
      colors,
      handlePanelPress,
      handlePanelLongPress,
      handleToggleCollapse,
      handleArchive,
      handleLoadMore,
      loadingGroupKey,
      resolveBrowserFavicon,
      trimmedQuery,
    ]
  );

  const keyExtractor = useCallback(
    (item: MobilePanelForestRow, index: number) =>
      item.kind === "owner"
        ? `owner:${item.owner || "workspace"}`
        : item.kind === "load-more"
          ? `more:${item.groupKey}`
          : `panel:${item.panel.id}:${index}`,
    []
  );

  const statusColor =
    connectionStatus === "connected"
      ? colors.statusConnected
      : connectionStatus === "connecting"
        ? colors.statusConnecting
        : colors.statusDisconnected;
  const statusLabel =
    connectionStatus === "connected"
      ? "Connected"
      : connectionStatus === "connecting"
        ? "Connecting…"
        : "Disconnected";

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}
    >
      <View style={styles.header}>
        <VibestudioLogo size={26} variant="symbol" />
        <View style={styles.headerCopy}>
          <Text style={[type.heading, { color: colors.text }]} numberOfLines={1}>
            {shellClient?.workspaceId ?? "Vibestudio"}
          </Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[type.micro, { color: colors.textTertiary }]}>{statusLabel}</Text>
          </View>
        </View>
      </View>

      <View
        style={[
          styles.searchWrap,
          { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
        ]}
      >
        <Search size={15} color={colors.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search panels"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search panels"
          style={[styles.searchInput, { color: colors.text }]}
        />
        {query.length > 0 ? (
          <Pressable
            onPress={() => setQuery("")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <X size={15} color={colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>

      {flatItems.length === 0 ? (
        <View style={styles.emptyContainer}>
          <VibestudioLogo size={64} variant="symbol" style={styles.emptyLogo} />
          <Text style={[type.bodyStrong, styles.emptyTitle, { color: colors.text }]}>
            {trimmedQuery ? "No matching panels" : "No panels open yet"}
          </Text>
          <Text style={[type.caption, styles.emptyText, { color: colors.textSecondary }]}>
            {trimmedQuery
              ? "Try a different search, or clear it to see the full tree."
              : "Tap + to open New Panel, or tap the address pill and enter a website or panel source."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={flatItems}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            (
              trimmedQuery
                ? searchCursor !== null
                : Boolean(shellClient?.panels.treeCache.getRootGroups().nextCursor)
            ) ? (
              <Pressable
                onPress={() => void handleLoadMoreIndex()}
                disabled={loadingIndexPage}
                style={styles.loadMore}
                accessibilityRole="button"
              >
                <Text style={[type.caption, { color: colors.primary }]}>
                  {loadingIndexPage
                    ? "Loading…"
                    : trimmedQuery
                      ? "Load more matches"
                      : "Load more panel owners"}
                </Text>
              </Pressable>
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.textSecondary}
            />
          }
        />
      )}

      <View
        style={[
          styles.footer,
          {
            borderTopColor: colors.borderSubtle,
            paddingBottom: Math.max(insets.bottom, spacing.md),
          },
        ]}
      >
        <Pressable
          onPress={handleSettingsPress}
          style={({ pressed }) => [
            styles.footerButton,
            pressed && { backgroundColor: colors.surfaceSunken },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Open settings"
        >
          <Settings size={18} color={colors.textSecondary} />
          <Text style={[type.bodyStrong, { color: colors.textSecondary }]}>Settings</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: 1,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    borderWidth: hairline,
    paddingHorizontal: spacing.md,
    height: 38,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
  },
  list: {
    flex: 1,
  },
  loadMore: {
    minHeight: 42,
    justifyContent: "center",
    paddingRight: spacing.lg,
  },
  listContent: {
    padding: spacing.sm,
  },
  ownerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 34,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  ownerDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  ownerLabel: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xxl,
  },
  emptyLogo: {
    marginBottom: spacing.lg,
    opacity: 0.9,
  },
  emptyTitle: {
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  emptyText: {
    textAlign: "center",
  },
  footer: {
    borderTopWidth: hairline,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  footerButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 44,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
});
