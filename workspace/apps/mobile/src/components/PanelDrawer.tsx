/**
 * PanelDrawer -- Drawer content showing the panel tree as a FlatList.
 *
 * Renders the canonical owner-grouped panel forest with explicit owner bands.
 *
 * Features:
 * - Flattened tree with collapse/expand
 * - Pull-to-refresh (re-reads tree from local registry)
 * - Tapping an item selects that panel and closes the drawer
 * - Swipe-to-archive on individual items
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  Pressable,
  Alert,
  ActionSheetIOS,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useAtomValue, useSetAtom } from "jotai";
import { panelForestAtom, shellClientAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import { activePanelIdAtom, pinnedPanelIdsAtom } from "../state/navigationAtoms";
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

interface PanelDrawerProps {
  /** Called when a panel is selected; parent should close the drawer */
  onSelectPanel: (panelId: string) => void;
}

function findPanelById(panels: Panel[], panelId: string): Panel | null {
  for (const panel of panels) {
    if (panel.id === panelId) return panel;
    const child = findPanelById(panel.children, panelId);
    if (child) return child;
  }
  return null;
}

export function PanelDrawer({ onSelectPanel }: PanelDrawerProps) {
  const shellClient = useAtomValue(shellClientAtom);
  const panelForest = useAtomValue(panelForestAtom);
  const setPanelForest = useSetAtom(panelForestAtom);
  const colors = useAtomValue(themeColorsAtom);
  const activePanelId = useAtomValue(activePanelIdAtom);
  const pinnedPanelIds = useAtomValue(pinnedPanelIdsAtom);
  const setPinnedPanelIds = useSetAtom(pinnedPanelIdsAtom);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
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

  const flatItems = useMemo(
    () =>
      buildMobilePanelForestRows(
        panelForest.forest,
        collapsedIds,
        shellClient?.currentUserId ?? null,
        ownerProfiles
      ),
    [collapsedIds, ownerProfiles, panelForest, shellClient]
  );

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
        .catch(() => {});
    },
    [shellClient]
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
    [onSelectPanel, panelRoots, shellClient, togglePanelPin]
  );

  const handlePanelLongPress = useCallback(
    (panelId: string) => {
      const panel = findPanelById(panelRoots, panelId);
      if (!panel) return;
      const commands = getAvailablePanelCommands(
        { chrome: buildPanelChromeState({ panel }), isPinned: pinnedPanelIds.has(panelId) },
        ["copy-address", "open-external", "duplicate", "toggle-pin", "archive"]
      );
      const labels = commands.map((command) => command.label);
      if (Platform.OS === "ios") {
        const destructiveIndex = commands.findIndex((command) => command.id === "archive");
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [...labels, "Cancel"],
            cancelButtonIndex: labels.length,
            destructiveButtonIndex: destructiveIndex >= 0 ? destructiveIndex : undefined,
          },
          (buttonIndex) => {
            const command = commands[buttonIndex];
            if (command) performPanelCommand(command.id, panelId);
          }
        );
        return;
      }
      Alert.alert(panel.title, undefined, [
        ...commands.map((command) => ({
          text: command.label,
          onPress: () => performPanelCommand(command.id, panelId),
          style: command.id === "archive" ? ("destructive" as const) : ("default" as const),
        })),
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [panelRoots, performPanelCommand, pinnedPanelIds]
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
              style={[styles.ownerDot, { backgroundColor: item.color ?? colors.textSecondary }]}
            />
            <Text style={[styles.ownerLabel, { color: colors.textSecondary }]}>{item.label}</Text>
          </View>
        );
      }
      const panelItem: FlatPanelItem = {
        id: item.panel.id,
        title: item.panel.title,
        depth: item.depth,
        childCount: item.panel.children.length,
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
    ]
  );

  const keyExtractor = useCallback(
    (item: MobilePanelForestRow) =>
      item.kind === "owner" ? `owner:${item.owner || "workspace"}` : `panel:${item.panel.id}`,
    []
  );

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}
    >
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Panels</Text>
      </View>

      {flatItems.length === 0 ? (
        <View style={styles.emptyContainer}>
          <VibestudioLogo size={72} variant="mark" style={styles.emptyLogo} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No panels open yet</Text>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Tap the address bar at the top of the screen and enter a URL or panel source to open
            your first panel.
          </Text>
        </View>
      ) : (
        <FlatList
          data={flatItems}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          style={{ flex: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.textSecondary}
            />
          }
        />
      )}

      <View style={[styles.footer, { borderTopColor: colors.border }]}>
        <Pressable onPress={handleSettingsPress} style={styles.footerButton} hitSlop={8}>
          <Text style={[styles.footerIcon, { color: colors.textSecondary }]}>{"\u2699"}</Text>
          <Text style={[styles.footerText, { color: colors.textSecondary }]}>Settings</Text>
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
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
  },
  listContent: {
    padding: 8,
  },
  ownerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 4,
  },
  ownerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  ownerLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  emptyLogo: {
    marginBottom: 18,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  footer: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  footerButton: {
    flexDirection: "row",
    alignItems: "center",
  },
  footerIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  footerText: {
    fontSize: 15,
  },
});
