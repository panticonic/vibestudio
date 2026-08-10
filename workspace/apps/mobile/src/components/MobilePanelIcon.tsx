import React, { useEffect, useState } from "react";
import { browserUrlFromPanelSource } from "@vibestudio/shared/panelChrome";
import { MobileUnitIcon } from "./MobileUnitIcon";

export function MobilePanelIcon(props: {
  icon?: string;
  source?: string;
  kind?: "workspace" | "browser";
  serverUrl: string;
  size?: number;
  color: string;
  testID?: string;
  resolveBrowserFavicon: (url: string) => Promise<string | null>;
}) {
  const browserUrl =
    props.kind === "browser" && props.source ? browserUrlFromPanelSource(props.source) : null;
  const [favicon, setFavicon] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setFavicon(null);
    if (browserUrl) {
      void props
        .resolveBrowserFavicon(browserUrl)
        .then((value) => {
          if (mounted) setFavicon(value);
        })
        .catch(() => {
          if (mounted) setFavicon(null);
        });
    }
    return () => {
      mounted = false;
    };
  }, [browserUrl, props.resolveBrowserFavicon]);

  return (
    <MobileUnitIcon
      icon={props.icon}
      source={props.source}
      imageOverride={favicon}
      kind={props.kind === "browser" ? "browser" : "panel"}
      serverUrl={props.serverUrl}
      size={props.size}
      color={props.color}
      testID={props.testID}
    />
  );
}
