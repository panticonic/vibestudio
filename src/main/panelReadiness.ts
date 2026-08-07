import type { PanelSlotObservation } from "@vibestudio/shared/panel/observation";

/** Test diagnostics projected from the server-owned canonical lifecycle. */
export type PanelReadinessSnapshot = {
  panelId: string;
  source: string | null;
  runtimeEntityId: string | null;
  contentReady: boolean;
  terminal: boolean;
  nativeSlotBound: boolean;
  attempt: PanelSlotObservation["attempt"];
  route: PanelSlotObservation["route"];
  build?: PanelSlotObservation["build"];
};

export function panelReadinessSnapshot(input: {
  panelId: string;
  source: string | null;
  nativeSlotBound: boolean;
  observation: PanelSlotObservation;
}): PanelReadinessSnapshot {
  const contentReady = input.observation.attempt?.phase === "ready";
  return {
    panelId: input.panelId,
    source: input.source,
    runtimeEntityId: input.observation.attempt?.runtimeEntityId ?? null,
    contentReady,
    terminal: contentReady && input.nativeSlotBound,
    nativeSlotBound: input.nativeSlotBound,
    attempt: input.observation.attempt,
    route: input.observation.route,
    ...(input.observation.build ? { build: input.observation.build } : {}),
  };
}
