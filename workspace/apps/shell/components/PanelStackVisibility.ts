import type { PanelArtifacts, PanelRuntimeStatus } from "@natstack/shared/types";
import type { PanelRuntimeLease } from "@natstack/shared/panel/panelLease";

export function shouldShowPanelView(artifacts: PanelArtifacts | undefined): boolean {
  return Boolean(
    artifacts?.htmlPath &&
    artifacts.buildState !== "pending" &&
    artifacts.buildState !== "error" &&
    !artifacts.error
  );
}

export function leasedElsewhereInfo(
  panelId: string,
  lease: Pick<PanelRuntimeLease, "slotId" | "holderLabel" | "platform"> | null | undefined,
  runtime: PanelRuntimeStatus | null | undefined
): { slotId: string; holderLabel: string } | null {
  const platform = lease?.platform ?? runtime?.platform;
  if (platform !== "headless" && platform !== "mobile") return null;

  const holderLabel = lease?.holderLabel ?? runtime?.holderLabel;
  if (!holderLabel) return null;

  return {
    slotId: lease?.slotId ?? panelId,
    holderLabel,
  };
}
