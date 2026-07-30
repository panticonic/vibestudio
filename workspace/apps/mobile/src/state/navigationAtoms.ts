/**
 * Navigation state atoms -- Jotai atoms for panel navigation state.
 *
 * Tracks the currently active panel ID and provides derived state
 * for the AppBar title and navigation decisions.
 */

import { atom } from "jotai";

/** The ID of the currently active/focused panel */
export const activePanelIdAtom = atom<string | null>(null);

/** Slot ids of client-local pinned panels (hydrated from AsyncStorage). */
export const pinnedPanelIdsAtom = atom<Set<string>>(new Set<string>());

/** Whether pins have finished hydrating; gates the GC sweep on cold start. */
export const pinsHydratedAtom = atom<boolean>(false);

export const activePanelMetadataAtom = atom<{
  panelId: string;
  title: string;
  parentId: string | null;
} | null>(null);

/** Derived: title of the active panel, or fallback */
export const activePanelTitleAtom = atom<string>((get) => {
  return get(activePanelMetadataAtom)?.title ?? "Vibestudio";
});

/** Derived: parent panel ID of the active panel (for Android back button) */
export const activePanelParentIdAtom = atom<string | null>((get) => {
  return get(activePanelMetadataAtom)?.parentId ?? null;
});
