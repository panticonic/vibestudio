/**
 * Theme state atoms -- Jotai atoms for theme detection and the color palette.
 *
 * Uses React Native's Appearance API to detect the system theme.
 * Unlike Electron (which uses matchMedia/localStorage), mobile uses
 * the native Appearance module directly.
 *
 * The palette is layered: `background` is the app canvas, `surface` sits on
 * top of it (bars, cards), `surfaceRaised` on top of that (sheets, menus,
 * toasts), and `surfaceSunken` recedes below (inputs, wells). Text has three
 * tiers; borders two. Metric tokens (spacing/type/radius) live in
 * ../design/tokens.
 */

import { atom } from "jotai";
import { Appearance, type ColorSchemeName } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

/** Current color scheme from the system ("light" | "dark" | null) */
export const systemColorSchemeAtom = atom<ColorSchemeName>(Appearance.getColorScheme());

export type ThemePreference = "system" | "light" | "dark";

const THEME_PREFERENCE_KEY = "vibestudio:theme-preference";

const themePreferenceBaseAtom = atom<ThemePreference>("system");

/** User theme override (Settings). "system" follows the OS. Persisted. */
export const themePreferenceAtom = atom(
  (get) => get(themePreferenceBaseAtom),
  (_get, set, next: ThemePreference) => {
    set(themePreferenceBaseAtom, next);
    void AsyncStorage.setItem(THEME_PREFERENCE_KEY, next).catch(() => {});
  }
);

/** Hydrates the persisted theme preference; call once at app start. */
export const hydrateThemePreferenceAtom = atom(null, async (_get, set) => {
  try {
    const stored = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      set(themePreferenceBaseAtom, stored);
    }
  } catch {
    // Keep the default; preference is a convenience.
  }
});

/** Effective scheme after applying the user preference. */
export const colorSchemeAtom = atom(
  (get): ColorSchemeName => {
    const preference = get(themePreferenceBaseAtom);
    if (preference !== "system") return preference;
    return get(systemColorSchemeAtom);
  },
  (_get, set, next: ColorSchemeName) => {
    set(systemColorSchemeAtom, next);
  }
);

/** Derived: whether dark mode is active (defaults to dark if system doesn't report) */
export const isDarkModeAtom = atom((get) => {
  const scheme = get(colorSchemeAtom);
  return scheme !== "light"; // default to dark
});

export interface ThemeColors {
  background: string;
  surface: string;
  /** Sheets, menus, toasts -- anything floating above surface. */
  surfaceRaised: string;
  /** Inputs, wells, inactive pills -- recedes below surface. */
  surfaceSunken: string;
  text: string;
  textSecondary: string;
  /** Faint metadata -- counts, timestamps, placeholder glyphs. */
  textTertiary: string;
  border: string;
  /** Softer divider for internal separators. */
  borderSubtle: string;
  primary: string;
  /** Text/icon color rendered on top of a `primary` fill. */
  onPrimary: string;
  accent: string;
  accentSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
  codeBackground: string;
  /** Scrim behind sheets and dialogs. */
  overlay: string;
  /** Pass to shadowColor together with design/tokens shadow presets. */
  shadow: string;
  statusConnected: string;
  statusConnecting: string;
  statusDisconnected: string;
}

const darkColors: ThemeColors = {
  background: "#100b18",
  surface: "#1a1226",
  surfaceRaised: "#241832",
  surfaceSunken: "#150e20",
  text: "#fbf7ff",
  textSecondary: "#b8a9c5",
  textTertiary: "#806f8f",
  border: "#49305f",
  borderSubtle: "#332140",
  primary: "#a874ff",
  onPrimary: "#180f22",
  accent: "#f05aa7",
  accentSoft: "rgba(168, 116, 255, 0.16)",
  success: "#57c785",
  successSoft: "rgba(87, 199, 133, 0.14)",
  warning: "#f7b955",
  warningSoft: "rgba(247, 185, 85, 0.14)",
  danger: "#ff7b72",
  dangerSoft: "rgba(255, 123, 114, 0.14)",
  info: "#7cb8ff",
  infoSoft: "rgba(124, 184, 255, 0.14)",
  codeBackground: "#150e20",
  overlay: "rgba(10, 5, 15, 0.66)",
  shadow: "#000000",
  statusConnected: "#3fa564",
  statusConnecting: "#e08c00",
  statusDisconnected: "#e04b3f",
};

const lightColors: ThemeColors = {
  background: "#fcfaff",
  surface: "#ffffff",
  surfaceRaised: "#ffffff",
  surfaceSunken: "#f2ebf7",
  text: "#24152f",
  textSecondary: "#685875",
  textTertiary: "#9686a2",
  border: "#decfe9",
  borderSubtle: "#eee5f4",
  primary: "#6d28d9",
  onPrimary: "#ffffff",
  accent: "#c21872",
  accentSoft: "rgba(109, 40, 217, 0.11)",
  success: "#188038",
  successSoft: "rgba(24, 128, 56, 0.11)",
  warning: "#b06000",
  warningSoft: "rgba(176, 96, 0, 0.12)",
  danger: "#d93025",
  dangerSoft: "rgba(217, 48, 37, 0.10)",
  info: "#1a6fd4",
  infoSoft: "rgba(26, 111, 212, 0.10)",
  codeBackground: "#f2ebf7",
  overlay: "rgba(36, 21, 47, 0.40)",
  shadow: "#24152f",
  statusConnected: "#2e9e57",
  statusConnecting: "#d98a00",
  statusDisconnected: "#d9453a",
};

/** Theme colors derived from the color scheme */
export const themeColorsAtom = atom<ThemeColors>((get) =>
  get(isDarkModeAtom) ? darkColors : lightColors
);
