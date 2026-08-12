const DRAWER_TRAILING_GUTTER = 48;
const DRAWER_MAX_WIDTH = 360;

/**
 * Keep enough of the current panel visible to make the drawer feel dismissible,
 * while using the extra width modern phones and tablets provide.
 */
export function mobileDrawerWidth(viewportWidth: number): number {
  return Math.max(0, Math.min(DRAWER_MAX_WIDTH, viewportWidth - DRAWER_TRAILING_GUTTER));
}
