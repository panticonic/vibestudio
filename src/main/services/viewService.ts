import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { viewMethods } from "@vibestudio/service-schemas/view";
import type { ViewManager } from "../viewManager.js";
import { assertHttpUrl } from "../utils.js";
import { callerHasPlatformCapability, viewHasAppCapability } from "./appCapabilities.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

export function createViewService(deps: { getViewManager: () => ViewManager }): ServiceDefinition {
  /**
   * Ownership invariant for cross-view methods (audit finding #9).
   *
   * The full workspace shell now runs as an app target. It gets cross-view
   * authority by declaring `panel-hosting`; ordinary app callers can only
   * reach self-targeted methods if this policy is expanded later.
   */
  const hasViewHostAuthority = (vm: ViewManager, callerId: string, callerKind: string): boolean => {
    if (callerHasPlatformCapability(callerId, callerKind, "panel-hosting")) return true;
    const viewInfo = vm.getViewInfo(callerId);
    return viewHasAppCapability(callerId, viewInfo, "panel-hosting");
  };

  const assertViewHost = (
    vm: ViewManager,
    callerId: string,
    callerKind: string,
    method: string
  ): void => {
    if (hasViewHostAuthority(vm, callerId, callerKind)) return;
    throw new Error(`view.${method}: caller '${callerId}' cannot host workspace views`);
  };

  const assertNativePanelSlotHost = (
    vm: ViewManager,
    callerId: string,
    callerKind: string,
    method: string
  ): void => {
    const viewInfo = vm.getViewInfo(callerId);
    if (callerKind === "app" && viewHasAppCapability(callerId, viewInfo, "panel-hosting")) {
      return;
    }
    throw new Error(`view.${method}: caller '${callerId}' cannot place native panel slots`);
  };

  const assertOwnsOrViewHost = (
    vm: ViewManager,
    callerId: string,
    callerKind: string,
    targetId: string,
    method: string
  ): void => {
    if (hasViewHostAuthority(vm, callerId, callerKind)) return;
    if (callerId === targetId) return;
    throw new Error(`view.${method}: caller '${callerId}' does not own target view '${targetId}'`);
  };

  return {
    name: "view",
    description: "View bounds, visibility, theme CSS",
    authority: { principals: ["user", "code"] },
    methods: viewMethods,
    handler: defineServiceHandler("view", viewMethods, {
      setBounds: (ctx, [viewId, bounds]) => {
        const vm = deps.getViewManager();
        assertOwnsOrViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          viewId,
          "setBounds"
        );
        vm.setViewBounds(viewId, bounds);
        return;
      },
      setVisible: (ctx, [viewId, visible]) => {
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
        assertOwnsOrViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          viewId,
          "setVisible"
        );
        vm.setViewVisible(viewId, visible);
        return;
      },
      forwardMouseClick: (ctx, [viewId, point]) => {
        const vm = deps.getViewManager();
        assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "forwardMouseClick");
        return vm.forwardMouseClick(viewId, point);
      },
      setThemeCss: (ctx, [css]) => {
        const vm = deps.getViewManager();
        assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "setThemeCss");
        vm.setThemeCss(css);
        return;
      },
      bindNativePanelSlot: (ctx, [request]) => {
        const vm = deps.getViewManager();
        assertNativePanelSlotHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          "bindNativePanelSlot"
        );
        vm.bindPanelSlot(ctx.caller.runtime.id, request);
        return { status: "bound" };
      },
      updateNativePanelSlot: (ctx, [request]) => {
        const vm = deps.getViewManager();
        assertNativePanelSlotHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          "updateNativePanelSlot"
        );
        return vm.updatePanelSlot(ctx.caller.runtime.id, request);
      },
      clearNativePanelSlot: (ctx, [request]) => {
        const vm = deps.getViewManager();
        assertNativePanelSlotHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          "clearNativePanelSlot"
        );
        vm.clearPanelSlot(ctx.caller.runtime.id, request.nativeSlotId);
        return;
      },
      setHostedShellReady: (ctx, [request]) => {
        const vm = deps.getViewManager();
        assertNativePanelSlotHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          "setHostedShellReady"
        );
        vm.setHostedShellReady(ctx.caller.runtime.id, request.ready);
        return;
      },
      setShellOverlay: (ctx, [active]) => {
        const vm = deps.getViewManager();
        assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "setShellOverlay");
        vm.setShellOverlayActive(active);
        return;
      },
      showNativeShellOverlay: (ctx, [options]) => {
        const vm = deps.getViewManager();
        assertViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          "showNativeShellOverlay"
        );
        vm.showNativeShellOverlay(options);
        return;
      },
      updateNativeShellOverlay: (ctx, [options]) => {
        const vm = deps.getViewManager();
        assertViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          "updateNativeShellOverlay"
        );
        vm.updateNativeShellOverlay(options);
        return;
      },
      hideNativeShellOverlay: (ctx, [id]) => {
        const vm = deps.getViewManager();
        assertViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          "hideNativeShellOverlay"
        );
        vm.hideNativeShellOverlay(id);
        return;
      },
      showContentOverlay: (ctx, [options]) => {
        const vm = deps.getViewManager();
        assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "showContentOverlay");
        vm.showContentOverlay(options);
        return;
      },
      updateContentOverlay: (ctx, [options]) => {
        const vm = deps.getViewManager();
        assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "updateContentOverlay");
        vm.updateContentOverlay(options);
        return;
      },
      hideContentOverlay: (ctx) => {
        const vm = deps.getViewManager();
        assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "hideContentOverlay");
        vm.hideContentOverlay();
        return;
      },
      browserNavigate: async (ctx, [browserId, url]) => {
        const vm = deps.getViewManager();
        assertOwnsOrViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          browserId,
          "browserNavigate"
        );
        assertHttpUrl(url);
        await vm.navigateView(browserId, url);
        return;
      },
      browserGoBack: (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        assertOwnsOrViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          browserId,
          "browserGoBack"
        );
        vm.getWebContents(browserId)?.navigationHistory.goBack();
        return;
      },
      browserGoForward: (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        assertOwnsOrViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          browserId,
          "browserGoForward"
        );
        vm.getWebContents(browserId)?.navigationHistory.goForward();
        return;
      },
      browserReload: (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        assertOwnsOrViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          browserId,
          "browserReload"
        );
        vm.reload(browserId);
        return;
      },
      browserForceReload: (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        assertOwnsOrViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          browserId,
          "browserForceReload"
        );
        vm.forceReload(browserId);
        return;
      },
      browserStop: (ctx, [browserId]) => {
        const vm = deps.getViewManager();
        assertOwnsOrViewHost(
          vm,
          ctx.caller.runtime.id,
          ctx.caller.runtime.kind,
          browserId,
          "browserStop"
        );
        vm.stop(browserId);
        return;
      },
    }),
  };
}
