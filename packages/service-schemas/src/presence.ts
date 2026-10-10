import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
const readAuthority: ServiceAuthorityPolicy = {
  principals: ["host", "user", "code"],
};
export const presenceMethods = defineServiceMethods({
  markPanelActive: {
    website: {
      kind: "closed",
      reason:
        "The presenceService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "panel.presence.update",
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "presence.control",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    presentation: {
      title: "Mark a panel as active",
      action: "mark a panel as active",
      description: "Allows {requesterKind} to mark a panel as active.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "act",
      },
    },
    args: z.tuple([z.string()]),
  },
  markPanelsOwned: {
    website: {
      kind: "closed",
      reason:
        "The presenceService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "panel.presence.update",
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "presence.control",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    presentation: {
      title: "Claim ownership of panels",
      action: "claim ownership of panels",
      description: "Allows {requesterKind} to claim ownership of panels.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "act",
      },
    },
    args: z.tuple([z.array(z.string())]),
  },
  getPanelActiveOwner: {
    website: {
      kind: "closed",
      reason:
        "The presenceService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "panel.presence.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "supervision",
      family: "presence.read",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    presentation: {
      title: "View who is using a panel",
      action: "view who is using a panel",
      description: "Allows {requesterKind} to view who is using a panel.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
    args: z.tuple([z.string()]),
    authority: readAuthority,
    access: { sensitivity: "read" as const },
  },
});
