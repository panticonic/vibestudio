import {
  MAX_PAGE_FAVICON_BYTES,
  detectFaviconMimeType,
  type PageFavicon,
} from "@vibestudio/browser-data";
import type { ImportedFavicon } from "../types.js";

/**
 * Normalize an imported icon without transcoding it.
 *
 * Browser engines already render their supported favicon formats. Preserving
 * validated source bytes avoids lossy conversion, retains vector SVG icons,
 * and makes ICO/JPEG/GIF/WebP/AVIF first-class rather than exceptional paths.
 */
export function normalizeFavicon(
  icon: ImportedFavicon,
  updatedAt: number = Date.now()
): PageFavicon | null {
  if (icon.data.byteLength === 0 || icon.data.byteLength > MAX_PAGE_FAVICON_BYTES) {
    return null;
  }
  const mimeType = detectFaviconMimeType(icon.data);
  if (!mimeType) return null;

  try {
    const page = new URL(icon.url);
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    const sourceUrl = httpUrl(icon.sourceUrl);
    return {
      pageUrl: page.href,
      origin: page.origin,
      ...(sourceUrl ? { sourceUrl } : {}),
      data: icon.data.toString("base64"),
      mimeType,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
