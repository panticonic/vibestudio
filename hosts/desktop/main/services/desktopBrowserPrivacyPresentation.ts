import { BrowserPrivacySectionSchema } from "@vibestudio/service-schemas/browserPrivacy";
import { desktopBrowserPrivacyPresentationMethods } from "@vibestudio/service-schemas/desktopBrowserPrivacyPresentation";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { BrowserPrivacySection } from "./browserPrivacyProtocol.js";

export function createDesktopBrowserPrivacyPresentation(deps: {
  openSettings(section: BrowserPrivacySection): void;
}): ServiceDefinition {
  return {
    name: "desktopBrowserPrivacyPresentation",
    description: "Open protected Browser data settings inside the desktop client",
    authority: { principals: ["host"] },
    methods: desktopBrowserPrivacyPresentationMethods,
    handler: async (_ctx, method, args) => {
      if (method !== "open") {
        throw new Error(`Unknown desktopBrowserPrivacyPresentation method: ${method}`);
      }
      deps.openSettings(BrowserPrivacySectionSchema.parse(args[0]));
    },
  };
}
