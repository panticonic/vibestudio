import React from "react";
import { Image, StyleSheet, View } from "react-native";

const BRAND_LOGO_DARK = require("./assets/vibestudio-dark.png");
const BRAND_MARK_DARK = require("./assets/vibestudio-mark-on-dark.png");

export function VibestudioLogo({ size = 44, variant = "tile", style }) {
  return (
    <View
      style={[
        styles.logo,
        variant === "tile" && styles.tile,
        {
          height: size,
          width: size,
          borderRadius: variant === "tile" ? Math.round(size * 0.22) : 0,
        },
        style,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={variant === "mark" ? BRAND_MARK_DARK : BRAND_LOGO_DARK}
        style={styles.image}
        resizeMode={variant === "tile" ? "cover" : "contain"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  logo: {
    flexShrink: 0,
  },
  tile: {
    backgroundColor: "#0a0b0c",
    borderColor: "#303a4f",
    borderWidth: 1,
    overflow: "hidden",
  },
  image: {
    height: "100%",
    width: "100%",
  },
});
