import { describe, expect, it } from "vitest";
import { preferredPaneChild, type FocusedPaneChromeState } from "./paneChrome";

const baseState: FocusedPaneChromeState = {
  paneId: "pane-a",
  panelId: "panel-a",
  children: [
    { panelId: "panel-a/child-1", title: "First child" },
    { panelId: "panel-a/child-2", title: "Second child" },
  ],
  selectedChildPanelId: "panel-a/child-2",
  visiblePaneCount: 1,
};

describe("preferredPaneChild", () => {
  it("uses the last-active child and falls back to the first child", () => {
    expect(preferredPaneChild(baseState)?.panelId).toBe("panel-a/child-2");

    expect(
      preferredPaneChild({
        ...baseState,
        selectedChildPanelId: "missing-child",
      })?.panelId
    ).toBe("panel-a/child-1");
  });
});
