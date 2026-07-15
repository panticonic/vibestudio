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
import { useAtomValue, useSetAtom } from "jotai";
import { panelForestAtom, shellClientAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { activePanelIdAtom, pinnedPanelIdsAtom } from "../state/navigationAtoms";
import { pushToastAtom } from "../state/toastAtoms";
import { showActionSheetAtom, type ActionSheetItem } from "../state/actionSheetAtoms";
import { savePinnedPanelIds } from "../shellCore/pinnedPanels";
import { PanelTreeItem, type FlatPanelItem } from "./PanelTreeItem";
import { VibestudioLogo } from "./VibestudioLogo";
import type { Panel } from "@vibestudio/shared/types";
import { buildPanelChromeState, isBrowserPanelSource } from "@vibestudio/shared/panelChrome";
import { getAvailablePanelCommands, type PanelCommandId } from "@vibestudio/shared/panelCommands";
import { getCurrentSnapshot } from "@vibestudio/shared/panel/accessors";
import { copyToClipboard, openExternalUrl } from "../services/nativeCapabilities";
import {
  buildMobilePanelForestRows,
  mobilePanelRoots,
  type MobileOwnerProfile,
  type MobilePanelForestRow,
} from "../shellCore/panelForest";
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

function findPanelById(panels: Panel[], panelId: string): Panel | null {
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
  const panelForest = useAtomValue(panelForestAtom);
  const setPanelForest = useSetAtom(panelForestAtom);
  const colors = useAtomValue(themeColorsAtom);
  const connectionStatus = useAtomValue(connectionStatusAtom);
  const activePanelId = useAtomValue(activePanelIdAtom);
  const pinnedPanelIds = useAtomValue(pinnedPanelIdsAtom);
  const setPinnedPanelIds = useSetAtom(pinnedPanelIdsAtom);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [ownerProfiles, setOwnerProfiles] = useState<Map<string, MobileOwnerProfile>>(new Map());

  const panelRoots = useMemo(() => mobilePanelRoots(panelForest.forest), [panelForest]);
  const ownerIds = useMemo(
    () => panelForest.forest.map((group) => group.owner).filter(Boolean),
    [panelForest]
  );
  useEffect(() => {
    if (!shellClient) {
      setOwnerProfiles(new Map());
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const profiles = await shellClient.resolveAccountProfiles(ownerIds);
        if (!cancelled) setOwnerProfiles(new Map(Object.entries(profiles)));
      } catch {
        // Keep the last successful labels during a transient reconnect.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ownerIds, shellClient]);

  // Build the collapsed set from the shell client's registry
  const collapsedIds = useMemo(() => {
    if (!shellClient) return new Set<string>();
    return new Set(shellClient.panels.getCollapsedIds());
  }, [shellClient, panelForest]);

  const forestRows = useMemo(
    () =>
      buildMobilePanelForestRows(
        panelForest.forest,
        collapsedIds,
        shellClient?.currentUserId ?? null,
        ownerProfiles
      ),
    [collapsedIds, ownerProfiles, panelForest, shellClient]
  );

  const trimmedQuery = query.trim().toLowerCase();

  // Search collapses the hierarchy into a flat match list; otherwise prepend a
  // "Pinned" band above the owner-grouped forest.
  const flatItems = useMemo<MobilePanelForestRow[]>(() => {
    if (trimmedQuery) {
      return forestRows.filter(
        (row) => row.kind === "panel" && row.panel.title.toLowerCase().includes(trimmedQuery)
      );
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
  }, [colors.primary, forestRows, pinnedPanelIds, trimmedQuery]);

  const handleRefresh = useCallback(async () => {
    if (!shellClient) return;
    setRefreshing(true);
    try {
      // Re-init forces a fresh fetch from the server
      await shellClient.panels.refresh();
      // Update the atom so the UI re-renders with the new tree
      setPanelForest(shellClient.panels.getTreeSnapshot());
    } catch {
      // Offline -- ignore
    }
    setRefreshing(false);
  }, [shellClient, setPanelForest]);

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
    },
    [shellClient]
  );

  const handleArchive = useCallback(
    (panelId: string) => {
      if (!shellClient) return;
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
      const panel = findPanelById(panelRoots, panelId);
      if (!panel) return;
      const snapshot = getCurrentSnapshot(panel);

      switch (command) {
        case "toggle-pin":
          togglePanelPin(panelId);
          return;
        case "copy-address":
          copyToClipboard(snapshot.source);
          pushToast({ title: "Address copied", message: snapshot.source, tone: "success" });
          return;
        case "open-external": {
          const url =
            snapshot.resolvedUrl ??
            (isBrowserPanelSource(snapshot.source)
              ? snapshot.source.slice("browser:".length)
              : null);
          if (url && /^https?:\/\//i.test(url)) void openExternalUrl(url);
          return;
        }
        case "duplicate":
          if (isBrowserPanelSource(snapshot.source)) {
            void shellClient.panels
              .createBrowserUrlPanel(null, snapshot.source.slice("browser:".length), {
                focus: true,
              })
              .then((result) => onSelectPanel(result.id));
          } else {
            void shellClient.panels
              .createRootPanel(snapshot.source)
              .then((result) => onSelectPanel(result.id));
          }
          return;
        case "archive":
          void shellClient.panels
            .archive(panelId)
            .then(() => shellClient.panels.refresh())
            .catch(() => {});
          return;
        default:
          onSelectPanel(panelId);
      }
    },
    [onSelectPanel, panelRoots, pushToast, shellClient, togglePanelPin]
  );

  const handlePanelLongPress = useCallback(
    (panelId: string) => {
      const panel = findPanelById(panelRoots, panelId);
      if (!panel) return;
      const isPinned = pinnedPanelIds.has(panelId);
      const commands = getAvailablePanelCommands(
        { chrome: buildPanelChromeState({ panel }), isPinned },
        ["copy-address", "open-external", "duplicate", "toggle-pin", "archive"]
      );
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
        subtitle: getCurrentSnapshot(panel).source,
        items,
        onSelect: (id) => performPanelCommand(id as PanelCommandId, panelId),
      });
    },
    [panelRoots, performPanelCommand, pinnedPanelIds, showActionSheet]
  );

  const handleSettingsPress = useCallback(() => {
    navigation.getParent()?.navigate("Settings" as never);
  }, [navigation]);

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
      const panelItem: FlatPanelItem = {
        id: item.panel.id,
        title: item.panel.title,
        depth: trimmedQuery ? 0 : item.depth,
        childCount: trimmedQuery ? 0 : item.panel.children.length,
        isCollapsed: item.isCollapsed,
      };
      return (
        <PanelTreeItem
          item={panelItem}
          isActive={panelItem.id === activePanelId}
          isPinned={pinnedPanelIds.has(panelItem.id)}
          colors={colors}
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
      trimmedQuery,
    ]
  );

  const keyExtractor = useCallback(
    (item: MobilePanelForestRow, index: number) =>
      item.kind === "owner"
        ? `owner:${item.owner || "workspace"}`
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
        <VibestudioLogo size={26} variant="mark" />
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
          <VibestudioLogo size={64} variant="mark" style={styles.emptyLogo} />
          <Text style={[type.bodyStrong, styles.emptyTitle, { color: colors.text }]}>
            {trimmedQuery ? "No matching panels" : "No panels open yet"}
          </Text>
          <Text style={[type.caption, styles.emptyText, { color: colors.textSecondary }]}>
            {trimmedQuery
              ? "Try a different search, or clear it to see the full tree."
              : "Tap + to choose a panel, or tap the address pill and enter a website or panel source."}
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
          { borderTopColor: colors.borderSubtle, paddingBottom: Math.max(insets.bottom, spacing.md) },
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
