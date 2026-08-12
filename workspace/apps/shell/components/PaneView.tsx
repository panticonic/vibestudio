import { useState } from "react";
import { Cross2Icon } from "@radix-ui/react-icons";
import { Box, Flex, IconButton, Tooltip } from "@radix-ui/themes";
import { useTouchDevice } from "@workspace/react/responsive";

import { PaneContent } from "./PaneContent";
import { PANE_ACTION_RAIL_HEIGHT, PANE_FOCUS_RAIL_HEIGHT, type LayoutPane } from "../layout/types";

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
  onClosePane?: (paneId: string) => void;
}

/**
 * One pane: a native-view content state machine with a transparent hover strip
 * above it. Multi-pane controls live in one centered capsule instead of drawing
 * a toolbar across the pane.
 *
 * Native panel views composite above ordinary shell DOM, so this reserved strip
 * is the only reliable place for pane-local controls. It remains visually empty
 * until interaction instead of masquerading as a persistent toolbar.
 *
 * The strip is completely invisible at rest. Hover, keyboard focus, or a touch
 * pointer reveals the centered grip and its pane-local close action together.
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
  onClosePane,
}: PaneViewProps) {
  const isTouch = useTouchDevice();
  const [railHovered, setRailHovered] = useState(false);
  const [railFocusWithin, setRailFocusWithin] = useState(false);
  const markFocused = focused && showPaneFocus;
  const railHeight = onClosePane ? PANE_ACTION_RAIL_HEIGHT : PANE_FOCUS_RAIL_HEIGHT;
  const controlsExpanded = Boolean(onClosePane) && (railHovered || railFocusWithin || isTouch);

  return (
    <Flex
      direction="column"
      data-pane-id={pane.id}
      style={{
        flex: `${pane.heightFr} 1 0`,
        minHeight: 0,
        minWidth: 0,
        // Square, deliberately. A radius here only ever reached the top two
        // corners: the top strip is shell DOM and gets clipped, while the rest
        // of the pane is a natively composited view that `overflow: hidden`
        // cannot touch — so the frame read rounded above and square below.
        // Rounding both would mean rounding the native view host-side; flush is
        // the house style for structural panes anyway (see overrides.css, where
        // the sidebar card sets border-radius: 0 for the same reason).
        borderRadius: 0,
        overflow: "hidden",
      }}
    >
      <Box
        onPointerEnter={() => setRailHovered(true)}
        onPointerLeave={() => setRailHovered(false)}
        onFocusCapture={() => setRailFocusWithin(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setRailFocusWithin(false);
          }
        }}
        style={{
          height: railHeight,
          flexShrink: 0,
          position: "relative",
          backgroundColor: "transparent",
        }}
      >
        <Flex
          align="center"
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            transform: "translateX(-50%)",
            width: 72,
            height: "100%",
            border: "1px solid var(--gray-a6)",
            borderRadius: 999,
            backgroundColor: "var(--gray-a4)",
            opacity: controlsExpanded ? 1 : 0,
            overflow: "hidden",
            transition: "opacity 90ms ease-out",
          }}
        >
          <button
            type="button"
            aria-label="Focus pane"
            title="Focus pane"
            onClick={() => onFocusPane(pane.id)}
            style={{
              width: 46,
              height: "100%",
              flexShrink: 0,
              padding: 0,
              border: 0,
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                height: 3,
                width: 28,
                borderRadius: 999,
                backgroundColor: markFocused ? "var(--gray-a10)" : "var(--gray-a8)",
              }}
            />
          </button>
          {onClosePane && (
            <Tooltip content="Close pane — panel stays in the tree">
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                radius="full"
                aria-label="Close pane"
                data-pane-close={pane.id}
                tabIndex={controlsExpanded ? 0 : -1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClosePane(pane.id);
                }}
                style={{
                  width: 24,
                  height: "100%",
                  flexShrink: 0,
                  padding: 0,
                }}
              >
                <Cross2Icon width={12} height={12} />
              </IconButton>
            </Tooltip>
          )}
        </Flex>
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
