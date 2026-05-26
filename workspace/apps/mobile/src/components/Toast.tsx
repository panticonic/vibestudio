import React, { useEffect, type ComponentType } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { dismissToastAtom, toastQueueAtom, type ToastTone } from "../state/toastAtoms";
import { themeColorsAtom } from "../state/themeAtoms";

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

function fallbackIcon(glyph: string): IconComponent {
  return function FallbackIcon({ size = 16, color }: IconProps) {
    return <Text style={{ color, fontSize: size, lineHeight: size }}>{glyph}</Text>;
  };
}

function icon(name: string, glyph: string): IconComponent {
  return lucideIcons[name] ?? fallbackIcon(glyph);
}

const AlertTriangle = icon("AlertTriangle", "!");
const CheckCircle2 = icon("CheckCircle2", "+");
const Info = icon("Info", "i");
const XCircle = icon("XCircle", "x");

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
                backgroundColor: colors.surface,
                borderColor: toneColor,
              },
            ]}
            testID={`toast-${toast.id}`}
          >
            <Icon size={18} color={toneColor} />
            <View style={styles.copy}>
              {toast.title ? <Text style={[styles.title, { color: colors.text }]}>{toast.title}</Text> : null}
              <Text style={[styles.message, { color: colors.textSecondary }]}>{toast.message}</Text>
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
    left: 12,
    position: "absolute",
    right: 12,
    top: 12,
    zIndex: 50,
  },
  toast: {
    alignItems: "flex-start",
    borderRadius: 8,
    borderWidth: 1,
    elevation: 6,
    flexDirection: "row",
    gap: 10,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  message: {
    fontSize: 13,
    fontWeight: "500",
    lineHeight: 18,
  },
});
