import { describe, expect, it } from "vitest";
import { openInNewColumnAction } from "./panelPresentation";
import type { PanelLayout } from "./types";

describe("openInNewColumnAction", () => {
  it("opens a hidden tree or breadcrumb panel beside the focused pane", () => {
    const layout: PanelLayout = {
      columns: [
        {
          id: "column-a",
          widthFr: 1,
          panes: [{ id: "pane-a", heightFr: 1, panelId: "panel-a" }],
        },
      ],
      focusedPaneId: "pane-a",
    };

    expect(openInNewColumnAction(layout, "panel-b")).toEqual({
      type: "open-beside",
      panelId: "panel-b",
      anchorPaneId: "pane-a",
    });
  });

  it("opens a child beside the context-menu target even when another pane is focused", () => {
    const layout: PanelLayout = {
      columns: [
        {
          id: "column-a",
          widthFr: 1,
          panes: [{ id: "pane-a", heightFr: 1, panelId: "panel-a" }],
        },
        {
          id: "column-b",
          widthFr: 1,
          panes: [{ id: "pane-b", heightFr: 1, panelId: "panel-b" }],
        },
      ],
      focusedPaneId: "pane-a",
    };

    expect(openInNewColumnAction(layout, "panel-child", "panel-b")).toEqual({
      type: "open-beside",
      panelId: "panel-child",
      anchorPaneId: "pane-b",
    });
  });

  it("moves a visible stacked pane into its own column", () => {
    const layout: PanelLayout = {
      columns: [
        {
          id: "column-a",
          widthFr: 1,
          panes: [
            { id: "pane-a", heightFr: 1, panelId: "panel-a" },
            { id: "pane-b", heightFr: 1, panelId: "panel-b" },
          ],
        },
      ],
      focusedPaneId: "pane-a",
    };

    expect(openInNewColumnAction(layout, "panel-b")).toEqual({
      type: "move-pane-to-new-column",
      paneId: "pane-b",
    });
  });

  it("focuses a panel that is already alone in a column", () => {
    const layout: PanelLayout = {
      columns: [
        {
          id: "column-a",
          widthFr: 1,
          panes: [{ id: "pane-a", heightFr: 1, panelId: "panel-a" }],
        },
      ],
      focusedPaneId: null,
    };

    expect(openInNewColumnAction(layout, "panel-a")).toEqual({
      type: "focus-pane",
      paneId: "pane-a",
    });
  });
});
