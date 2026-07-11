import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const savedPermissionGrantSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["capability", "userland"]),
    callerLabel: z.string().min(1),
    scopeLabel: z.string().min(1),
    capability: z.string().optional(),
    resource: z.string().optional(),
    repoPath: z.string().optional(),
    effectiveVersion: z.string().optional(),
    grantedAt: z.number().optional(),
  })
  .strict();

export type SavedPermissionGrant = z.infer<typeof savedPermissionGrantSchema>;

export const permissionsMethods = defineServiceMethods({
  list: {
    description: "List durable capability and userland grants for the trusted permissions page.",
    args: z.tuple([]),
    returns: z.array(savedPermissionGrantSchema),
    access: { sensitivity: "read" },
  },
  revoke: {
    description: "Revoke one durable permission grant by its opaque id.",
    args: z.tuple([
      z.object({ kind: z.enum(["capability", "userland"]), id: z.string().min(1) }).strict(),
    ]),
    returns: z.void(),
    access: { sensitivity: "write" },
  },
});
