/**
 * Walking every panel there is, in the order they are presented.
 *
 * A browser cycles tabs because a tab strip is a flat list. This app has
 * trees, and more than one of them: each workspace owns a forest, and the
 * chrome stacks the workspaces in catalog order. So "the next one along" is a
 * walk of all of it — depth-first through each tree, tree after tree, and
 * workspace after workspace — which is the order the panel tree is read in and
 * therefore the order a person expects to move through.
 *
 * The whole tree participates, not only what happens to be on screen. A panel
 * that is not in a pane is presented when the cycle reaches it, the same way
 * clicking it in the tree would: cycling is how you get to a panel you cannot
 * see, so skipping those would defeat it.
 *
 * This module is the order and the arithmetic, with no opinion about how a
 * panel is presented or how a workspace is focused — those belong to the
 * caller, and keeping them out is what makes the order testable.
 */

import type { Panel, PanelTreeSnapshot } from "@vibestudio/shared/types";

/** One workspace's panels, already in presentation order. */
export interface CyclableWorkspace {
  workspaceId: string;
  panelIds: readonly string[];
}

/** Where the cycle currently stands, as the host knows it. */
export interface PanelCyclePosition {
  workspaceId: string | null;
  panelId: string | null;
}

/** The panel a step lands on. */
export interface PanelCycleTarget {
  workspaceId: string;
  panelId: string;
}

/**
 * One workspace's panels, depth-first, in the order its tree presents them.
 *
 * Owner groups keep the order the registry bucketed them into, which is the
 * order the sidebar bands them in, so a shared workspace cycles one person's
 * trees before the next person's rather than interleaving them.
 */
export function panelPresentationOrder(snapshot: PanelTreeSnapshot): string[] {
  const order: string[] = [];
  const visit = (panel: Panel): void => {
    order.push(panel.id);
    for (const child of panel.children ?? []) visit(child);
  };
  for (const group of snapshot.forest) {
    for (const root of group.rootPanels) visit(root);
  }
  return order;
}

/**
 * The panel one step from here, wrapping at both ends.
 *
 * Wrapping matters more than it sounds: a cycle that stops leaves the user
 * pressing a key that does nothing and no way to tell whether they are at the
 * end or the shortcut is broken.
 */
export function stepPanelCycle(
  workspaces: readonly CyclableWorkspace[],
  current: PanelCyclePosition,
  forward: boolean
): PanelCycleTarget | null {
  const flat: PanelCycleTarget[] = workspaces.flatMap((workspace) =>
    workspace.panelIds.map((panelId) => ({ workspaceId: workspace.workspaceId, panelId }))
  );
  if (flat.length === 0) return null;

  const index = flat.findIndex(
    (entry) => entry.workspaceId === current.workspaceId && entry.panelId === current.panelId
  );
  if (index === -1) {
    // Nothing focused, or a focus this walk does not contain — an archived
    // panel, or a workspace that has since closed. Each direction then means
    // what it means from outside the order: forward enters at the front.
    return forward ? (flat[0] ?? null) : (flat[flat.length - 1] ?? null);
  }
  const next = (index + (forward ? 1 : -1) + flat.length) % flat.length;
  return flat[next] ?? null;
}
