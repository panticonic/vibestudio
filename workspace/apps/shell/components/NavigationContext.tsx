import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  NavigationMode,
  LazyTitleNavigationData,
  LazyStatusNavigationData,
} from "./navigationTypes";
import type { PanelPlacementHint } from "../layout/types";

export interface PanelNavigationOptions {
  parentId?: string;
  hint?: PanelPlacementHint;
  intentId?: string;
  /** Explicit user navigation replaces the pane the user most recently focused. */
  target?: "focused-pane";
}

export type NavigateToPanelId = (panelId: string, options?: PanelNavigationOptions) => void;

interface NavigationContextValue {
  mode: NavigationMode;
  setMode: (mode: NavigationMode) => void;
  addressBarVisible: boolean;
  setAddressBarVisible: (visible: boolean) => void;
  // ID-based lazy navigation
  lazyTitleNavigation: LazyTitleNavigationData | null;
  setLazyTitleNavigation: (data: LazyTitleNavigationData | null) => void;
  lazyStatusNavigation: LazyStatusNavigationData | null;
  setLazyStatusNavigation: (data: LazyStatusNavigationData | null) => void;
  navigateToId: NavigateToPanelId;
  registerNavigateToId: (fn: NavigateToPanelId) => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);
const SMALL_WINDOW_QUERY = "(max-width: 767px)";

export function getDefaultNavigationMode(): NavigationMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "tree";
  }

  return window.matchMedia(SMALL_WINDOW_QUERY).matches ? "stack" : "tree";
}

export function useNavigation(): NavigationContextValue {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error("useNavigation must be used within a NavigationProvider");
  }
  return context;
}

interface NavigationProviderProps {
  children: ReactNode;
}

export function NavigationProvider({ children }: NavigationProviderProps) {
  const [mode, setMode] = useState<NavigationMode>(() => getDefaultNavigationMode());
  const [addressBarVisible, setAddressBarVisible] = useState(() => {
    try {
      return localStorage.getItem("address-bar-visible") === "true";
    } catch {
      return false;
    }
  });

  // ID-based lazy navigation state
  const [lazyTitleNavigation, setLazyTitleNavigation] = useState<LazyTitleNavigationData | null>(
    null
  );
  const [lazyStatusNavigation, setLazyStatusNavigation] = useState<LazyStatusNavigationData | null>(
    null
  );

  // Use ref for stable navigateToId callback (prevents listener cycling)
  const navigateToIdFnRef = useRef<NavigateToPanelId>(() => {});

  const navigateToId = useCallback(
    (panelId: string, options?: PanelNavigationOptions) => {
      navigateToIdFnRef.current(panelId, options);
    },
    [] // Stable forever - no dependencies
  );

  const registerNavigateToId = useCallback((fn: NavigateToPanelId) => {
    navigateToIdFnRef.current = fn;
  }, []);

  const value = useMemo<NavigationContextValue>(
    () => ({
      mode,
      setMode,
      addressBarVisible,
      setAddressBarVisible: (visible: boolean) => {
        setAddressBarVisible(visible);
        try {
          localStorage.setItem("address-bar-visible", visible ? "true" : "false");
        } catch {
          // Ignore storage failures.
        }
      },
      lazyTitleNavigation,
      setLazyTitleNavigation,
      lazyStatusNavigation,
      setLazyStatusNavigation,
      navigateToId,
      registerNavigateToId,
    }),
    [
      mode,
      addressBarVisible,
      lazyTitleNavigation,
      lazyStatusNavigation,
      navigateToId,
      registerNavigateToId,
    ]
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}
