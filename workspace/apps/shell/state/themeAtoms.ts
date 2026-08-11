import { atom } from "jotai";
import { ThemeConfigSchema } from "@vibestudio/shared/panelContracts";
import type { ThemeConfig } from "@vibestudio/shared/theme";
import { APP_THEME } from "@workspace/ui/theme";

export type ThemeMode = "light" | "dark" | "system";

export type ThemeConfigValue = ThemeConfig;

/**
 * The user's theme preference (light, dark, or system).
 * Defaults to 'system' to respect OS preferences.
 */
export const themeModeAtom = atom<ThemeMode>("system");

/**
 * The currently applied theme based on user preference and system settings.
 * This is a derived atom that resolves 'system' mode to the actual theme.
 */
export const effectiveThemeAtom = atom<"light" | "dark">((get) => {
  const mode = get(themeModeAtom);

  if (mode === "system") {
    // Check system preference
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  }

  return mode;
});

/**
 * Action atom to set the theme mode.
 * Also persists the preference to localStorage.
 */
export const setThemeModeAtom = atom(null, (get, set, mode: ThemeMode) => {
  set(themeModeAtom, mode);

  // Persist to localStorage
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem("theme-mode", mode);
    } catch (error) {
      console.error("Failed to save theme preference:", error);
    }
  }
});

/**
 * Load theme preference from localStorage on app startup.
 */
export const loadThemePreferenceAtom = atom(null, (get, set) => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const saved = localStorage.getItem("theme-mode");
    if (saved === "light" || saved === "dark" || saved === "system") {
      set(themeModeAtom, saved);
    }
  } catch (error) {
    console.error("Failed to load theme preference:", error);
  }
});

// ===========================================================================
// Theme IDENTITY (accent/radius/…) — a live user setting, broadcast to panels.
// ===========================================================================

/** The active theme identity; defaults to the app signature (APP_THEME). */
export const themeConfigAtom = atom<ThemeConfigValue>({ ...APP_THEME });

/** Set + persist the theme identity. */
export const setThemeConfigAtom = atom(null, (get, set, patch: Partial<ThemeConfigValue>) => {
  const next = { ...get(themeConfigAtom), ...patch };
  set(themeConfigAtom, next);
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem("theme-config", JSON.stringify(next));
    } catch (error) {
      console.error("Failed to save theme identity:", error);
    }
  }
});

/** Load the persisted theme identity on startup. */
export const loadThemeConfigAtom = atom(null, (get, set) => {
  if (typeof window === "undefined") return;
  try {
    const saved = localStorage.getItem("theme-config");
    if (!saved) return;
    const parsed = ThemeConfigSchema.safeParse({ ...APP_THEME, ...JSON.parse(saved) });
    if (parsed.success) set(themeConfigAtom, parsed.data);
  } catch (error) {
    console.error("Failed to load theme identity:", error);
  }
});
