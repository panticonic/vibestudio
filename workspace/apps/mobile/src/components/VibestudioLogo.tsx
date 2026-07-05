import React from "react";
import { Image, StyleSheet, View } from "react-native";
import type { ImageStyle, StyleProp, ViewStyle } from "react-native";
import { useAtomValue } from "jotai";
import { isDarkModeAtom, themeColorsAtom } from "../state/themeAtoms";

const LOGO_TILE_DARK = require("../assets/vibestudio-dark.png");
const LOGO_TILE_LIGHT = require("../assets/vibestudio-light.png");
const LOGO_MARK_DARK = require("../assets/vibestudio-mark-on-dark.png");
const LOGO_MARK_LIGHT = require("../assets/vibestudio-mark-on-light.png");

export interface VibestudioLogoProps {
  size?: number;
  variant?: "tile" | "mark";
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
}

export function VibestudioLogo({ size = 48, variant = "tile", style, imageStyle }: VibestudioLogoProps) {
  const isDark = useAtomValue(isDarkModeAtom);
  const colors = useAtomValue(themeColorsAtom);
  const source =
    variant === "mark"
      ? isDark
        ? LOGO_MARK_DARK
        : LOGO_MARK_LIGHT
      : isDark
        ? LOGO_TILE_DARK
        : LOGO_TILE_LIGHT;

  return (
    <View
      style={[
        styles.logo,
        variant === "tile" && {
          borderColor: colors.border,
          borderRadius: Math.round(size * 0.22),
          borderWidth: StyleSheet.hairlineWidth,
          overflow: "hidden",
        },
        { height: size, width: size },
        style,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={source}
        resizeMode={variant === "tile" ? "cover" : "contain"}
        style={[styles.image, imageStyle]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  logo: {
    flexShrink: 0,
  },
  image: {
    height: "100%",
    width: "100%",
  },
});
