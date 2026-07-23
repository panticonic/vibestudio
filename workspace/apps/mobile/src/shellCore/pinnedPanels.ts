/**
 * Client-local, workspace-scoped panel pin store for mobile.
 *
 * Mirrors `localViewState.ts` (AsyncStorage via a `require` guard). Pins are
 * keyed by **slot id** and persist across reloads under a per-workspace key.
 */

import { getNativeAppStorage } from "../services/nativeAppStorage";

interface PinnedPanelsFile {
  version: 1;
  pinnedPanelIds: string[];
}

function storageKey(workspaceId: string): string {
  return `vibestudio:workspace:${workspaceId}:pinned-panels`;
}

export async function loadPinnedPanelIds(workspaceId: string): Promise<string[]> {
  const storage = getNativeAppStorage();
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
  const storage = getNativeAppStorage();
  const payload: PinnedPanelsFile = { version: 1, pinnedPanelIds };
  try {
    await storage.setItem(storageKey(workspaceId), JSON.stringify(payload));
  } catch {
    // Best-effort persistence; a failed write must not crash the shell.
  }
}
