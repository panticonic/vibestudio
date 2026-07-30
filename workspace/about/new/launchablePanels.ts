import type { WorkspaceNode } from "@workspace/runtime";

/** Flatten a workspace tree into the visible entries this panel can launch. */
export function collectLaunchablePanels(nodes: WorkspaceNode[]): WorkspaceNode[] {
  const result: WorkspaceNode[] = [];
  for (const node of nodes) {
    if (
      node.launchable &&
      !node.launchable.hidden &&
      (node.path.startsWith("panels/") || node.path.startsWith("about/"))
    ) {
      result.push(node);
    }
    result.push(...collectLaunchablePanels(node.children));
  }
  return result.sort((a, b) =>
    (a.launchable?.title ?? a.name).localeCompare(b.launchable?.title ?? b.name)
  );
}
