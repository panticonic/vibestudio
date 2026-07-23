import React from "react";
import { Image, StyleSheet, View } from "react-native";
import type { ImageStyle, StyleProp, ViewStyle } from "react-native";
import { useAtomValue } from "jotai";
import { isDarkModeAtom, themeColorsAtom } from "../state/themeAtoms";

const LOGO = require("../assets/vibestudio-logo.png");
const SYMBOL = require("../assets/vibestudio-symbol.png");
const SYMBOL_ON_DARK = require("../assets/vibestudio-symbol-on-dark.png");
const SYMBOL_ON_LIGHT = require("../assets/vibestudio-symbol-on-light.png");

export interface VibestudioLogoProps {
  size?: number;
  variant?: "logo" | "symbol" | "tile";
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
}

export function VibestudioLogo({
  size = 48,
  variant = "symbol",
  style,
  imageStyle,
}: VibestudioLogoProps) {
  const isDark = useAtomValue(isDarkModeAtom);
  const colors = useAtomValue(themeColorsAtom);
  const source =
    variant === "logo"
      ? LOGO
      : variant === "symbol"
        ? SYMBOL
        : isDark
          ? SYMBOL_ON_DARK
          : SYMBOL_ON_LIGHT;
  const width = variant === "logo" ? Math.round((size * 2) / 3) : size;

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
        { height: size, width },
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
