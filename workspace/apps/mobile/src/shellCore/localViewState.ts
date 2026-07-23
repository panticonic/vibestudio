import { createLocalPanelViewStateStore } from "@vibestudio/shell-core/localViewState";
import type { LocalPanelViewStateStore } from "@vibestudio/shell-core/panelManager";
import { getNativeAppStorage } from "../services/nativeAppStorage";

export function createMobileLocalViewStateStore(workspaceId: string): LocalPanelViewStateStore {
  const key = `vibestudio:workspace:${workspaceId}:local-view-state`;
  return createLocalPanelViewStateStore({
    async read() {
      return getNativeAppStorage().getItem(key);
    },
    async write(serialized) {
      await getNativeAppStorage().setItem(key, serialized);
    },
  });
}
