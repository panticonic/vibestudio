import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { SvgUri } from "react-native-svg";
import {
  Globe,
  LayoutGrid,
  Settings,
  Settings2,
  Smartphone,
  Workflow,
  type IconComponent,
} from "../design/icons";

export type MobileUnitIconKind = "panel" | "browser" | "worker" | "app" | "extension" | "system";

const FALLBACKS: Record<MobileUnitIconKind, IconComponent> = {
  panel: LayoutGrid,
  browser: Globe,
  worker: Workflow,
  app: Smartphone,
  extension: Settings2,
  system: Settings,
};

function isSvgImage(uri: string): boolean {
  return /^data:image\/svg\+xml(?:[;,]|$)/i.test(uri) || /\.svg(?:$|[?&#])/i.test(uri);
}

export function MobileUnitIcon(props: {
  icon?: string;
  source?: string;
  imageOverride?: string | null;
  kind: MobileUnitIconKind;
  serverUrl: string;
  size?: number;
  color: string;
  testID?: string;
}) {
  const size = props.size ?? 18;
  const manifestImage = useMemo(() => {
    if (props.icon?.startsWith("data:image/")) return props.icon;
    if (!props.icon?.startsWith("./") || !props.source || !props.serverUrl) return null;
    return `${props.serverUrl}/__vibestudio/unit-icon?source=${encodeURIComponent(props.source)}&path=${encodeURIComponent(props.icon.slice(2))}`;
  }, [props.icon, props.serverUrl, props.source]);
  const image = props.imageOverride ?? manifestImage;
  const [imageFailed, setImageFailed] = useState(false);
  const handleImageError = useCallback(() => setImageFailed(true), []);

  useEffect(() => setImageFailed(false), [image]);

  let content: React.ReactNode;
  if (image && !imageFailed) {
    content = isSvgImage(image) ? (
      <SvgUri
        uri={image}
        width={size}
        height={size}
        onError={handleImageError}
        testID={props.testID ? `${props.testID}-svg` : undefined}
      />
    ) : (
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: image }}
        style={{ width: size, height: size, borderRadius: Math.max(2, Math.round(size / 6)) }}
        resizeMode="contain"
        onError={handleImageError}
      />
    );
  } else if (props.icon && !props.icon.startsWith("./") && !props.icon.startsWith("data:image/")) {
    content = (
      <Text
        accessibilityElementsHidden
        style={[styles.emoji, { width: size, fontSize: size - 1, lineHeight: size + 1 }]}
      >
        {props.icon}
      </Text>
    );
  } else {
    const Fallback = FALLBACKS[props.kind];
    content = <Fallback size={size - 1} color={props.color} />;
  }

  return (
    <View
      testID={props.testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.frame, { width: size, height: size }]}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: {
    flexShrink: 0,
    textAlign: "center",
  },
});
