/**
 * PanelTreeItem -- Individual tree node in the panel drawer.
 *
 * Renders a single panel entry with:
 * - Indentation based on tree depth
 * - Panel title (truncated if too long)
 * - Expand/collapse chevron for panels with children
 * - Active panel highlight (soft accent fill + accent text, not a solid slab)
 * - Pin indicator
 * - Swipe-to-archive gesture (swipe left reveals "Archive" action)
 */

import React, { useCallback } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import {
  Gesture,
  GestureDetector,
  type PanGestureHandlerEventPayload,
} from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from "react-native-reanimated";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import type { ThemeColors } from "../state/themeAtoms";
import { radius, spacing, type } from "../design/tokens";
import { Archive, ChevronDown, ChevronRight, Pin } from "../design/icons";

function triggerHaptic() {
  try {
    ReactNativeHapticFeedback.trigger("impactMedium", {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    });
  } catch {
    // Haptics not available on this device
  }
}

const INDENT_PER_LEVEL = 14;
const ARCHIVE_THRESHOLD = -120;
const ITEM_HEIGHT = 46;

export interface FlatPanelItem {
  id: string;
  title: string;
  depth: number;
  childCount: number;
  isCollapsed: boolean;
}

interface PanelTreeItemProps {
  item: FlatPanelItem;
  isActive: boolean;
  isPinned?: boolean;
  colors: ThemeColors;
  onPress: (panelId: string) => void;
  onLongPress?: (panelId: string) => void;
  onToggleCollapse: (panelId: string, collapsed: boolean) => void;
  onArchive: (panelId: string) => void | Promise<void>;
}

export function PanelTreeItem({
  item,
  isActive,
  isPinned = false,
  colors,
  onPress,
  onLongPress,
  onToggleCollapse,
  onArchive,
}: PanelTreeItemProps) {
  const translateX = useSharedValue(0);
  const itemHeight = useSharedValue(ITEM_HEIGHT);
  const itemOpacity = useSharedValue(1);
  const hasPassedThreshold = useSharedValue(false);

  const handleArchive = useCallback(() => {
    void Promise.resolve(onArchive(item.id))
      .then(() => {
        itemHeight.value = withTiming(0, { duration: 250 });
        itemOpacity.value = withTiming(0, { duration: 200 });
      })
      .catch(() => {
        translateX.value = withTiming(0, { duration: 200 });
        itemHeight.value = withTiming(ITEM_HEIGHT, { duration: 200 });
        itemOpacity.value = withTiming(1, { duration: 200 });
      });
  }, [item.id, onArchive, itemHeight, itemOpacity, translateX]);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-5, 5])
    .onUpdate((event: PanGestureHandlerEventPayload) => {
      // Only allow swiping left (negative translateX)
      if (event.translationX < 0) {
        translateX.value = event.translationX;
      }
      // Trigger haptic when crossing the archive threshold
      if (event.translationX < ARCHIVE_THRESHOLD && !hasPassedThreshold.value) {
        hasPassedThreshold.value = true;
        runOnJS(triggerHaptic)();
      } else if (event.translationX >= ARCHIVE_THRESHOLD) {
        hasPassedThreshold.value = false;
      }
    })
    .onEnd((event: PanGestureHandlerEventPayload) => {
      hasPassedThreshold.value = false;
      if (event.translationX < ARCHIVE_THRESHOLD) {
        // Past threshold -- commit archive
        translateX.value = withTiming(-400, { duration: 200 });
        runOnJS(handleArchive)();
      } else {
        // Snap back
        translateX.value = withTiming(0, { duration: 200 });
      }
    });

  const rowAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const archiveBackgroundStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [-ARCHIVE_THRESHOLD, 0], [1, 0], Extrapolation.CLAMP),
  }));

  const containerAnimatedStyle = useAnimatedStyle(() => ({
    height: itemHeight.value,
    opacity: itemOpacity.value,
  }));

  const handlePress = useCallback(() => {
    onPress(item.id);
  }, [item.id, onPress]);

  const handleChevronPress = useCallback(() => {
    onToggleCollapse(item.id, !item.isCollapsed);
  }, [item.id, item.isCollapsed, onToggleCollapse]);

  const titleColor = isActive ? colors.primary : colors.text;
  const mutedColor = isActive ? colors.primary : colors.textTertiary;

  return (
    <Animated.View style={[styles.outerContainer, containerAnimatedStyle]}>
      {/* Archive background revealed on swipe */}
      <Animated.View
        style={[
          styles.archiveBackground,
          { backgroundColor: colors.danger },
          archiveBackgroundStyle,
        ]}
      >
        <Archive size={16} color="#ffffff" />
        <Text style={styles.archiveText}>Archive</Text>
      </Animated.View>

      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            styles.row,
            {
              backgroundColor: isActive ? colors.accentSoft : "transparent",
              paddingLeft: spacing.sm + item.depth * INDENT_PER_LEVEL,
            },
            rowAnimatedStyle,
          ]}
        >
          {/* Expand/collapse chevron */}
          {item.childCount > 0 ? (
            <Pressable
              onPress={handleChevronPress}
              style={styles.chevronButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={item.isCollapsed ? "Expand children" : "Collapse children"}
            >
              {item.isCollapsed ? (
                <ChevronRight size={15} color={mutedColor} />
              ) : (
                <ChevronDown size={15} color={mutedColor} />
              )}
            </Pressable>
          ) : (
            <View style={styles.chevronSpacer} />
          )}

          {/* Panel title */}
          <Pressable
            onPress={handlePress}
            onLongPress={() => onLongPress?.(item.id)}
            style={styles.titlePressable}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}. Long-press for actions.`}
          >
            <Text
              style={[
                type.body,
                isActive && type.bodyStrong,
                styles.title,
                { color: titleColor },
              ]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {item.title}
            </Text>
          </Pressable>

          {/* Pin indicator — quiet glyph, only when pinned */}
          {isPinned && (
            <View accessibilityLabel="Pinned" style={styles.pinIndicator}>
              <Pin size={13} color={mutedColor} />
            </View>
          )}

          {/* Child count badge */}
          {item.childCount > 0 && (
            <Text style={[type.micro, styles.childCount, { color: mutedColor }]}>
              {item.childCount}
            </Text>
          )}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    overflow: "hidden",
    marginVertical: 1,
  },
  archiveBackground: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.sm,
    paddingRight: spacing.xl,
    borderRadius: radius.md,
  },
  archiveText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: ITEM_HEIGHT,
    borderRadius: radius.md,
    paddingRight: spacing.md,
  },
  chevronButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  chevronSpacer: {
    width: 24,
  },
  titlePressable: {
    flex: 1,
    justifyContent: "center",
    marginLeft: spacing.xs,
    alignSelf: "stretch",
  },
  title: {
    lineHeight: undefined,
  },
  childCount: {
    marginLeft: spacing.sm,
  },
  pinIndicator: {
    marginLeft: spacing.xs,
    flexShrink: 0,
  },
});
