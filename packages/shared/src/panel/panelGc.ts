/**
 * Pin-aware garbage-collection selectors for client-local panel runtimes.
 *
 * Pure functions with **no client/runtime dependencies** — this is the shared
 * logic between desktop (Electron main) and mobile (React Native), and the
 * primary test surface for the GC policy.
 *
 * A "loaded" panel is one that currently holds a runtime lease + a local
 * rendered surface. GC unloads (releases lease + destroys renderer) without
 * touching the workspace tree. Two policies are expressed here:
 *
 *  - **Idle**: a panel inactive for >= idleMs is eligible for unload, UNLESS it
 *    is the active/protected panel, has `keepLoaded` set (automation attached),
 *    or is pinned. For idle, a pin is a HARD exclusion regardless of age.
 *  - **Cap**: when the loaded count exceeds `cap`, evict the best candidates to
 *    get back to `cap`. Protected and `keepLoaded` ids are NEVER evicted. A pin
 *    is a SOFT de-prioritization: pinned panels sort to the back and are only
 *    evicted when no unpinned candidate remains (so a just-focused panel can
 *    always load).
 */

export interface LoadedPanelSnapshot {
  panelId: string;
  /** Wall-clock ms of the last time this panel was the active/visible surface. */
  lastActive: number;
}

export interface PanelGcPredicates {
  /** Client-local pin (workspace-scoped, keyed by slot id). */
  isPinned: (panelId: string) => boolean;
  /** Lease has `keepLoaded` set (>=1 CDP/automation client attached). */
  isKeepLoaded: (panelId: string) => boolean;
}

/**
 * Eviction ranking shared by both selectors: unpinned-before-pinned, then
 * oldest `lastActive` first. The FRONT of the sorted list is the best eviction
 * candidate. Stable for equal keys via the original index.
 */
function rankForEviction(
  loaded: LoadedPanelSnapshot[],
  isPinned: (id: string) => boolean,
): LoadedPanelSnapshot[] {
  return loaded
    .map((snapshot, index) => ({ snapshot, index }))
    .sort((a, b) => {
      const aPinned = isPinned(a.snapshot.panelId) ? 1 : 0;
      const bPinned = isPinned(b.snapshot.panelId) ? 1 : 0;
      if (aPinned !== bPinned) return aPinned - bPinned; // unpinned (0) first
      if (a.snapshot.lastActive !== b.snapshot.lastActive) {
        return a.snapshot.lastActive - b.snapshot.lastActive; // oldest first
      }
      return a.index - b.index; // stable
    })
    .map((entry) => entry.snapshot);
}

/**
 * Panels eligible for idle unload: age >= idleMs AND not protected /
 * keepLoaded / pinned. Order is not significant (all returned victims are
 * unloaded), but follows the eviction ranking for determinism.
 */
export function selectIdlePanelVictims(
  loaded: LoadedPanelSnapshot[],
  opts: { now: number; idleMs: number; protectedIds: Iterable<string> } & PanelGcPredicates,
): string[] {
  const protectedSet = new Set(opts.protectedIds);
  return rankForEviction(loaded, opts.isPinned)
    .filter((snapshot) => {
      const id = snapshot.panelId;
      if (protectedSet.has(id)) return false;
      if (opts.isPinned(id)) return false; // hard exclusion for idle
      if (opts.isKeepLoaded(id)) return false;
      return opts.now - snapshot.lastActive >= opts.idleMs;
    })
    .map((snapshot) => snapshot.panelId);
}

/**
 * Victims to evict to bring the loaded count down to `cap`. Never returns
 * protected/keepLoaded ids; returns pinned ids only after all unpinned
 * candidates are exhausted (so the just-focused panel can always load).
 * Returns [] when already at/under cap.
 */
export function selectCapEvictionVictims(
  loaded: LoadedPanelSnapshot[],
  opts: { cap: number; protectedIds: Iterable<string> } & PanelGcPredicates,
): string[] {
  const overBy = loaded.length - opts.cap;
  if (overBy <= 0) return [];

  const protectedSet = new Set(opts.protectedIds);
  const candidates = rankForEviction(loaded, opts.isPinned).filter((snapshot) => {
    const id = snapshot.panelId;
    if (protectedSet.has(id)) return false;
    if (opts.isKeepLoaded(id)) return false;
    return true;
  });

  // Front-of-list candidates are the best to evict (unpinned-oldest-first,
  // pinned only as a last resort). Take as many as we need to reach the cap.
  return candidates.slice(0, overBy).map((snapshot) => snapshot.panelId);
}
