/**
 * ActionSheetHost -- renders the app-wide themed action sheet (see
 * state/actionSheetAtoms). Mounted once at the root, above navigation.
 *
 * Visual: dimmed backdrop, rounded card that slides up from the bottom with a
 * drag handle, rows with icon + label + optional description, tone-aware
 * colors, safe-area padding. Tap backdrop / drag down / Cancel to dismiss.
 */

import React, { useCallback, useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue, useSetAtom } from "jotai";
import { actionSheetAtom, dismissActionSheetAtom } from "../../state/actionSheetAtoms";
import { themeColorsAtom } from "../../state/themeAtoms";
import { radius, shadow, spacing, type } from "../../design/tokens";
import { Check } from "../../design/icons";

const SLIDE_DISTANCE = 480;

export function ActionSheetHost() {
  const config = useAtomValue(actionSheetAtom);
  const dismiss = useSetAtom(dismissActionSheetAtom);
  const colors = useAtomValue(themeColorsAtom);
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(SLIDE_DISTANCE)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  const animateIn = useCallback(() => {
    translateY.setValue(SLIDE_DISTANCE);
    backdropOpacity.setValue(0);
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [backdropOpacity, translateY]);

  const animateOut = useCallback(
    (onDone: () => void) => {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: SLIDE_DISTANCE,
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start(() => onDone());
    },
    [backdropOpacity, translateY]
  );

  useEffect(() => {
    if (config) animateIn();
  }, [config, animateIn]);

  const close = useCallback(() => {
    animateOut(() => dismiss());
  }, [animateOut, dismiss]);

  const select = useCallback(
    (id: string) => {
      const onSelect = config?.onSelect;
      animateOut(() => {
        dismiss();
        onSelect?.(id);
      });
    },
    [animateOut, config, dismiss]
  );

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dy > 0) translateY.setValue(gesture.dy);
      },
      onPanResponderRelease: (_evt, gesture) => {
        if (gesture.dy > 90 || gesture.vy > 0.8) {
          close();
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 4,
          }).start();
        }
      },
    })
  ).current;

  if (!config) return null;

  return (
    <Modal transparent visible statusBarTranslucent animationType="none" onRequestClose={close}>
      <View style={styles.root}>
        <Animated.View
          style={[styles.backdrop, { backgroundColor: colors.overlay, opacity: backdropOpacity }]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Dismiss" />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            shadow.sheet,
            {
              backgroundColor: colors.surfaceRaised,
              paddingBottom: Math.max(insets.bottom, spacing.lg),
              shadowColor: colors.shadow,
              transform: [{ translateY }],
            },
          ]}
        >
          <View {...panResponder.panHandlers} style={styles.grabArea}>
            <View style={[styles.grabber, { backgroundColor: colors.border }]} />
            {config.title ? (
              <Text
                style={[type.heading, styles.title, { color: colors.text }]}
                numberOfLines={1}
              >
                {config.title}
              </Text>
            ) : null}
            {config.subtitle ? (
              <Text
                style={[type.caption, styles.subtitle, { color: colors.textSecondary }]}
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {config.subtitle}
              </Text>
            ) : null}
          </View>
          <ScrollView bounces={false} style={styles.list}>
            {config.items.map((item) => {
              const tone = item.tone ?? "default";
              const labelColor =
                tone === "danger"
                  ? colors.danger
                  : tone === "primary"
                    ? colors.primary
                    : colors.text;
              const Icon = item.icon;
              return (
                <Pressable
                  key={item.id}
                  disabled={item.disabled}
                  onPress={() => select(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: colors.surfaceSunken },
                    item.disabled && styles.disabled,
                  ]}
                >
                  {Icon ? (
                    <View style={styles.rowIcon}>
                      <Icon size={19} color={tone === "default" ? colors.textSecondary : labelColor} />
                    </View>
                  ) : null}
                  <View style={styles.rowCopy}>
                    <Text style={[type.bodyStrong, { color: labelColor }]} numberOfLines={1}>
                      {item.label}
                    </Text>
                    {item.description ? (
                      <Text
                        style={[type.caption, { color: colors.textTertiary }]}
                        numberOfLines={2}
                      >
                        {item.description}
                      </Text>
                    ) : null}
                  </View>
                  {item.selected ? <Check size={18} color={colors.primary} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            style={({ pressed }) => [
              styles.cancel,
              { backgroundColor: pressed ? colors.surfaceSunken : "transparent", borderColor: colors.borderSubtle },
            ]}
          >
            <Text style={[type.bodyStrong, { color: colors.textSecondary }]}>Cancel</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: "78%",
  },
  grabArea: {
    alignItems: "center",
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.xl,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    marginBottom: spacing.sm,
  },
  title: {
    textAlign: "center",
  },
  subtitle: {
    marginTop: 2,
    textAlign: "center",
  },
  list: {
    flexGrow: 0,
    paddingHorizontal: spacing.sm,
    marginTop: spacing.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  rowIcon: {
    width: 24,
    alignItems: "center",
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  disabled: {
    opacity: 0.4,
  },
  cancel: {
    marginTop: spacing.xs,
    marginHorizontal: spacing.lg,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
