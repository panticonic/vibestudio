import { Fragment, useRef, useState } from "react";
import { Flex } from "@radix-ui/themes";

import type { PanelContextMenuAction } from "@vibestudio/shared/types";
import type { LayoutColumn } from "../layout/types";
import { PaneView, PANE_CHROME_HEIGHT } from "./PaneView";
import { ResizableDivider } from "./ResizableDivider";
import { MIN_PANE_HEIGHT } from "../layout/types";

interface PaneColumnProps {
  column: LayoutColumn;
  minWidth: number;
  focusedPaneId: string | null;
  resident: boolean;
  layoutEpoch: number;
  viewportHeight: number;
  unresponsivePanels: Set<string>;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onSplitBelow: (paneId: string) => void;
  onOpenBeside: (paneId: string) => void;
  onShowAddressBar: () => void;
  onPanelAction: (panelId: string, action: PanelContextMenuAction) => void;
  onResizePanes: (columnId: string, paneFrs: number[]) => void;
}

const PANE_DIVIDER_HEIGHT = 7;

/** One column: a vertical stack of panes with draggable height dividers. */
export function PaneColumn({
  column,
  minWidth,
  focusedPaneId,
  resident,
  layoutEpoch,
  viewportHeight,
  unresponsivePanels,
  onDismissUnresponsive,
  onFocusPane,
  onClosePane,
  onSplitBelow,
  onOpenBeside,
  onShowAddressBar,
  onPanelAction,
  onResizePanes,
}: PaneColumnProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Live fractions during a divider drag; committed to layout state on release
  // so per-pointer-move renders stay local to this column (plan §11).
  const [liveFrs, setLiveFrs] = useState<number[] | null>(null);
  const liveFrsRef = useRef<number[] | null>(null);

  const frs = liveFrs ?? column.panes.map((pane) => pane.heightFr);
  const totalFr = frs.reduce((sum, fr) => sum + fr, 0);
  const canSplitBelow =
    (column.panes.length + 1) * (MIN_PANE_HEIGHT + PANE_CHROME_HEIGHT + PANE_DIVIDER_HEIGHT) <=
    viewportHeight;

  const dragBetween = (index: number, deltaPx: number) => {
    const height = containerRef.current?.getBoundingClientRect().height ?? 0;
    if (height <= 0) return;
    const current = liveFrsRef.current ?? column.panes.map((pane) => pane.heightFr);
    const total = current.reduce((sum, fr) => sum + fr, 0);
    const deltaFr = (deltaPx / height) * total;
    const minFr = (MIN_PANE_HEIGHT / height) * total;
    const next = [...current];
    const before = next[index];
    const after = next[index + 1];
    if (before === undefined || after === undefined) return;
    const applied = Math.max(Math.min(deltaFr, after - minFr), -(before - minFr));
    next[index] = before + applied;
    next[index + 1] = after - applied;
    liveFrsRef.current = next;
    setLiveFrs(next);
  };

  const commit = () => {
    if (liveFrsRef.current) onResizePanes(column.id, liveFrsRef.current);
    liveFrsRef.current = null;
    setLiveFrs(null);
  };

  return (
    <Flex
      direction="column"
      ref={containerRef}
      data-column-id={column.id}
      style={{
        flex: `${column.widthFr} 1 0`,
        minWidth,
        minHeight: 0,
        // Column entry/exit animates DOM chrome only (~150 ms, §6): surfaces
        // are hidden during residency transitions, and live divider drags
        // bypass the transition for instant tracking.
        transition: liveFrs === null ? "flex-grow 150ms ease-out" : "none",
      }}
    >
      {column.panes.map((pane, index) => (
        <Fragment key={pane.id}>
          {index > 0 && (
            <ResizableDivider
              orientation="horizontal"
              label={`Resize panes ${index} and ${index + 1}`}
              valueNow={(frs.slice(0, index).reduce((sum, fr) => sum + fr, 0) / totalFr) * 100}
              onDrag={(deltaPx) => dragBetween(index - 1, deltaPx)}
              onDragEnd={commit}
              onKeyboardStep={(deltaPx) => {
                dragBetween(index - 1, deltaPx);
                commit();
              }}
              onReset={() =>
                onResizePanes(
                  column.id,
                  column.panes.map(() => 1)
                )
              }
            />
          )}
          <PaneView
            pane={{ ...pane, heightFr: frs[index] ?? pane.heightFr }}
            focused={focusedPaneId === pane.id}
            resident={resident}
            layoutEpoch={layoutEpoch}
            canSplitBelow={canSplitBelow}
            unresponsive={unresponsivePanels.has(pane.panelId)}
            onDismissUnresponsive={onDismissUnresponsive}
            onFocusPane={onFocusPane}
            onClosePane={onClosePane}
            onSplitBelow={onSplitBelow}
            onOpenBeside={onOpenBeside}
            onShowAddressBar={onShowAddressBar}
            onPanelAction={onPanelAction}
          />
        </Fragment>
      ))}
    </Flex>
  );
}
