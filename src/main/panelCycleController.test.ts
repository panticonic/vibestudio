import { describe, expect, it, vi } from "vitest";
import { createPanelCycler, type PanelCycleDeps } from "./panelCycleController.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { Panel } from "@vibestudio/shared/types";

function registry(panelIds: string[], focusedPanelId: string | null): PanelRegistry {
  return {
    getPanelTreeSnapshot: () => ({
      revision: 1,
      forest: [
        {
          owner: "",
          rootPanels: panelIds.map((id) => ({ id, title: id, children: [] }) as unknown as Panel),
        },
      ],
    }),
    getFocusedPanelId: () => focusedPanelId,
  } as unknown as PanelRegistry;
}

function harness(options: {
  order: string[];
  registries: Record<string, PanelRegistry>;
  focused: string | null;
}) {
  const focusWorkspace = vi.fn();
  const presentPanel = vi.fn();
  const deps: PanelCycleDeps = {
    orderedWorkspaceIds: () => options.order,
    getRegistry: (workspaceId) => options.registries[workspaceId] ?? null,
    focusedWorkspaceId: () => options.focused,
    focusWorkspace,
    presentPanel,
  };
  return { cycler: createPanelCycler(deps), focusWorkspace, presentPanel };
}

describe("cycling panels across workspaces", () => {
  it("presents the next panel without touching workspace focus inside one tree", () => {
    const { cycler, focusWorkspace, presentPanel } = harness({
      order: ["personal", "system"],
      registries: {
        personal: registry(["p1", "p2"], "p1"),
        system: registry(["s1"], null),
      },
      focused: "personal",
    });

    expect(cycler.cycle(true)).toBe(true);
    expect(presentPanel).toHaveBeenCalledWith("personal", "p2");
    expect(focusWorkspace).not.toHaveBeenCalled();
  });

  it("brings the next workspace forward before presenting a panel in it", () => {
    // Order matters: presenting first shows the panel appearing in a section
    // that has not come forward yet.
    const calls: string[] = [];
    const { cycler, focusWorkspace, presentPanel } = harness({
      order: ["personal", "system"],
      registries: {
        personal: registry(["p1"], "p1"),
        system: registry(["s1"], null),
      },
      focused: "personal",
    });
    focusWorkspace.mockImplementation((id: string) => calls.push(`focus:${id}`));
    presentPanel.mockImplementation((workspaceId: string, panelId: string) =>
      calls.push(`present:${workspaceId}/${panelId}`)
    );

    expect(cycler.cycle(true)).toBe(true);
    expect(calls).toEqual(["focus:system", "present:system/s1"]);
  });

  it("skips a workspace in the catalog that is not open", () => {
    const { cycler, presentPanel } = harness({
      order: ["personal", "closed", "system"],
      registries: {
        personal: registry(["p1"], "p1"),
        system: registry(["s1"], null),
      },
      focused: "personal",
    });

    expect(cycler.cycle(true)).toBe(true);
    expect(presentPanel).toHaveBeenCalledWith("system", "s1");
  });

  it("reports that it could not move when there is nothing anywhere", () => {
    const { cycler, presentPanel } = harness({
      order: ["personal"],
      registries: { personal: registry([], null) },
      focused: "personal",
    });

    expect(cycler.cycle(true)).toBe(false);
    expect(presentPanel).not.toHaveBeenCalled();
  });
});
