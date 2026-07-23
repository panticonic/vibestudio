import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export const BrowserPermissionCapabilitySchema = z.enum([
  "camera",
  "microphone",
  "geolocation",
  "notifications",
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
    description: "Read the current origin-scoped website permission projection.",
    args: z.tuple([]),
    returns: z.object({
      environmentKey: z.string(),
      grants: z.array(BrowserPermissionGrantSchema),
    }),
    access: { sensitivity: "read" },
    authority: { principals: ["host"] },
  },
  request: {
    description: "Request owner approval for origin-scoped website capabilities.",
    args: z.tuple([
      z.object({
        panelId: z.string().min(1),
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
    authority: { principals: ["host"] },
  },
  revoke: {
    description: "Revoke remembered website permission grants for an origin.",
    args: z.tuple([
      z.object({
        origin: z.string(),
        capability: BrowserPermissionCapabilitySchema.optional(),
      }),
    ]),
    returns: z.number().int().nonnegative(),
    access: { sensitivity: "destructive" },
    authority: { principals: ["host"] },
  },
});
