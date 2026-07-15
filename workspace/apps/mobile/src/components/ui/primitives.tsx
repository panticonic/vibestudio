/**
 * Shared UI primitives. Small, token-driven building blocks so screens stop
 * hand-rolling buttons/rows/badges with divergent metrics.
 */

import React, { type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useAtomValue } from "jotai";
import { themeColorsAtom } from "../../state/themeAtoms";
import { pressedOpacity, radius, spacing, touchTarget, type } from "../../design/tokens";
import type { IconComponent } from "../../design/icons";

/** Round, hit-target-sized icon button with a soft pressed state. */
export function IconButton({
  icon: Icon,
  onPress,
  onLongPress,
  label,
  size = 20,
  color,
  disabled = false,
  style,
}: {
  icon: IconComponent;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Accessibility label -- required so every control is discoverable. */
  label: string;
  size?: number;
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && { backgroundColor: colors.surfaceSunken },
        disabled && styles.disabled,
        style,
      ]}
    >
      <Icon size={size} color={color ?? colors.text} />
    </Pressable>
  );
}

/** Standard button. variant: filled (primary), outline, ghost, danger. */
export function Button({
  label,
  onPress,
  variant = "outline",
  icon: Icon,
  loading = false,
  disabled = false,
  style,
  testID,
}: {
  label: string;
  onPress?: () => void;
  variant?: "filled" | "outline" | "ghost" | "danger";
  icon?: IconComponent;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const palette = {
    filled: { bg: colors.primary, border: colors.primary, fg: colors.onPrimary },
    outline: { bg: "transparent", border: colors.border, fg: colors.text },
    ghost: { bg: "transparent", border: "transparent", fg: colors.primary },
    danger: { bg: colors.dangerSoft, border: colors.danger, fg: colors.danger },
  }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && { opacity: pressedOpacity },
        (disabled || loading) && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : (
        Icon && <Icon size={17} color={palette.fg} />
      )}
      <Text style={[type.bodyStrong, { color: palette.fg }]}>{label}</Text>
    </Pressable>
  );
}

/** Small-caps section label with generous top spacing. */
export function SectionHeader({ label, trailing }: { label: string; trailing?: ReactNode }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.sectionHeader}>
      <Text style={[type.section, { color: colors.textTertiary }]}>{label}</Text>
      {trailing}
    </View>
  );
}

/** Pill badge, tone-aware. */
export function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger" | "info";
}) {
  const colors = useAtomValue(themeColorsAtom);
  const palette = {
    neutral: { bg: colors.surfaceSunken, fg: colors.textSecondary },
    primary: { bg: colors.accentSoft, fg: colors.primary },
    success: { bg: colors.successSoft, fg: colors.success },
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    info: { bg: colors.infoSoft, fg: colors.info },
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={[type.micro, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

/** Centered empty/error/loading state with icon or custom art, copy, action. */
export function EmptyState({
  art,
  icon: Icon,
  title,
  message,
  action,
}: {
  art?: ReactNode;
  icon?: IconComponent;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.empty}>
      {art ?? (Icon ? <Icon size={40} color={colors.textTertiary} /> : null)}
      <Text style={[type.bodyStrong, styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      {message ? (
        <Text style={[type.caption, styles.emptyMessage, { color: colors.textSecondary }]}>
          {message}
        </Text>
      ) : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

/** Card container sitting on the app background. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.borderSubtle },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    width: touchTarget - 4,
    height: touchTarget - 4,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  button: {
    minHeight: touchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  disabled: {
    opacity: 0.45,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    alignSelf: "flex-start",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xxl,
  },
  emptyTitle: {
    marginTop: spacing.lg,
    textAlign: "center",
  },
  emptyMessage: {
    marginTop: spacing.sm,
    textAlign: "center",
    maxWidth: 280,
  },
  emptyAction: {
    marginTop: spacing.lg,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
});
