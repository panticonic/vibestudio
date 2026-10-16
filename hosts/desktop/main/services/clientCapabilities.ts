import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { ViewManager } from "../viewManager.js";
import type { ClientWindows } from "../clientWindow.js";

type ClientViewInfo = NonNullable<ReturnType<ViewManager["getViewInfo"]>>;

/**
 * Whether the live, admitted client view holds `capability`. Capabilities are
 * the server-vetted `grantedCapabilities` the launch delivered; `panel-hosting`
 * additionally requires the view to be the window's hosting surface.
 */
export function viewHasClientCapability(
  viewInfo: ClientViewInfo | null,
  capability: ClientCapability
): boolean {
  if (viewInfo?.type !== "client" || !viewInfo.capabilities.includes(capability)) return false;
  if (capability !== "panel-hosting") return true;
  return viewInfo.hostChrome;
}

export function requireClientCapability(
  ctx: ServiceContext,
  viewManager: ViewManager,
  capability: ClientCapability,
  surface: string
): void {
  if (ctx.caller.runtime.kind !== "client") {
    throw accessError(`${surface} is restricted to client callers`);
  }
  const viewInfo = viewManager.getViewInfo(ctx.caller.runtime.id);
  if (viewHasClientCapability(viewInfo, capability)) return;
  throw accessError(
    `${surface} requires client capability '${capability}' for ${ctx.caller.runtime.id}`
  );
}

function accessError(message: string): Error {
  return Object.assign(new Error(message), { code: "EACCES" });
}

/**
 * Gate a service that lists both `panel` and `client` callers so that the
 * client grant is restricted to a client holding `panel-hosting`. Callers of
 * other kinds pass through untouched; the service's own authority decides them.
 */
export function requireChromeClientCallerOr(
  ctx: ServiceContext,
  viewManager: ViewManager,
  surface: string
): void {
  if (ctx.caller.runtime.kind !== "client") return;
  requireClientCapability(ctx, viewManager, "panel-hosting", surface);
}

/** Gate a capability that any client window may hold, whether or not it hosts panels. */
export function requireWindowCapability(
  ctx: ServiceContext,
  windows: Pick<ClientWindows, "byCaller">,
  capability: ClientCapability,
  surface: string
): void {
  if (ctx.caller.runtime.kind !== "client") {
    throw accessError(`${surface} is restricted to client callers`);
  }
  const window = windows.byCaller(ctx.caller.runtime.id);
  if (window?.spec.capabilities.includes(capability)) return;
  throw accessError(
    `${surface} requires client capability '${capability}' for ${ctx.caller.runtime.id}`
  );
}
