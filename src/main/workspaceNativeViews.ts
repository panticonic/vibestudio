import type { ViewManager, ViewConfig } from "./viewManager.js";

export interface WorkspaceViewIdentity {
  workspaceId: string;
  runtimeId: string;
}

/** Native resources use a qualified key; runtime APIs continue to use local IDs. */
export function workspaceNativeViewId(identity: WorkspaceViewIdentity): string {
  if (!identity.workspaceId || !identity.runtimeId)
    throw new Error("A native view needs workspace and runtime identities");
  return `workspace:${JSON.stringify([identity.workspaceId, identity.runtimeId])}`;
}

export function parseWorkspaceNativeViewId(id: string): WorkspaceViewIdentity | null {
  if (!id.startsWith("workspace:")) return null;
  try {
    const value: unknown = JSON.parse(id.slice("workspace:".length));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value.some((part) => typeof part !== "string" || !part)
    )
      return null;
    return { workspaceId: value[0] as string, runtimeId: value[1] as string };
  } catch {
    return null;
  }
}

/**
 * The workspace side of the single window's native-view boundary. PanelView
 * owns local runtime IDs; the compositor owns qualified native resources.
 * This adapter never chooses a workspace from focus or forwards unknown IDs.
 */
export class WorkspaceNativeViews {
  constructor(
    readonly workspaceId: string,
    private readonly window: ViewManager
  ) {
    if (!workspaceId) throw new Error("Workspace ID is required");
  }

  nativeId(runtimeId: string): string {
    return workspaceNativeViewId({ workspaceId: this.workspaceId, runtimeId });
  }

  setProtectedViews(ids: Set<string>): void {
    this.window.setWorkspaceProtectedViews(
      this.workspaceId,
      new Set([...ids].map((id) => this.nativeId(id)))
    );
  }

  getVisibleHostChromeAppId(): string | null {
    const id = this.window.getVisibleHostChromeAppId();
    const identity = id ? this.window.getViewInfo(id)?.workspaceIdentity : undefined;
    return identity?.workspaceId === this.workspaceId ? identity.runtimeId : null;
  }
  getShellOverlayActive() {
    return this.window.getShellOverlayActive();
  }
  getNativePanelSlotDebugInfo() {
    return this.window.getNativePanelSlotDebugInfo().flatMap((slot) => {
      const identity = parseWorkspaceNativeViewId(slot.panelId);
      return identity?.workspaceId === this.workspaceId
        ? [{ ...slot, panelId: identity.runtimeId }]
        : [];
    });
  }
  getDeclaredPanelSlotIds(): string[] {
    return this.window.getDeclaredPanelSlotIds().flatMap((id) => {
      const identity = parseWorkspaceNativeViewId(id);
      return identity?.workspaceId === this.workspaceId ? [identity.runtimeId] : [];
    });
  }
  getNativePanelSlotBinding(id: string) {
    return this.window.getNativePanelSlotBinding(this.nativeId(id));
  }
  attachDeclaredPanelSlot(id: string) {
    return this.window.attachDeclaredPanelSlot(this.nativeId(id));
  }

  createView(config: ViewConfig) {
    return this.window.createView({
      ...config,
      workspaceIdentity: { workspaceId: this.workspaceId, runtimeId: config.id },
      id: this.nativeId(config.id),
      ...(config.parentId ? { parentId: this.nativeId(config.parentId) } : {}),
    });
  }
  destroyView(id: string) {
    this.window.destroyView(this.nativeId(id));
  }
  focusView(id: string) {
    return this.window.focusView(this.nativeId(id));
  }
  captureView(id: string) {
    return this.window.captureView(this.nativeId(id));
  }
  isContentOverlayWebContentsId(id: number): boolean {
    return (
      this.getVisibleHostChromeAppId() !== null && this.window.isContentOverlayWebContentsId(id)
    );
  }
  getViewPartition(id: string) {
    return this.window.getViewPartition(this.nativeId(id));
  }
  getViewUrl(id: string) {
    return this.window.getViewUrl(this.nativeId(id));
  }
  getWebContents(id: string) {
    return this.window.getWebContents(this.nativeId(id));
  }
  getViewInfo(id: string) {
    return this.window.getViewInfo(this.nativeId(id));
  }
  hasView(id: string) {
    return this.window.hasView(this.nativeId(id));
  }
  isManagedNavigationInFlight(id: string, url: string) {
    return this.window.isManagedNavigationInFlight(this.nativeId(id), url);
  }
  navigateView(id: string, url: string, documentId?: string) {
    return this.window.navigateView(this.nativeId(id), url, documentId);
  }
  openDevTools(id: string, mode?: "detach" | "right" | "bottom") {
    return this.window.openDevTools(this.nativeId(id), mode);
  }
  reloadView(id: string) {
    return this.window.reloadView(this.nativeId(id));
  }
  retryViewNavigation(id: string, url: string) {
    return this.window.retryViewNavigation(this.nativeId(id), url);
  }
  setViewVisible(id: string, visible: boolean) {
    return this.window.setViewVisible(this.nativeId(id), visible);
  }
  updateAppView(
    id: string,
    ...args: Parameters<ViewManager["updateAppView"]> extends [string, ...infer Rest] ? Rest : never
  ) {
    return this.window.updateAppView(this.nativeId(id), ...args);
  }
  updateCodeIdentity(id: string, identity: Parameters<ViewManager["updateCodeIdentity"]>[1]) {
    return this.window.updateCodeIdentity(this.nativeId(id), identity);
  }
  findViewIdByWebContentsId(contentsId: number): string | null {
    const nativeId = this.window.findViewIdByWebContentsId(contentsId);
    const identity = nativeId ? parseWorkspaceNativeViewId(nativeId) : null;
    return identity?.workspaceId === this.workspaceId ? identity.runtimeId : null;
  }
}
