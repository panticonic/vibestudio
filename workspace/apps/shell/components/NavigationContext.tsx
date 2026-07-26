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

export interface NavigationLayoutValue {
  mode: NavigationMode;
  addressBarVisible: boolean;
}

export interface NavigationLazyValue {
  lazyTitleNavigation: LazyTitleNavigationData | null;
  lazyStatusNavigation: LazyStatusNavigationData | null;
}

export interface NavigationActionsValue {
  setMode: (mode: NavigationMode) => void;
  setAddressBarVisible: (visible: boolean) => void;
  setLazyTitleNavigation: (data: LazyTitleNavigationData | null) => void;
  setLazyStatusNavigation: (data: LazyStatusNavigationData | null) => void;
  navigateToId: NavigateToPanelId;
  registerNavigateToId: (fn: NavigateToPanelId) => void;
}

export type NavigationContextValue = NavigationLayoutValue &
  NavigationLazyValue &
  NavigationActionsValue;

const NavigationLayoutContext = createContext<NavigationLayoutValue | null>(null);
const NavigationLazyContext = createContext<NavigationLazyValue | null>(null);
const NavigationActionsContext = createContext<NavigationActionsValue | null>(null);
const SMALL_WINDOW_QUERY = "(max-width: 767px)";

export function getDefaultNavigationMode(): NavigationMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "tree";
  }

  return window.matchMedia(SMALL_WINDOW_QUERY).matches ? "stack" : "tree";
}

export function useNavigationLayout(): NavigationLayoutValue {
  const context = useContext(NavigationLayoutContext);
  if (!context) {
    throw new Error("useNavigationLayout must be used within a NavigationProvider");
  }
  return context;
}

export function useNavigationLazy(): NavigationLazyValue {
  const context = useContext(NavigationLazyContext);
  if (!context) {
    throw new Error("useNavigationLazy must be used within a NavigationProvider");
  }
  return context;
}

export function useNavigationActions(): NavigationActionsValue {
  const context = useContext(NavigationActionsContext);
  if (!context) {
    throw new Error("useNavigationActions must be used within a NavigationProvider");
  }
  return context;
}

export function useNavigation(): NavigationContextValue {
  return {
    ...useNavigationLayout(),
    ...useNavigationLazy(),
    ...useNavigationActions(),
  };
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

  const setPersistedAddressBarVisible = useCallback((visible: boolean) => {
    setAddressBarVisible(visible);
    try {
      localStorage.setItem("address-bar-visible", visible ? "true" : "false");
    } catch {
      // Ignore storage failures.
    }
  }, []);

  const layoutValue = useMemo<NavigationLayoutValue>(
    () => ({
      mode,
      addressBarVisible,
    }),
    [mode, addressBarVisible]
  );
  const lazyValue = useMemo<NavigationLazyValue>(
    () => ({
      lazyTitleNavigation,
      lazyStatusNavigation,
    }),
    [lazyTitleNavigation, lazyStatusNavigation]
  );
  const actionsValue = useMemo<NavigationActionsValue>(
    () => ({
      setMode,
      setAddressBarVisible: setPersistedAddressBarVisible,
      setLazyTitleNavigation,
      setLazyStatusNavigation,
      navigateToId,
      registerNavigateToId,
    }),
    [setPersistedAddressBarVisible, navigateToId, registerNavigateToId]
  );

  return (
    <NavigationActionsContext.Provider value={actionsValue}>
      <NavigationLayoutContext.Provider value={layoutValue}>
        <NavigationLazyContext.Provider value={lazyValue}>
          {children}
        </NavigationLazyContext.Provider>
      </NavigationLayoutContext.Provider>
    </NavigationActionsContext.Provider>
  );
}
