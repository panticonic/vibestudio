import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSetAtom } from "jotai";
import { Cross2Icon } from "@radix-ui/react-icons";
import { Box, Button, Card, Flex, IconButton, Spinner, Text, TextField } from "@radix-ui/themes";
import { VibestudioLogo } from "@workspace/ui";
import { useIsMobile } from "@workspace/react/responsive";

import type { LazyTitleNavigationData, LazyStatusNavigationData } from "./navigationTypes";
import type { PanelContextMenuAction } from "@vibestudio/shared/types";
import {
  DEFAULT_SEARCH_TEMPLATE,
  applySearchTemplate,
  getBrowserNavigationIntentForAddressAction,
  getBrowserNavigationIntentForCommand,
  type AddressNavigationMode,
  type PanelCommandId,
} from "@vibestudio/shared/panelCommands";
import {
  buildPanelChromeState,
  isBrowserPanelSource,
  parseAddressInput,
  type AddressAction,
  type PanelChromeState,
} from "@vibestudio/shared/panelChrome";
import {
  useRootPanels,
  useFullPanel,
  usePanelTree,
  useAncestors,
  useSiblings,
  useDescendantSiblingGroups,
} from "../shell/hooks/PanelTreeContext";
import {
  app,
  incomingPanelLocation,
  notification,
  panel as panelService,
  view,
  workspace,
} from "../shell/client";
import {
  pinMutationSeqAtom,
  pinnedPanelIdsAtom,
  workspaceChooserDialogOpenAtom,
} from "../state/appModeAtoms";
import { getCurrentSnapshot } from "@vibestudio/shared/panel/accessors";
import { useNavigation } from "./NavigationContext";
import { LazyPanelTreeSidebar } from "./LazyPanelTreeSidebar";
import { useShellEvent } from "../shell/useShellEvent";
import { SavePasswordBar } from "./SavePasswordBar";
import { assertPresent } from "../utils/assertPresent";
import { ColumnRow } from "./ColumnRow";
import { usePanelLayout } from "../layout/usePanelLayout";
import { findPane, paneForPanel } from "../layout/placementEngine";
import { LAYOUT_DROP_EVENT, type LayoutDropDetail } from "../layout/dropTargets";
import type { PanelPlacementHint } from "../layout/types";

interface PanelStackProps {
  onTitleChange?: (title: string) => void;
  onChromeStateChange?: (state: PanelChromeState | null) => void;
  hostTheme: "light" | "dark";
  onRegisterDevToolsHandler?: (handler: () => void) => void;
  onRegisterNavigateToId?: (navigate: (panelId: string) => void) => void;
  onRegisterPanelAction?: (
    handler: (panelId: string, action: PanelContextMenuAction) => void
  ) => void;
  onRegisterChromeCommand?: (handler: (command: ChromeCommand) => void) => void;
}

function reportPanelCommandError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void notification.show({ type: "error", title: `${action} failed`, message, ttl: 8_000 });
}

export type ChromeCommand =
  | { type: PanelCommandId }
  | {
      type: "navigate";
      value: string;
      mode?: AddressNavigationMode;
      ref?: string;
      action?: AddressAction;
    };

function captureHostThemeCss(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const computed = getComputedStyle(document.documentElement);
  const declarations: string[] = [];

  for (const property of Array.from(computed)) {
    if (!property.startsWith("--")) {
      continue;
    }
    const value = computed.getPropertyValue(property).trim();
    if (value) {
      declarations.push(`${property}: ${value}`);
    }
  }

  const cssVariables = `:root { ${declarations.join("; ")} }`;
  const baseline = `html, body { margin: 0; padding: 0; height: 100%; }
#root {
  min-height: 100dvh;
  box-sizing: border-box;
}`;

  return `${cssVariables}\n${baseline}`;
}

interface PanelTreeNode {
  id: string;
  children?: PanelTreeNode[];
}

function panelTreeContainsId(panels: PanelTreeNode[], id: string): boolean {
  for (const panel of panels) {
    if (panel.id === id) return true;
    if (panel.children && panelTreeContainsId(panel.children, id)) return true;
  }
  return false;
}

export function PanelStack({
  onTitleChange,
  onChromeStateChange,
  hostTheme,
  onRegisterDevToolsHandler,
  onRegisterNavigateToId,
  onRegisterPanelAction,
  onRegisterChromeCommand,
}: PanelStackProps) {
  const {
    mode: navigationMode,
    setMode,
    setLazyTitleNavigation,
    setLazyStatusNavigation,
    registerNavigateToId,
    setAddressBarVisible,
  } = useNavigation();

  const setPinnedPanelIds = useSetAtom(pinnedPanelIdsAtom);
  const bumpPinMutationSeq = useSetAtom(pinMutationSeqAtom);
  const openWorkspaceChooser = useSetAtom(workspaceChooserDialogOpenAtom);

  // The layout content viewport (the area right of the sidebar) drives the
  // engine's fit tests; measured with a ResizeObserver. A callback ref (state,
  // not a ref object) matters: the measured box mounts only after the loading
  // early-return, so a mount-time effect would observe nothing forever.
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const [contentSize, setContentSize] = useState({ width: 1024, height: 768 });
  useEffect(() => {
    const el = contentEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContentSize((current) =>
          current.width === Math.round(rect.width) && current.height === Math.round(rect.height)
            ? current
            : { width: Math.round(rect.width), height: Math.round(rect.height) }
        );
      }
    });
    observer.observe(el);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setContentSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    }
    return () => observer.disconnect();
  }, [contentEl]);

  const {
    layout,
    layoutEpoch,
    bumpLayoutEpoch,
    residentColumnIds,
    parkedLeft,
    parkedRight,
    focusedPanelId,
    visiblePanelIds,
    dispatch,
    dispatchIntent,
    restored,
  } = usePanelLayout(contentSize.width, contentSize.height);

  // Switching to a *different* focused panel returns the title bar to breadcrumb
  // view. Guard on an actual id change: the context's setAddressBarVisible
  // identity is unstable, so an unguarded effect would re-run every render and
  // clobber the address view the moment a breadcrumb click opened it.
  const lastAddressResetPanelIdRef = useRef(focusedPanelId);
  useEffect(() => {
    if (lastAddressResetPanelIdRef.current === focusedPanelId) return;
    lastAddressResetPanelIdRef.current = focusedPanelId;
    setAddressBarVisible(false);
  }, [focusedPanelId, setAddressBarVisible]);
  const [hostThemeCss, setHostThemeCss] = useState<string | null>(null);
  const [unresponsivePanels, setUnresponsivePanels] = useState<Set<string>>(() => new Set());
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState({ activeMatchOrdinal: 0, matches: 0 });
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizeHover, setIsResizeHover] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1024 : window.innerWidth
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizePointerIdRef = useRef<number | null>(null);
  const isMobile = useIsMobile();

  // Lazy data hooks — chrome, breadcrumbs, and commands follow the focused pane.
  const { panels: rootPanels, loading: rootLoading } = useRootPanels();
  const { panel: visiblePanel } = useFullPanel(focusedPanelId);
  const { panelMap } = usePanelTree();
  const { ancestors } = useAncestors(focusedPanelId);
  const { siblings } = useSiblings(focusedPanelId);
  const { groups: descendantGroups } = useDescendantSiblingGroups(focusedPanelId);

  useShellEvent(
    "toggle-find-in-page",
    useCallback(() => setFindOpen((open) => !open), [])
  );
  useEffect(() => {
    if (!findOpen || !focusedPanelId || !findText) {
      setFindResult({ activeMatchOrdinal: 0, matches: 0 });
      return;
    }
    const timer = window.setTimeout(() => {
      void panelService
        .findInPage(focusedPanelId, findText, { forward: true, findNext: false })
        .then(setFindResult)
        .catch((error) => reportPanelCommandError("Find", error));
    }, 100);
    return () => window.clearTimeout(timer);
  }, [findOpen, findText, focusedPanelId]);
  const closeFind = useCallback(() => {
    if (focusedPanelId) void panelService.stopFindInPage(focusedPanelId);
    setFindOpen(false);
    setFindText("");
  }, [focusedPanelId]);
  const nextFind = useCallback(
    (forward: boolean) => {
      if (!focusedPanelId || !findText) return;
      void panelService
        .findInPage(focusedPanelId, findText, { forward, findNext: true })
        .then(setFindResult)
        .catch((error) => reportPanelCommandError("Find", error));
    },
    [findText, focusedPanelId]
  );

  useShellEvent(
    "panel-responsiveness-changed",
    useCallback(({ panelId, responsive }) => {
      setUnresponsivePanels((current) => {
        const next = new Set(current);
        if (responsive) next.delete(panelId);
        else next.add(panelId);
        return next;
      });
    }, [])
  );

  // Ancestor IDs for tree auto-expansion
  const ancestorIds = useMemo(() => ancestors.map((a) => a.id), [ancestors]);

  // Theme CSS initialization
  useEffect(() => {
    const css = captureHostThemeCss();
    setHostThemeCss(css);

    void panelService.updateTheme(hostTheme).catch((error) => {
      console.error("Failed to broadcast panel theme", error);
    });
  }, [hostTheme]);

  // Startup restore, deleted-panel fallback, and tree reconcile all live in
  // usePanelLayout (§7, §4.5); the engine is the single writer of layout state.

  // Build lazy title navigation data
  const lazyTitleNavigationData = useMemo<LazyTitleNavigationData | null>(() => {
    if (!visiblePanel) {
      return null;
    }

    return {
      ancestors,
      currentSiblings: siblings,
      currentId: visiblePanel.id,
      currentTitle: visiblePanel.title,
    };
  }, [ancestors, siblings, visiblePanel]);

  // Build lazy status navigation data
  const lazyStatusNavigationData = useMemo<LazyStatusNavigationData | null>(() => {
    if (!focusedPanelId) {
      return null;
    }

    return {
      descendantGroups,
      visiblePanelId: focusedPanelId,
    };
  }, [descendantGroups, focusedPanelId]);

  // Update navigation context with lazy data
  useEffect(() => {
    setLazyTitleNavigation(lazyTitleNavigationData);
  }, [setLazyTitleNavigation, lazyTitleNavigationData]);

  useEffect(() => {
    setLazyStatusNavigation(lazyStatusNavigationData);
  }, [setLazyStatusNavigation, lazyStatusNavigationData]);

  // Navigate to a specific panel by ID (rule 1: replace in the nearest-relative
  // pane, or focus its pane when already visible).
  const navigateToPanelId = useCallback(
    (panelId: string) => {
      if (!panelId) {
        return;
      }
      dispatch({ type: "show-panel", panelId, origin: "navigate-event" });
    },
    [dispatch]
  );

  // A child just created with focus: dispatch full open-child intent so the
  // engine can place it beside/below its parent (§4.2). The intentId keeps a
  // later bare navigate-to-panel for the same creation from double-applying.
  const openChildInLayout = useCallback(
    (parentId: string, childId: string, hint?: PanelPlacementHint) => {
      // The server resolves call-site ?? manifest hints onto the snapshot (W4);
      // use it when the local call site didn't carry one.
      const resolvedHint =
        hint ??
        (panelMap.get(childId)?.snapshot as { placement?: PanelPlacementHint } | undefined)
          ?.placement;
      dispatchIntent(`create:${childId}`, {
        type: "open-child",
        panelId: childId,
        parentId,
        hint: resolvedHint,
      });
    },
    [dispatchIntent, panelMap]
  );

  // Register navigate function with context
  useEffect(() => {
    registerNavigateToId(navigateToPanelId);
  }, [registerNavigateToId, navigateToPanelId]);

  // Register navigate function with parent
  useEffect(() => {
    if (!onRegisterNavigateToId) return;
    onRegisterNavigateToId(navigateToPanelId);
  }, [onRegisterNavigateToId, navigateToPanelId]);

  // Listen for navigate-to-panel events from main process (e.g., when new
  // panels are created with focus: true). The payload optionally carries the
  // canonical layout intent (§3.1): parentId/hint/intentId for creations.
  useShellEvent(
    "navigate-to-panel",
    useCallback(
      (payload: {
        panelId: string;
        parentId?: string;
        hint?: PanelPlacementHint;
        intentId?: string;
      }) => {
        const intentId = payload.intentId ?? (payload.parentId ? `create:${payload.panelId}` : undefined);
        if (payload.parentId) {
          dispatchIntent(intentId, {
            type: "open-child",
            panelId: payload.panelId,
            parentId: payload.parentId,
            hint: payload.hint,
          });
          return;
        }
        dispatchIntent(intentId, {
          type: "show-panel",
          panelId: payload.panelId,
          origin: "navigate-event",
        });
      },
      [dispatchIntent]
    )
  );

  // Renderer-local creation surfaces (title bar, sidebar add-child, user
  // notifications) announce via this custom event; the detail may carry the
  // parent for full open-child intent.
  useEffect(() => {
    const handleShellPanelCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: string; parentId?: string }>).detail;
      if (!detail?.panelId) return;
      if (detail.parentId) {
        openChildInLayout(detail.parentId, detail.panelId);
      } else {
        navigateToPanelId(detail.panelId);
      }
    };
    window.addEventListener("shell-panel-created", handleShellPanelCreated);
    return () => window.removeEventListener("shell-panel-created", handleShellPanelCreated);
  }, [openChildInLayout, navigateToPanelId]);

  // Tree→layout drops (W5, D8): pane-header drop shows the panel in exactly
  // that pane; gutter drop opens it in a new column at that position.
  const layoutRefForDrop = useRef(layout);
  layoutRefForDrop.current = layout;
  useEffect(() => {
    const handleLayoutDrop = (event: Event) => {
      const detail = (event as CustomEvent<LayoutDropDetail>).detail;
      if (!detail?.panelId) return;
      const target = detail.target;
      if (target.kind === "pane") {
        dispatch({ type: "place-in-pane", panelId: detail.panelId, paneId: target.paneId });
        return;
      }
      const column = layoutRefForDrop.current.columns.find(
        (candidate) => candidate.id === target.columnId
      );
      const anchorPane = column?.panes[0];
      if (anchorPane) {
        dispatch({ type: "open-beside", panelId: detail.panelId, anchorPaneId: anchorPane.id });
      }
    };
    window.addEventListener(LAYOUT_DROP_EVENT, handleLayoutDrop);
    return () => window.removeEventListener(LAYOUT_DROP_EVENT, handleLayoutDrop);
  }, [dispatch]);

  // Native focus feedback (§5.2): when a native view gains focus by a route the
  // shell didn't initiate, follow it with layout focus.
  useShellEvent(
    "native-slot-focused",
    useCallback(
      (payload: { nativeSlotId: string; panelId: string }) => {
        const location = paneForPanel(layout, payload.panelId);
        if (location && layout.focusedPaneId !== location.pane.id) {
          dispatch({ type: "focus-pane", paneId: location.pane.id });
        }
      },
      [layout, dispatch]
    )
  );

  const navigatePanelHistory = useCallback(
    (panelId: string, delta: -1 | 1): Promise<unknown> => {
      const targetPanel = panelMap.get(panelId);
      if (targetPanel && isBrowserPanelSource(getCurrentSnapshot(targetPanel).source)) {
        return delta === -1 ? view.browserGoBack(panelId) : view.browserGoForward(panelId);
      }
      return panelService.navigateHistory(panelId, delta);
    },
    [panelMap]
  );

  // Handle panel context menu actions (reload, unload)
  const handlePanelAction = useCallback(
    async (panelId: string, action: PanelContextMenuAction) => {
      switch (action) {
        case "back":
          await panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand("back"))
          );
          await navigatePanelHistory(panelId, -1);
          break;
        case "forward":
          await panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand("forward"))
          );
          await navigatePanelHistory(panelId, 1);
          break;
        case "reload":
        case "reload-panel":
          await panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand("reload-panel"))
          );
          await panelService.reload(panelId);
          break;
        case "reload-view":
          await panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand("reload-view"))
          );
          await panelService.reloadView(panelId);
          break;
        case "force-reload":
        case "force-reload-view":
          await panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand("force-reload-view"))
          );
          await panelService.forceReloadView(panelId);
          break;
        case "rebuild-panel":
          await panelService.rebuildPanel(panelId);
          break;
        case "stop":
          await view.browserStop(panelId);
          break;
        case "copy-address": {
          const state = await panelService.getChromeState(panelId);
          await navigator.clipboard.writeText(state.editableAddress);
          break;
        }
        case "copy-panel-id":
          await navigator.clipboard.writeText(panelId);
          break;
        case "add-child": {
          const result = await panelService.createChild(panelId, "about/new", { focus: true });
          openChildInLayout(panelId, result.id);
          break;
        }
        case "open-external": {
          const state = await panelService.getChromeState(panelId);
          if (state.resolvedUrl && /^https?:\/\//i.test(state.resolvedUrl)) {
            await app.openExternal(state.resolvedUrl);
          }
          break;
        }
        case "duplicate": {
          const state = await panelService.getChromeState(panelId);
          if (state.kind === "browser") {
            if (state.resolvedUrl) {
              const result = await panelService.createBrowser(state.resolvedUrl, { focus: true });
              navigateToPanelId(result.id);
            }
          } else {
            const result = await panelService.createPanel(state.source, { isRoot: true });
            navigateToPanelId(result.id);
          }
          break;
        }
        case "toggle-pin": {
          // Client-local pin: protects the panel from idle/cap GC. Update the
          // mirror atom from the authoritative new state the main process returns,
          // and bump the mutation seq so an in-flight tree reconcile can't clobber it.
          const pinned = await panelService.togglePin(panelId);
          setPinnedPanelIds((prev) => {
            const next = new Set(prev);
            if (pinned) next.add(panelId);
            else next.delete(panelId);
            return next;
          });
          bumpPinMutationSeq((seq) => seq + 1);
          break;
        }
        case "unload":
          // Unload panel resources but keep in tree (can be re-loaded later)
          await panelService.unload(panelId);
          break;
        case "archive":
          // Close panel (remove from tree)
          await panelService.archive(panelId);
          break;
      }
    },
    [navigatePanelHistory, navigateToPanelId, openChildInLayout, setPinnedPanelIds, bumpPinMutationSeq]
  );

  // Register panel action handler with parent
  useEffect(() => {
    onRegisterPanelAction?.(handlePanelAction);
  }, [onRegisterPanelAction, handlePanelAction]);

  // Handle direct close button clicks (X button in tree sidebar)
  const handleArchive = useCallback(async (panelId: string) => {
    try {
      await panelService.archive(panelId);
    } catch (error) {
      reportPanelCommandError("Close panel", error);
    }
  }, []);

  useEffect(() => {
    if (!isMobile) {
      return;
    }

    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, [isMobile]);

  const startSidebarResize = (event: React.PointerEvent) => {
    event.preventDefault();
    resizePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizingSidebar(true);
  };

  useEffect(() => {
    if (!isResizingSidebar) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (resizePointerIdRef.current !== null && event.pointerId !== resizePointerIdRef.current) {
        return;
      }
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const nextWidth = event.clientX - rect.left;
      const maxWidth = Math.max(240, rect.width - 200);
      const clamped = Math.min(maxWidth, Math.max(180, nextWidth));
      setSidebarWidth(clamped);
    };

    const stopResize = (event: PointerEvent) => {
      if (resizePointerIdRef.current !== null && event.pointerId !== resizePointerIdRef.current) {
        return;
      }
      resizePointerIdRef.current = null;
      setIsResizingSidebar(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize, { capture: true });
    window.addEventListener("pointercancel", stopResize, { capture: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize, {
        capture: true,
      } as EventListenerOptions);
      window.removeEventListener("pointercancel", stopResize, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [isResizingSidebar]);

  const mobileSidebarWidth = Math.max(0, Math.min(360, viewportWidth - 48));
  const effectiveSidebarWidth = isMobile ? mobileSidebarWidth : sidebarWidth;
  const sidebarVisible = navigationMode === "tree";

  // Send theme CSS to main process for injection into views
  useEffect(() => {
    if (hostThemeCss) {
      void view
        .setThemeCss(hostThemeCss)
        .catch((err: unknown) => console.warn("[PanelStack] Theme CSS injection failed:", err));
    }
  }, [hostThemeCss]);

  const openDevToolsForVisiblePanel = useCallback(() => {
    const panelId = visiblePanel?.id;
    if (!panelId) {
      return;
    }

    void panelService.openDevTools(panelId).catch((error) => {
      console.error("Failed to open panel devtools", error);
    });
  }, [visiblePanel?.id]);

  const runChromeCommand = useCallback(
    (command: ChromeCommand) => {
      const panelId = visiblePanel?.id;
      if (!panelId) return;

      switch (command.type) {
        case "back":
          void panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand(command.type))
          );
          void navigatePanelHistory(panelId, -1);
          return;
        case "forward":
          void panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand(command.type))
          );
          void navigatePanelHistory(panelId, 1);
          return;
        case "reload-panel":
          void panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand(command.type))
          );
          void panelService
            .reload(panelId)
            .catch((error) => reportPanelCommandError("Reload", error));
          return;
        case "reload-view":
          void panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand(command.type))
          );
          void panelService
            .reloadView(panelId)
            .catch((error) => reportPanelCommandError("Reload", error));
          return;
        case "force-reload-view":
          void panelService.markBrowserNavigationIntent(
            panelId,
            assertPresent(getBrowserNavigationIntentForCommand(command.type))
          );
          void panelService
            .forceReloadView(panelId)
            .catch((error) => reportPanelCommandError("Force reload", error));
          return;
        case "rebuild-panel":
          void panelService
            .rebuildPanel(panelId)
            .catch((error) => reportPanelCommandError("Rebuild", error));
          return;
        case "stop":
          void view.browserStop(panelId);
          return;
        case "copy-address":
          void panelService
            .getChromeState(panelId)
            .then((state) => navigator.clipboard.writeText(state.editableAddress));
          return;
        case "open-external":
          void panelService.getChromeState(panelId).then((state) => {
            if (state.resolvedUrl && /^https?:\/\//i.test(state.resolvedUrl)) {
              void app.openExternal(state.resolvedUrl);
            }
          });
          return;
        case "duplicate": {
          if (!visiblePanel) return;
          const snapshot = getCurrentSnapshot(visiblePanel);
          if (isBrowserPanelSource(snapshot.source)) {
            const url = visiblePanel.navigation?.url ?? snapshot.resolvedUrl;
            if (url)
              void panelService
                .createBrowser(url, { focus: true })
                .then((result) => navigateToPanelId(result.id))
                .catch((error) => reportPanelCommandError("Duplicate panel", error));
          } else {
            void panelService
              .createPanel(snapshot.source, {
                isRoot: true,
                ref: snapshot.options.ref,
              })
              .then((result) => navigateToPanelId(result.id))
              .catch((error) => reportPanelCommandError("Duplicate panel", error));
          }
          return;
        }
        case "toggle-pin":
          void panelService.togglePin(panelId).then((pinned) => {
            setPinnedPanelIds((prev) => {
              const next = new Set(prev);
              if (pinned) next.add(panelId);
              else next.delete(panelId);
              return next;
            });
            bumpPinMutationSeq((seq) => seq + 1);
          });
          return;
        case "unload":
          void panelService
            .unload(panelId)
            .catch((error) => reportPanelCommandError("Unload", error));
          return;
        case "archive":
          if (
            visiblePanel &&
            (panelMap.get(panelId)?.children.length ?? 0) > 0 &&
            !window.confirm(
              `Close “${visiblePanel.title}” and its child panels? All descendants will be archived.`
            )
          )
            return;
          void panelService
            .archive(panelId)
            .catch((error) => reportPanelCommandError("Close panel", error));
          return;
        case "focus-address":
          window.dispatchEvent(new Event("shell-focus-address"));
          return;
        case "navigate": {
          if (command.action) {
            executeAddressAction(panelId, command.action, command.mode ?? "current", command.ref);
            return;
          }
          const parsed = parseAddressInput(command.value);
          if (!parsed) return;
          if (parsed.type === "panel-location") {
            const location = parsed.location;
            const mode = command.mode ?? location.disposition ?? "current";
            if (mode === "external") {
              void app.openExternal(command.value);
              return;
            }
            void (async () => {
              if (location.workspace && location.workspace !== (await workspace.getActive())) {
                await incomingPanelLocation.prepareWorkspaceRelaunch(location);
                try {
                  await workspace.select(location.workspace);
                } catch (error) {
                  await incomingPanelLocation.prepareWorkspaceRelaunch(null);
                  throw error;
                }
                return;
              }
              const common = {
                ref: location.ref,
                contextId: location.contextId,
                stateArgs: location.stateArgs,
              };
              const result =
                mode === "current"
                  ? await panelService.navigate(panelId, location.source, common)
                  : mode === "child"
                    ? await panelService.createChild(panelId, location.source, {
                        ...common,
                        name: location.name,
                        focus: location.focus ?? true,
                      })
                    : await panelService.createPanel(location.source, {
                        ...common,
                        name: location.name,
                        isRoot: true,
                        focus: location.focus ?? true,
                      });
              if (result && location.focus !== false) {
                if (mode === "child") openChildInLayout(panelId, result.id);
                else navigateToPanelId(result.id);
              }
            })().catch((error: unknown) => {
              void notification.show({
                type: "error",
                title: "Panel link could not be opened",
                message: error instanceof Error ? error.message : String(error),
              });
            });
            return;
          }
          const mode = command.mode ?? "current";
          if (parsed.type === "browser-url") {
            const action: AddressAction = {
              type: "navigate-url",
              url: parsed.url,
              recordAsTyped: true,
            };
            const intent = getBrowserNavigationIntentForAddressAction(action);
            if (intent) void panelService.markBrowserNavigationIntent(panelId, intent);
            if (mode === "external") {
              void app.openExternal(parsed.url);
            } else if (mode === "child") {
              void panelService
                .createBrowserChild(panelId, parsed.url, { focus: true })
                .then((result) => openChildInLayout(panelId, result.id));
            } else if (mode === "root") {
              void panelService
                .createBrowser(parsed.url, { focus: true })
                .then((result) => navigateToPanelId(result.id));
            } else if (
              visiblePanel &&
              isBrowserPanelSource(getCurrentSnapshot(visiblePanel).source)
            ) {
              void view.browserNavigate(panelId, parsed.url);
            } else {
              void panelService
                .createBrowser(parsed.url, { focus: true })
                .then((result) => navigateToPanelId(result.id));
            }
            return;
          }
          if (parsed.type === "panel-source") {
            const ref = command.ref;
            const creator =
              mode === "current"
                ? panelService.navigate(panelId, parsed.source, { ref })
                : mode === "child"
                  ? panelService.createChild(panelId, parsed.source, { focus: true, ref })
                  : panelService.createPanel(parsed.source, { isRoot: true, ref });
            void creator.then((result) => {
              if (!result) return;
              if (mode === "child") openChildInLayout(panelId, result.id);
              else navigateToPanelId(result.id);
            });
            return;
          }
          if (parsed.type === "search") {
            const url = applySearchTemplate(parsed.query);
            const action: AddressAction = {
              type: "search",
              query: parsed.query,
              template: DEFAULT_SEARCH_TEMPLATE,
              recordAsTyped: true,
            };
            const intent = getBrowserNavigationIntentForAddressAction(action);
            if (intent) void panelService.markBrowserNavigationIntent(panelId, intent);
            if (mode === "external") {
              void app.openExternal(url);
            } else if (mode === "child") {
              void panelService
                .createBrowserChild(panelId, url, { focus: true })
                .then((result) => openChildInLayout(panelId, result.id));
            } else if (mode === "root") {
              void panelService
                .createBrowser(url, { focus: true })
                .then((result) => navigateToPanelId(result.id));
            } else if (
              visiblePanel &&
              isBrowserPanelSource(getCurrentSnapshot(visiblePanel).source)
            ) {
              void view.browserNavigate(panelId, url);
            } else {
              void panelService
                .createBrowser(url, { focus: true })
                .then((result) => navigateToPanelId(result.id));
            }
            return;
          }
        }
      }

      function executeAddressAction(
        targetPanelId: string,
        action: AddressAction,
        mode: AddressNavigationMode,
        ref?: string
      ) {
        if (action.type === "panel-location") {
          const location = action.location;
          const targetMode = mode === "current" ? (location.disposition ?? mode) : mode;
          if (targetMode === "external") {
            if (action.raw) void app.openExternal(action.raw);
            return;
          }
          void (async () => {
            if (location.workspace && location.workspace !== (await workspace.getActive())) {
              await incomingPanelLocation.prepareWorkspaceRelaunch(location);
              try {
                await workspace.select(location.workspace);
              } catch (error) {
                await incomingPanelLocation.prepareWorkspaceRelaunch(null);
                throw error;
              }
              return;
            }
            const common = {
              ref: location.ref,
              contextId: location.contextId,
              stateArgs: location.stateArgs,
            };
            const result =
              targetMode === "current"
                ? await panelService.navigate(targetPanelId, location.source, common)
                : targetMode === "child"
                  ? await panelService.createChild(targetPanelId, location.source, {
                      ...common,
                      name: location.name,
                      focus: location.focus ?? true,
                    })
                  : await panelService.createPanel(location.source, {
                      ...common,
                      name: location.name,
                      isRoot: true,
                      focus: location.focus ?? true,
                    });
            if (result && location.focus !== false) {
              if (targetMode === "child") openChildInLayout(targetPanelId, result.id);
              else navigateToPanelId(result.id);
            }
          })().catch((error: unknown) => {
            void notification.show({
              type: "error",
              title: "Panel link could not be opened",
              message: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        if (action.type === "navigate-url") {
          const intent = getBrowserNavigationIntentForAddressAction(action);
          if (intent) void panelService.markBrowserNavigationIntent(targetPanelId, intent);
          if (mode === "external") {
            void app.openExternal(action.url);
          } else if (mode === "child") {
            void panelService
              .createBrowserChild(targetPanelId, action.url, { focus: true })
              .then((result) => openChildInLayout(targetPanelId, result.id));
          } else if (mode === "root") {
            void panelService
              .createBrowser(action.url, { focus: true })
              .then((result) => navigateToPanelId(result.id));
          } else if (
            visiblePanel &&
            isBrowserPanelSource(getCurrentSnapshot(visiblePanel).source)
          ) {
            void view.browserNavigate(targetPanelId, action.url);
          } else {
            void panelService
              .createBrowser(action.url, { focus: true })
              .then((result) => navigateToPanelId(result.id));
          }
          return;
        }
        if (action.type === "search" || action.type === "keyword-search") {
          const url = applySearchTemplate(action.query, action.template);
          const intent = getBrowserNavigationIntentForAddressAction(action);
          if (intent) void panelService.markBrowserNavigationIntent(targetPanelId, intent);
          if (mode === "external") {
            void app.openExternal(url);
          } else if (mode === "child") {
            void panelService
              .createBrowserChild(targetPanelId, url, { focus: true })
              .then((result) => openChildInLayout(targetPanelId, result.id));
          } else if (mode === "root") {
            void panelService
              .createBrowser(url, { focus: true })
              .then((result) => navigateToPanelId(result.id));
          } else if (
            visiblePanel &&
            isBrowserPanelSource(getCurrentSnapshot(visiblePanel).source)
          ) {
            void view.browserNavigate(targetPanelId, url);
          } else {
            void panelService
              .createBrowser(url, { focus: true })
              .then((result) => navigateToPanelId(result.id));
          }
          return;
        }
        if (action.type === "panel-source") {
          const actionRef = action.ref ?? ref;
          const creator =
            mode === "current"
              ? panelService.navigate(targetPanelId, action.source, { ref: actionRef })
              : mode === "child"
                ? panelService.createChild(targetPanelId, action.source, {
                    focus: true,
                    ref: actionRef,
                  })
                : panelService.createPanel(action.source, { isRoot: true, ref: actionRef });
          void creator.then((result) => {
            if (!result) return;
            if (mode === "child") openChildInLayout(targetPanelId, result.id);
            else navigateToPanelId(result.id);
          });
        }
      }
    },
    [
      navigatePanelHistory,
      navigateToPanelId,
      openChildInLayout,
      setPinnedPanelIds,
      bumpPinMutationSeq,
      visiblePanel,
      panelMap,
    ]
  );

  useEffect(() => {
    onRegisterChromeCommand?.(runChromeCommand);
  }, [onRegisterChromeCommand, runChromeCommand]);

  useEffect(() => {
    // Provide the actual handler so callers don't need to double-invoke
    onRegisterDevToolsHandler?.(openDevToolsForVisiblePanel);
  }, [onRegisterDevToolsHandler, openDevToolsForVisiblePanel]);

  // Notify parent of title changes
  useEffect(() => {
    if (onTitleChange && visiblePanel) {
      onTitleChange(visiblePanel.title);
    }
  }, [onTitleChange, visiblePanel]);

  useEffect(() => {
    if (!visiblePanel) {
      onChromeStateChange?.(null);
      return;
    }

    const fallback = buildPanelChromeState({
      panel: {
        id: visiblePanel.id,
        title: visiblePanel.title,
        children: [],
        snapshot: visiblePanel.snapshot,
        artifacts: visiblePanel.artifacts,
        navigation: visiblePanel.navigation,
      },
    });
    onChromeStateChange?.(fallback);

    let cancelled = false;
    void panelService
      .getChromeState(visiblePanel.id)
      .then((state) => {
        if (!cancelled) onChromeStateChange?.(state);
      })
      .catch(() => {
        // Fallback above is enough when git/server metadata is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [onChromeStateChange, visiblePanel]);

  const isTreeNavigation = navigationMode === "tree";
  const closeMobileTree = useCallback(() => {
    if (isMobile) {
      setMode("stack");
    }
  }, [isMobile, setMode]);
  // Plain tree click = replace in the resolved pane (rule 1); Cmd/Ctrl-click =
  // force open-beside anchored at the focused pane (D8).
  const navigateFromTree = useCallback(
    (panelId: string, options?: { openBeside?: boolean }) => {
      if (options?.openBeside && layout.focusedPaneId) {
        dispatch({ type: "open-beside", panelId, anchorPaneId: layout.focusedPaneId });
      } else {
        dispatch({ type: "show-panel", panelId, origin: "tree-click" });
      }
      closeMobileTree();
    },
    [closeMobileTree, dispatch, layout.focusedPaneId]
  );

  const focusPane = useCallback(
    (paneId: string) => dispatch({ type: "focus-pane", paneId }),
    [dispatch]
  );
  const focusColumn = useCallback(
    (columnId: string) => {
      const column = layout.columns.find((candidate) => candidate.id === columnId);
      const pane = column?.panes[0];
      if (pane) dispatch({ type: "focus-pane", paneId: pane.id });
    },
    [layout, dispatch]
  );
  const closePane = useCallback(
    (paneId: string) => dispatch({ type: "close-pane", paneId }),
    [dispatch]
  );
  const splitBelowPane = useCallback(
    (paneId: string) => {
      const panelId = findPane(layout, paneId)?.pane.panelId;
      if (!panelId) return;
      void panelService
        .createChild(panelId, "about/new", {
          focus: true,
          placement: { disposition: "split-below" },
        })
        .then((result) =>
          dispatchIntent(`create:${result.id}`, {
            type: "split-below",
            panelId: result.id,
            anchorPaneId: paneId,
          })
        )
        .catch((error) => reportPanelCommandError("Split pane", error));
    },
    [layout, dispatchIntent]
  );
  const openBesidePane = useCallback(
    (paneId: string) => {
      dispatch({ type: "move-pane-to-new-column", paneId });
    },
    [dispatch]
  );
  const showAddressBar = useCallback(() => {
    setAddressBarVisible(true);
    window.requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("shell-focus-address")));
  }, [setAddressBarVisible]);
  const dismissUnresponsive = useCallback((panelId: string) => {
    setUnresponsivePanels((current) => {
      const next = new Set(current);
      next.delete(panelId);
      return next;
    });
  }, []);

  // Keyboard pane-focus movement: Cmd/Ctrl+Alt+arrows; +Shift+←/→ brings the
  // nearest parked column into the viewport (§5.2/§6).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.altKey) return;
      const focused = layout.focusedPaneId ? findPane(layout, layout.focusedPaneId) : null;
      if (!focused) return;
      if (event.shiftKey) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const parked = event.key === "ArrowLeft" ? parkedLeft : parkedRight;
        const target = event.key === "ArrowLeft" ? parked[parked.length - 1] : parked[0];
        if (target) focusColumn(target);
        return;
      }
      let target: string | null = null;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const neighbor = layout.columns[focused.columnIndex + delta];
        target = neighbor?.panes[Math.min(focused.paneIndex, (neighbor?.panes.length ?? 1) - 1)]?.id ?? null;
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const delta = event.key === "ArrowUp" ? -1 : 1;
        target = focused.column.panes[focused.paneIndex + delta]?.id ?? null;
      } else {
        return;
      }
      event.preventDefault();
      if (target) focusPane(target);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [layout, parkedLeft, parkedRight, focusPane, focusColumn]);

  const visibleIdSet = useMemo(() => new Set(visiblePanelIds), [visiblePanelIds]);

  const resizeColumns = useCallback(
    (columnFrs: number[]) => dispatch({ type: "resize-columns", columnFrs }),
    [dispatch]
  );
  const resizePanes = useCallback(
    (columnId: string, paneFrs: number[]) => dispatch({ type: "resize-panes", columnId, paneFrs }),
    [dispatch]
  );

  // Show loading state while initializing
  if ((rootLoading && rootPanels.length === 0) || !restored) {
    return (
      <Flex
        direction="column"
        align="center"
        justify="center"
        gap="3"
        style={{ flex: 1, height: "100%" }}
      >
        <VibestudioLogo size={68} variant="symbol" />
        <Spinner size="3" />
        <Text>Initializing panels...</Text>
      </Flex>
    );
  }

  const layoutEmpty = layout.columns.length === 0;

  return (
    <Flex
      direction="column"
      gap="0"
      style={{ flex: "1 1 0", minHeight: 0, minWidth: 0 }}
      ref={containerRef}
    >
      <Flex
        gap="0"
        style={{
          flex: "1 1 0",
          minHeight: 0,
          minWidth: 0,
          alignItems: "stretch",
        }}
      >
        {isTreeNavigation && (
          <Card
            data-shell-panel-sidebar="true"
            className="app-shell-panel-card"
            size="2"
            style={{
              width: `${effectiveSidebarWidth}px`,
              minWidth: isMobile ? `${effectiveSidebarWidth}px` : "200px",
              flexShrink: 0,
              alignSelf: "stretch",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              borderRadius: isMobile ? 0 : undefined,
              borderTop: isMobile ? 0 : undefined,
              borderBottom: isMobile ? 0 : undefined,
            }}
          >
            <Flex direction="column" gap="2" style={{ flex: 1, minHeight: 0 }}>
              {isMobile && (
                <Flex align="center" justify="end" px="1" pt="1">
                  <IconButton
                    size="1"
                    variant="ghost"
                    aria-label="Close panel tree"
                    onClick={closeMobileTree}
                  >
                    <Cross2Icon />
                  </IconButton>
                </Flex>
              )}
              <LazyPanelTreeSidebar
                selectedId={focusedPanelId}
                visibleIds={visibleIdSet}
                ancestorIds={ancestorIds}
                onSelect={navigateFromTree}
                onPanelAction={handlePanelAction}
                onArchive={handleArchive}
              />
            </Flex>
          </Card>
        )}

        {isTreeNavigation && !isMobile && (
          <Box
            onPointerDown={startSidebarResize}
            onPointerEnter={() => setIsResizeHover(true)}
            onPointerLeave={() => setIsResizeHover(false)}
            style={{
              // A roomy, invisible grab area keeps resizing easy while the
              // visible divider stays a slim hairline.
              cursor: "col-resize",
              flexShrink: 0,
              width: 7,
              alignSelf: "stretch",
              touchAction: "none",
              display: "flex",
              justifyContent: "center",
              background: "transparent",
            }}
          >
            <Box
              style={{
                width: isResizingSidebar || isResizeHover ? 2 : 1,
                alignSelf: "stretch",
                backgroundColor:
                  isResizingSidebar || isResizeHover ? "var(--accent-8)" : "var(--gray-a6)",
                transition: "background-color 120ms ease-out, width 120ms ease-out",
              }}
            />
          </Box>
        )}

        {/* Layout viewport: a row of resizable columns of panes */}
        <Flex direction="column" gap="0" style={{ flex: "1 1 0", minHeight: 0, minWidth: 0 }}>
          <SavePasswordBar visiblePanelId={focusedPanelId} />
          {findOpen && (
            <Flex
              align="center"
              justify="end"
              gap="1"
              p="1"
              style={{ borderBottom: "1px solid var(--gray-a5)" }}
            >
              <TextField.Root
                autoFocus
                size="1"
                value={findText}
                placeholder="Find in page"
                onChange={(event) => setFindText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") closeFind();
                  if (event.key === "Enter") nextFind(!event.shiftKey);
                }}
              />
              <Text size="1" color="gray">
                {findResult.matches
                  ? `${findResult.activeMatchOrdinal}/${findResult.matches}`
                  : "0/0"}
              </Text>
              <Button size="1" variant="ghost" onClick={() => nextFind(false)}>
                Previous
              </Button>
              <Button size="1" variant="ghost" onClick={() => nextFind(true)}>
                Next
              </Button>
              <IconButton size="1" variant="ghost" aria-label="Close find" onClick={closeFind}>
                <Cross2Icon />
              </IconButton>
            </Flex>
          )}
          <Card
            className="app-shell-panel-card"
            size="3"
            style={{
              flex: "1 1 0",
              minHeight: 0,
              minWidth: 0,
              overflow: "hidden",
              padding: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Box
              ref={setContentEl}
              style={{
                flex: "1 1 0",
                width: "100%",
                minHeight: 0,
                minWidth: 0,
                position: "relative",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {layoutEmpty ? (
                <Flex
                  direction="column"
                  align="center"
                  justify="center"
                  gap="3"
                  style={{ flex: 1, height: "100%", textAlign: "center" }}
                >
                  <VibestudioLogo size={72} variant="symbol" />
                  <Text weight="medium">No panels available.</Text>
                  <Text size="2" color="gray">
                    Create a panel or choose another workspace to continue.
                  </Text>
                  <Flex gap="2" wrap="wrap" justify="center">
                    <Button
                      onClick={() => {
                        void panelService
                          .createAboutPanel("new")
                          .then((result) => navigateToPanelId(result.id))
                          .catch((error) => reportPanelCommandError("Create panel", error));
                      }}
                    >
                      New panel
                    </Button>
                    <Button variant="soft" onClick={() => openWorkspaceChooser(true)}>
                      Switch workspace
                    </Button>
                  </Flex>
                </Flex>
              ) : (
                <ColumnRow
                  layout={layout}
                  residentColumnIds={residentColumnIds}
                  parkedLeft={parkedLeft}
                  parkedRight={parkedRight}
                  layoutEpoch={layoutEpoch}
                  viewportHeight={contentSize.height}
                  unresponsivePanels={unresponsivePanels}
                  onDismissUnresponsive={dismissUnresponsive}
                  onFocusPane={focusPane}
                  onFocusColumn={focusColumn}
                  onClosePane={closePane}
                  onSplitBelow={splitBelowPane}
                  onOpenBeside={openBesidePane}
                  onShowAddressBar={showAddressBar}
                  onPanelAction={handlePanelAction}
                  onResizeColumns={resizeColumns}
                  onResizePanes={resizePanes}
                  onTransitionSettled={bumpLayoutEpoch}
                />
              )}
            </Box>
          </Card>
        </Flex>
      </Flex>
    </Flex>
  );
}
