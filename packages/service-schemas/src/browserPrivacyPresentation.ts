import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { BrowserPrivacySectionSchema } from "./browserPrivacy.js";

const presentationTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "native-effect" as const,
  family: "browserPrivacyPresentation.open",
  rationale:
    "Routes one reviewed provider intent to the exact host-verified shell that owns the initiating panel; the route carries no protected data and has no independent user gate.",
};

/** Host-owned presentation router beneath the reviewed Base browser-data
 * provider. The caller never supplies a device, platform, or endpoint. */
export const browserPrivacyPresentationMethods = defineServiceMethods({
  open: {
    tier: presentationTier,
    description:
      "Open the protected browser-data manager on the exact shell that owns the initiating panel.",
    args: z.tuple([BrowserPrivacySectionSchema.optional()]),
    returns: z.void(),
    authority: { principals: ["code"] },
    access: { sensitivity: "write" },
  },
});
