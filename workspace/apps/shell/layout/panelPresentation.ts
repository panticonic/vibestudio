import { paneForPanel } from "./placementEngine";
import type { LayoutAction } from "./placementEngine";
import type { PanelLayout } from "./types";

/**
 * Resolve the context-menu "Open in New Column" command without duplicating
 * layout policy in the tree, breadcrumbs, or pane chrome.
 */
export function openInNewColumnAction(
  layout: PanelLayout,
  panelId: string,
  anchorPanelId?: string
): LayoutAction {
  const existing = paneForPanel(layout, panelId);
  if (existing) {
    return existing.column.panes.length > 1
      ? { type: "move-pane-to-new-column", paneId: existing.pane.id }
      : { type: "focus-pane", paneId: existing.pane.id };
  }
  const anchorPaneId = anchorPanelId
    ? (paneForPanel(layout, anchorPanelId)?.pane.id ?? layout.focusedPaneId)
    : layout.focusedPaneId;
  if (anchorPaneId) {
    return {
      type: "open-beside",
      panelId,
      anchorPaneId,
    };
  }
  return { type: "show-panel", panelId, origin: "navigate-event" };
}
