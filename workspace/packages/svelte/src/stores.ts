/**
 * Svelte-idiomatic stores wrapping @workspace/runtime APIs.
 * These provide reactive state management for Svelte panels.
 */

import { readable } from "svelte/store";
import { panel } from "@workspace/runtime";
import * as runtime from "@workspace/runtime";

/** Reactive theme store — updates when the host theme changes. */
export const theme = readable(panel.getTheme(), (set) => {
  return panel.onThemeChange((nextTheme) => set(nextTheme));
});

/** Static panel ID store. */
export const panelId = readable(runtime.id);

/** Static context ID store. */
export const contextId = readable(runtime.contextId);

/** Reactive connection error store — null when connected. */
export const connectionError = readable<{ code: number; reason: string; source?: string } | null>(
  null,
  (set) => {
    return panel.onConnectionError((err) => set(err));
  },
);

/**
 * Reactive state-args store — reflects the panel's current state args.
 *
 * Initializes from the current snapshot via `getStateArgs()` (exposed by
 * @workspace/runtime as `panel.stateArgs.get`) and updates whenever the host
 * dispatches the `vibez1:stateArgsChanged` CustomEvent, whose `.detail` is the
 * new args object. This is the Svelte-store analogue of React's `useStateArgs`.
 */
export const stateArgs = readable<Record<string, unknown>>(panel.stateArgs.get(), (set) => {
  const handler = (event: Event) => {
    set((event as CustomEvent<Record<string, unknown>>).detail);
  };
  window.addEventListener("vibez1:stateArgsChanged", handler as EventListener);
  return () => window.removeEventListener("vibez1:stateArgsChanged", handler as EventListener);
});

/**
 * Update this panel's state args. Re-exported from @workspace/runtime
 * (`panel.stateArgs.set`, i.e. `setStateArgs`) for convenience — pairs with the
 * `stateArgs` store, which reflects the resulting changes.
 */
export const setStateArgs = panel.stateArgs.set;
