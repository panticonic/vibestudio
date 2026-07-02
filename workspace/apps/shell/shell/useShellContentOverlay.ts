/**
 * Reusable chrome-side driver for the content overlay (the rich sibling of
 * `useNativeShellOverlay`). Any chrome component can float a registered surface
 * above the panels by passing `{ surface, open, bounds, props, theme }`; intents
 * the surface emits come back through `onIntent`. The owning component keeps the
 * authority (state + RPC) — the overlay is pure presentation.
 */
import { useEffect, useRef } from "react";
import { contentOverlay, view } from "./client";
import type { OverlaySurfaceKey, OverlayThemeInfo } from "../overlay/types";

export interface ContentOverlayBounds {
  /** Anchor region (the panel viewport rect). Main floats the surface at its
   *  top-right corner and sizes it to the surface's reported content height. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellContentOverlayOptions {
  surface: OverlaySurfaceKey;
  open: boolean;
  bounds: ContentOverlayBounds;
  props: unknown;
  theme: OverlayThemeInfo;
  focus?: boolean;
}

function optionsKey(options: ShellContentOverlayOptions): string {
  const { bounds } = options;
  return [
    options.surface,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    options.focus ? 1 : 0,
    JSON.stringify(options.theme),
    JSON.stringify(options.props),
  ].join(":");
}

export function useShellContentOverlay(
  options: ShellContentOverlayOptions | null,
  onIntent?: (payload: unknown) => void
): void {
  const shownRef = useRef(false);
  const lastKeyRef = useRef<string | null>(null);
  const onIntentRef = useRef(onIntent);
  onIntentRef.current = onIntent;

  // Forwarded surface intents (subscribe once for the component's lifetime).
  useEffect(() => contentOverlay.on((payload) => onIntentRef.current?.(payload)), []);

  const key = options?.open ? optionsKey(options) : null;
  useEffect(() => {
    if (!options?.open) {
      if (shownRef.current) {
        shownRef.current = false;
        lastKeyRef.current = null;
        void view.hideContentOverlay();
      }
      return;
    }
    const payload = {
      surface: options.surface,
      bounds: options.bounds,
      props: options.props,
      theme: options.theme,
      focus: options.focus,
    };
    if (!shownRef.current) {
      shownRef.current = true;
      lastKeyRef.current = key;
      void view.showContentOverlay(payload);
      return;
    }
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    void view.updateContentOverlay(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Ensure the overlay is torn down if the owner unmounts while open.
  useEffect(
    () => () => {
      if (shownRef.current) {
        shownRef.current = false;
        void view.hideContentOverlay();
      }
    },
    []
  );
}
