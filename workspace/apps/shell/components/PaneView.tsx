import { useDroppable } from "@dnd-kit/core";
import { Box, Flex } from "@radix-ui/themes";

import { PaneContent } from "./PaneContent";
import { paneDropId } from "../layout/dropTargets";
import { PANE_DROP_HANDLE_HEIGHT, type LayoutPane } from "../layout/types";

interface PaneViewProps {
  pane: LayoutPane;
  focused: boolean;
  resident: boolean;
  layoutEpoch: number;
  unresponsive: boolean;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
}

/**
 * One pane: a native-view content state machine with only a six-pixel shell
 * handle above it. The handle preserves an unobscured tree-drop target (D9)
 * without duplicating the titlebar for every vertically stacked pane. Actions
 * for the focused pane live in the global titlebar, outside native-view bounds.
 */
export function PaneView({
  pane,
  focused,
  resident,
  layoutEpoch,
  unresponsive,
  onDismissUnresponsive,
  onFocusPane,
}: PaneViewProps) {
  // Native WebContentsViews always composite above renderer DOM. Keep the drop
  // target in reserved shell chrome rather than attempting a hover overlay.
  const { setNodeRef: setDropRef, isOver: isDropOver } = useDroppable({
    id: paneDropId(pane.id),
  });

  return (
    <Flex
      direction="column"
      data-pane-id={pane.id}
      style={{
        flex: `${pane.heightFr} 1 0`,
        minHeight: 0,
        minWidth: 0,
        // Focus ring on the pane frame (D7/§6): accent for focused, hairline otherwise.
        outline: focused ? "2px solid var(--accent-8)" : "1px solid var(--gray-a5)",
        outlineOffset: -2,
        borderRadius: "var(--radius-2)",
        overflow: "hidden",
      }}
    >
      <Box
        ref={setDropRef}
        onPointerDown={() => onFocusPane(pane.id)}
        role="button"
        tabIndex={0}
        aria-label="Focus pane; drop a panel here to replace its contents"
        title="Drop a panel here"
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onFocusPane(pane.id);
          }
        }}
        style={{
          height: PANE_DROP_HANDLE_HEIGHT,
          flexShrink: 0,
          backgroundColor: isDropOver
            ? "var(--accent-8)"
            : focused
              ? "var(--accent-a6)"
              : "var(--gray-a4)",
          cursor: "default",
          transition: "background-color 120ms ease-out",
        }}
      />
      <Flex direction="column" style={{ flex: "1 1 0", minHeight: 0, minWidth: 0 }}>
        <PaneContent
          paneId={pane.id}
          panelId={pane.panelId}
          resident={resident}
          focused={focused}
          layoutEpoch={layoutEpoch}
          unresponsive={unresponsive}
          onDismissUnresponsive={onDismissUnresponsive}
          onFocusPane={onFocusPane}
        />
      </Flex>
    </Flex>
  );
}
