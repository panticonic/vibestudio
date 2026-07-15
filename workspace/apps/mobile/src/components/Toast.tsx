import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { dismissToastAtom, toastQueueAtom, type ToastTone } from "../state/toastAtoms";
import { themeColorsAtom } from "../state/themeAtoms";
import { AlertTriangle, CheckCircle2, Info, XCircle, type IconComponent } from "../design/icons";
import { radius, shadow, spacing, type } from "../design/tokens";

const DEFAULT_DURATION_MS = 4500;

export function Toast() {
  const toasts = useAtomValue(toastQueueAtom);
  const dismissToast = useSetAtom(dismissToastAtom);
  const colors = useAtomValue(themeColorsAtom);

  useEffect(() => {
    const timers = toasts.map((toast) => {
      const duration = toast.durationMs ?? DEFAULT_DURATION_MS;
      if (duration <= 0) return null;
      return setTimeout(() => dismissToast(toast.id), duration);
    });
    return () => {
      for (const timer of timers) {
        if (timer) clearTimeout(timer);
      }
    };
  }, [dismissToast, toasts]);

  if (toasts.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={styles.viewport}>
      {toasts.slice(-3).map((toast) => {
        const tone = toast.tone ?? "info";
        const Icon = toneIcon(tone);
        const toneColor = toneToColor(colors, tone);
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Dismiss notification: ${toast.title ? `${toast.title}. ` : ""}${toast.message}`}
            key={toast.id}
            onPress={() => dismissToast(toast.id)}
            style={[
              styles.toast,
              {
                backgroundColor: colors.surfaceRaised,
                shadowColor: colors.shadow,
              },
            ]}
            testID={`toast-${toast.id}`}
          >
            <View style={[styles.accent, { backgroundColor: toneColor }]} />
            <Icon size={18} color={toneColor} />
            <View style={styles.copy}>
              {toast.title ? (
                <Text style={[type.bodyStrong, { color: colors.text }]}>{toast.title}</Text>
              ) : null}
              <Text style={[type.caption, { color: colors.textSecondary }]}>{toast.message}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function toneIcon(tone: ToastTone): IconComponent {
  if (tone === "success") return CheckCircle2;
  if (tone === "warning") return AlertTriangle;
  if (tone === "danger") return XCircle;
  return Info;
}

function toneToColor(
  colors: { accent: string; success: string; warning: string; danger: string },
  tone: ToastTone,
) {
  if (tone === "success") return colors.success;
  if (tone === "warning") return colors.warning;
  if (tone === "danger") return colors.danger;
  return colors.accent;
}

const styles = StyleSheet.create({
  viewport: {
    left: spacing.md,
    position: "absolute",
    right: spacing.md,
    top: spacing.md,
    zIndex: 50,
  },
  toast: {
    alignItems: "flex-start",
    borderRadius: radius.lg,
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.sm,
    overflow: "hidden",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    ...shadow.toast,
  },
  accent: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  copy: {
    flex: 1,
    gap: spacing.xxs,
  },
});
