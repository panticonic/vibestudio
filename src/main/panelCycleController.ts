/**
 * Performing a step of the panel cycle, across workspaces.
 *
 * The order lives in `panelCycle.ts`; this is what it takes to act on it. Only
 * the main process can: each workspace's shell is its own renderer and sees
 * only its own tree, so nothing in a renderer could cycle past the edge of the
 * workspace it belongs to. Here the whole catalog and every open workspace's
 * registry are in one place.
 *
 * Landing on a panel in another workspace is two things, in this order: the
 * chrome has to bring that workspace's section forward, and the workspace has
 * to present the panel. Reversing them shows the panel appearing in a section
 * that is still sliding into place.
 */

import { createDevLogger } from "@vibestudio/dev-log";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import {
  panelPresentationOrder,
  stepPanelCycle,
  type CyclableWorkspace,
  type PanelCycleTarget,
} from "./panelCycle.js";

const log = createDevLogger("PanelCycle");

export interface PanelCycleDeps {
  /** Open workspaces in the order the chrome stacks their sections. */
  orderedWorkspaceIds(): readonly string[];
  /** The registry of one open workspace, or null when it is not open. */
  getRegistry(workspaceId: string): PanelRegistry | null;
  focusedWorkspaceId(): string | null;
  /** Make this workspace the focused one, chrome included. */
  focusWorkspace(workspaceId: string): void;
  /** Ask a workspace to present a panel it already owns. */
  presentPanel(workspaceId: string, panelId: string): void;
}

export interface PanelCycler {
  /** Move one panel along the presentation order. True when it moved. */
  cycle(forward: boolean): boolean;
}

export function createPanelCycler(deps: PanelCycleDeps): PanelCycler {
  const walk = (): CyclableWorkspace[] =>
    deps.orderedWorkspaceIds().flatMap((workspaceId) => {
      const registry = deps.getRegistry(workspaceId);
      if (!registry) return [];
      return [{ workspaceId, panelIds: panelPresentationOrder(registry.getPanelTreeSnapshot()) }];
    });

  const land = (target: PanelCycleTarget, from: string | null): void => {
    if (target.workspaceId !== from) deps.focusWorkspace(target.workspaceId);
    deps.presentPanel(target.workspaceId, target.panelId);
  };

  return {
    cycle(forward: boolean): boolean {
      const workspaces = walk();
      const focusedWorkspaceId = deps.focusedWorkspaceId();
      const focusedPanelId = focusedWorkspaceId
        ? (deps.getRegistry(focusedWorkspaceId)?.getFocusedPanelId() ?? null)
        : null;
      const target = stepPanelCycle(
        workspaces,
        { workspaceId: focusedWorkspaceId, panelId: focusedPanelId },
        forward
      );
      if (!target) {
        log.trace("Nothing to cycle to");
        return false;
      }
      land(target, focusedWorkspaceId);
      return true;
    },
  };
}
