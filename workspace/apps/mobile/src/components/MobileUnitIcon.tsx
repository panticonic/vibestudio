import React, { useEffect, useMemo, useState } from "react";
import { Image, StyleSheet, Text } from "react-native";
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

export function MobileUnitIcon(props: {
  icon?: string;
  source?: string;
  imageOverride?: string | null;
  kind: MobileUnitIconKind;
  serverUrl: string;
  size?: number;
  color: string;
}) {
  const size = props.size ?? 18;
  const manifestImage = useMemo(() => {
    if (props.icon?.startsWith("data:image/")) return props.icon;
    if (!props.icon?.startsWith("./") || !props.source || !props.serverUrl) return null;
    return `${props.serverUrl}/__vibestudio/unit-icon?source=${encodeURIComponent(props.source)}&path=${encodeURIComponent(props.icon.slice(2))}`;
  }, [props.icon, props.serverUrl, props.source]);
  const image = props.imageOverride ?? manifestImage;
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [image]);

  if (image && !imageFailed) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: image }}
        style={{ width: size, height: size, borderRadius: Math.max(2, Math.round(size / 6)) }}
        resizeMode="contain"
        onError={() => setImageFailed(true)}
      />
    );
  }
  if (props.icon && !props.icon.startsWith("./") && !props.icon.startsWith("data:image/")) {
    return (
      <Text
        accessibilityElementsHidden
        style={[styles.emoji, { width: size, fontSize: size - 1, lineHeight: size + 1 }]}
      >
        {props.icon}
      </Text>
    );
  }
  const Fallback = FALLBACKS[props.kind];
  return <Fallback size={size - 1} color={props.color} />;
}

const styles = StyleSheet.create({
  emoji: {
    flexShrink: 0,
    textAlign: "center",
  },
});
