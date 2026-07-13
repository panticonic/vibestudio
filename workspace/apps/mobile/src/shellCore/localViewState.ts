import { createLocalPanelViewStateStore } from "@vibestudio/shell-core/localViewState";
import type { LocalPanelViewStateStore } from "@vibestudio/shell-core/panelManager";

declare const require: (moduleName: string) => unknown;

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

function getAsyncStorage(): AsyncStorageLike | null {
  try {
    const mod = require("@react-native-async-storage/async-storage") as {
      default?: AsyncStorageLike;
    } & AsyncStorageLike;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export function createMobileLocalViewStateStore(workspaceId: string): LocalPanelViewStateStore {
  const key = `vibestudio:workspace:${workspaceId}:local-view-state`;
  return createLocalPanelViewStateStore({
    async read() {
      const storage = getAsyncStorage();
      if (!storage) return null;
      return storage.getItem(key);
    },
    async write(serialized) {
      const storage = getAsyncStorage();
      if (!storage) return;
      await storage.setItem(key, serialized);
    },
  });
}
