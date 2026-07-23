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
    background: dark ? "#100b18" : "#fcfaff",
    surface: dark ? "#1a1226" : "#ffffff",
    text: dark ? "#fbf7ff" : "#24152f",
    textSecondary: dark ? "#b8a9c5" : "#685875",
    border: dark ? "#49305f" : "#decfe9",
    primary: dark ? "#a874ff" : "#6d28d9",
    accent: dark ? "#f05aa7" : "#c21872",
    accentSoft: dark ? "rgba(168, 116, 255, 0.16)" : "rgba(109, 40, 217, 0.11)",
    success: dark ? "#57c785" : "#188038",
    warning: dark ? "#f7b955" : "#b06000",
    danger: dark ? "#ff7b72" : "#d93025",
    dangerSoft: dark ? "rgba(255, 123, 114, 0.14)" : "rgba(217, 48, 37, 0.12)",
    codeBackground: dark ? "#150e20" : "#f2ebf7",
    statusConnected: "#4caf50",
    statusConnecting: "#ff9800",
    statusDisconnected: "#f44336",
  };
});
