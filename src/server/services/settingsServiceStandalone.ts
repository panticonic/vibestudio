/**
 * Settings Service (Standalone Mode) — model role config for headless/remote
 * shell clients.
 *
 * Mirror of the Electron settingsService (src/main/services/settingsService.ts).
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { settingsMethods } from "@vibestudio/service-schemas/settings";
import type { SettingsData, ModelRoleConfig } from "@vibestudio/shared/types";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { loadCentralConfig } from "@vibestudio/workspace/loader";

export function createSettingsServiceStandalone(_deps: {
  dispatcher: ServiceDispatcher;
}): ServiceDefinition {
  return {
    name: "settings",
    description: "Settings, model roles (standalone mode)",
    authority: { principals: ["user", "code"] },
    methods: settingsMethods,
    handler: defineServiceHandler("settings", settingsMethods, {
      getData: () => {
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
              modelRoles[role] =
                `${(value as { provider: string }).provider}:${(value as { model: string }).model}`;
            }
          }
        }

        return {
          modelRoles,
        } as SettingsData;
      },
    }),
  };
}
