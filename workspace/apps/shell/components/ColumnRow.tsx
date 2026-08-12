import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Box, Flex } from "@radix-ui/themes";

import { MIN_COLUMN_WIDTH, type LayoutColumn, type PanelLayout } from "../layout/types";
import { usePanelTree } from "../shell/hooks/PanelTreeContext";
import { usePanelDndDrag } from "../shell/hooks/PanelDndContext";
import { viewportDropId, type ViewportDropPosition } from "../layout/dropTargets";
import { PaneColumn } from "./PaneColumn";
import { ResizableDivider } from "./ResizableDivider";
import { minWidthOfPanel } from "../layout/treeEnv";

interface ColumnRowProps {
  layout: PanelLayout;
  residentColumnIds: string[];
  layoutEpoch: number;
  unresponsivePanels: Set<string>;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onResizeColumns: (columnFrs: number[]) => void;
  onResizePanes: (columnId: string, paneFrs: number[]) => void;
  /** Called when a residency transition settles, to force a surface resync (§5.4). */
  onTransitionSettled: () => void;
}

const COLUMN_TRANSITION_MS = 150;

const DROP_POSITIONS: ViewportDropPosition[] = ["left", "full", "right"];

function ViewportDropZone({ position }: { position: ViewportDropPosition }) {
  const { setNodeRef, isOver } = useDroppable({ id: viewportDropId(position) });
  const coverage =
    position === "full"
      ? { inset: 4 }
      : position === "left"
        ? { left: 4, top: 4, bottom: 4, width: "calc(50% - 6px)" }
        : { right: 4, top: 4, bottom: 4, width: "calc(50% - 6px)" };
  return (
    <Box
      ref={setNodeRef}
      data-layout-drop-position={position}
      role="button"
      aria-label={position === "full" ? "Use full viewport" : `Place panel on the ${position}`}
      style={{
        position: "absolute",
        ...coverage,
        pointerEvents: "none",
        borderRadius: "var(--radius-3)",
        border: `1px solid ${isOver ? "var(--gray-a8)" : "transparent"}`,
        backgroundColor: isOver ? "var(--gray-a4)" : "transparent",
        boxShadow: isOver ? "inset 0 0 0 1px var(--gray-a3)" : "none",
        transition: "background-color 80ms ease-out, border-color 80ms ease-out",
      }}
    />
  );
}

function ViewportDropOverlay() {
  return (
    <Box
      data-layout-drop-overlay="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        pointerEvents: "none",
        backgroundColor: "transparent",
      }}
    >
      {DROP_POSITIONS.map((position) => (
        <ViewportDropZone key={position} position={position} />
      ))}
    </Box>
  );
}

/**
 * Flex row of the viewport-resident columns interleaved with dividers. Columns
 * that do not fit stay available through the panel tree without consuming a
 * sliver of viewport space. During a residency/column-count transition,
 * surfaces are briefly non-resident (slots cleared) so live native views never
 * translate (§6); the settle callback bumps the layout epoch as the commit
 * point.
 */
export function ColumnRow({
  layout,
  residentColumnIds,
  layoutEpoch,
  unresponsivePanels,
  onDismissUnresponsive,
  onFocusPane,
  onClosePane,
  onResizeColumns,
  onResizePanes,
  onTransitionSettled,
}: ColumnRowProps) {
  const { panelMap, parentMap } = usePanelTree();
  const { activeId: treeDragActiveId } = usePanelDndDrag();
  const residentSet = useMemo(() => new Set(residentColumnIds), [residentColumnIds]);
  const residentColumns = layout.columns.filter((column) => residentSet.has(column.id));
  const layoutPaneCount = layout.columns.reduce((total, column) => total + column.panes.length, 0);
  // With a single pane on screen there is nothing for a focus rail to
  // distinguish it from, so it would be decoration on every panel.
  const showPaneFocus =
    residentColumns.reduce((total, column) => total + column.panes.length, 0) > 1;
  const columnMinWidths = residentColumns.map((column) =>
    column.panes.reduce(
      (minimum, pane) =>
        Math.max(
          minimum,
          minWidthOfPanel({ panelMap, parentMap }, pane.panelId),
          pane.minWidthOverride ?? 0
        ),
      MIN_COLUMN_WIDTH
    )
  );

  // Residency transitions (park/un-park, column enter/exit) hide surfaces for
  // one animation beat; pure resizes never do.
  const residencyKey = residentColumnIds.join("|");
  const lastResidencyKeyRef = useRef(residencyKey);
  const [transitioning, setTransitioning] = useState(false);
  useEffect(() => {
    if (lastResidencyKeyRef.current === residencyKey) return;
    lastResidencyKeyRef.current = residencyKey;
    setTransitioning(true);
    const timer = window.setTimeout(() => {
      setTransitioning(false);
      onTransitionSettled();
    }, COLUMN_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [residencyKey, onTransitionSettled]);

  const [liveFrs, setLiveFrs] = useState<number[] | null>(null);
  const liveFrsRef = useRef<number[] | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const dragColumnWidthsRef = useRef<number[] | null>(null);

  const frs = liveFrs ?? residentColumns.map((column) => column.widthFr);
  const totalFr = frs.reduce((sum, fr) => sum + fr, 0);

  const prepareDrag = () => {
    const elements = rowRef.current?.querySelectorAll<HTMLElement>("[data-column-id]");
    const widths = residentColumns.map(
      (_column, columnIndex) => elements?.[columnIndex]?.getBoundingClientRect().width ?? 0
    );
    dragColumnWidthsRef.current = widths.every((width) => width > 0) ? widths : null;
  };

  const dragBetween = (index: number, deltaPx: number) => {
    const widths = dragColumnWidthsRef.current;
    if (!widths) return;
    const columnsWidth = widths.reduce((sum, width) => sum + width, 0);
    const current = liveFrsRef.current ?? residentColumns.map((column) => column.widthFr);
    const total = current.reduce((sum, fr) => sum + fr, 0);
    const beforeWidth = widths[index] ?? 0;
    const afterWidth = widths[index + 1] ?? 0;
    if (beforeWidth <= 0 || afterWidth <= 0) return;
    const beforeMin = columnMinWidths[index] ?? MIN_COLUMN_WIDTH;
    const afterMin = columnMinWidths[index + 1] ?? MIN_COLUMN_WIDTH;
    const appliedPx = Math.max(
      Math.min(deltaPx, afterWidth - afterMin),
      -(beforeWidth - beforeMin)
    );
    const deltaFr = (appliedPx / columnsWidth) * total;
    const next = [...current];
    const before = next[index];
    const after = next[index + 1];
    if (before === undefined || after === undefined) return;
    widths[index] = beforeWidth + appliedPx;
    widths[index + 1] = afterWidth - appliedPx;
    next[index] = before + deltaFr;
    next[index + 1] = after - deltaFr;
    liveFrsRef.current = next;
    setLiveFrs(next);
  };

  const commit = () => {
    const live = liveFrsRef.current;
    liveFrsRef.current = null;
    dragColumnWidthsRef.current = null;
    setLiveFrs(null);
    if (!live) return;
    // Merge live resident frs back into the full column list (parked columns
    // keep their stored fractions).
    let cursor = 0;
    onResizeColumns(
      layout.columns.map((column) =>
        residentSet.has(column.id) ? (live[cursor++] ?? column.widthFr) : column.widthFr
      )
    );
  };

  return (
    <Flex
      direction="column"
      style={{ flex: "1 1 0", minHeight: 0, minWidth: 0, position: "relative" }}
    >
      {treeDragActiveId !== null && <ViewportDropOverlay />}
      <Flex ref={rowRef} gap="0" style={{ flex: "1 1 0", minHeight: 0, minWidth: 0 }}>
        {residentColumns.map((column, index) => (
          <Fragment key={column.id}>
            {index > 0 && (
              <ResizableDivider
                orientation="vertical"
                label={`Resize columns ${index} and ${index + 1}`}
                valueNow={(frs.slice(0, index).reduce((sum, fr) => sum + fr, 0) / totalFr) * 100}
                onDragStart={prepareDrag}
                onDrag={(deltaPx) => dragBetween(index - 1, deltaPx)}
                onDragEnd={commit}
                onKeyboardStep={(deltaPx) => {
                  prepareDrag();
                  dragBetween(index - 1, deltaPx);
                  commit();
                }}
                onReset={() => onResizeColumns(layout.columns.map(() => 1))}
              />
            )}
            <PaneColumn
              column={{ ...column, widthFr: frs[index] } as LayoutColumn}
              minWidth={columnMinWidths[index] ?? MIN_COLUMN_WIDTH}
              focusedPaneId={layout.focusedPaneId}
              showPaneFocus={showPaneFocus}
              resident={!transitioning && treeDragActiveId === null}
              layoutEpoch={layoutEpoch}
              unresponsivePanels={unresponsivePanels}
              onDismissUnresponsive={onDismissUnresponsive}
              onFocusPane={onFocusPane}
              onClosePane={layoutPaneCount > 1 ? onClosePane : undefined}
              onResizePanes={onResizePanes}
            />
          </Fragment>
        ))}
      </Flex>
    </Flex>
  );
}
