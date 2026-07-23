import { useDroppable } from "@dnd-kit/core";
import { Cross2Icon, DotsHorizontalIcon, ViewHorizontalIcon } from "@radix-ui/react-icons";
import { DropdownMenu, Flex, IconButton, Text } from "@radix-ui/themes";

import type { PanelContextMenuAction } from "@vibestudio/shared/types";
import { useFullPanel } from "../shell/hooks/PanelTreeContext";
import { PaneContent } from "./PaneContent";
import { paneDropId } from "../layout/dropTargets";
import type { LayoutPane } from "../layout/types";

export const PANE_CHROME_HEIGHT = 28;

interface PaneViewProps {
  pane: LayoutPane;
  focused: boolean;
  resident: boolean;
  layoutEpoch: number;
  /** Vertical fit test result for this pane's column (§4.3): full column disables split. */
  canSplitBelow: boolean;
  unresponsive: boolean;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onSplitBelow: (paneId: string) => void;
  onOpenBeside: (paneId: string) => void;
  onShowAddressBar: () => void;
  onPanelAction: (panelId: string, action: PanelContextMenuAction) => void;
}

/**
 * One pane: slim micro-header (title, split/close controls, overflow menu) over
 * the pane's content state machine. The header is DOM, so it is also the drop
 * target and context-menu host (D9); the ✕ is layout-only and never archives
 * the panel (D2).
 */
export function PaneView({
  pane,
  focused,
  resident,
  layoutEpoch,
  canSplitBelow,
  unresponsive,
  onDismissUnresponsive,
  onFocusPane,
  onClosePane,
  onSplitBelow,
  onOpenBeside,
  onShowAddressBar,
  onPanelAction,
}: PaneViewProps) {
  const { panel: fullPanel } = useFullPanel(pane.panelId);
  const title = fullPanel?.title ?? "Loading…";
  // The header is the pane's drop target for tree drags (D9: chrome only in
  // gutters and headers); the drop shows the dragged panel in this pane.
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
      <Flex
        ref={setDropRef}
        align="center"
        gap="1"
        px="2"
        onPointerDown={() => onFocusPane(pane.id)}
        style={{
          height: PANE_CHROME_HEIGHT,
          flexShrink: 0,
          backgroundColor: isDropOver
            ? "var(--accent-a5)"
            : focused
              ? "var(--accent-a3)"
              : "var(--gray-a2)",
          userSelect: "none",
        }}
      >
        <Text
          size="1"
          weight={focused ? "medium" : "regular"}
          truncate
          style={{ flex: "1 1 0", minWidth: 0, cursor: "default" }}
          onDoubleClick={onShowAddressBar}
        >
          {title}
        </Text>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          aria-label="Split below"
          disabled={!canSplitBelow}
          title={canSplitBelow ? "Split below" : "Column is full"}
          onClick={() => onSplitBelow(pane.id)}
        >
          <ViewHorizontalIcon />
        </IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton size="1" variant="ghost" color="gray" aria-label="Pane menu">
              <DotsHorizontalIcon />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content size="1">
            <DropdownMenu.Item onSelect={() => onPanelAction(pane.panelId, "reload-panel")}>
              Reload
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => onPanelAction(pane.panelId, "toggle-pin")}>
              Pin / Unpin
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => onOpenBeside(pane.id)}>
              Open in new column
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={!canSplitBelow} onSelect={() => onSplitBelow(pane.id)}>
              Split below
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            {/* Destructive tree operation, visually separated from layout ops (D2). */}
            <DropdownMenu.Item color="red" onSelect={() => onPanelAction(pane.panelId, "archive")}>
              Archive panel
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          aria-label="Close pane"
          title="Close pane (panel stays in the tree)"
          onClick={() => onClosePane(pane.id)}
        >
          <Cross2Icon />
        </IconButton>
      </Flex>
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
