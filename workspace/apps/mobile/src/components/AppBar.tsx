/**
 * AppBar -- Top chrome for the mobile workspace app.
 *
 * Layout (browse mode):
 *   [Menu]  [ address pill: title + host/meta caption ]  [⋯]  [+]
 *
 * The pill is the discoverability hub: tap to edit the address, long-press for
 * panel actions, and its caption line surfaces the source/URL + repo state
 * that used to hide behind the address toggle. Address mode swaps in an
 * edit row (back/forward/input/reload) plus autocomplete suggestions.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { StyleProp, TextStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue, useSetAtom } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";
import { shellClientAtom } from "../state/shellClientAtom";
import { showActionSheetAtom } from "../state/actionSheetAtoms";
import { pushToastAtom } from "../state/toastAtoms";
import {
  splitTextByMatchRanges,
  type AddressAutocompleteItem,
  type TextMatchRange,
} from "@vibestudio/shared/panelChrome";
import { hairline, radius, spacing, touchTarget, type } from "../design/tokens";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Clock3,
  Globe2,
  LayoutGrid,
  Menu,
  MoreHorizontal,
  PanelTop,
  Plus,
  RefreshCw,
  Search,
  Square,
  Workflow,
  X,
  type IconComponent,
} from "../design/icons";
import { IconButton } from "./ui/primitives";

interface AppBarProps {
  /** Title to display in the address pill */
  title: string;
  /** Called when the hamburger menu button is pressed */
  onMenuPress: () => void;
  /** Called after a new panel is created, with the new panel's ID */
  onPanelCreated?: (panelId: string) => void;
  addressBarVisible?: boolean;
  address?: string;
  isLoading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onToggleAddressBar?: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onStop?: () => void;
  onNavigateAddress?: (value: string) => void;
  addressSuggestions?: AddressAutocompleteItem[];
  onAddressQueryChange?: (value: string) => void;
  onSelectAddressSuggestion?: (item: AddressAutocompleteItem) => void;
  onShowActions?: () => void;
}

export function AppBar({
  title,
  onMenuPress,
  onPanelCreated,
  addressBarVisible = false,
  address = "",
  isLoading = false,
  canGoBack = false,
  canGoForward = false,
  onToggleAddressBar,
  onBack,
  onForward,
  onReload,
  onStop,
  onNavigateAddress,
  addressSuggestions = [],
  onAddressQueryChange,
  onSelectAddressSuggestion,
  onShowActions,
}: AppBarProps) {
  const insets = useSafeAreaInsets();
  const colors = useAtomValue(themeColorsAtom);
  const shellClient = useAtomValue(shellClientAtom);
  const showActionSheet = useSetAtom(showActionSheetAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const [addressValue, setAddressValue] = useState(address);
  const [addressFocused, setAddressFocused] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  const visibleSuggestions = useMemo(
    () => (addressFocused ? addressSuggestions.slice(0, 8) : []),
    [addressFocused, addressSuggestions]
  );

  useEffect(() => {
    setAddressValue(address);
  }, [address]);

  useEffect(() => {
    if (addressBarVisible) onAddressQueryChange?.(addressValue);
  }, [addressBarVisible, addressValue, onAddressQueryChange]);

  // Focus the input as soon as address mode opens.
  useEffect(() => {
    if (addressBarVisible) {
      const timer = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
    setAddressFocused(false);
    return undefined;
  }, [addressBarVisible]);

  const handleCreatePanel = useCallback(() => {
    if (!shellClient) return;
    const createPanel = async (kind: "new" | "browser") => {
      try {
        const result = await shellClient.panels.createAboutPanel(kind);
        onPanelCreated?.(result.id);
      } catch (error) {
        pushToast({
          title: "Panel creation failed",
          message: error instanceof Error ? error.message : "Could not create panel.",
          tone: "danger",
        });
      }
    };
    showActionSheet({
      title: "New panel",
      items: [
        {
          id: "new",
          label: "New panel",
          description: "Pick an app or workspace unit to open",
          icon: LayoutGrid,
        },
        {
          id: "browser",
          label: "Browser",
          description: "Open a web page in a browser panel",
          icon: Globe2,
        },
      ],
      onSelect: (id) => void createPanel(id as "new" | "browser"),
    });
  }, [onPanelCreated, pushToast, shellClient, showActionSheet]);

  const caption = address && address !== title ? address : "";

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          backgroundColor: colors.surface,
          borderBottomColor: colors.borderSubtle,
        },
      ]}
    >
      {!addressBarVisible ? (
        <View style={styles.content}>
          <IconButton icon={Menu} onPress={onMenuPress} label="Open panel drawer" />
          <Pressable
            onPress={onToggleAddressBar}
            onLongPress={onShowActions}
            accessibilityRole="button"
            accessibilityLabel="Edit address. Long-press for panel actions."
            style={({ pressed }) => [
              styles.pill,
              {
                backgroundColor: pressed ? colors.surfaceRaised : colors.surfaceSunken,
                borderColor: colors.borderSubtle,
              },
            ]}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={colors.textSecondary} style={styles.pillSpinner} />
            ) : null}
            <View style={styles.pillCopy}>
              <Text
                style={[type.bodyStrong, styles.pillTitle, { color: colors.text }]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {title}
              </Text>
              {caption ? (
                <Text
                  style={[type.micro, { color: colors.textTertiary }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {caption}
                </Text>
              ) : null}
            </View>
          </Pressable>
          {onShowActions ? (
            <IconButton
              icon={MoreHorizontal}
              onPress={onShowActions}
              label="Panel actions"
              color={colors.textSecondary}
            />
          ) : null}
          <IconButton
            icon={Plus}
            onPress={handleCreatePanel}
            label="Create new panel"
            size={23}
            disabled={!shellClient}
          />
        </View>
      ) : (
        <View style={styles.content}>
          <IconButton
            icon={ArrowLeft}
            onPress={onBack}
            disabled={!canGoBack}
            label="Back"
            color={colors.text}
          />
          <IconButton
            icon={ArrowRight}
            onPress={onForward}
            disabled={!canGoForward}
            label="Forward"
            color={colors.text}
          />
          <View
            style={[
              styles.inputWrap,
              { backgroundColor: colors.surfaceSunken, borderColor: colors.primary },
            ]}
          >
            <TextInput
              ref={inputRef}
              testID="address-input"
              value={addressValue}
              onFocus={() => {
                setAddressFocused(true);
                onAddressQueryChange?.(addressValue);
              }}
              onBlur={() => {
                setTimeout(() => setAddressFocused(false), 120);
              }}
              onChangeText={(text) => {
                setAddressValue(text);
                onAddressQueryChange?.(text);
              }}
              onSubmitEditing={() => {
                setAddressFocused(false);
                onNavigateAddress?.(addressValue);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              selectTextOnFocus
              style={[styles.addressInput, { color: colors.text }]}
              placeholder="Search or enter address"
              placeholderTextColor={colors.textTertiary}
            />
            <IconButton
              icon={isLoading ? Square : RefreshCw}
              onPress={isLoading ? onStop : onReload}
              label={isLoading ? "Stop loading" : "Reload"}
              size={16}
              color={colors.textSecondary}
              style={styles.inlineReload}
            />
          </View>
          <IconButton
            icon={X}
            onPress={onToggleAddressBar}
            label="Close address bar"
            color={colors.textSecondary}
          />
        </View>
      )}
      {addressBarVisible && visibleSuggestions.length > 0 && (
        <View style={[styles.suggestions, { borderTopColor: colors.borderSubtle }]}>
          {visibleSuggestions.map((item, index) => (
            <Pressable
              key={`${item.kind}:${item.value}`}
              testID={`address-suggestion-${index}`}
              onPress={() => {
                setAddressValue(item.value);
                setAddressFocused(false);
                onSelectAddressSuggestion?.(item);
              }}
              style={({ pressed }) => [
                styles.suggestionRow,
                pressed && { backgroundColor: colors.surfaceSunken },
              ]}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              <View style={styles.suggestionContent}>
                {React.createElement(iconForSuggestion(item.iconKind), {
                  size: 17,
                  color: colors.textTertiary,
                })}
                <View style={styles.suggestionText}>
                  <HighlightedText
                    text={item.label}
                    ranges={item.matchRanges?.label}
                    style={[styles.suggestionLabel, { color: colors.text }]}
                    highlightStyle={[styles.suggestionMatch, { color: colors.primary }]}
                  />
                  <HighlightedText
                    text={item.meta}
                    ranges={item.matchRanges?.meta}
                    style={[styles.suggestionMeta, { color: colors.textSecondary }]}
                    highlightStyle={[styles.suggestionMatch, { color: colors.primary }]}
                  />
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function iconForSuggestion(kind: AddressAutocompleteItem["iconKind"]): IconComponent {
  return (
    (
      {
        globe: Globe2,
        history: Clock3,
        bookmark: Bookmark,
        search: Search,
        session: Workflow,
        panel: PanelTop,
      } as Record<string, IconComponent>
    )[kind] ?? Globe2
  );
}

function HighlightedText({
  text,
  ranges,
  style,
  highlightStyle,
}: {
  text: string;
  ranges?: TextMatchRange[];
  style: StyleProp<TextStyle>;
  highlightStyle: StyleProp<TextStyle>;
}) {
  return (
    <Text style={style} numberOfLines={1}>
      {splitTextByMatchRanges(text, ranges).map((part, index) => (
        <Text key={`${index}:${part.text}`} style={part.highlighted ? highlightStyle : undefined}>
          {part.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: hairline,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    paddingHorizontal: spacing.xs,
    gap: spacing.xxs,
  },
  pill: {
    flex: 1,
    minWidth: 0,
    minHeight: touchTarget - 4,
    borderRadius: radius.pill,
    borderWidth: hairline,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    marginHorizontal: spacing.xxs,
  },
  pillSpinner: {
    marginRight: spacing.sm,
  },
  pillCopy: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
  },
  pillTitle: {
    maxWidth: "100%",
  },
  inputWrap: {
    flex: 1,
    minWidth: 0,
    height: touchTarget - 4,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.md,
    marginHorizontal: spacing.xxs,
  },
  addressInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  inlineReload: {
    width: 36,
    height: 36,
  },
  suggestions: {
    borderTopWidth: hairline,
    paddingVertical: spacing.xs,
  },
  suggestionRow: {
    minHeight: touchTarget,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  suggestionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  suggestionText: {
    flex: 1,
    minWidth: 0,
  },
  suggestionLabel: {
    fontSize: 14,
    fontWeight: "500",
  },
  suggestionMeta: {
    marginTop: 1,
    fontSize: 12,
  },
  suggestionMatch: {
    fontWeight: "800",
  },
});
