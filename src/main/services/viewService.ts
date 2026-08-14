import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { coreViewMethods, viewMethods } from "@vibestudio/service-schemas/view";
import { panelMethods } from "@vibestudio/service-schemas/panel";
import type { ViewManager } from "../viewManager.js";
import { assertHttpUrl } from "../utils.js";
import { callerHasPlatformCapability, viewHasAppCapability } from "./appCapabilities.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { buildPanelViewHandler, type PanelViewMethodDeps } from "./panelShellService.js";
export function createViewService(
  deps: { getViewManager: () => ViewManager } & Partial<Omit<PanelViewMethodDeps, "getViewManager">>
): ServiceDefinition {
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

  const coreHandler = defineServiceHandler("view", coreViewMethods, {
    setBounds: (ctx, [viewId, bounds]) => {
      const vm = deps.getViewManager();
      assertOwnsOrViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, viewId, "setBounds");
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
    connectNativePanelAdapter: (ctx, [hello]) => {
      const vm = deps.getViewManager();
      assertNativePanelSlotHost(
        vm,
        ctx.caller.runtime.id,
        ctx.caller.runtime.kind,
        "connectNativePanelAdapter"
      );
      return vm.connectNativePanelAdapter(ctx.caller.runtime.id, hello);
    },
    applyNativePanelSurfaces: async (ctx, [snapshot]) => {
      const vm = deps.getViewManager();
      assertNativePanelSlotHost(
        vm,
        ctx.caller.runtime.id,
        ctx.caller.runtime.kind,
        "applyNativePanelSurfaces"
      );
      const previousPanelIds = new Set(vm.getDeclaredPanelSlotIds());
      const result = await vm.applyNativePanelSurfaces(ctx.caller.runtime.id, snapshot);
      if (result.accepted) {
        const currentPanelIds = new Set(vm.getDeclaredPanelSlotIds());
        for (const panelId of previousPanelIds) {
          if (!currentPanelIds.has(panelId)) deps.panelOrchestrator?.onNativeSlotCleared(panelId);
        }
        for (const panelId of currentPanelIds) {
          if (!previousPanelIds.has(panelId)) deps.panelOrchestrator?.onNativeSlotDeclared(panelId);
        }
      }
      return result;
    },
    setShellOverlay: (ctx, [active]) => {
      const vm = deps.getViewManager();
      assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "setShellOverlay");
      vm.setShellOverlayActive(active);
      return;
    },
    showNativeShellOverlay: (ctx, [options]) => {
      const vm = deps.getViewManager();
      assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "showNativeShellOverlay");
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
      assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "hideNativeShellOverlay");
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
      const { surface, ...rest } = options;
      vm.updateContentOverlay(surface, rest);
      return;
    },
    hideContentOverlay: (ctx, [{ surface }]) => {
      const vm = deps.getViewManager();
      assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "hideContentOverlay");
      vm.hideContentOverlay(surface);
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
    browserForceReload: async (ctx, [browserId]) => {
      const vm = deps.getViewManager();
      assertOwnsOrViewHost(
        vm,
        ctx.caller.runtime.id,
        ctx.caller.runtime.kind,
        browserId,
        "browserForceReload"
      );
      if (deps.panelRegistry?.getPanel(browserId) && deps.panelOrchestrator) {
        await deps.panelOrchestrator.forceReloadPanelView(browserId);
      } else {
        vm.forceReload(browserId);
      }
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
  });
  const panelHandler = buildPanelViewHandler(deps as PanelViewMethodDeps);
  return {
    name: "view",
    description: "Electron-native view, panel presentation, and browser operations",
    authority: { principals: ["user", "code"] },
    methods: viewMethods,
    handler: (ctx, method, args) =>
      method in panelMethods ? panelHandler(ctx, method, args) : coreHandler(ctx, method, args),
  };
}
