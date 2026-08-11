/**
 * Theme identity shared by the shell, runtime bridge, and panel renderers.
 *
 * These values intentionally match the finite Radix Themes contract without
 * importing a UI library into the host/shared layer. Keeping the transport
 * finite lets every renderer pass a validated ThemeConfig straight through;
 * no literal narrowing casts or renderer-specific conversion objects belong at
 * the boundary.
 */
export const THEME_ACCENT_COLORS = [
  "gray",
  "gold",
  "bronze",
  "brown",
  "yellow",
  "amber",
  "orange",
  "tomato",
  "red",
  "ruby",
  "crimson",
  "pink",
  "plum",
  "purple",
  "violet",
  "iris",
  "indigo",
  "blue",
  "cyan",
  "teal",
  "jade",
  "green",
  "grass",
  "lime",
  "mint",
  "sky",
] as const;

export const THEME_GRAY_COLORS = [
  "auto",
  "gray",
  "mauve",
  "slate",
  "sage",
  "olive",
  "sand",
] as const;
export const THEME_RADII = ["none", "small", "medium", "large", "full"] as const;
export const THEME_SCALINGS = ["90%", "95%", "100%", "105%", "110%"] as const;
export const THEME_PANEL_BACKGROUNDS = ["solid", "translucent"] as const;

export type ThemeAccentColor = (typeof THEME_ACCENT_COLORS)[number];
export type ThemeGrayColor = (typeof THEME_GRAY_COLORS)[number];
export type ThemeRadius = (typeof THEME_RADII)[number];
export type ThemeScaling = (typeof THEME_SCALINGS)[number];
export type ThemePanelBackground = (typeof THEME_PANEL_BACKGROUNDS)[number];

export const isThemeAccentColor = (value: unknown): value is ThemeAccentColor =>
  THEME_ACCENT_COLORS.some((candidate) => candidate === value);
export const isThemeGrayColor = (value: unknown): value is ThemeGrayColor =>
  THEME_GRAY_COLORS.some((candidate) => candidate === value);
export const isThemeRadius = (value: unknown): value is ThemeRadius =>
  THEME_RADII.some((candidate) => candidate === value);
export const isThemeScaling = (value: unknown): value is ThemeScaling =>
  THEME_SCALINGS.some((candidate) => candidate === value);
export const isThemePanelBackground = (value: unknown): value is ThemePanelBackground =>
  THEME_PANEL_BACKGROUNDS.some((candidate) => candidate === value);

export interface ThemeConfig {
  accentColor: ThemeAccentColor;
  grayColor: ThemeGrayColor;
  radius: ThemeRadius;
  scaling: ThemeScaling;
  panelBackground: ThemePanelBackground;
}

/** Product default used until a persisted or shell-provided preference wins. */
export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  accentColor: "violet",
  grayColor: "mauve",
  radius: "medium",
  scaling: "100%",
  panelBackground: "translucent",
};
