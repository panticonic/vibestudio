/**
 * Registry of overlay surfaces hosted by the reusable content overlay. Add a
 * surface component here + a key in `OverlaySurfaceKey` (./types) to make it
 * floatable above the panels; the chrome drives it via `useShellContentOverlay`.
 */
import { ApprovalCardSurface } from "./ApprovalCardSurface";
import type { OverlaySurfaceComponent, OverlaySurfaceKey } from "./types";

export const OVERLAY_SURFACES: Record<OverlaySurfaceKey, OverlaySurfaceComponent> = {
  "approval-card": ApprovalCardSurface,
};

export function getOverlaySurface(key: string): OverlaySurfaceComponent | null {
  return (OVERLAY_SURFACES as Record<string, OverlaySurfaceComponent | undefined>)[key] ?? null;
}
