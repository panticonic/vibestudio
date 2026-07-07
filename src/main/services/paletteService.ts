import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { ViewManager } from "../viewManager.js";
import type { PaletteCommand } from "@vibestudio/shared/types";
import { paletteMethods } from "@vibestudio/shared/serviceSchemas/palette";
import { requireChromeCaller } from "./appCapabilities.js";

/**
 * The app-level command-palette bridge. A leaf panel (`panel` caller — or a
 * chrome `app`) registers/unregisters its OWN contributed commands; the chrome
 * shell lists the contributions and runs a chosen one, which the orchestrator
 * dispatches back to the owning panel via `runtime:palette-run`.
 *
 * register/unregister are inherently scoped by `ctx.caller.runtime.id` — a
 * caller can only ever touch its own command set — so they need NO capability
 * gate and admit any `panel`/`app` caller. (The previous `panel-hosting` gate
 * was wrong: that is a chrome-trust capability leaf panels never hold, so
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
    policy: { allowed: ["shell", "app", "panel"] },
    methods: paletteMethods,
    handler: async (ctx, method, args) => {
      const orchestrator = deps.panelOrchestrator;

      switch (method) {
        case "register": {
          orchestrator.registerPaletteCommands(ctx.caller.runtime.id, args[0] as PaletteCommand[]);
          return;
        }

        case "unregister": {
          orchestrator.unregisterPaletteCommands(ctx.caller.runtime.id);
          return;
        }

        case "list": {
          // Aggregation/dispatch is chrome's job; a panel must not enumerate
          // or dispatch into other panels.
          requireChromeCaller(ctx, deps.getViewManager(), "palette.list");
          return orchestrator.listPaletteCommands();
        }

        case "run": {
          requireChromeCaller(ctx, deps.getViewManager(), "palette.run");
          const [panelId, commandId] = args as [string, string];
          orchestrator.runPaletteCommand(panelId, commandId);
          return;
        }

        default:
          throw new Error(`Unknown palette method: ${method}`);
      }
    },
  };
}
