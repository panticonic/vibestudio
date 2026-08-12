export type MobileBackAction = "close-address" | "browser-back" | "parent-panel" | "system";

export interface MobileBackState {
  drawerOpen: boolean;
  addressBarVisible: boolean;
  browserCanGoBack: boolean;
  parentPanelId: string | null;
}

/** Resolve Android back from the most transient mobile surface outward. */
export function resolveMobileBackAction(state: MobileBackState): MobileBackAction {
  if (state.drawerOpen) return "system";
  if (state.addressBarVisible) return "close-address";
  if (state.browserCanGoBack) return "browser-back";
  if (state.parentPanelId) return "parent-panel";
  return "system";
}
