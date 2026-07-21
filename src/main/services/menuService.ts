import { Menu, type MenuItemConstructorOptions } from "electron";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { buildMethods } from "@vibestudio/service-schemas/build";
import { menuMethods } from "@vibestudio/service-schemas/menu";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { ViewManager } from "../viewManager.js";
import type { ServerClient } from "../serverClient.js";
import type { PanelContextMenuAction } from "@vibestudio/shared/types";
import { buildPanelChromeState } from "@vibestudio/shared/panelChrome";
import { getAvailablePanelCommands, type PanelCommandId } from "@vibestudio/shared/panelCommands";
import { getPanelSource } from "@vibestudio/shared/panel/accessors";
import { buildHamburgerMenuTemplate } from "../menu.js";
import { requireAppCapability } from "./appCapabilities.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

export function createMenuService(deps: {
  panelOrchestrator: PanelOrchestrator;
  panelRegistry: PanelRegistry;
  getViewManager: () => ViewManager;
  serverClient: ServerClient | null;
}): ServiceDefinition {
  const serverClient = deps.serverClient;
  const buildClient = serverClient
    ? createTypedServiceClient("build", buildMethods, (svc, m, a) => serverClient.call(svc, m, a))
    : null;
  return {
    name: "menu",
    description: "Native menus",
    authority: { principals: ["user", "code"] },
    methods: menuMethods,
    handler: defineServiceHandler("menu", menuMethods, {
      showHamburger: (ctx, [position]) => {
        const vm = deps.getViewManager();
        requireAppCapability(ctx, vm, "native-menus", "menu.showHamburger");
        const lifecycle = deps.panelOrchestrator;
        const registry = deps.panelRegistry;
        const shellContents = vm.getShellWebContents();

        const clearBuildCache = async () => {
          if (buildClient) {
            try {
              await buildClient.recompute();
            } catch (e) {
              console.warn("[App] Build recompute failed:", e);
            }
          }
          try {
            lifecycle.invalidateReadyPanels();
          } catch (error) {
            console.warn("[App] Failed to invalidate panel states:", error);
          }
          console.log("[App] Build cache cleared via hamburger menu");
        };

        const template = buildHamburgerMenuTemplate(shellContents, clearBuildCache, {
          onHistoryBack: () => {
            const panelId = registry.getFocusedPanelId();
            const panel = panelId ? registry.getPanel(panelId) : null;
            if (!panelId || !panel) return;
            const contents = vm.getWebContents(panelId);
            if (
              getPanelSource(panel).startsWith("browser:") &&
              contents?.navigationHistory.canGoBack()
            ) {
              contents.navigationHistory.goBack();
              return;
            }
            // Through the orchestrator: server write + imperative view rebuild.
            void lifecycle.navigatePanelHistory(panelId, -1);
          },
          onHistoryForward: () => {
            const panelId = registry.getFocusedPanelId();
            const panel = panelId ? registry.getPanel(panelId) : null;
            if (!panelId || !panel) return;
            const contents = vm.getWebContents(panelId);
            if (
              getPanelSource(panel).startsWith("browser:") &&
              contents?.navigationHistory.canGoForward()
            ) {
              contents.navigationHistory.goForward();
              return;
            }
            void lifecycle.navigatePanelHistory(panelId, 1);
          },
        });
        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window: vm.getWindow(), x: position.x, y: position.y });
        return;
      },
      showContext: (ctx, [items, position]) => {
        const vm = deps.getViewManager();
        requireAppCapability(ctx, vm, "native-menus", "menu.showContext");
        return new Promise<string | null>((resolve) => {
          const template: MenuItemConstructorOptions[] = items.map((item) => ({
            label: item.label,
            click: () => resolve(item.id),
          }));
          const menu = Menu.buildFromTemplate(template);
          menu.popup({
            window: vm.getWindow(),
            x: position.x,
            y: position.y,
            callback: () => resolve(null),
          });
        });
      },
      showPanelContext: (ctx, [panelId, position]) => {
        const vm = deps.getViewManager();
        requireAppCapability(ctx, vm, "native-menus", "menu.showPanelContext");
        const lifecycle = deps.panelOrchestrator;
        const registry = deps.panelRegistry;
        const panel = registry.getPanel(panelId);
        const chrome = panel ? buildPanelChromeState({ panel }) : null;
        const commands = getAvailablePanelCommands(
          { chrome, isPinned: lifecycle.isPanelPinned(panelId) },
          [
            "back",
            "forward",
            "reload-panel",
            "reload-view",
            "force-reload-view",
            "rebuild-panel",
            "stop",
            "copy-address",
            "copy-panel-id",
            "open-external",
            "duplicate",
            "add-child",
            "toggle-pin",
            "unload",
            "archive",
          ]
        );

        return new Promise<PanelContextMenuAction | null>((resolve) => {
          const addCommand = (id: PanelCommandId): MenuItemConstructorOptions | null => {
            const command = commands.find((candidate) => candidate.id === id);
            if (!command) return null;
            return { label: command.label, click: () => resolve(id as PanelContextMenuAction) };
          };
          const template: MenuItemConstructorOptions[] = [
            addCommand("back"),
            addCommand("forward"),
            { type: "separator" },
            addCommand("reload-panel"),
            addCommand("reload-view"),
            addCommand("force-reload-view"),
            addCommand("rebuild-panel"),
            addCommand("stop"),
            { type: "separator" },
            addCommand("copy-address"),
            addCommand("copy-panel-id"),
            addCommand("open-external"),
            addCommand("duplicate"),
            addCommand("add-child"),
            { type: "separator" },
            addCommand("toggle-pin"),
            addCommand("unload"),
            { type: "separator" },
            addCommand("archive"),
          ].filter(Boolean) as MenuItemConstructorOptions[];
          const menu = Menu.buildFromTemplate(template);
          menu.popup({
            window: vm.getWindow(),
            x: position.x,
            y: position.y,
            callback: () => resolve(null),
          });
        });
      },
    }),
  };
}
