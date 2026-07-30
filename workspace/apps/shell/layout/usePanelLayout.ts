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
import {
  fallbackCandidatesFor,
  minWidthOfPanel,
  nearestVisibleRelativePane,
  observedPanelDeletions,
} from "./treeEnv";
import { mintColumnId, mintPaneId, PANE_VERTICAL_CHROME_HEIGHT } from "./types";
import type { PanelLayout, PersistedLayout } from "./types";

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
export function usePanelLayout(
  viewportWidth: number,
  viewportHeight: number
): UsePanelLayoutResult {
  const { panelMap, parentMap, initialized, refreshing } = usePanelTree();
  const { panels: rootPanels, loading: rootLoading } = useRootPanels();

  const [layout, setLayout] = useState<PanelLayout>(EMPTY_LAYOUT);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [restored, setRestored] = useState(false);
  const restoredRef = useRef(false);
  const pendingActionsRef = useRef<LayoutAction[]>([]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const latestMapsRef = useRef({ panelMap, parentMap });
  latestMapsRef.current = { panelMap, parentMap };
  const reconcileMapsRef = useRef({ panelMap, parentMap });
  const rootPanelsRef = useRef(rootPanels);
  rootPanelsRef.current = rootPanels;

  const env = useMemo<LayoutEnv>(
    () => ({
      viewportWidth,
      viewportHeight,
      paneChromeHeight: PANE_VERTICAL_CHROME_HEIGHT,
      firstRootPanelId: () => rootPanelsRef.current[0]?.id ?? null,
      minWidthOf: (panelId) => minWidthOfPanel(latestMapsRef.current, panelId),
      treeRelation: () => "none",
      nearestVisibleRelative: (panelId, current) =>
        nearestVisibleRelativePane(latestMapsRef.current, panelId, current),
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
      .catch((error) => console.warn("[usePanelLayout] Failed to load active workspace:", error));
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
      // Presentation events can arrive while the persisted per-device layout
      // is still loading. Queue them so restore cannot overwrite a creation
      // that the authoritative panel service has already published.
      if (!restoredRef.current) {
        pendingActionsRef.current.push(action);
        return;
      }
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
      const existingIds = new Set(latestMapsRef.current.panelMap.keys());
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
      const queued = pendingActionsRef.current;
      pendingActionsRef.current = [];
      for (const action of queued) {
        next = applyLayoutAction(next, action, envRef.current);
      }
      restoredRef.current = true;
      layoutRef.current = next;
      setLayout(next);
      setLayoutEpoch((epoch) => epoch + 1);
      setRestored(true);
      if (queued.length > 0) schedulePersist();
    })();
    return () => {
      cancelled = true;
    };
  }, [restored, rootLoading, initialized, schedulePersist]);

  // The placement model's invariant is that a restored layout is empty iff the
  // workspace has no roots. Query-first discovery may lag presentation or
  // briefly reconcile an older projection, so enforce that invariant whenever
  // the first authoritative root is available.
  useEffect(() => {
    if (!restored || layout.columns.length > 0) return;
    const seedId = rootPanels[0]?.id;
    if (!seedId) return;
    setLayout((current) => {
      if (current.columns.length > 0) return current;
      const next = seedLayout(seedId);
      layoutRef.current = next;
      setLayoutEpoch((epoch) => epoch + 1);
      schedulePersist();
      return next;
    });
  }, [restored, layout.columns.length, rootPanels, schedulePersist]);

  // Persist layout focus so restore can seed from it (W3: the focused pane's
  // panel is the successor of the old single focused panel).
  const focusedPanelId = useMemo(() => {
    if (!layout.focusedPaneId) return null;
    return findPane(layout, layout.focusedPaneId)?.pane.panelId ?? null;
  }, [layout]);
  useEffect(() => {
    if (!restored || !focusedPanelId) return;
    void panelService
      .setFocusedPanelId(focusedPanelId)
      .catch((error) => console.warn("[usePanelLayout] Failed to persist focused panel:", error));
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
    if (!restored || refreshing) {
      if (reconcileTimerRef.current !== null) {
        window.clearTimeout(reconcileTimerRef.current);
        reconcileTimerRef.current = null;
      }
      return;
    }
    const previousMaps = reconcileMapsRef.current;
    // Presentation and query-first discovery are independent streams. A
    // panel-created event can place a durable slot before this client's
    // bounded tree projection has observed it; absence is only evidence of
    // deletion when the panel was present in the preceding projection.
    const casualties = observedPanelDeletions(visiblePanelIds, previousMaps, { panelMap });
    reconcileMapsRef.current = { panelMap, parentMap };
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
          !reconcileMapsRef.current.panelMap.has(entry.panelId) &&
          paneForPanel(layoutRef.current, entry.panelId) !== null
      );
      if (stillGone.length === 0) return;
      dispatch({
        type: "tree-reconcile",
        removed: stillGone.map((entry) => ({
          panelId: entry.panelId,
          fallbackCandidates: entry.fallbackCandidates.filter((candidateId) =>
            reconcileMapsRef.current.panelMap.has(candidateId)
          ),
        })),
      });
    }, DELETED_PANEL_DEBOUNCE_MS);
  }, [restored, refreshing, visiblePanelIds, panelMap, parentMap, dispatch]);
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
