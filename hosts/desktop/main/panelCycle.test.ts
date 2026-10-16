import { describe, expect, it } from "vitest";
import { panelPresentationOrder, stepPanelCycle, type CyclableWorkspace } from "./panelCycle.js";
import type { Panel, PanelTreeSnapshot } from "@vibestudio/shared/types";

function panel(id: string, children: Panel[] = []): Panel {
  return { id, title: id, children } as unknown as Panel;
}

function snapshot(forest: Array<{ owner: string; rootPanels: Panel[] }>): PanelTreeSnapshot {
  return { revision: 1, forest };
}

const workspaces: CyclableWorkspace[] = [
  { workspaceId: "personal", panelIds: ["p1", "p2"] },
  { workspaceId: "system", panelIds: ["s1"] },
];

describe("panel presentation order", () => {
  it("walks each tree depth-first, parents before their children", () => {
    const order = panelPresentationOrder(
      snapshot([
        {
          owner: "",
          rootPanels: [panel("a", [panel("a1", [panel("a1x")]), panel("a2")]), panel("b")],
        },
      ])
    );
    expect(order).toEqual(["a", "a1", "a1x", "a2", "b"]);
  });

  it("keeps owner groups whole, the way the tree bands them", () => {
    const order = panelPresentationOrder(
      snapshot([
        { owner: "ada", rootPanels: [panel("ada-1", [panel("ada-1a")])] },
        { owner: "bob", rootPanels: [panel("bob-1")] },
      ])
    );
    expect(order).toEqual(["ada-1", "ada-1a", "bob-1"]);
  });

  it("has nothing to walk in an empty workspace", () => {
    expect(panelPresentationOrder(snapshot([]))).toEqual([]);
  });
});

describe("stepping the cycle", () => {
  it("moves within a workspace", () => {
    expect(stepPanelCycle(workspaces, { workspaceId: "personal", panelId: "p1" }, true)).toEqual({
      workspaceId: "personal",
      panelId: "p2",
    });
  });

  it("crosses into the next workspace at the end of a tree", () => {
    // The point of the request this implements: the cycle does not stop at the
    // edge of the workspace you happen to be in.
    expect(stepPanelCycle(workspaces, { workspaceId: "personal", panelId: "p2" }, true)).toEqual({
      workspaceId: "system",
      panelId: "s1",
    });
  });

  it("wraps around both ends", () => {
    expect(stepPanelCycle(workspaces, { workspaceId: "system", panelId: "s1" }, true)).toEqual({
      workspaceId: "personal",
      panelId: "p1",
    });
    expect(stepPanelCycle(workspaces, { workspaceId: "personal", panelId: "p1" }, false)).toEqual({
      workspaceId: "system",
      panelId: "s1",
    });
  });

  it("enters at the end the direction comes from when the focus is unknown", () => {
    // An archived panel, or a workspace that closed under the focus.
    expect(stepPanelCycle(workspaces, { workspaceId: null, panelId: null }, true)).toEqual({
      workspaceId: "personal",
      panelId: "p1",
    });
    expect(stepPanelCycle(workspaces, { workspaceId: "gone", panelId: "x" }, false)).toEqual({
      workspaceId: "system",
      panelId: "s1",
    });
  });

  it("has nowhere to go with no panels anywhere", () => {
    expect(stepPanelCycle([], { workspaceId: "personal", panelId: "p1" }, true)).toBeNull();
    expect(
      stepPanelCycle(
        [{ workspaceId: "personal", panelIds: [] }],
        { workspaceId: "personal", panelId: null },
        true
      )
    ).toBeNull();
  });

  it("stays put when it is the only panel there is", () => {
    const only: CyclableWorkspace[] = [{ workspaceId: "personal", panelIds: ["p1"] }];
    expect(stepPanelCycle(only, { workspaceId: "personal", panelId: "p1" }, true)).toEqual({
      workspaceId: "personal",
      panelId: "p1",
    });
  });
});
