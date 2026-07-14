import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { ViewManager } from "../viewManager.js";
import { paletteMethods } from "@vibestudio/service-schemas/palette";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { requirePanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";

/**
 * The app-level command-palette bridge. A leaf panel (`panel` caller — or a
 * chrome `app`) registers/unregisters its OWN contributed commands; the chrome
 * shell lists the contributions and runs a chosen one, which the orchestrator
 * dispatches back to the owning panel via `runtime:palette-run`.
 *
 * register/unregister are inherently scoped by `ctx.caller.runtime.id` — a
 * caller can only ever touch its own command set — so they need NO capability
 * gate and admit any `panel`/`app` caller. (The previous `panel-hosting` gate
 * was wrong: that capability leaf is reserved for panel-hosting code, so
 * panel-contributed commands silently never registered.) list/run are
 * chrome-only (they enumerate / dispatch across panels) — gated via
 * {@link requireChromeCaller}: hosted workspace chrome resolves as
 * `kind:"app"`, so the old bare `kind === "shell"` check silently rejected it
 * and dropped panel-contributed commands.
 */
export function createPaletteService(deps: {
  panelOrchestrator: PanelOrchestrator;
  getViewManager: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "palette",
    description: "App-level command palette contributions",
    authority: { principals: ["user", "code"] },
    methods: paletteMethods,
    handler: defineServiceHandler("palette", paletteMethods, {
      register: (ctx, [commands]) => {
        deps.panelOrchestrator.registerPaletteCommands(ctx.caller.runtime.id, commands);
        return;
      },
      unregister: (ctx) => {
        deps.panelOrchestrator.unregisterPaletteCommands(ctx.caller.runtime.id);
        return;
      },
      list: async (ctx) => {
        // Aggregation/dispatch is chrome's job; a panel must not enumerate
        // or dispatch into other panels.
        await requirePanelHostingAuthority(ctx, "palette.list");
        return deps.panelOrchestrator.listPaletteCommands();
      },
      run: async (ctx, [panelId, commandId]) => {
        await requirePanelHostingAuthority(ctx, "palette.run");
        deps.panelOrchestrator.runPaletteCommand(panelId, commandId);
        return;
      },
    }),
  };
}
