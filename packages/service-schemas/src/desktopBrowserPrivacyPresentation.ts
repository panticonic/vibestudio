import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { BrowserPrivacySectionSchema } from "./browserPrivacy.js";

const presentationTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "native-effect" as const,
  family: "browserPrivacyPresentation.open",
  rationale:
    "Receives one host-routed presentation intent on the exact authenticated desktop shell and carries no protected data.",
};

/** Desktop host receiver for the presentation router. It is published only on
 * the authenticated desktop shell connection. */
export const desktopBrowserPrivacyPresentationMethods = defineServiceMethods({
  open: {
    website: {"kind":"closed","reason":"The desktopBrowserPrivacyPresentation receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    tier: presentationTier,
    description: "Open the Electron-owned protected browser-data manager.",
    args: z.tuple([BrowserPrivacySectionSchema]),
    returns: z.void(),
    authority: { principals: ["host"] },
    access: { sensitivity: "write" },
  },
});
