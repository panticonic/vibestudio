/**
 * Svelte-idiomatic stores wrapping @workspace/runtime APIs.
 * These provide reactive state management for Svelte panels.
 */

import { derived, readable } from "svelte/store";
import { panel } from "@workspace/runtime";
import * as runtime from "@workspace/runtime";
import type { ThemeConfig } from "@workspace/runtime";

/** Reactive theme store — updates when the host theme changes. */
export const theme = readable(panel.getTheme(), (set) => {
  return panel.onThemeChange((nextTheme) => set(nextTheme));
});

/** Full live app theme identity (accent, radius, density, and panel background). */
export const themeConfig = readable<ThemeConfig>(panel.getThemeConfig(), (set) => {
  return panel.onThemeConfigChange((nextConfig) => set(nextConfig));
});

const ACCENT_COLORS: Record<string, string> = {
  amber: "#ffc53d",
  blue: "#3e63dd",
  cyan: "#00a2c7",
  green: "#30a46c",
  iris: "#5b5bd6",
  orange: "#f76b15",
  pink: "#d6409f",
  purple: "#8e4ec6",
  red: "#e5484d",
  ruby: "#e54666",
  sky: "#7ce2fe",
  teal: "#12a594",
  yellow: "#f5d90a",
};

/** CSS variables for framework-neutral Svelte panels. */
export const themeStyle = derived(themeConfig, (config) => {
  const radius =
    config.radius === "none"
      ? "0"
      : config.radius === "small"
        ? "4px"
        : config.radius === "large"
          ? "12px"
          : config.radius === "full"
            ? "9999px"
            : "8px";
  const scale = Number.parseFloat(config.scaling) / 100;
  return `--vibestudio-accent:${ACCENT_COLORS[config.accentColor] ?? ACCENT_COLORS["blue"]};--vibestudio-radius:${radius};--vibestudio-scale:${scale}`;
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
  }
);

/**
 * Reactive state-args store — reflects the panel's current state args.
 *
 * Initializes from the current snapshot via `getStateArgs()` (exposed by
 * @workspace/runtime as `panel.stateArgs.get`) and updates whenever the host
 * dispatches the `vibestudio:stateArgsChanged` CustomEvent, whose `.detail` is the
 * new args object. This is the Svelte-store analogue of React's `useStateArgs`.
 */
export const stateArgs = readable<Record<string, unknown>>(panel.stateArgs.get(), (set) => {
  const handler = (event: Event) => {
    set((event as CustomEvent<Record<string, unknown>>).detail);
  };
  window.addEventListener("vibestudio:stateArgsChanged", handler as EventListener);
  return () => window.removeEventListener("vibestudio:stateArgsChanged", handler as EventListener);
});

/**
 * Update this panel's state args. Re-exported from @workspace/runtime
 * (`panel.stateArgs.set`, i.e. `setStateArgs`) for convenience — pairs with the
 * `stateArgs` store, which reflects the resulting changes.
 */
export const setStateArgs = panel.stateArgs.set;
