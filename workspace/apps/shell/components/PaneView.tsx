import { useDroppable } from "@dnd-kit/core";
import { Box, Flex } from "@radix-ui/themes";

import { PaneContent } from "./PaneContent";
import { paneDropId } from "../layout/dropTargets";
import { PANE_DROP_HANDLE_HEIGHT, type LayoutPane } from "../layout/types";

interface PaneViewProps {
  pane: LayoutPane;
  focused: boolean;
  /**
   * Whether focus is worth drawing at all — false when this is the only pane on
   * screen. Separate from `focused`, which stays true regardless because it also
   * drives native slot binding.
   */
  showPaneFocus: boolean;
  resident: boolean;
  layoutEpoch: number;
  unresponsive: boolean;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
}

/**
 * One pane: a native-view content state machine with only a six-pixel shell
 * rail above it. The rail preserves an unobscured tree-drop target (D9)
 * without duplicating the titlebar for every vertically stacked pane. Actions
 * for the focused pane live in the global titlebar, outside native-view bounds.
 *
 * The rail also has to carry focus. A pane's outline is drawn on shell DOM, but
 * the native view composites above it and sits flush to the left, right and
 * bottom edges, so only the top strip is ever actually visible — which is why
 * this doubles as the focus indicator. It says so in neutral greys rather than
 * a brand wash: a saturated slab across the top of every pane fights whatever
 * page is rendering below it. The accent is spent only while a drag is over the
 * rail, where it has to read instantly.
 *
 * Only the drop target needs the full six pixels; the *mark* does not. Painting
 * the whole strip made every pane look capped by a stray scrollbar, so the rail
 * itself stays transparent and a short centred grip carries the state instead —
 * grown and darkened when focused, the way a handle is meant to read. Drag-over
 * is the one case that still washes the entire strip, because at that moment
 * the question being answered is "how big is the target", not "which pane".
 */
export function PaneView({
  pane,
  focused,
  showPaneFocus,
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
  const markFocused = focused && showPaneFocus;

  return (
    <Flex
      direction="column"
      data-pane-id={pane.id}
      style={{
        flex: `${pane.heightFr} 1 0`,
        minHeight: 0,
        minWidth: 0,
        // Frame hairline (D7/§6). Kept to one neutral pixel in both states: the
        // native view hides all but the top edge, where a heavier ring would
        // only thicken the rail below into a band.
        outline: markFocused ? "1px solid var(--gray-a7)" : "1px solid var(--gray-a4)",
        outlineOffset: -1,
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
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isDropOver ? "var(--accent-8)" : "transparent",
          cursor: "default",
          transition: "background-color 120ms ease-out",
        }}
      >
        <Box
          style={{
            height: 2,
            width: markFocused ? 40 : 24,
            borderRadius: 999,
            backgroundColor: isDropOver
              ? "var(--accent-1)"
              : markFocused
                ? "var(--gray-a8)"
                : "var(--gray-a5)",
            transition: "width 120ms ease-out, background-color 120ms ease-out",
          }}
        />
      </Box>
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
