import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Box } from "@radix-ui/themes";

import { view, type NativePanelSlotBounds } from "../shell/client";

interface PanelSurfaceProps {
  nativeSlotId: string;
  panelId: string;
  focused: boolean;
  className?: string;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
}

function sameBounds(a: NativePanelSlotBounds | null, b: NativePanelSlotBounds): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function readBounds(el: HTMLElement | null): NativePanelSlotBounds | null {
  const rect = el?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function PanelSurface({
  nativeSlotId,
  panelId,
  focused,
  className,
  onPointerDown,
}: PanelSurfaceProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const boundRef = useRef(false);
  const lastBoundsRef = useRef<NativePanelSlotBounds | null>(null);
  const rafRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const clearSlot = useCallback(() => {
    if (!boundRef.current) return;
    boundRef.current = false;
    lastBoundsRef.current = null;
    void view
      .clearNativePanelSlot({ nativeSlotId })
      .catch((err: unknown) => console.warn("[PanelSurface] clear failed:", err));
  }, [nativeSlotId]);

  const syncSlot = useCallback(() => {
    const bounds = readBounds(elementRef.current);
    if (!bounds) return;

    if (!boundRef.current) {
      boundRef.current = true;
      lastBoundsRef.current = bounds;
      void view
        .bindNativePanelSlot({ nativeSlotId, panelId, bounds, focused })
        .catch((err: unknown) => {
          boundRef.current = false;
          const message = err instanceof Error ? err.message : String(err);
          if (/Hosted shell is not ready/i.test(message)) {
            clearRetry();
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              syncSlot();
            }, 50);
            return;
          }
          console.warn("[PanelSurface] bind failed:", err);
        });
      return;
    }

    if (sameBounds(lastBoundsRef.current, bounds)) return;
    lastBoundsRef.current = bounds;
    void view
      .updateNativePanelSlot({ nativeSlotId, bounds })
      .catch((err: unknown) => console.warn("[PanelSurface] bounds update failed:", err));
  }, [clearRetry, focused, nativeSlotId, panelId]);

  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      syncSlot();
    });
  }, [syncSlot]);

  useLayoutEffect(() => {
    scheduleSync();
    const el = elementRef.current;
    if (!el) return;

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    resizeObserver?.observe(el);

    window.addEventListener("resize", scheduleSync);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
    };
  }, [scheduleSync]);

  useEffect(() => {
    if (!boundRef.current) {
      scheduleSync();
      return;
    }
    void view
      .updateNativePanelSlot({ nativeSlotId, focused })
      .catch((err: unknown) => console.warn("[PanelSurface] focus update failed:", err));
  }, [focused, nativeSlotId, scheduleSync]);

  useEffect(() => clearSlot, [clearSlot]);

  useEffect(() => {
    return () => {
      clearRetry();
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [clearRetry]);

  return (
    <Box
      ref={elementRef}
      className={className}
      data-native-panel-slot-id={nativeSlotId}
      data-panel-id={panelId}
      onPointerDown={onPointerDown}
      style={{ flex: "1 1 0", position: "relative", minHeight: 0, minWidth: 0 }}
    />
  );
}
