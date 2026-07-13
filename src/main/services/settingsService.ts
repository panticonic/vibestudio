import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { settingsMethods } from "@vibestudio/service-schemas/settings";
import type { SettingsData, ModelRoleConfig } from "@vibestudio/shared/types";
import type { ServerClient } from "../serverClient.js";
import { loadCentralConfig } from "@vibestudio/workspace/loader";
import type { ViewManager } from "../viewManager.js";
import { requireAppCapability } from "./appCapabilities.js";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";

export function createSettingsService(_deps: {
  serverClient: ServerClient | null;
  getViewManager?: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "settings",
    description: "Settings, model roles",
    policy: { allowed: ["shell", "app"] },
    methods: settingsMethods,
    handler: defineServiceHandler("settings", settingsMethods, {
      getData: (ctx) => {
        if (ctx.caller.runtime.kind === "app") {
          if (!_deps.getViewManager) throw new Error("settings.getData app capability unavailable");
          requireAppCapability(ctx, _deps.getViewManager(), "panel-hosting", "settings.getData");
        }
        const centralConfig = loadCentralConfig();

        const modelRoles: ModelRoleConfig = {};
        if (centralConfig.models) {
          for (const [role, value] of Object.entries(centralConfig.models)) {
            if (typeof value === "string") {
              modelRoles[role] = value;
            } else if (
              value &&
              typeof value === "object" &&
              "provider" in value &&
              "model" in value
            ) {
              modelRoles[role] = `${value.provider}:${value.model}`;
            }
          }
        }

        return {
          modelRoles,
        } satisfies SettingsData;
      },
    }),
  };
}
