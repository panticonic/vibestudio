import type { PanelPresentationSnapshot } from "@vibestudio/shared/panel/presentation";
import type { PanelSlotObservation } from "@vibestudio/shared/panel/observation";

/**
 * Test diagnostics for the Electron-owned presentation lifecycle.
 *
 * `presentation` is the sole readiness oracle. The server observation is kept
 * alongside it to diagnose propagation without reconstructing a second
 * readiness predicate from coordinator and native-host facts.
 */
export type PanelReadinessSnapshot = {
  panelId: string;
  source: string | null;
  runtimeEntityId: string | null;
  contentReady: boolean;
  terminal: boolean;
  nativeSlotBound: boolean;
  presentation: PanelPresentationSnapshot["presentation"];
  presentationRevision: number;
  attempt: PanelSlotObservation["attempt"];
  route: PanelSlotObservation["route"];
  build?: PanelSlotObservation["build"];
};

export function panelReadinessSnapshot(input: {
  panelId: string;
  source: string | null;
  nativeSlotBound: boolean;
  presentation: PanelPresentationSnapshot;
  observation: PanelSlotObservation;
}): PanelReadinessSnapshot {
  const ready = input.presentation.presentation.state === "ready";
  const runtimeEntityId =
    input.presentation.presentation.state === "ready"
      ? input.presentation.presentation.runtimeEntityId
      : (input.observation.attempt?.runtimeEntityId ?? null);
  return {
    panelId: input.panelId,
    source: input.source,
    runtimeEntityId,
    contentReady: ready,
    terminal: ready,
    nativeSlotBound: input.nativeSlotBound,
    presentation: input.presentation.presentation,
    presentationRevision: input.presentation.revision,
    attempt: input.observation.attempt,
    route: input.observation.route,
    ...(input.observation.build ? { build: input.observation.build } : {}),
  };
}
