import type { ContentOverlayBridge } from "./types";

/**
 * Accessor for the content-overlay bridge injected by `contentOverlayPreload`
 * on the surface document. Returns null when absent (e.g. unit tests, or the
 * full-app document which has no such preload).
 */
export function getContentOverlayBridge(): ContentOverlayBridge | null {
  return globalThis.__vibez1ContentOverlay ?? null;
}
