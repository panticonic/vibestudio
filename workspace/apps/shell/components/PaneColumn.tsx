import { Fragment, useRef, useState } from "react";
import { Flex } from "@radix-ui/themes";

import { MIN_PANE_HEIGHT, type LayoutColumn } from "../layout/types";
import { PaneView } from "./PaneView";
import { ResizableDivider } from "./ResizableDivider";

interface PaneColumnProps {
  column: LayoutColumn;
  minWidth: number;
  focusedPaneId: string | null;
  resident: boolean;
  layoutEpoch: number;
  unresponsivePanels: Set<string>;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
  onResizePanes: (columnId: string, paneFrs: number[]) => void;
}

/** One column: a vertical stack of panes with draggable height dividers. */
export function PaneColumn({
  column,
  minWidth,
  focusedPaneId,
  resident,
  layoutEpoch,
  unresponsivePanels,
  onDismissUnresponsive,
  onFocusPane,
  onResizePanes,
}: PaneColumnProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Live fractions during a divider drag; committed to layout state on release
  // so per-pointer-move renders stay local to this column (plan §11).
  const [liveFrs, setLiveFrs] = useState<number[] | null>(null);
  const liveFrsRef = useRef<number[] | null>(null);

  const frs = liveFrs ?? column.panes.map((pane) => pane.heightFr);
  const totalFr = frs.reduce((sum, fr) => sum + fr, 0);
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
            unresponsive={unresponsivePanels.has(pane.panelId)}
            onDismissUnresponsive={onDismissUnresponsive}
            onFocusPane={onFocusPane}
          />
        </Fragment>
      ))}
    </Flex>
  );
}
