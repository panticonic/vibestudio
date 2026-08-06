import { PanelHostObservationSchema } from "@vibestudio/shared/panelContracts";
import type {
  PanelBootObservation,
  PanelHostObservation,
} from "@vibestudio/shared/panel/observation";

export interface DesktopPanelObservationSource {
  getBootObservation(panelId: string): Promise<PanelBootObservation>;
  getPanelHostObservation(panelId: string, boot: PanelBootObservation): PanelHostObservation;
}

/**
 * Produce the canonical presentation-host observation at the desktop wire
 * boundary. Headless and desktop must publish this same value; consumers never
 * infer a host-specific shape.
 */
export async function observeDesktopPanelHost(
  source: DesktopPanelObservationSource,
  panelId: string
): Promise<PanelHostObservation> {
  const boot = await source.getBootObservation(panelId);
  return PanelHostObservationSchema.parse(source.getPanelHostObservation(panelId, boot));
}
