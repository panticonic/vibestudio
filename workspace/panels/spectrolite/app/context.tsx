/**
 * React bindings for the Spectrolite app: a context carrying the app
 * singleton plus selector hooks. Components call `useAppState(selector)`
 * and re-render only when their selected slice changes.
 */

import { createContext, useContext } from "react";
import type { SpectroliteApp } from "./createApp";
import type { SpectroliteState } from "./state";
import { useStoreState } from "./store";

const AppContext = createContext<SpectroliteApp | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): SpectroliteApp {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp must be used inside <AppProvider>");
  return app;
}

export function useAppState<U>(selector: (state: SpectroliteState) => U): U {
  const app = useApp();
  return useStoreState(app.store, selector);
}
