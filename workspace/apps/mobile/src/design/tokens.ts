/**
 * Design tokens -- the single source of truth for the mobile app's visual
 * language. Colors live in themeAtoms (scheme-dependent); everything metric
 * lives here so components stop hand-rolling sizes.
 *
 * Scale philosophy: 4pt spacing grid, a small type ramp, and three radius
 * tiers. Use `radius.pill` for chips/badges only.
 */

import { StyleSheet, type TextStyle } from "react-native";

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

/** Minimum comfortable touch target. */
export const touchTarget = 44;

export const hairline = StyleSheet.hairlineWidth;

type Weight = TextStyle["fontWeight"];

const weight = {
  regular: "400" as Weight,
  medium: "500" as Weight,
  semibold: "600" as Weight,
  bold: "700" as Weight,
};

/** Type ramp. Use these instead of ad-hoc fontSize/fontWeight pairs. */
export const type = {
  /** Screen titles ("Settings"). */
  title: { fontSize: 24, fontWeight: weight.bold, letterSpacing: -0.4 } as TextStyle,
  /** App-bar / sheet headings. */
  heading: { fontSize: 17, fontWeight: weight.semibold, letterSpacing: -0.2 } as TextStyle,
  /** Section headers -- small caps label style. */
  section: {
    fontSize: 12,
    fontWeight: weight.bold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  } as TextStyle,
  /** Primary row / body text. */
  body: { fontSize: 15, fontWeight: weight.regular, lineHeight: 21 } as TextStyle,
  /** Emphasized row text (list row titles, button labels). */
  bodyStrong: { fontSize: 15, fontWeight: weight.semibold } as TextStyle,
  /** Secondary line under a row title. */
  caption: { fontSize: 13, fontWeight: weight.regular, lineHeight: 18 } as TextStyle,
  /** Tiny metadata (badges, counts, chips). */
  micro: { fontSize: 11, fontWeight: weight.semibold, letterSpacing: 0.2 } as TextStyle,
} as const;

/**
 * Elevation presets. Pair with a scheme-aware shadow color from theme colors
 * (`colors.shadow`) via `{ ...shadow.card, shadowColor: colors.shadow }`.
 */
export const shadow = {
  card: {
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  sheet: {
    shadowOpacity: 0.28,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -6 },
    elevation: 16,
  },
  toast: {
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
} as const;

/** Standard pressed-state opacity for Pressables without a bg change. */
export const pressedOpacity = 0.55;
