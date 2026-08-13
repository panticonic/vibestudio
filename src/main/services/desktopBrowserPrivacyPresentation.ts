import { BrowserPrivacySectionSchema } from "@vibestudio/service-schemas/browserPrivacy";
import { desktopBrowserPrivacyPresentationMethods } from "@vibestudio/service-schemas/desktopBrowserPrivacyPresentation";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { BrowserPrivacyManager } from "./browserPrivacyManager.js";

export function createDesktopBrowserPrivacyPresentation(deps: {
  getPrivacyManager(): Pick<BrowserPrivacyManager, "open"> | null;
}): ServiceDefinition {
  return {
    name: "desktopBrowserPrivacyPresentation",
    description: "Desktop-owned browser privacy manager presentation",
    authority: { principals: ["host"] },
    methods: desktopBrowserPrivacyPresentationMethods,
    handler: async (_ctx, method, args) => {
      if (method !== "open") {
        throw new Error(`Unknown desktopBrowserPrivacyPresentation method: ${method}`);
      }
      const manager = deps.getPrivacyManager();
      if (!manager) throw new Error("Browser privacy manager is unavailable on this host");
      await manager.open(BrowserPrivacySectionSchema.parse(args[0]));
    },
  };
}
