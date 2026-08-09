import type { WorkspaceNode } from "@workspace/runtime";

export interface LaunchablePanelGroups {
  panels: WorkspaceNode[];
  about: WorkspaceNode[];
}

const byTitle = (a: WorkspaceNode, b: WorkspaceNode) =>
  (a.launchable?.title ?? a.name).localeCompare(b.launchable?.title ?? b.name);

/** Collect visible launch targets into the categories shown by the launcher. */
export function collectLaunchablePanelGroups(nodes: WorkspaceNode[]): LaunchablePanelGroups {
  const groups: LaunchablePanelGroups = { panels: [], about: [] };

  const visit = (node: WorkspaceNode) => {
    if (node.launchable && !node.launchable.hidden) {
      if (node.path.startsWith("panels/")) groups.panels.push(node);
      else if (node.path.startsWith("about/")) groups.about.push(node);
    }

    node.children.forEach(visit);
  };

  for (const node of nodes) {
    visit(node);
  }

  groups.panels.sort(byTitle);
  groups.about.sort(byTitle);
  return groups;
}
