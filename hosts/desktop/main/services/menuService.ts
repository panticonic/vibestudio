import { Menu, type MenuItemConstructorOptions } from "electron";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { menuMethods } from "@vibestudio/service-schemas/menu";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type { ViewManager } from "../viewManager.js";
import type { PanelContextMenuAction } from "@vibestudio/shared/types";
import { buildPanelChromeState } from "@vibestudio/shared/panelChrome";
import {
  getAvailablePanelCommands,
  PANEL_CONTEXT_MENU_SECTIONS,
  type PanelCommandId,
} from "@vibestudio/shared/panelCommands";
import { requireWindowCapability } from "./clientCapabilities.js";
import type { ClientMenus } from "../clientMenu.js";
import type { ClientWindows } from "../clientWindow.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

export function createMenuService(deps: {
  panelOrchestrator: PanelOrchestrator;
  panelRegistry: PanelRegistry;
  getViewManager: () => ViewManager;
  clientWindows: Pick<ClientWindows, "byCaller">;
  /** The menus clients contributed; the caller's own popup opens from here. */
  menus: ClientMenus;
  getPanelWebContents: (panelId: string) => Electron.WebContents | null;
}): ServiceDefinition {
  return {
    name: "menu",
    description: "Native menus",
    authority: { principals: ["user", "host", "code"] },
    methods: menuMethods,
    handler: defineServiceHandler("menu", menuMethods, {
      showHamburger: (ctx, [position]) => {
        requireWindowCapability(ctx, deps.clientWindows, "native-menus", "menu.showHamburger");
        const window = deps.clientWindows.byCaller(ctx.caller.runtime.id);
        const native = window?.browserWindow();
        if (!window || !native) throw new Error("The calling client has no open window");
        deps.menus.popup(window.windowId, native, position);
        return;
      },
      showContext: (ctx, [items, position]) => {
        requireWindowCapability(ctx, deps.clientWindows, "native-menus", "menu.showContext");
        const native = deps.clientWindows.byCaller(ctx.caller.runtime.id)?.browserWindow();
        if (!native) throw new Error("The calling client has no open window");
        return new Promise<string | null>((resolve) => {
          const template: MenuItemConstructorOptions[] = items.map((item) => ({
            label: item.label,
            click: () => resolve(item.id),
          }));
          const menu = Menu.buildFromTemplate(template);
          menu.popup({
            window: native,
            x: position.x,
            y: position.y,
            callback: () => resolve(null),
          });
        });
      },
      showPanelContext: (ctx, [panelId, position, presentation]) => {
        const vm = deps.getViewManager();
        requireWindowCapability(ctx, deps.clientWindows, "native-menus", "menu.showPanelContext");
        const lifecycle = deps.panelOrchestrator;
        const registry = deps.panelRegistry;
        const panel = registry.getPanel(panelId);
        const chrome = panel ? buildPanelChromeState({ panel }) : null;
        const commands = getAvailablePanelCommands(
          {
            chrome,
            isPinned: lifecycle.isPanelPinned(panelId),
            childCount: panel?.children.length ?? 0,
            presentation,
          },
          PANEL_CONTEXT_MENU_SECTIONS.flat()
        );

        return new Promise<PanelContextMenuAction | null>((resolve) => {
          const addCommand = (id: PanelCommandId): MenuItemConstructorOptions | null => {
            const command = commands.find((candidate) => candidate.id === id);
            if (!command) return null;
            return { label: command.label, click: () => resolve(id as PanelContextMenuAction) };
          };
          const sections = PANEL_CONTEXT_MENU_SECTIONS.map((ids) =>
            ids
              .map((id) => addCommand(id))
              .filter((item): item is MenuItemConstructorOptions => item !== null)
          );
          const template = sections
            .filter((section) => section.length > 0)
            .flatMap((section, index) =>
              index === 0 ? section : [{ type: "separator" } as const, ...section]
            );
          const contents = deps.getPanelWebContents(panelId);
          const nativeId = contents ? vm.findViewIdByWebContentsId(contents.id) : null;
          if (nativeId)
            template.unshift(vm.panelFullscreenMenuItem(nativeId), { type: "separator" });
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
