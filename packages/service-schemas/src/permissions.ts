import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export const savedPermissionGrantSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["capability", "userland", "credential-use", "browser-site"]),
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

const authorityDomainSchema = z.enum([
  "files",
  "sharing",
  "accounts",
  "web",
  "automation",
  "people",
  "computer",
  "safety",
]);
const authorityVerbSchema = z.enum(["see", "act", "manage"]);

export const agentAuthorityItemSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["grant", "lock"]),
    capability: z.string().optional(),
    action: z.string().min(1),
    resource: z.string().optional(),
    domain: authorityDomainSchema,
    verb: authorityVerbSchema,
    state: z.enum(["active", "suspended", "locked"]),
    decidedAt: z.number(),
    lastUsedAt: z.number().optional(),
    attemptCount: z.number().int().nonnegative().optional(),
    lastAttemptAt: z.number().optional(),
  })
  .strict();

export const agentAuthorityCellSchema = z
  .object({
    domain: authorityDomainSchema,
    verb: authorityVerbSchema,
    state: z.enum(["asks-first", "allowed", "never", "not-available"]),
    allowanceCount: z.number().int().nonnegative(),
    items: z.array(agentAuthorityItemSchema),
  })
  .strict();

export const agentAuthorityProfileSchema = z
  .object({
    bindingId: z.string().min(1),
    name: z.string().min(1),
    summary: z.string().min(1),
    cells: z.array(agentAuthorityCellSchema),
  })
  .strict();

export type AgentAuthorityProfile = z.infer<typeof agentAuthorityProfileSchema>;

export const permissionsMethods = defineServiceMethods({
  list: {
    description: "List active session and durable capability, userland, and credential-use grants.",
    args: z.tuple([]),
    returns: z.array(savedPermissionGrantSchema),
    access: { sensitivity: "read" },
  },
  revoke: {
    description: "Revoke one durable permission grant by its opaque id.",
    args: z.tuple([
      z
        .object({
          kind: z.enum(["capability", "userland", "credential-use", "browser-site"]),
          id: z.string().min(1),
        })
        .strict(),
    ]),
    returns: z.void(),
    access: { sensitivity: "write" },
  },
  listAgentProfiles: {
    description:
      "List the living authority profile for every agent with standing permissions or locks.",
    args: z.tuple([]),
    returns: z.array(agentAuthorityProfileSchema),
    access: { sensitivity: "read" },
  },
  updateAgentProfile: {
    description: "Restore, remove, unlock, or reset one agent's lasting authority settings.",
    args: z.tuple([
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("revoke-grant"), id: z.string().min(1) }).strict(),
        z.object({ action: z.literal("restore-grant"), id: z.string().min(1) }).strict(),
        z.object({ action: z.literal("unlock"), id: z.string().min(1) }).strict(),
        z
          .object({
            action: z.literal("reset"),
            bindingId: z.string().min(1),
            keepLocks: z.boolean(),
          })
          .strict(),
      ]),
    ]),
    returns: z.void(),
    access: { sensitivity: "write" },
  },
});
