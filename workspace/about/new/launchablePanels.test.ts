import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "@workspace/runtime";
import { collectLaunchablePanels } from "./launchablePanels";

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

describe("collectLaunchablePanels", () => {
  it("returns only visible panel targets", () => {
    const panels = collectLaunchablePanels([
      node("panels", {
        children: [
          node("panels/terminal", { launchable: true, title: "Terminal" }),
          node("panels/chat", { launchable: true, title: "Chat" }),
          node("panels/internal", { launchable: true, title: "Internal", hidden: true }),
        ],
      }),
      node("about", {
        children: [node("about/help", { launchable: true, title: "Help" })],
      }),
      node("skills/example"),
      node("extensions/example"),
      node("workers/agent", { launchable: true, title: "Agent" }),
    ]);

    expect(panels.map((panel) => panel.path)).toEqual([
      "panels/chat",
      "about/help",
      "panels/terminal",
    ]);
  });
});
