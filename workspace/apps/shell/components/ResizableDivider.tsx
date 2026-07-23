import { useCallback, useEffect, useRef, useState } from "react";
import { Box } from "@radix-ui/themes";
import { COLUMN_DIVIDER_WIDTH } from "../layout/types";

interface ResizableDividerProps {
  orientation: "vertical" | "horizontal"; // vertical = resizes columns (col-resize)
  /** Accessible name, e.g. "Resize columns 1 and 2". */
  label: string;
  /** Current position as a percentage (0–100) of the divided space. */
  valueNow: number;
  /** Called with the pointer delta in px along the resize axis while dragging. */
  onDrag: (deltaPx: number) => void;
  /** Commit the drag (pointer-up); fractions are written to layout state here. */
  onDragEnd?: () => void;
  /** Arrow-key resize step, in px. */
  onKeyboardStep?: (deltaPx: number) => void;
  /** Non-drag alternative: double-click resets to equal distribution. */
  onReset?: () => void;
}

const KEYBOARD_STEP_PX = 24;

/**
 * Generalization of the sidebar resizer: fat invisible hitbox + hairline,
 * pointer capture, and keyboard operation (`role="separator"`, arrow keys).
 */
export function ResizableDivider({
  orientation,
  label,
  valueNow,
  onDrag,
  onDragEnd,
  onKeyboardStep,
  onReset,
}: ResizableDividerProps) {
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
  const lastPosRef = useRef(0);

  const axisPos = useCallback(
    (event: PointerEvent | React.PointerEvent) =>
      orientation === "vertical" ? event.clientX : event.clientY,
    [orientation]
  );

  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    lastPosRef.current = axisPos(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current) return;
      const pos = axisPos(event);
      const delta = pos - lastPosRef.current;
      if (delta !== 0) {
        lastPosRef.current = pos;
        onDrag(delta);
      }
    };
    const stopDrag = (event: PointerEvent) => {
      if (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current) return;
      pointerIdRef.current = null;
      setDragging(false);
      onDragEnd?.();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDrag, { capture: true });
    window.addEventListener("pointercancel", stopDrag, { capture: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag, { capture: true } as EventListenerOptions);
      window.removeEventListener("pointercancel", stopDrag, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [dragging, axisPos, onDrag, onDragEnd]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!onKeyboardStep) return;
    const decrease =
      orientation === "vertical" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const increase =
      orientation === "vertical" ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (!decrease && !increase) return;
    event.preventDefault();
    onKeyboardStep(increase ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX);
    onDragEnd?.();
  };

  const active = dragging || hovered;
  const isVertical = orientation === "vertical";
  return (
    <Box
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={0}
      aria-valuemax={100}
      onPointerDown={startDrag}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      style={{
        cursor: isVertical ? "col-resize" : "row-resize",
        flexShrink: 0,
        width: isVertical ? COLUMN_DIVIDER_WIDTH : undefined,
        height: isVertical ? undefined : COLUMN_DIVIDER_WIDTH,
        alignSelf: "stretch",
        touchAction: "none",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "transparent",
      }}
    >
      <Box
        style={{
          width: isVertical ? (active ? 2 : 1) : undefined,
          height: isVertical ? undefined : active ? 2 : 1,
          alignSelf: "stretch",
          flex: isVertical ? undefined : "1 1 0",
          backgroundColor: active ? "var(--accent-8)" : "var(--gray-a6)",
          transition: "background-color 120ms ease-out, width 120ms ease-out, height 120ms ease-out",
        }}
      />
    </Box>
  );
}
