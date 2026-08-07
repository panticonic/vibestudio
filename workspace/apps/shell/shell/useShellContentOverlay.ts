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

export function useShellContentOverlay(
  options: ShellContentOverlayOptions | null,
  onIntent?: (payload: unknown) => void
): void {
  const shownRef = useRef(false);
  const onIntentRef = useRef(onIntent);
  onIntentRef.current = onIntent;

  // Forwarded surface intents (subscribe once for the component's lifetime).
  useEffect(() => contentOverlay.on((payload) => onIntentRef.current?.(payload)), []);

  const open = options?.open === true;
  const surface = options?.surface;
  const bounds = options?.bounds;
  const props = options?.props;
  const theme = options?.theme;
  const focus = options?.focus;
  useEffect(() => {
    if (!open || !surface || !bounds || !theme) {
      if (shownRef.current) {
        shownRef.current = false;
        void view.hideContentOverlay();
      }
      return;
    }
    const payload = {
      surface,
      bounds,
      props,
      theme,
      focus,
    };
    if (!shownRef.current) {
      shownRef.current = true;
      void view.showContentOverlay(payload);
      return;
    }
    void view.updateContentOverlay(payload);
  }, [bounds?.height, bounds?.width, bounds?.x, bounds?.y, focus, open, props, surface, theme]);

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
