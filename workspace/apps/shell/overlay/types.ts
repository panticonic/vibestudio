/**
 * Shared contract for the reusable "shell content overlay" — a rich React
 * surface hosted in a transparent native WebContentsView raised above the
 * panels (the generalized sibling of the rows-only address-bar overlay).
 *
 * The primitive is deliberately surface-agnostic: the owning chrome pushes a
 * serializable `props` payload and receives opaque `intent` payloads back, so
 * any feature can register a surface without touching the transport. The first
 * surface is the approval card (see ./registry).
 */

import type { ComponentType } from "react";

/** Keys of the registered overlay surfaces (see ./registry). */
export type OverlaySurfaceKey = "approval-card";

/**
 * Contract every overlay surface component implements: it receives its
 * (surface-specific) serialized `props` and an `emitIntent` to send opaque
 * intent payloads back to the owning chrome.
 */
export interface OverlaySurfaceComponentProps {
  props: unknown;
  emitIntent: (payload: unknown) => void;
}
export type OverlaySurfaceComponent = ComponentType<OverlaySurfaceComponentProps>;

/**
 * Theme identity forwarded to the surface so it matches the chrome's
 * appearance. The overlay document is a separate WebContents, so it can't read
 * the chrome's Radix <Theme> — the chrome serializes it here instead. Mirrors
 * the subset of `@workspace/ui` AppTheme that Radix <Theme> consumes.
 */
export interface OverlayThemeInfo {
  appearance: "light" | "dark";
  accentColor?: string;
  grayColor?: string;
  panelBackground?: "solid" | "translucent";
  radius?: "none" | "small" | "medium" | "large" | "full";
  scaling?: "90%" | "95%" | "100%" | "105%" | "110%";
}

/** Message pushed main → surface to (re)render it. */
export interface OverlayRenderMessage {
  surface: OverlaySurfaceKey;
  /** Surface-specific, validated by the surface component. */
  props: unknown;
  theme: OverlayThemeInfo;
  /**
   * Max content height (px) the surface may occupy — derived by main from the
   * anchor region. The surface caps itself to this (scrolling internally) and
   * reports its actual height, so auto-fit never loops.
   */
  maxHeight: number;
}

/**
 * The bridge the content-overlay preload injects on the surface document.
 * `reportSize` drives main's auto-fit; `emitIntent` forwards an opaque payload
 * to the owning chrome (e.g. "the user pressed Deny").
 */
export interface ContentOverlayBridge {
  /** Subscribe to render messages; `null` means clear (the overlay was hidden).
   *  Returns an unsubscribe fn. */
  onRender(handler: (message: OverlayRenderMessage | null) => void): () => void;
  /** Report the surface's current content height (px) for auto-fit. */
  reportSize(height: number): void;
  /** Emit an opaque intent payload back to the owning chrome. */
  emitIntent(payload: unknown): void;
  /** Report a drag gesture (screen coordinates) so main can move the native
   *  view and snap it to the nearest corner on release. */
  reportDrag(phase: "start" | "move" | "end", screenX: number, screenY: number): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __natstackContentOverlay: ContentOverlayBridge | undefined;
}
