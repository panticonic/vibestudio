import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Button, Flex, Text } from "@radix-ui/themes";

import { view, type NativePanelSlotBounds, type NativePanelSlotSyncResult } from "../shell/client";

interface PanelSurfaceProps {
  nativeSlotId: string;
  panelId: string;
  bindingKey?: string;
  focused: boolean;
  className?: string;
  /**
   * Counter bumped on every committed layout/viewport change. ResizeObserver is
   * blind to position-only movement, so an epoch change forces a bounds resync
   * regardless of observer silence (multi-column layout plan §5.4).
   */
  layoutEpoch?: number;
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
  bindingKey,
  focused,
  className,
  layoutEpoch,
  onPointerDown,
}: PanelSurfaceProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const boundRef = useRef(false);
  const bindingKeyRef = useRef<string | undefined>(bindingKey);
  const lastBoundsRef = useRef<NativePanelSlotBounds | null>(null);
  const rafRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const syncSlotRef = useRef<(() => void) | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryAttemptRef.current = 0;
  }, []);

  const scheduleRetry = useCallback(
    (reason: string) => {
      if (retryTimerRef.current !== null) return;
      const attempt = retryAttemptRef.current + 1;
      retryAttemptRef.current = attempt;
      if (attempt > 100) {
        console.warn(`[PanelSurface] bind retry exhausted for ${panelId}: ${reason}`);
        setAttachError(`Panel display did not attach: ${reason}`);
        return;
      }
      const delayMs = Math.min(500, 50 * attempt);
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        syncSlotRef.current?.();
      }, delayMs);
    },
    [panelId]
  );

  const handleUpdateResult = useCallback(
    (result: NativePanelSlotSyncResult | undefined) => {
      if (result?.status !== "missing") return;
      boundRef.current = false;
      lastBoundsRef.current = null;
      scheduleRetry(result.reason);
    },
    [scheduleRetry]
  );

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
        .then(() => {
          retryAttemptRef.current = 0;
          setAttachError(null);
        })
        .catch((err: unknown) => {
          boundRef.current = false;
          const message = err instanceof Error ? err.message : String(err);
          if (/Hosted shell is not ready|target is not a panel view/i.test(message)) {
            scheduleRetry(message);
            return;
          }
          console.warn("[PanelSurface] bind failed:", err);
          setAttachError(`Panel display failed to attach: ${message}`);
        });
      return;
    }

    retryAttemptRef.current = 0;
    if (sameBounds(lastBoundsRef.current, bounds)) return;
    lastBoundsRef.current = bounds;
    void view
      .updateNativePanelSlot({ nativeSlotId, bounds })
      .then(handleUpdateResult)
      .catch((err: unknown) => console.warn("[PanelSurface] bounds update failed:", err));
  }, [focused, handleUpdateResult, nativeSlotId, panelId, scheduleRetry]);

  syncSlotRef.current = syncSlot;

  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      syncSlot();
    });
  }, [syncSlot]);

  // An epoch change means the layout committed (or a column animation settled):
  // the box may have moved without resizing, which no observer reports. Resync
  // unconditionally, and in dev flag any drift between the DOM box and the
  // last-sent native bounds one frame later.
  useEffect(() => {
    if (layoutEpoch === undefined) return;
    scheduleSync();
    if (!(import.meta as { env?: { DEV?: boolean } }).env?.DEV) return;
    const raf = window.requestAnimationFrame(() => {
      const bounds = readBounds(elementRef.current);
      if (bounds && lastBoundsRef.current && !sameBounds(lastBoundsRef.current, bounds)) {
        console.warn(
          `[PanelSurface] bounds drift after layout epoch ${layoutEpoch} for ${panelId}`,
          { dom: bounds, sent: lastBoundsRef.current }
        );
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [layoutEpoch, panelId, scheduleSync]);

  useEffect(() => {
    if (bindingKeyRef.current === bindingKey) return;
    bindingKeyRef.current = bindingKey;
    boundRef.current = false;
    lastBoundsRef.current = null;
    scheduleSync();
  }, [bindingKey, scheduleSync]);

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
      .then(handleUpdateResult)
      .catch((err: unknown) => console.warn("[PanelSurface] focus update failed:", err));
  }, [focused, handleUpdateResult, nativeSlotId, scheduleSync]);

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

  if (attachError) {
    return (
      <Flex direction="column" align="center" justify="center" gap="2" p="4" style={{ flex: 1 }}>
        <Text color="red" weight="medium">
          Panel display unavailable
        </Text>
        <Text size="2" color="gray" align="center">
          {attachError}
        </Text>
        <Button
          size="2"
          onClick={() => {
            setAttachError(null);
            boundRef.current = false;
            lastBoundsRef.current = null;
            retryAttemptRef.current = 0;
            scheduleSync();
          }}
        >
          Retry display
        </Button>
      </Flex>
    );
  }

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
