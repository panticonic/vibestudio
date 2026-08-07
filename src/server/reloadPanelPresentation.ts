import type { PanelLifecycleResult } from "@vibestudio/shared/types";
import type { CdpBridge } from "./cdpBridge.js";

type PanelPresentationBridge = Pick<CdpBridge, "isTargetRegistered" | "sendHostCommand">;

/**
 * Reload an already presented panel in place on its owning host.
 *
 * CDP automation pins the current lease so eviction cannot tear a page out
 * from under an operation. Reload is compatible with that pin: the host owns
 * the webContents/page and can navigate it without releasing residency.
 * Returning false means there is no registered presentation and the caller
 * must use the normal allocation path.
 */
export async function reloadRegisteredPanelPresentation(
  bridge: PanelPresentationBridge,
  panelId: string
): Promise<boolean> {
  if (!bridge.isTargetRegistered(panelId)) return false;

  const result = (await bridge.sendHostCommand(
    panelId,
    "reloadPanel",
    []
  )) as PanelLifecycleResult | null;
  if (!result?.reloaded) {
    throw new Error(`Presentation host did not reload panel ${panelId}`);
  }
  return true;
}
