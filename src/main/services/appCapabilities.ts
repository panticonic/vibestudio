import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { isAuthorizedChromeAppCaller } from "@vibestudio/shared/chromeTrust";
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

/**
 * Gate a service whose `policy.allowed` lists both `shell` and `app` so that
 * the `app` grant is restricted to authorized chrome (panel-hosting) — i.e. the
 * authorized workspace chrome app, never an arbitrary workspace app.
 * Native-host `shell`/`server`/`panel` callers pass through untouched; `app`
 * callers must carry the `panel-hosting` chrome capability.
 */
export function requireChromeAppCallerOrHost(
  ctx: ServiceContext,
  viewManager: ViewManager,
  surface: string
): void {
  if (ctx.caller.runtime.kind !== "app") return;
  requireAppCapability(ctx, viewManager, "panel-hosting", surface);
}

/**
 * Gate a surface to CHROME only — the native host (`shell`: electron-main /
 * bootstrap launch gate) or the authorized chrome app carrying
 * `panel-hosting`. Unlike {@link requireChromeAppCallerOrHost},
 * this REJECTS `panel`/`server`/arbitrary-`app` callers, so it is the correct
 * gate for cross-panel surfaces (e.g. `palette.list`/`palette.run`,
 * `app.openWorkspacePath`) whose `policy.allowed` also admits `panel` for OTHER
 * methods. Hosted workspace chrome now resolves as `kind:"app"`, so a bare
 * `kind === "shell"` check silently rejected it.
 */
export function requireChromeCaller(
  ctx: ServiceContext,
  viewManager: ViewManager,
  surface: string
): void {
  const { kind } = ctx.caller.runtime;
  if (kind === "shell") return;
  if (kind === "app") {
    requireAppCapability(ctx, viewManager, "panel-hosting", surface);
    return;
  }
  throw new Error(`${surface} is restricted to chrome (the shell)`);
}
