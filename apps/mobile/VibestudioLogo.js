import React from "react";
import { Image, StyleSheet, View } from "react-native";

const BRAND_LOGO = require("./assets/vibestudio-logo.png");
const BRAND_SYMBOL = require("./assets/vibestudio-symbol.png");
const BRAND_SYMBOL_ON_DARK = require("./assets/vibestudio-symbol-on-dark.png");

export function VibestudioLogo({ size = 44, variant = "symbol", style }) {
  const width = variant === "logo" ? Math.round((size * 2) / 3) : size;
  const source =
    variant === "logo" ? BRAND_LOGO : variant === "tile" ? BRAND_SYMBOL_ON_DARK : BRAND_SYMBOL;
  return (
    <View
      style={[
        styles.logo,
        variant === "tile" && styles.tile,
        {
          height: size,
          width,
          borderRadius: variant === "tile" ? Math.round(size * 0.22) : 0,
        },
        style,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={source}
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
    backgroundColor: "#100b18",
    borderColor: "#4b2f67",
    borderWidth: 1,
    overflow: "hidden",
  },
  image: {
    height: "100%",
    width: "100%",
  },
});
