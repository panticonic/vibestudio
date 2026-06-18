import type { AppCapability } from "@natstack/shared/unitManifest";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { isAuthorizedChromeAppCaller } from "@natstack/shared/chromeTrust";
import type { ViewManager } from "../viewManager.js";

type AppViewInfo = NonNullable<ReturnType<ViewManager["getViewInfo"]>>;

const mainPlatformCapabilities: Readonly<Record<string, readonly AppCapability[]>> = {
  shell: ["panel-hosting"],
};

export function callerHasPlatformCapability(
  callerId: string,
  callerKind: string,
  capability: AppCapability
): boolean {
  if (callerKind !== "shell") return false;
  return mainPlatformCapabilities[callerId]?.includes(capability) === true;
}

export function viewHasAppCapability(
  callerId: string,
  viewInfo: AppViewInfo | null,
  capability: AppCapability
): boolean {
  if (viewInfo?.type !== "app" || !viewInfo.capabilities.includes(capability)) return false;
  if (capability !== "panel-hosting") return true;
  return isAuthorizedChromeAppCaller(callerId, viewInfo.appIdentity?.source);
}

export function requireAppCapability(
  ctx: ServiceContext,
  viewManager: ViewManager,
  capability: AppCapability,
  surface: string
): void {
  if (ctx.caller.runtime.kind !== "app") {
    throw new Error(`${surface} is restricted to app callers`);
  }
  const viewInfo = viewManager.getViewInfo(ctx.caller.runtime.id);
  if (viewHasAppCapability(ctx.caller.runtime.id, viewInfo, capability)) return;
  throw new Error(
    `${surface} requires app capability '${capability}' for ${ctx.caller.runtime.id}`
  );
}
