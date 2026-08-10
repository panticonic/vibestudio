import {
  ComponentInstanceIcon,
  CubeIcon,
  DashboardIcon,
  DesktopIcon,
  GearIcon,
  GlobeIcon,
} from "@radix-ui/react-icons";
import { lazy, Suspense, useEffect, useState } from "react";
import type { PanelNavigationState } from "@vibestudio/shared/types";

const BrowserFavicon = lazy(async () => {
  const module = await import("./BrowserFavicon");
  return { default: module.BrowserFavicon };
});

export function PanelIcon({
  icon,
  source,
  favicon,
  size = 16,
  fallback = false,
}: {
  icon?: string;
  source?: string;
  favicon?: PanelNavigationState["favicon"];
  size?: number;
  fallback?: "panel" | "browser" | "worker" | "app" | "extension" | "system" | false;
}) {
  const imageSource =
    icon?.startsWith("./") && source
      ? `../../__vibestudio/unit-icon?source=${encodeURIComponent(source)}&path=${encodeURIComponent(icon.slice(2))}`
      : icon?.startsWith("data:image/")
        ? icon
        : null;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageSource]);
  if (favicon) {
    return (
      <Suspense fallback={<GlobeIcon width={size} height={size} />}>
        <BrowserFavicon handle={favicon} size={size} />
      </Suspense>
    );
  }
  if (imageSource && !imageFailed) {
    return (
      <img
        src={imageSource}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: "block",
          objectFit: "contain",
          borderRadius: Math.max(2, Math.round(size * 0.2)),
        }}
        onError={() => setImageFailed(true)}
      />
    );
  }
  if (icon && !icon.startsWith("./") && !icon.startsWith("data:image/")) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size,
          lineHeight: 1,
          fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif",
        }}
      >
        {icon}
      </span>
    );
  }
  if (!fallback) return null;
  const props = { width: size, height: size, style: { flexShrink: 0 } };
  if (fallback === "browser") return <GlobeIcon {...props} />;
  if (fallback === "panel") return <DashboardIcon {...props} />;
  if (fallback === "worker") return <GearIcon {...props} />;
  if (fallback === "app") return <DesktopIcon {...props} />;
  if (fallback === "extension") return <ComponentInstanceIcon {...props} />;
  return <CubeIcon {...props} />;
}
