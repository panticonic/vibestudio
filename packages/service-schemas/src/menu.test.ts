import { describe, expect, it } from "vitest";
import { PanelContextMenuActionSchema, PanelContextPresentationSchema } from "./menu.js";

describe("PanelContextMenuActionSchema", () => {
  it("exposes the shared pane commands used by tree and breadcrumb context menus", () => {
    for (const action of [
      "open-child-beside",
      "add-child-below",
      "open-in-new-column",
      "close-pane",
    ]) {
      expect(PanelContextMenuActionSchema.parse(action)).toBe(action);
    }
  });

  it("validates per-device pane presentation capabilities", () => {
    expect(PanelContextPresentationSchema.parse({ kind: "stacked", canSplitBelow: true })).toEqual({
      kind: "stacked",
      canSplitBelow: true,
    });
  });
});
