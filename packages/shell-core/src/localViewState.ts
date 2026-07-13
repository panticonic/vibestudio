import type { LocalPanelViewState, LocalPanelViewStateStore } from "./panelManager.js";

export interface LocalViewStateStorage {
  read(): Promise<string | null>;
  write(serialized: string): Promise<void>;
}

function parseLocalPanelViewState(serialized: string): LocalPanelViewState {
  const parsed = JSON.parse(serialized) as Partial<LocalPanelViewState>;
  return {
    collapsedIds: Array.isArray(parsed.collapsedIds)
      ? parsed.collapsedIds.filter((id): id is string => typeof id === "string")
      : [],
    focusedPanelId: typeof parsed.focusedPanelId === "string" ? parsed.focusedPanelId : null,
    panelTitles:
      parsed.panelTitles && typeof parsed.panelTitles === "object"
        ? Object.fromEntries(
            Object.entries(parsed.panelTitles).filter(
              (entry): entry is [string, { source: string; title: string }] => {
                const value = entry[1] as { source?: unknown; title?: unknown };
                return typeof value.source === "string" && typeof value.title === "string";
              }
            )
          )
        : {},
  };
}

export function createLocalPanelViewStateStore(
  storage: LocalViewStateStorage
): LocalPanelViewStateStore {
  return {
    async load() {
      try {
        const serialized = await storage.read();
        return serialized === null ? null : parseLocalPanelViewState(serialized);
      } catch {
        return null;
      }
    },
    async save(state) {
      await storage.write(
        JSON.stringify({
          collapsedIds: state.collapsedIds,
          focusedPanelId: state.focusedPanelId ?? null,
          panelTitles: state.panelTitles ?? {},
        })
      );
    },
  };
}
