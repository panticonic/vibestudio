import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export const BrowserPermissionCapabilitySchema = z.enum([
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "downloads",
  "clipboard",
  "autofill",
  "popups",
]);
export const BrowserPermissionDecisionSchema = z.enum([
  "once",
  "session",
  "always",
  "block",
  "dismiss",
]);
export const BrowserPermissionGrantSchema = z.object({
  origin: z.string().url(),
  capability: BrowserPermissionCapabilitySchema,
  decision: z.enum(["allow", "block"]),
  scope: z.enum(["session", "always", "block"]),
  updatedAt: z.number(),
});

export const browserPermissionsMethods = defineServiceMethods({
  snapshot: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "browserPermissions.control",
      rationale:
        "Verified-user read of that user's exact-origin browser grants; code and anonymous callers remain excluded.",
    },
    description: "Read the current origin-scoped website permission projection.",
    args: z.tuple([z.object({ sessionEpoch: z.string().min(16).max(200) }).strict()]),
    returns: z.object({
      environmentKey: z.string(),
      grants: z.array(BrowserPermissionGrantSchema),
    }),
    access: { sensitivity: "read" },
    authority: { principals: ["user"] },
  },
  request: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "browserPermissions.control",
      rationale:
        "Verified-user browser permission prompt flow; the decision is stored as a user grant and code callers remain excluded.",
    },
    description: "Request owner approval for origin-scoped website capabilities.",
    args: z.tuple([
      z.object({
        panelId: z.string().min(1),
        sessionEpoch: z.string().min(16).max(200),
        origin: z.string(),
        topLevelUrl: z.string(),
        capabilities: z.array(BrowserPermissionCapabilitySchema).min(1),
        deviceLabel: z.string().min(1).max(200),
      }),
    ]),
    returns: z.object({
      decision: BrowserPermissionDecisionSchema,
      granted: z.boolean(),
      grants: z.array(BrowserPermissionGrantSchema),
    }),
    access: { sensitivity: "write" },
    authority: { principals: ["user"] },
  },
  revoke: {
    tier: {
      tier: "open",
      session: "family",
      residency: "grant-authority",
      family: "browserPermissions.retire",
      rationale:
        "Verified-user revocation of that user's exact-origin browser grants, driven by explicit shell UI.",
    },
    description: "Revoke remembered website permission grants for an origin.",
    args: z.tuple([
      z.object({
        origin: z.string(),
        sessionEpoch: z.string().min(16).max(200),
        capability: BrowserPermissionCapabilitySchema.optional(),
      }),
    ]),
    returns: z.number().int().nonnegative(),
    access: { sensitivity: "destructive" },
    authority: { principals: ["user"] },
  },
});
