import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Box, Flex, Text } from "@radix-ui/themes";

import {
  MIN_COLUMN_WIDTH,
  PARKED_EDGE_TAB_WIDTH,
  type LayoutColumn,
  type PanelLayout,
} from "../layout/types";
import { usePanelTree } from "../shell/hooks/PanelTreeContext";
import { usePanelDndDrag } from "../shell/hooks/PanelDndContext";
import { gutterDropId } from "../layout/dropTargets";
import { PaneColumn } from "./PaneColumn";
import { ResizableDivider } from "./ResizableDivider";
import { minWidthOfPanel } from "../layout/treeEnv";

interface ColumnRowProps {
  layout: PanelLayout;
  residentColumnIds: string[];
  parkedLeft: string[];
  parkedRight: string[];
  layoutEpoch: number;
  unresponsivePanels: Set<string>;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
  onFocusColumn: (columnId: string) => void;
  onResizeColumns: (columnFrs: number[]) => void;
  onResizePanes: (columnId: string, paneFrs: number[]) => void;
  /** Called when a residency transition settles, to force a surface resync (§5.4). */
  onTransitionSettled: () => void;
}

const COLUMN_TRANSITION_MS = 150;

/**
 * Vertical drop strip after a column, shown only while a tree drag is live
 * (D9: drop zones live in the gaps). Dropping opens the dragged panel in a
 * new column at this position.
 */
function GutterDropZone({ columnId }: { columnId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: gutterDropId(columnId) });
  return (
    <Box
      ref={setNodeRef}
      data-gutter-drop={columnId}
      style={{
        width: 18,
        flexShrink: 0,
        alignSelf: "stretch",
        display: "flex",
        justifyContent: "center",
        padding: "8px 0",
      }}
    >
      <Box
        style={{
          width: 4,
          alignSelf: "stretch",
          borderRadius: 2,
          backgroundColor: isOver ? "var(--accent-8)" : "var(--gray-a5)",
          transition: "background-color 120ms ease-out",
        }}
      />
    </Box>
  );
}

function EdgeTabStrip({
  side,
  columns,
  layout,
  panelTitle,
  onFocusColumn,
}: {
  side: "left" | "right";
  columns: string[];
  layout: PanelLayout;
  panelTitle: (panelId: string) => string;
  onFocusColumn: (columnId: string) => void;
}) {
  if (columns.length === 0) return null;
  return (
    <Flex
      direction="column"
      gap="1"
      p="1"
      style={{
        width: PARKED_EDGE_TAB_WIDTH,
        flexShrink: 0,
        alignSelf: "stretch",
        overflow: "hidden",
      }}
      data-edge-tabs={side}
    >
      {columns.map((columnId) => {
        const column = layout.columns.find((candidate) => candidate.id === columnId);
        const firstPanelId = column?.panes[0]?.panelId;
        const title = firstPanelId ? panelTitle(firstPanelId) : "";
        return (
          <Box
            key={columnId}
            role="button"
            tabIndex={0}
            title={title}
            onClick={() => onFocusColumn(columnId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onFocusColumn(columnId);
            }}
            style={{
              flex: "1 1 0",
              minHeight: 48,
              maxHeight: 160,
              borderRadius: "var(--radius-2)",
              backgroundColor: "var(--gray-a3)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <Text
              size="1"
              color="gray"
              truncate
              style={{ writingMode: "vertical-rl", maxHeight: "100%" }}
            >
              {title}
            </Text>
          </Box>
        );
      })}
    </Flex>
  );
}

/**
 * Flex row of the viewport-resident columns interleaved with dividers, plus
 * edge-tab strips for parked columns (D10). Never CSS-scrolls native surfaces;
 * paging is a layout-state change. During a residency/column-count transition,
 * surfaces are briefly non-resident (slots cleared) so live native views never
 * translate (§6); the settle callback bumps the layout epoch as the commit
 * point.
 */
export function ColumnRow({
  layout,
  residentColumnIds,
  parkedLeft,
  parkedRight,
  layoutEpoch,
  unresponsivePanels,
  onDismissUnresponsive,
  onFocusPane,
  onFocusColumn,
  onResizeColumns,
  onResizePanes,
  onTransitionSettled,
}: ColumnRowProps) {
  const { panelMap, parentMap } = usePanelTree();
  const { activeId: treeDragActiveId } = usePanelDndDrag();
  const residentSet = useMemo(() => new Set(residentColumnIds), [residentColumnIds]);
  const residentColumns = layout.columns.filter((column) => residentSet.has(column.id));
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

  const frs = liveFrs ?? residentColumns.map((column) => column.widthFr);
  const totalFr = frs.reduce((sum, fr) => sum + fr, 0);

  const dragBetween = (index: number, deltaPx: number) => {
    const elements = rowRef.current?.querySelectorAll<HTMLElement>("[data-column-id]");
    const beforeWidth = elements?.[index]?.getBoundingClientRect().width ?? 0;
    const afterWidth = elements?.[index + 1]?.getBoundingClientRect().width ?? 0;
    const columnsWidth = residentColumns.reduce(
      (sum, _column, columnIndex) =>
        sum + (elements?.[columnIndex]?.getBoundingClientRect().width ?? 0),
      0
    );
    if (columnsWidth <= 0 || beforeWidth <= 0 || afterWidth <= 0) return;
    const current = liveFrsRef.current ?? residentColumns.map((column) => column.widthFr);
    const total = current.reduce((sum, fr) => sum + fr, 0);
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
    next[index] = before + deltaFr;
    next[index + 1] = after - deltaFr;
    liveFrsRef.current = next;
    setLiveFrs(next);
  };

  const commit = () => {
    const live = liveFrsRef.current;
    liveFrsRef.current = null;
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

  const panelTitle = (panelId: string) => panelMap.get(panelId)?.title ?? panelId;

  return (
    <Flex ref={rowRef} gap="0" style={{ flex: "1 1 0", minHeight: 0, minWidth: 0 }}>
      <EdgeTabStrip
        side="left"
        columns={parkedLeft}
        layout={layout}
        panelTitle={panelTitle}
        onFocusColumn={onFocusColumn}
      />
      {residentColumns.map((column, index) => (
        <Fragment key={column.id}>
          {index > 0 && (
            <ResizableDivider
              orientation="vertical"
              label={`Resize columns ${index} and ${index + 1}`}
              valueNow={(frs.slice(0, index).reduce((sum, fr) => sum + fr, 0) / totalFr) * 100}
              onDrag={(deltaPx) => dragBetween(index - 1, deltaPx)}
              onDragEnd={commit}
              onKeyboardStep={(deltaPx) => {
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
            resident={!transitioning}
            layoutEpoch={layoutEpoch}
            unresponsivePanels={unresponsivePanels}
            onDismissUnresponsive={onDismissUnresponsive}
            onFocusPane={onFocusPane}
            onResizePanes={onResizePanes}
          />
          {treeDragActiveId !== null && <GutterDropZone columnId={column.id} />}
        </Fragment>
      ))}
      <EdgeTabStrip
        side="right"
        columns={parkedRight}
        layout={layout}
        panelTitle={panelTitle}
        onFocusColumn={onFocusColumn}
      />
    </Flex>
  );
}
