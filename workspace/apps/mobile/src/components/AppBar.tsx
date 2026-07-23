/**
 * AppBar -- Top navigation bar for the mobile workspace app.
 *
 * Layout:
 *   [Hamburger]  [Panel Title]  [+ New Panel]
 *
 * Features:
 * - Left: hamburger menu button to open the panel drawer
 * - Center: current panel title (or "Vibestudio" if no panel selected)
 * - Right: "+" button to create a new panel
 * - Uses safe area insets for status bar spacing
 */

import React, { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActionSheetIOS,
  Platform,
  Alert,
  TextInput,
} from "react-native";
import type { StyleProp, TextStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";
import { shellClientAtom } from "../state/shellClientAtom";
import {
  splitTextByMatchRanges,
  type AddressAutocompleteItem,
  type TextMatchRange,
} from "@vibestudio/shared/panelChrome";
import { VibestudioLogo } from "./VibestudioLogo";

declare const require: (id: string) => unknown;
type IconProps = { size?: number; color?: string; strokeWidth?: number };
type IconComponent = ComponentType<IconProps>;
type IconModule = Record<string, IconComponent | undefined>;
let lucideIcons: IconModule = {};
try {
  lucideIcons = require("lucide-react-native") as IconModule;
} catch {
  lucideIcons = {};
}
const fallbackIcon =
  (glyph: string): IconComponent =>
  ({ size = 18, color }) => (
    <Text style={{ color, fontSize: size, lineHeight: size }}>{glyph}</Text>
  );
const icon = (name: string, glyph: string) => lucideIcons[name] ?? fallbackIcon(glyph);
const ArrowLeft = icon("ArrowLeft", "‹");
const ArrowRight = icon("ArrowRight", "›");
const Bookmark = icon("Bookmark", "★");
const Clock3 = icon("Clock3", "◷");
const Globe2 = icon("Globe2", "◎");
const Link2 = icon("Link2", "↗");
const Menu = icon("Menu", "≡");
const PanelTop = icon("PanelTop", "□");
const Plus = icon("Plus", "+");
const RefreshCw = icon("RefreshCw", "↻");
const Search = icon("Search", "?");
const Square = icon("Square", "■");
const Workflow = icon("Workflow", "◇");

interface AppBarProps {
  /** Title to display in the center */
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
  const [addressValue, setAddressValue] = useState(address);
  const [addressFocused, setAddressFocused] = useState(false);
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

  const handleCreatePanel = useCallback(() => {
    if (!shellClient) return;

    const createPanel = async (type: "new" | "browser") => {
      try {
        const result = await shellClient.panels.createAboutPanel(type);
        onPanelCreated?.(result.id);
      } catch (error) {
        Alert.alert(
          "Panel Creation Failed",
          error instanceof Error ? error.message : "Could not create panel."
        );
      }
    };

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["New Panel", "Browser", "Cancel"],
          cancelButtonIndex: 2,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) createPanel("new");
          else if (buttonIndex === 1) createPanel("browser");
        }
      );
    } else {
      Alert.alert("Create Panel", undefined, [
        { text: "New Panel", onPress: () => createPanel("new") },
        { text: "Browser", onPress: () => createPanel("browser") },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }, [shellClient, onPanelCreated]);

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          backgroundColor: colors.surface,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <View style={styles.content}>
        {/* Hamburger menu button */}
        <Pressable
          onPress={onMenuPress}
          style={styles.iconButton}
          hitSlop={8}
          accessibilityLabel="Open panel drawer"
          accessibilityRole="button"
        >
          <Menu size={23} color={colors.text} />
        </Pressable>

        <VibestudioLogo size={30} variant="symbol" style={styles.brandLogo} />

        {/* Panel title */}
        <Text
          style={[styles.title, { color: colors.text }]}
          numberOfLines={1}
          ellipsizeMode="tail"
          onPress={onToggleAddressBar}
          onLongPress={onShowActions}
        >
          {title}
        </Text>

        <Pressable
          onPress={onToggleAddressBar}
          onLongPress={onShowActions}
          style={styles.urlButton}
          hitSlop={8}
          accessibilityLabel={addressBarVisible ? "Hide address bar" : "Show address bar"}
          accessibilityRole="button"
        >
          <Link2 size={18} color={colors.textSecondary} />
        </Pressable>

        {/* Create new panel button */}
        <Pressable
          onPress={handleCreatePanel}
          style={styles.iconButton}
          hitSlop={8}
          accessibilityLabel="Create new panel"
          accessibilityRole="button"
        >
          <Plus size={25} color={colors.text} />
        </Pressable>
      </View>
      {addressBarVisible && (
        <View style={[styles.addressRow, { borderTopColor: colors.border }]}>
          <Pressable
            onPress={onBack}
            disabled={!canGoBack}
            style={[styles.navButton, !canGoBack && styles.disabledButton]}
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={8}
          >
            <ArrowLeft size={20} color={colors.text} />
          </Pressable>
          <Pressable
            onPress={onForward}
            disabled={!canGoForward}
            style={[styles.navButton, !canGoForward && styles.disabledButton]}
            accessibilityLabel="Forward"
            accessibilityRole="button"
            hitSlop={8}
          >
            <ArrowRight size={20} color={colors.text} />
          </Pressable>
          <TextInput
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
            style={[
              styles.addressInput,
              {
                color: colors.text,
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
            placeholder="Search or enter address"
            placeholderTextColor={colors.textSecondary}
          />
          <Pressable
            onPress={isLoading ? onStop : onReload}
            style={styles.navButton}
            accessibilityLabel={isLoading ? "Stop loading" : "Reload"}
            accessibilityRole="button"
            hitSlop={8}
          >
            {isLoading ? (
              <Square size={16} color={colors.text} />
            ) : (
              <RefreshCw size={19} color={colors.text} />
            )}
          </Pressable>
        </View>
      )}
      {addressBarVisible && visibleSuggestions.length > 0 && (
        <View
          style={[
            styles.suggestions,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              borderBottomColor: colors.border,
            },
          ]}
        >
          {visibleSuggestions.map((item, index) => (
            <Pressable
              key={`${item.kind}:${item.value}`}
              testID={`address-suggestion-${index}`}
              onPress={() => {
                setAddressValue(item.value);
                setAddressFocused(false);
                onSelectAddressSuggestion?.(item);
              }}
              style={styles.suggestionRow}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              <View style={styles.suggestionContent}>
                {React.createElement(iconForSuggestion(item.iconKind), {
                  size: 18,
                  color: colors.textSecondary,
                })}
                <View style={styles.suggestionText}>
                  <HighlightedText
                    text={item.label}
                    ranges={item.matchRanges?.label}
                    style={[styles.suggestionLabel, { color: colors.text }]}
                    highlightStyle={styles.suggestionMatch}
                  />
                  <HighlightedText
                    text={item.meta}
                    ranges={item.matchRanges?.meta}
                    style={[styles.suggestionMeta, { color: colors.textSecondary }]}
                    highlightStyle={styles.suggestionMatch}
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
    borderBottomWidth: 1,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 48,
    paddingHorizontal: 8,
  },
  addressRow: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    gap: 6,
  },
  addressInput: {
    flex: 1,
    height: 32,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
  },
  suggestions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
  },
  suggestionRow: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  suggestionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  suggestionIcon: {
    width: 22,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
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
    marginTop: 2,
    fontSize: 12,
  },
  suggestionMatch: {
    fontWeight: "800",
  },
  navButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  navButtonText: {
    fontSize: 18,
    fontWeight: "600",
  },
  disabledButton: {
    opacity: 0.35,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  brandLogo: {
    marginLeft: -4,
  },
  hamburger: {
    width: 22,
    height: 16,
    justifyContent: "space-between",
  },
  hamburgerLine: {
    width: 22,
    height: 2,
    borderRadius: 1,
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
    marginHorizontal: 8,
  },
  urlButton: {
    paddingHorizontal: 6,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  urlButtonText: {
    fontSize: 11,
    fontWeight: "700",
  },
  plusIcon: {
    fontSize: 28,
    fontWeight: "300",
    lineHeight: 30,
  },
});
