/**
 * Theme state atoms -- Jotai atoms for theme detection.
 *
 * Uses React Native's Appearance API to detect the system theme.
 * Unlike Electron (which uses matchMedia/localStorage), mobile uses
 * the native Appearance module directly.
 */

import { atom } from "jotai";
import { Appearance, type ColorSchemeName } from "react-native";

/** Current color scheme from the system ("light" | "dark" | null) */
export const colorSchemeAtom = atom<ColorSchemeName>(Appearance.getColorScheme());

/** Derived: whether dark mode is active (defaults to dark if system doesn't report) */
export const isDarkModeAtom = atom((get) => {
  const scheme = get(colorSchemeAtom);
  return scheme !== "light"; // default to dark
});

/** Basic theme colors derived from the color scheme */
export const themeColorsAtom = atom((get) => {
  const dark = get(isDarkModeAtom);
  return {
    background: dark ? "#0a0b0c" : "#f7f4ee",
    surface: dark ? "#141821" : "#ffffff",
    text: dark ? "#f8fafc" : "#111827",
    textSecondary: dark ? "#9ca3af" : "#4b5563",
    border: dark ? "#303a4f" : "#d7d0c3",
    primary: dark ? "#f59e0b" : "#b45309",
    accent: dark ? "#facc15" : "#b45309",
    accentSoft: dark ? "rgba(250, 204, 21, 0.14)" : "rgba(180, 83, 9, 0.12)",
    success: dark ? "#57c785" : "#188038",
    warning: dark ? "#f7b955" : "#b06000",
    danger: dark ? "#ff7b72" : "#d93025",
    dangerSoft: dark ? "rgba(255, 123, 114, 0.14)" : "rgba(217, 48, 37, 0.12)",
    codeBackground: dark ? "#101318" : "#ece6da",
    statusConnected: "#4caf50",
    statusConnecting: "#ff9800",
    statusDisconnected: "#f44336",
  };
});
