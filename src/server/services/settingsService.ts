/** Canonical workspace settings service for every connected host. */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { settingsMethods } from "@vibestudio/service-schemas/settings";
import type { SettingsData, ModelRoleConfig } from "@vibestudio/shared/types";
import { loadCentralConfig } from "@vibestudio/workspace/loader";

export function createSettingsService(): ServiceDefinition {
  return {
    name: "settings",
    description: "Workspace settings and model roles",
    authority: { principals: ["user", "code"] },
    methods: settingsMethods,
    handler: defineServiceHandler("settings", settingsMethods, {
      getData: () => {
        const centralConfig = loadCentralConfig();
        const modelRoles: ModelRoleConfig = {};
        for (const [role, value] of Object.entries(centralConfig.models ?? {})) {
          if (typeof value === "string") {
            modelRoles[role] = value;
          } else if (value) {
            modelRoles[role] = `${value.provider}:${value.model}`;
          }
        }
        return { modelRoles } satisfies SettingsData;
      },
    }),
  };
}
