import type { PanelRuntimeStatus } from "@vibestudio/shared/types";

export type PanelReadinessSnapshot = {
  panelId: string;
  source: string | null;
  /** Renderer content and its runtime are ready, whether or not this panel is visible. */
  contentReady: boolean;
  /** Content-ready and bound into the visible native panel slot. */
  terminal: boolean;
  view: { exists: boolean; url: string | null; isLoading: boolean | null };
  artifacts: {
    buildState: string | null;
    htmlPath: string | null;
    error: string | null;
  };
  runtime: PanelRuntimeStatus | null;
  nativeSlotBound: boolean;
};

export type PanelReadinessSignals = Omit<PanelReadinessSnapshot, "contentReady" | "terminal">;

export function isPanelContentReady(signals: PanelReadinessSignals): boolean {
  return (
    signals.source !== null &&
    signals.runtime?.leased === true &&
    signals.view.exists &&
    !!signals.view.url &&
    signals.view.isLoading === false &&
    signals.artifacts.buildState === "ready" &&
    !!signals.artifacts.htmlPath &&
    !signals.artifacts.error
  );
}

export function isTerminalPanelReadiness(signals: PanelReadinessSignals): boolean {
  return isPanelContentReady(signals) && signals.nativeSlotBound;
}

export function panelReadinessSnapshot(signals: PanelReadinessSignals): PanelReadinessSnapshot {
  return {
    ...signals,
    contentReady: isPanelContentReady(signals),
    terminal: isTerminalPanelReadiness(signals),
  };
}
