import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "@workspace/runtime";
import { collectLaunchablePanelGroups } from "./launchablePanels";

function node(
  path: string,
  options: {
    title?: string;
    hidden?: boolean;
    children?: WorkspaceNode[];
    launchable?: boolean;
  } = {}
): WorkspaceNode {
  return {
    name: path.split("/").at(-1) ?? path,
    path,
    isUnit: path.includes("/"),
    children: options.children ?? [],
    ...(options.launchable
      ? {
          launchable: {
            type: "app" as const,
            title: options.title ?? path,
            ...(options.hidden ? { hidden: true } : {}),
          },
        }
      : {}),
  };
}

describe("collectLaunchablePanelGroups", () => {
  it("groups visible panel targets by workspace source", () => {
    const groups = collectLaunchablePanelGroups([
      node("panels", {
        children: [
          node("panels/terminal", { launchable: true, title: "Terminal" }),
          node("panels/chat", { launchable: true, title: "Chat" }),
          node("panels/internal", { launchable: true, title: "Internal", hidden: true }),
        ],
      }),
      node("about", {
        children: [
          node("about/help", { launchable: true, title: "Help" }),
          node("about/about", { launchable: true, title: "About Vibestudio" }),
        ],
      }),
      node("skills/example"),
      node("extensions/example"),
      node("workers/agent", { launchable: true, title: "Agent" }),
    ]);

    expect(groups.panels.map((panel) => panel.path)).toEqual(["panels/chat", "panels/terminal"]);
    expect(groups.about.map((panel) => panel.path)).toEqual(["about/about", "about/help"]);
  });
});
