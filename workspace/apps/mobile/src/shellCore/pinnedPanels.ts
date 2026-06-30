/**
 * Client-local, workspace-scoped panel pin store for mobile.
 *
 * Mirrors `localViewState.ts` (AsyncStorage via a `require` guard). Pins are
 * keyed by **slot id** and persist across reloads under a per-workspace key.
 */

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

interface PinnedPanelsFile {
  version: 1;
  pinnedPanelIds: string[];
}

function storageKey(workspaceId: string): string {
  return `vibez1:workspace:${workspaceId}:pinned-panels`;
}

export async function loadPinnedPanelIds(workspaceId: string): Promise<string[]> {
  const storage = getAsyncStorage();
  if (!storage) return [];
  try {
    const raw = await storage.getItem(storageKey(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PinnedPanelsFile>;
    return Array.isArray(parsed.pinnedPanelIds)
      ? parsed.pinnedPanelIds.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export async function savePinnedPanelIds(
  workspaceId: string,
  pinnedPanelIds: string[],
): Promise<void> {
  const storage = getAsyncStorage();
  if (!storage) return;
  const payload: PinnedPanelsFile = { version: 1, pinnedPanelIds };
  try {
    await storage.setItem(storageKey(workspaceId), JSON.stringify(payload));
  } catch {
    // Best-effort persistence; a failed write must not crash the shell.
  }
}
