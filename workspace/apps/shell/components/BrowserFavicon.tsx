import { useEffect, useState } from "react";
import { GlobeIcon } from "@radix-ui/react-icons";
import { browserData } from "../shell/client";

export type BrowserFaviconHandle = { pageUrl: string; updatedAt: number };

const faviconCache = new Map<string, string>();

export function BrowserFavicon({
  handle,
  size = 16,
}: {
  handle: BrowserFaviconHandle;
  size?: number;
}) {
  const key = `${handle.pageUrl}\0${handle.updatedAt}`;
  const [src, setSrc] = useState(() => faviconCache.get(key));

  useEffect(() => {
    const cached = faviconCache.get(key);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    void browserData
      .getPageFavicon(handle.pageUrl)
      .then((record) => {
        const bytes = record?.png16 ?? record?.png32;
        if (!bytes || cancelled) return;
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer;
        const value = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
        faviconCache.set(key, value);
        while (faviconCache.size > 128) {
          const oldest = faviconCache.entries().next().value as [string, string] | undefined;
          if (!oldest) break;
          faviconCache.delete(oldest[0]);
          URL.revokeObjectURL(oldest[1]);
        }
        setSrc(value);
      })
      .catch(() => {
        // The globe fallback is the complete error state for favicon retrieval.
      });
    return () => {
      cancelled = true;
    };
  }, [handle.pageUrl, key]);

  return src ? (
    <img src={src} width={size} height={size} alt="" style={{ flexShrink: 0 }} />
  ) : (
    <GlobeIcon width={size} height={size} />
  );
}
