import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  allOf,
  anyOf,
  methodCapability,
  relationship,
} from "@vibestudio/shared/authorization";

const permissionsAuthority = (method: "list" | "revoke") => ({
  requirement: anyOf(
    methodCapability("host"),
    allOf(methodCapability("user"), relationship("workspace-member")),
    allOf(
      methodCapability("code"),
      relationship("workspace-member"),
      relationship("code-source", "about/permissions")
    )
  ),
  resource: { kind: "literal" as const, key: `service:permissions.${method}` },
});

export const savedPermissionGrantSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["capability", "userland", "credential-use"]),
    callerLabel: z.string().min(1),
    scopeLabel: z.string().min(1),
    capability: z.string().optional(),
    resource: z.string().optional(),
    repoPath: z.string().optional(),
    executionDigest: z.string().optional(),
    grantedAt: z.number().optional(),
  })
  .strict();

export type SavedPermissionGrant = z.infer<typeof savedPermissionGrantSchema>;

export const permissionsMethods = defineServiceMethods({
  list: {
    description: "List active session and durable capability, userland, and credential-use grants.",
    args: z.tuple([]),
    returns: z.array(savedPermissionGrantSchema),
    authority: permissionsAuthority("list"),
    access: { sensitivity: "read" },
  },
  revoke: {
    description: "Revoke one durable permission grant by its opaque id.",
    args: z.tuple([
      z
        .object({
          kind: z.enum(["capability", "userland", "credential-use"]),
          id: z.string().min(1),
        })
        .strict(),
    ]),
    returns: z.void(),
    authority: permissionsAuthority("revoke"),
    access: { sensitivity: "write" },
  },
});
