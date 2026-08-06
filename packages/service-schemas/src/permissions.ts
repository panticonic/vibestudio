import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export const savedPermissionGrantSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["capability", "credential-use", "browser-site"]),
    callerLabel: z.string().min(1),
    scopeLabel: z.string().min(1),
    capability: z.string().optional(),
    resource: z.string().optional(),
    repoPath: z.string().optional(),
    effectiveVersion: z.string().optional(),
    grantedAt: z.number().optional(),
    lastUsedAt: z.number().optional(),
    expiresAt: z.number().optional(),
    why: z.string().min(1),
    /**
     * Where this permission came from, in the words §7.7 uses: `Part of
     * Vibestudio`, `Added with your workspace's base`, `You allowed this`.
     *
     * Separate from `why`, which says what the permission does. Revisiting an
     * install-time decision needs the other half — whether this was something
     * the user chose in the moment or something a part arrived holding — and
     * without it every row read as though it had been prompted for.
     */
    origin: z.string().min(1).optional(),
    approvedBy: z.string().min(1),
    duration: z.string().min(1),
    revokeEffect: z.string().min(1),
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
    why: z.string().min(1),
    approvedBy: z.string().min(1),
    duration: z.string().min(1),
    revokeEffect: z.string().min(1),
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
    paused: z.boolean(),
    cells: z.array(agentAuthorityCellSchema),
  })
  .strict();

export type AgentAuthorityProfile = z.infer<typeof agentAuthorityProfileSchema>;

export const authoritySafetyStatusSchema = z
  .object({
    workspaceLocked: z.boolean(),
    activeAgentCount: z.number().int().nonnegative(),
    pendingAcquisitionCount: z.number().int().nonnegative(),
  })
  .strict();

export const permissionsMethods = defineServiceMethods({
  list: {
    capability: "permissions.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "permissions.read",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    presentation: {
      title: "View saved site permissions",
      action: "view saved site permissions",
      description: "Allows {requesterKind} to view saved site permissions.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "List active session and durable capability, userland, and credential-use grants.",
    args: z.tuple([]),
    returns: z.array(savedPermissionGrantSchema),
    access: { sensitivity: "read" },
  },
  revoke: {
    capability: "permissions.revoke",
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "permissions.retire",
      rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
    },
    presentation: {
      title: "Remove a saved site permission",
      action: "remove a saved site permission",
      description: "Allows {requesterKind} to remove a saved site permission.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description: "Revoke one durable permission grant by its opaque id.",
    args: z.tuple([
      z
        .object({
          kind: z.enum(["capability", "credential-use", "browser-site"]),
          id: z.string().min(1),
        })
        .strict(),
    ]),
    returns: z.void(),
    access: { sensitivity: "write" },
  },
  listAgentProfiles: {
    capability: "permissions.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "permissions.read",
      rationale: "G4: privacy or saved authority-map read; §2 default {code, session} family",
    },
    presentation: {
      title: "View saved agent choices",
      action: "view saved agent choices",
      description: "Allows {requesterKind} to view saved choices for agents.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "List the living authority profile for every agent with standing permissions or locks.",
    args: z.tuple([]),
    returns: z.array(agentAuthorityProfileSchema),
    access: { sensitivity: "read" },
  },
  safetyStatus: {
    capability: "permissions.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "permissions.control",
      rationale: "G4: privacy or live authority-map read; §2 default {code, session} family",
    },
    presentation: {
      title: "View workspace authority safety status",
      action: "view workspace authority safety status",
      description:
        "Allows {requesterKind} to view whether workspace authority is locked and how much agent work it affects.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "Read the live emergency authority state and the work it can immediately interrupt.",
    args: z.tuple([]),
    returns: authoritySafetyStatusSchema,
    access: { sensitivity: "read" },
  },
  updateAgentProfile: {
    capability: "permissions.revoke",
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "permissions.mutate",
      rationale:
        "C2: restores or removes lasting authority choices; §2 default {code, session} family",
    },
    presentation: {
      title: "Change saved agent choices",
      action: "change saved agent choices",
      description: "Allows {requesterKind} to restore or remove saved choices for agents.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "Pause or resume an agent, revoke all of its authority, or change one lasting authority setting.",
    args: z.tuple([
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("revoke-grant"), id: z.string().min(1) }).strict(),
        z.object({ action: z.literal("restore-grant"), id: z.string().min(1) }).strict(),
        z.object({ action: z.literal("unlock"), id: z.string().min(1) }).strict(),
        z.object({ action: z.literal("pause-agent"), bindingId: z.string().min(1) }).strict(),
        z.object({ action: z.literal("resume-agent"), bindingId: z.string().min(1) }).strict(),
        z.object({ action: z.literal("revoke-all-agent"), bindingId: z.string().min(1) }).strict(),
      ]),
    ]),
    returns: z.void(),
    access: { sensitivity: "write" },
  },
  setWorkspaceAuthorityLock: {
    capability: "permissions.revoke",
    tier: {
      tier: "critical",
      session: "family",
      residency: "grant-authority",
      family: "permissions.mutate",
      rationale:
        "C2: suspends or restores protected authority workspace-wide; §2 default {code, session} family",
    },
    presentation: {
      title: "Change the workspace authority lock",
      action: "change the workspace authority lock",
      description:
        "Allows {requesterKind} to stop or restore protected authority across the workspace.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "manage",
      },
    },
    description:
      "Engage or release the emergency workspace lock for every agent's protected authority.",
    args: z.tuple([z.object({ locked: z.boolean() }).strict()]),
    returns: authoritySafetyStatusSchema,
    access: { sensitivity: "write" },
  },
});
