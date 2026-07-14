import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { viewMethods } from "@vibestudio/service-schemas/view";
import type { ViewManager } from "../viewManager.js";
import { assertHttpUrl } from "../utils.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { hasPanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";

export function createViewService(deps: { getViewManager: () => ViewManager }): ServiceDefinition {
  /**
   * Ownership invariant for cross-view methods (audit finding #9).
   *
   * The full workspace shell now runs as an app target. It gets cross-view
   * authority by declaring `panel-hosting`; ordinary app callers can only
   * reach self-targeted methods if this policy is expanded later.
   */
  const assertViewHost = async (ctx: ServiceContext, method: string): Promise<void> => {
    if (await hasPanelHostingAuthority(ctx)) return;
    throw new Error(
      `view.${method}: caller '${ctx.caller.runtime.id}' cannot host workspace views`
    );
  };

  const assertNativePanelSlotHost = async (ctx: ServiceContext, method: string): Promise<void> => {
    if (await hasPanelHostingAuthority(ctx)) return;
    throw new Error(
      `view.${method}: caller '${ctx.caller.runtime.id}' cannot place native panel slots`
    );
  };

  const assertOwnsOrViewHost = async (
    ctx: ServiceContext,
    targetId: string,
    method: string
  ): Promise<void> => {
    const callerId = ctx.caller.runtime.id;
    if (callerId === targetId || (await hasPanelHostingAuthority(ctx))) return;
    throw new Error(`view.${method}: caller '${callerId}' does not own target view '${targetId}'`);
  };

  return {
    name: "view",
    description: "View bounds, visibility, theme CSS",
    authority: { principals: ["user", "code"] },
    methods: viewMethods,
    handler: defineServiceHandler("view", viewMethods, {
      setBounds: async (ctx, [viewId, bounds]) => {
        const vm = deps.getViewManager();
        await assertOwnsOrViewHost(ctx, viewId, "setBounds");
        vm.setViewBounds(viewId, bounds);
        return;
      },
      setVisible: async (ctx, [viewId, visible]) => {
        const vm = deps.getViewManager();
        const targetInfo = vm.getViewInfo(viewId);
        if (
          ctx.caller.runtime.kind === "app" &&
          ctx.caller.runtime.id !== viewId &&
          targetInfo?.type === "panel"
        ) {
          throw new Error(
            `view.setVisible: hosted apps must place panel views with native panel slots`
          );
        }
        await assertOwnsOrViewHost(ctx, viewId, "setVisible");
        vm.setViewVisible(viewId, visible);
        return;
      },
      forwardMouseClick: async (ctx, [viewId, point]) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "forwardMouseClick");
        return vm.forwardMouseClick(viewId, point);
      },
      setThemeCss: async (ctx, [css]) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "setThemeCss");
        vm.setThemeCss(css);
        return;
      },
      bindNativePanelSlot: async (ctx, [request]) => {
        const vm = deps.getViewManager();
        await assertNativePanelSlotHost(ctx, "bindNativePanelSlot");
        vm.bindPanelSlot(ctx.caller.runtime.id, request);
        return { status: "bound" };
      },
      updateNativePanelSlot: async (ctx, [request]) => {
        const vm = deps.getViewManager();
        await assertNativePanelSlotHost(ctx, "updateNativePanelSlot");
        return vm.updatePanelSlot(ctx.caller.runtime.id, request);
      },
      clearNativePanelSlot: async (ctx, [request]) => {
        const vm = deps.getViewManager();
        await assertNativePanelSlotHost(ctx, "clearNativePanelSlot");
        vm.clearPanelSlot(ctx.caller.runtime.id, request.nativeSlotId);
        return;
      },
      setHostedShellReady: async (ctx, [request]) => {
        const vm = deps.getViewManager();
        await assertNativePanelSlotHost(ctx, "setHostedShellReady");
        vm.setHostedShellReady(ctx.caller.runtime.id, request.ready);
        return;
      },
      setShellOverlay: async (ctx, [active]) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "setShellOverlay");
        vm.setShellOverlayActive(active);
        return;
      },
      showNativeShellOverlay: async (ctx, [options]) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "showNativeShellOverlay");
        vm.showNativeShellOverlay(options);
        return;
      },
      updateNativeShellOverlay: async (ctx, [options]) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "updateNativeShellOverlay");
        vm.updateNativeShellOverlay(options);
        return;
      },
      hideNativeShellOverlay: async (ctx, [id]) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "hideNativeShellOverlay");
        vm.hideNativeShellOverlay(id);
        return;
      },
      showContentOverlay: async (ctx, [options]) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "showContentOverlay");
        vm.showContentOverlay(options);
        return;
      },
      updateContentOverlay: async (ctx, [options]) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "updateContentOverlay");
        vm.updateContentOverlay(options);
        return;
      },
      hideContentOverlay: async (ctx) => {
        const vm = deps.getViewManager();
        await assertViewHost(ctx, "hideContentOverlay");
        vm.hideContentOverlay();
        return;
      },
      browserNavigate: async (ctx, [browserId, url]) => {
        const vm = deps.getViewManager();
        await assertOwnsOrViewHost(ctx, browserId, "browserNavigate");
        assertHttpUrl(url);
        await vm.navigateView(browserId, url);
        return;
      },
      browserGoBack: async (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        await assertOwnsOrViewHost(ctx, browserId, "browserGoBack");
        vm.getWebContents(browserId)?.navigationHistory.goBack();
        return;
      },
      browserGoForward: async (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        await assertOwnsOrViewHost(ctx, browserId, "browserGoForward");
        vm.getWebContents(browserId)?.navigationHistory.goForward();
        return;
      },
      browserReload: async (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        await assertOwnsOrViewHost(ctx, browserId, "browserReload");
        vm.reload(browserId);
        return;
      },
      browserForceReload: async (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        await assertOwnsOrViewHost(ctx, browserId, "browserForceReload");
        vm.forceReload(browserId);
        return;
      },
      browserStop: async (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        await assertOwnsOrViewHost(ctx, browserId, "browserStop");
        vm.stop(browserId);
        return;
      },
    }),
  };
}
