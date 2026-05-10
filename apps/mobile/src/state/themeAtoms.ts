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
    background: dark ? "#1a1a2e" : "#e9eef6",
    surface: dark ? "#16213e" : "#f1f5f9",
    text: dark ? "#e0e0e0" : "#1a1a1a",
    textSecondary: dark ? "#888888" : "#4b5563",
    border: dark ? "#333333" : "#cbd5e1",
    primary: dark ? "#0f3460" : "#1a73e8",
    accent: dark ? "#7db4ff" : "#1558c0",
    accentSoft: dark ? "rgba(125, 180, 255, 0.14)" : "rgba(26, 115, 232, 0.12)",
    success: dark ? "#57c785" : "#188038",
    warning: dark ? "#f7b955" : "#b06000",
    danger: dark ? "#ff7b72" : "#d93025",
    dangerSoft: dark ? "rgba(255, 123, 114, 0.14)" : "rgba(217, 48, 37, 0.12)",
    codeBackground: dark ? "#101827" : "#e2e8f0",
    statusConnected: "#4caf50",
    statusConnecting: "#ff9800",
    statusDisconnected: "#f44336",
  };
});
