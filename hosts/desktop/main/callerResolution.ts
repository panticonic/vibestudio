import type { ViewConfig } from "./viewManager.js";
import type { CallerKind } from "@vibestudio/shared/principalKinds";

export type ElectronViewCallerKind = Extract<CallerKind, "panel" | "client">;

export interface ElectronViewInfoForCallerResolution {
  type: ViewConfig["type"];
  hostChrome?: boolean;
}

/** The panel-hosting client: the trusted chrome of the one panel-hosting window. */
export function isPanelHostingClientView(
  viewInfo: ElectronViewInfoForCallerResolution | null | undefined
): boolean {
  return viewInfo?.type === "client" && viewInfo.hostChrome === true;
}

/**
 * Every renderer the host runs is a panel or a client. There is no bare
 * "shell" principal: the launch gate is host UI that makes no RPC calls, and a
 * client is its own principal.
 */
export function resolveElectronViewCaller(
  callerId: string,
  viewInfo: ElectronViewInfoForCallerResolution | null | undefined
): { callerId: string; callerKind: ElectronViewCallerKind } {
  if (!viewInfo) {
    throw new Error(`Unknown Electron view caller: ${callerId}`);
  }
  return { callerId, callerKind: viewInfo.type };
}
