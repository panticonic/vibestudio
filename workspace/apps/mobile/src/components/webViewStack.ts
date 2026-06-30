/**
 * WebView-stack helpers for the mobile shell.
 *
 * Extracted from MainScreen.tsx so the pin-aware cap and the idle sweep are
 * unit-testable in isolation. Both reuse the shared GC selectors
 * (`@vibez1/shared/panel/panelGc`); predicates are passed in to keep these
 * functions pure.
 */

import {
  PANEL_UI_IDLE_UNLOAD_MS,
  PANEL_UI_MAX_LOADED_MOBILE,
} from "@vibez1/shared/constants";
import {
  selectCapEvictionVictims,
  selectIdlePanelVictims,
  type LoadedPanelSnapshot,
} from "@vibez1/shared/panel/panelGc";

export interface WebViewEntry {
  panelId: string;
  url: string;
  managed: boolean;
  panelInit: unknown | null;
  lastActive: number;
}

export interface StackPredicates {
  isPinned: (id: string) => boolean;
  isKeepLoaded: (id: string) => boolean;
}

function toSnapshots(entries: WebViewEntry[]): LoadedPanelSnapshot[] {
  return entries.map((entry) => ({ panelId: entry.panelId, lastActive: entry.lastActive }));
}

/**
 * Insert `nextEntry` (replacing any existing entry with the same id), then
 * pin-aware-evict down to `cap`. Protected ids — the incoming panel and the
 * active panel — are never evicted; pinned panels are evicted only when no
 * unpinned candidate remains. Replaces the old blind LRU.
 */
export function addWebViewEntry(
  entries: WebViewEntry[],
  nextEntry: WebViewEntry,
  opts: { activePanelId: string | null; cap?: number } & StackPredicates,
): WebViewEntry[] {
  const cap = opts.cap ?? PANEL_UI_MAX_LOADED_MOBILE;
  const withoutExisting = entries.filter((entry) => entry.panelId !== nextEntry.panelId);
  const nextEntries = [...withoutExisting, nextEntry];
  if (nextEntries.length <= cap) return nextEntries;

  const protectedIds = [nextEntry.panelId, ...(opts.activePanelId ? [opts.activePanelId] : [])];
  const victims = new Set(
    selectCapEvictionVictims(toSnapshots(nextEntries), {
      cap,
      protectedIds,
      isPinned: opts.isPinned,
      isKeepLoaded: opts.isKeepLoaded,
    }),
  );
  if (victims.size === 0) return nextEntries;
  return nextEntries.filter((entry) => !victims.has(entry.panelId));
}

/**
 * Idle sweep with side effects + foreground gating. A no-op (returns the input
 * stack unchanged) when `foreground` is false, so a backgrounded app never GCs.
 * For each inactive-unpinned victim, calls `unload(id)` and drops it from the
 * returned stack.
 */
export function sweepIdleWebViews(
  entries: WebViewEntry[],
  opts: {
    now: number;
    activePanelId: string | null;
    foreground: boolean;
    unload: (id: string) => void;
  } & StackPredicates,
): WebViewEntry[] {
  if (!opts.foreground) return entries;

  const victims = selectIdlePanelVictims(toSnapshots(entries), {
    now: opts.now,
    idleMs: PANEL_UI_IDLE_UNLOAD_MS,
    protectedIds: opts.activePanelId ? [opts.activePanelId] : [],
    isPinned: opts.isPinned,
    isKeepLoaded: opts.isKeepLoaded,
  });
  if (victims.length === 0) return entries;

  const victimSet = new Set(victims);
  for (const id of victimSet) opts.unload(id);
  return entries.filter((entry) => !victimSet.has(entry.panelId));
}
