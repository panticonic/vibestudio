import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { panel as panelService, workspace } from "../shell/client";
import { usePanelTree, useRootPanels } from "../shell/hooks/PanelTreeContext";
import {
  applyLayoutAction,
  computeViewport,
  findPane,
  paneForPanel,
  validateRestoredLayout,
  type LayoutAction,
  type LayoutEnv,
} from "./placementEngine";
import { fallbackCandidatesFor, minWidthOfPanel, nearestVisibleRelativePane } from "./treeEnv";
import { mintColumnId, mintPaneId } from "./types";
import type { PanelLayout, PersistedLayout } from "./types";

/** Micro-header + divider chrome per pane, for the vertical fit tests (§4.2c). */
export const PANE_CHROME_HEIGHT_FOR_FIT = 35;

const PERSIST_DEBOUNCE_MS = 500;
const DELETED_PANEL_DEBOUNCE_MS = 50;
const MAX_SEEN_INTENTS = 256;

const EMPTY_LAYOUT: PanelLayout = { columns: [], focusedPaneId: null };

function seedLayout(panelId: string | null): PanelLayout {
  if (!panelId) return EMPTY_LAYOUT;
  const pane = { id: mintPaneId(), heightFr: 1, panelId };
  return {
    columns: [{ id: mintColumnId(), widthFr: 1, panes: [pane] }],
    focusedPaneId: pane.id,
  };
}

export interface UsePanelLayoutResult {
  layout: PanelLayout;
  /** Bumped on every committed layout/viewport change; drives surface resync (§5.4). */
  layoutEpoch: number;
  bumpLayoutEpoch: () => void;
  residentColumnIds: string[];
  parkedLeft: string[];
  parkedRight: string[];
  /** The focused pane's panel — the successor of `visiblePanelId` for chrome/commands. */
  focusedPanelId: string | null;
  visiblePanelIds: string[];
  dispatch: (action: LayoutAction) => void;
  /** Dispatch deduped by intentId (§4.9) — creation surfaces can double-deliver. */
  dispatchIntent: (intentId: string | undefined, action: LayoutAction) => void;
  restored: boolean;
}

/**
 * Owns the shell's PanelLayout: engine dispatch, per-device persistence and
 * restore (§7), intent dedup (§4.9), and tree-reconcile on panel deletion
 * (§4.5). The engine is the single writer of layout state.
 */
export function usePanelLayout(viewportWidth: number, viewportHeight: number): UsePanelLayoutResult {
  const { panelMap, parentMap, initialized } = usePanelTree();
  const { panels: rootPanels, loading: rootLoading } = useRootPanels();

  const [layout, setLayout] = useState<PanelLayout>(EMPTY_LAYOUT);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [restored, setRestored] = useState(false);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const mapsRef = useRef({ panelMap, parentMap });
  const rootPanelsRef = useRef(rootPanels);
  rootPanelsRef.current = rootPanels;

  const env = useMemo<LayoutEnv>(
    () => ({
      viewportWidth,
      viewportHeight,
      paneChromeHeight: PANE_CHROME_HEIGHT_FOR_FIT,
      firstRootPanelId: () => rootPanelsRef.current[0]?.id ?? null,
      minWidthOf: (panelId) => minWidthOfPanel(mapsRef.current, panelId),
      treeRelation: () => "none",
      nearestVisibleRelative: (panelId, current) =>
        nearestVisibleRelativePane(mapsRef.current, panelId, current),
    }),
    [viewportWidth, viewportHeight]
  );
  const envRef = useRef(env);
  envRef.current = env;

  // Debounced per-device persistence (§3.3/§7); identity is resolved main-side,
  // the workspaceId in the blob is informational.
  const persistTimerRef = useRef<number | null>(null);
  const workspaceIdRef = useRef<string>("");
  useEffect(() => {
    void workspace
      .getActive()
      .then((active) => {
        workspaceIdRef.current = typeof active === "string" ? active : "";
      })
      .catch(() => {});
  }, []);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      const persisted: PersistedLayout = {
        version: 1,
        workspaceId: workspaceIdRef.current,
        layout: layoutRef.current,
        updatedAt: new Date().toISOString(),
      };
      void panelService
        .savePanelLayout(persisted)
        .catch((error) => console.warn("[usePanelLayout] persist failed:", error));
    }, PERSIST_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    },
    []
  );

  const dispatch = useCallback(
    (action: LayoutAction) => {
      setLayout((previous) => {
        const next = applyLayoutAction(previous, action, envRef.current);
        if (next !== previous) {
          layoutRef.current = next;
          setLayoutEpoch((epoch) => epoch + 1);
          schedulePersist();
        }
        return next;
      });
    },
    [schedulePersist]
  );

  const seenIntentsRef = useRef<Set<string>>(new Set());
  const dispatchIntent = useCallback(
    (intentId: string | undefined, action: LayoutAction) => {
      if (intentId) {
        const seen = seenIntentsRef.current;
        if (seen.has(intentId)) return;
        seen.add(intentId);
        if (seen.size > MAX_SEEN_INTENTS) {
          for (const stale of seen) {
            seen.delete(stale);
            if (seen.size <= MAX_SEEN_INTENTS / 2) break;
          }
        }
      }
      dispatch(action);
    },
    [dispatch]
  );

  // Startup restore (§7): persisted layout pruned against the tree, else seed
  // from the persisted focused panel ?? first root; empty workspace stays empty.
  useEffect(() => {
    if (restored || rootLoading || !initialized) return;
    let cancelled = false;
    void (async () => {
      const existingIds = new Set(mapsRef.current.panelMap.keys());
      let next: PanelLayout | null = null;
      try {
        const blob = await panelService.getPanelLayout();
        next = validateRestoredLayout(blob, existingIds);
      } catch {
        next = null;
      }
      if (!next) {
        let seedId: string | null = rootPanelsRef.current[0]?.id ?? null;
        try {
          const focusedId = await panelService.getFocusedPanelId();
          if (focusedId && existingIds.has(focusedId)) seedId = focusedId;
        } catch {
          // fall back to first root
        }
        next = seedLayout(seedId);
      }
      if (cancelled) return;
      layoutRef.current = next;
      setLayout(next);
      setLayoutEpoch((epoch) => epoch + 1);
      setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [restored, rootLoading, initialized]);

  // Persist layout focus so restore can seed from it (W3: the focused pane's
  // panel is the successor of the old single focused panel).
  const focusedPanelId = useMemo(() => {
    if (!layout.focusedPaneId) return null;
    return findPane(layout, layout.focusedPaneId)?.pane.panelId ?? null;
  }, [layout]);
  useEffect(() => {
    if (!restored || !focusedPanelId) return;
    void panelService.setFocusedPanelId(focusedPanelId).catch(() => {});
  }, [restored, focusedPanelId]);

  const visiblePanelIds = useMemo(
    () => layout.columns.flatMap((column) => column.panes.map((pane) => pane.panelId)),
    [layout]
  );

  // Tree reconcile (§4.5/§7.4): when visible panels disappear from the tree,
  // wait out the creation-race debounce, then dispatch ONE atomic action whose
  // fallback candidates come from the topology as it was before the update.
  const reconcileTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!restored) return;
    const previousMaps = mapsRef.current;
    const casualties = visiblePanelIds.filter((panelId) => !panelMap.has(panelId));
    mapsRef.current = { panelMap, parentMap };
    if (casualties.length === 0) return;
    const removed = casualties.map((panelId) => ({
      panelId,
      fallbackCandidates: fallbackCandidatesFor(previousMaps, panelId),
    }));
    if (reconcileTimerRef.current !== null) window.clearTimeout(reconcileTimerRef.current);
    reconcileTimerRef.current = window.setTimeout(() => {
      reconcileTimerRef.current = null;
      // Re-check against the *latest* tree: a creation race may have re-added.
      const stillGone = removed.filter(
        (entry) =>
          !mapsRef.current.panelMap.has(entry.panelId) &&
          paneForPanel(layoutRef.current, entry.panelId) !== null
      );
      if (stillGone.length === 0) return;
      dispatch({
        type: "tree-reconcile",
        removed: stillGone.map((entry) => ({
          panelId: entry.panelId,
          fallbackCandidates: entry.fallbackCandidates.filter((candidateId) =>
            mapsRef.current.panelMap.has(candidateId)
          ),
        })),
      });
    }, DELETED_PANEL_DEBOUNCE_MS);
  }, [restored, visiblePanelIds, panelMap, parentMap, dispatch]);
  useEffect(
    () => () => {
      if (reconcileTimerRef.current !== null) window.clearTimeout(reconcileTimerRef.current);
    },
    []
  );

  const viewport = useMemo(() => computeViewport(layout, env), [layout, env]);

  const bumpLayoutEpoch = useCallback(() => setLayoutEpoch((epoch) => epoch + 1), []);

  return {
    layout,
    layoutEpoch,
    bumpLayoutEpoch,
    residentColumnIds: viewport.residentColumnIds,
    parkedLeft: viewport.parkedLeft,
    parkedRight: viewport.parkedRight,
    focusedPanelId,
    visiblePanelIds,
    dispatch,
    dispatchIntent,
    restored,
  };
}
