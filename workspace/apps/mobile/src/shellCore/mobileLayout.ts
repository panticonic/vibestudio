const DRAWER_TRAILING_GUTTER = 48;
const DRAWER_MAX_WIDTH = 360;
const TABLET_MIN_SHORTEST_SIDE = 600;
const TABLET_DRAWER_MIN_WIDTH = 280;
const TABLET_DRAWER_MAX_WIDTH = 320;

export interface MobileNavigationLayout {
  kind: "phone" | "tablet";
  drawerWidth: number;
}

/**
 * Keep enough of the current panel visible to make the drawer feel dismissible,
 * while using the extra width modern phones and tablets provide.
 */
function overlayDrawerWidth(viewportWidth: number): number {
  return Math.max(0, Math.min(DRAWER_MAX_WIDTH, viewportWidth - DRAWER_TRAILING_GUTTER));
}

/**
 * Phones keep the tree in a dismissible overlay in either orientation. A true
 * tablet (600dp shortest side) gets a stable master/detail workspace with a
 * bounded sidebar, including while rotating between portrait and landscape.
 */
export function mobileNavigationLayout(
  viewportWidth: number,
  viewportHeight: number
): MobileNavigationLayout {
  const shortestSide = Math.min(viewportWidth, viewportHeight);
  if (shortestSide < TABLET_MIN_SHORTEST_SIDE) {
    return { kind: "phone", drawerWidth: overlayDrawerWidth(viewportWidth) };
  }
  return {
    kind: "tablet",
    drawerWidth: Math.min(
      TABLET_DRAWER_MAX_WIDTH,
      Math.max(TABLET_DRAWER_MIN_WIDTH, Math.round(viewportWidth * 0.3))
    ),
  };
}
