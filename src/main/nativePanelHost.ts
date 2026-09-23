import {
  NativePanelAdapterHelloSchema,
  NativePanelDesiredSnapshotSchema,
} from "@vibestudio/service-schemas/view";
import type { ViewManager } from "./viewManager.js";

/** Window-local presentation. Workspace admission happens when its runtime opens. */
export function createNativePanelHost(deps: {
  getViewManager(): ViewManager;
  hasWorkspace(workspaceId: string): boolean;
  openWorkspace(workspaceId: string): Promise<unknown>;
  onFocusedWorkspaceChanged(workspaceId: string | null): void;
  onNativeSlotChanged(nativeId: string, declared: boolean): void;
}) {
  function owner(senderId: number) {
    const vm = deps.getViewManager();
    const id = vm.findViewIdByWebContentsId(senderId);
    const info = id ? vm.getViewInfo(id) : null;
    if (!id || info?.type !== "app" || !info.hostChrome)
      throw new Error("Native presentation is available only to the hosted shell");
    return { vm, id };
  }
  return {
    async openWorkspace(senderId: number, workspaceId: unknown) {
      owner(senderId);
      if (typeof workspaceId !== "string" || !workspaceId.trim())
        throw new Error("A workspace ID is required");
      await deps.openWorkspace(workspaceId);
    },
    connect(senderId: number, input: unknown) {
      const { vm, id } = owner(senderId);
      return vm.connectNativePanelAdapter(id, NativePanelAdapterHelloSchema.parse(input));
    },
    async apply(senderId: number, input: unknown) {
      const { vm, id } = owner(senderId);
      const snapshot = NativePanelDesiredSnapshotSchema.parse(input);
      const workspaces = new Set(snapshot.surfaces.map((s) => s.materialization.workspaceId));
      if (snapshot.focusedWorkspaceId) workspaces.add(snapshot.focusedWorkspaceId);
      for (const workspaceId of workspaces) {
        if (!deps.hasWorkspace(workspaceId))
          throw new Error("Workspace is not open on this desktop");
      }
      const previous = new Set(vm.getDeclaredPanelSlotIds());
      const result = await vm.applyNativePanelSurfaces(id, snapshot);
      if (result.accepted) {
        deps.onFocusedWorkspaceChanged(result.observation.focusedWorkspaceId);
        const current = new Set(vm.getDeclaredPanelSlotIds());
        for (const panelId of previous)
          if (!current.has(panelId)) deps.onNativeSlotChanged(panelId, false);
        for (const panelId of current)
          if (!previous.has(panelId)) deps.onNativeSlotChanged(panelId, true);
      }
      return result;
    },
  };
}
