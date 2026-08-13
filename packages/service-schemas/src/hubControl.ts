/** Typed authenticated child-to-hub control plane. */

import { z } from "zod";
import {
  normalizeFingerprint,
  PAIRING_CODE_PATTERN,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseConnectLink,
  parseSignalingEndpoint,
} from "@vibestudio/shared/connect";
import { SERVER_BOOT_ID_PATTERN, SERVER_ID_PATTERN } from "@vibestudio/shared/deviceCredentials";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { RevokedUserCleanupResultSchema } from "@vibestudio/identity/revocationCleanup";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";

const readAccess = { sensitivity: "read" as const };
const writeAccess = { sensitivity: "write" as const };
const adminAccess = { sensitivity: "admin" as const };
const destructiveAccess = { sensitivity: "destructive" as const };

export const HubWorkspaceEntrySchema = z
  .object({
    workspaceId: z.string(),
    name: z.string(),
    lastOpened: z.number(),
    running: z.boolean(),
    ephemeral: z.boolean().optional(),
  })
  .strict();
export type HubWorkspaceEntry = z.infer<typeof HubWorkspaceEntrySchema>;

export const HubReachSchema = z
  .object({
    room: z.string().regex(PAIRING_ROOM_PATTERN),
    fp: z.string().refine((value) => /^[0-9A-F]{64}$/.test(normalizeFingerprint(value)), {
      message: "Expected a SHA-256 DTLS fingerprint",
    }),
    sig: z.string().refine((value) => parseSignalingEndpoint(value).kind === "ok", {
      message: "Expected a secure signaling URL or a cleartext loopback URL",
    }),
    v: z.literal(PAIRING_PROTOCOL_VERSION),
    ice: z.enum(["all", "relay"]),
  })
  .strict();

export const HubWorkspaceRouteSchema = z
  .object({
    workspace: z.string(),
    workspaceId: z.string(),
    running: z.literal(true),
    serverUrl: z.string(),
    workspaceReach: HubReachSchema,
    serverId: z.string().regex(SERVER_ID_PATTERN),
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
  })
  .strict();

export const HubPairingInviteSchema = z
  .object({
    room: z.string().regex(PAIRING_ROOM_PATTERN),
    fp: z.string().refine((value) => /^[0-9A-F]{64}$/.test(normalizeFingerprint(value)), {
      message: "Expected a SHA-256 DTLS fingerprint",
    }),
    sig: z.string().refine((value) => parseSignalingEndpoint(value).kind === "ok", {
      message: "Expected a secure signaling URL or a cleartext loopback URL",
    }),
    v: z.literal(PAIRING_PROTOCOL_VERSION),
    ice: z.enum(["all", "relay"]),
    code: z.string().regex(PAIRING_CODE_PATTERN),
    exp: z.number().int().positive(),
    deepLink: z.string().startsWith("vibestudio://connect?"),
    pairUrl: z.string().startsWith("https://vibestudio.app/pair#"),
    expiresInMs: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    serverId: z.string().regex(SERVER_ID_PATTERN),
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
  })
  .strict()
  .superRefine((invite, ctx) => {
    for (const [field, link] of [
      ["deepLink", invite.deepLink],
      ["pairUrl", invite.pairUrl],
    ] as const) {
      const parsed = parseConnectLink(link);
      if (parsed.kind === "error") {
        ctx.addIssue({ code: "custom", path: [field], message: parsed.reason });
        continue;
      }
      const signaling = parseSignalingEndpoint(invite.sig);
      const matches =
        parsed.room === invite.room &&
        normalizeFingerprint(parsed.fp) === normalizeFingerprint(invite.fp) &&
        parsed.code === invite.code &&
        signaling.kind === "ok" &&
        parsed.sig === signaling.url &&
        parsed.v === invite.v &&
        parsed.ice === invite.ice &&
        parsed.exp === invite.expiresAt;
      if (!matches) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Pairing link does not match the invite coordinates",
        });
      }
    }
  });

export const HubReadyPayloadSchema = z
  .object({
    mode: z.literal("hub"),
    gatewayUrl: z.string().url(),
    rootInvite: HubPairingInviteSchema.nullable(),
    serverId: z.string().regex(SERVER_ID_PATTERN),
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
    gatewayPort: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    version: z.string().min(1),
    buildId: z.string().regex(/^[a-f0-9]{64}$/),
    workspaces: z.array(HubWorkspaceEntrySchema),
  })
  .strict()
  .superRefine((ready, ctx) => {
    const invite = ready.rootInvite;
    if (!invite) return;
    if (invite.serverId !== ready.serverId) {
      ctx.addIssue({
        code: "custom",
        path: ["rootInvite", "serverId"],
        message: "Invite serverId does not match the ready-file serverId",
      });
    }
    if (invite.serverBootId !== ready.serverBootId) {
      ctx.addIssue({
        code: "custom",
        path: ["rootInvite", "serverBootId"],
        message: "Invite serverBootId does not match the ready-file serverBootId",
      });
    }
  });

export const HubUserSchema = z
  .object({
    userId: z.string(),
    handle: z.string(),
    displayName: z.string(),
    role: z.enum(["root", "admin", "member"]),
  })
  .strict();

const userRefFields = { userId: z.string().optional(), handle: z.string().optional() };
const requireUserRef = <T extends { userId?: string; handle?: string }>(value: T) =>
  !!value.userId || !!value.handle;
const userRef = z
  .object(userRefFields)
  .strict()
  .refine(requireUserRef, "userId or handle is required");

const pairingTtl = z
  .number()
  .int()
  .min(30_000)
  .max(60 * 60 * 1000)
  .optional();

export const HubDeviceSchema = z
  .object({
    deviceId: z.string(),
    userId: z.string(),
    label: z.string(),
    platform: z.string().optional(),
    createdAt: z.number(),
    lastUsedAt: z.number().optional(),
    revokedAt: z.number().optional(),
  })
  .strict();

export const HubPresenceWorkspaceSchema = z
  .object({
    workspace: z.string(),
    workspaceId: z.string(),
    endpoints: z.number().int().positive(),
  })
  .strict();

export const HubUserPresenceSchema = z
  .object({
    userId: z.string(),
    handle: z.string(),
    displayName: z.string(),
    workspaces: z.array(HubPresenceWorkspaceSchema),
  })
  .strict();

const HubWorkspaceMembershipSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    addedBy: z.string(),
    addedAt: z.number(),
  })
  .strict();

const HubWorkspaceMemberSchema = HubWorkspaceMembershipSchema.extend({
  implicit: z.boolean().optional(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.enum(["root", "admin", "member"]).nullable(),
}).strict();

export const hubControlMethods = defineServiceMethods({
  listWorkspaces: {
    capability: "workspaces.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "View available workspaces",
      action: "view available workspaces",
      description: "Allows {requesterKind} to view available workspaces.",
      group: "accounts",
      authorityCategory: {
        domain: "files",
        verb: "see",
      },
    },
    description: "List workspaces visible to the authenticated account.",
    args: z.tuple([]),
    returns: z.array(HubWorkspaceEntrySchema),
    access: readAccess,
  },
  routeWorkspace: {
    capability: "workspaces.open",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Connect to a workspace",
      action: "connect to a workspace",
      description: "Allows {requesterKind} to connect to a workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "files",
        verb: "act",
      },
    },
    description:
      "Route one exact workspaceId and return only that child's workspaceReach; the caller keeps its existing hub control reach.",
    args: z.tuple([z.object({ workspaceId: z.string().min(1) }).strict()]),
    returns: HubWorkspaceRouteSchema,
    access: readAccess,
  },
  createWorkspace: {
    capability: "workspaces.create",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.create",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Create a workspace",
      action: "create a workspace",
      description: "Allows {requesterKind} to create a workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description: "Create and register a workspace from one exact external root template.",
    args: z.tuple([
      z
        .object({
          workspace: z.string().min(1),
          rootTemplate: WorkspaceTemplatePinSchema.optional(),
        })
        .strict(),
    ]),
    returns: HubWorkspaceEntrySchema,
    access: writeAccess,
  },
  ensureEphemeralWorkspace: {
    capability: "workspaces.create",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Prepare a temporary workspace",
      action: "prepare a temporary workspace",
      description: "Allows {requesterKind} to prepare a temporary workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description: "Ensure the canonical disposable development workspace exists on the live hub.",
    args: z.tuple([]),
    returns: HubWorkspaceEntrySchema,
    access: adminAccess,
  },
  deleteWorkspace: {
    capability: "workspaces.delete",
    tier: {
      tier: "critical",
      session: "family",
      residency: "identity",
      family: "hubControl.retire",
      rationale:
        "C3: irreversible destruction outside VCS protection; §2 default {code, session} family",
    },
    presentation: {
      title: "Delete a workspace",
      action: "delete a workspace",
      description: "Allows {requesterKind} to delete a workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description: "Delete a workspace and cascade every membership row.",
    args: z.tuple([z.object({ workspace: z.string().min(1) }).strict()]),
    returns: z.object({ deleted: z.boolean(), workspaceId: z.string().nullable() }),
    access: destructiveAccess,
  },
  addWorkspaceMember: {
    capability: "workspace.members.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Add a workspace member",
      action: "add a workspace member",
      description: "Allows {requesterKind} to add a workspace member.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Add an existing account to a workspace.",
    args: z.tuple([
      z
        .object({ ...userRefFields, workspace: z.string().min(1) })
        .strict()
        .refine(requireUserRef, "userId or handle is required"),
    ]),
    returns: HubWorkspaceMembershipSchema.extend({
      workspace: z.string(),
      handle: z.string(),
    }).strict(),
    access: adminAccess,
  },
  removeWorkspaceMember: {
    capability: "workspace.members.remove",
    tier: {
      tier: "critical",
      session: "family",
      residency: "identity",
      family: "hubControl.retire",
      rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
    },
    presentation: {
      title: "Remove a workspace member",
      action: "remove a workspace member",
      description: "Allows {requesterKind} to remove a workspace member.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Remove an account from a workspace and close its child sessions.",
    args: z.tuple([
      z
        .object({ ...userRefFields, workspace: z.string().min(1) })
        .strict()
        .refine(requireUserRef, "userId or handle is required"),
    ]),
    returns: z.object({ removed: z.boolean(), closedSessions: z.number() }),
    access: destructiveAccess,
  },
  listWorkspaceMembers: {
    capability: "workspace.members.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "View workspace members",
      action: "view workspace members",
      description: "Allows {requesterKind} to view workspace members.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
    description: "List the account membership projection for one workspace.",
    args: z.tuple([z.object({ workspace: z.string().min(1) }).strict()]),
    returns: z.object({
      workspace: z.string(),
      workspaceId: z.string(),
      members: z.array(HubWorkspaceMemberSchema),
    }),
    access: readAccess,
  },
  listUserPresence: {
    capability: "presence.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "View who is currently active",
      action: "view who is currently active",
      description: "Allows {requesterKind} to view who is currently active.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
    description: "List the visible workspaces where a user currently has a live human endpoint.",
    args: z.tuple([userRef]),
    returns: HubUserPresenceSchema,
    access: readAccess,
  },
  inviteUser: {
    capability: "workspace.members.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Invite someone to the workspace",
      action: "invite someone to the workspace",
      description: "Allows {requesterKind} to invite someone to the workspace.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Create an account, grant workspaces, and mint its first-device invite.",
    args: z.tuple([
      z
        .object({
          handle: z.string().min(1),
          displayName: z.string().min(1).optional(),
          role: z.enum(["admin", "member"]).optional(),
          workspaces: z.array(z.string().min(1)).min(1),
          ttlMs: pairingTtl,
        })
        .strict(),
    ]),
    returns: z.object({
      user: HubUserSchema,
      workspaces: z.array(z.string()),
      pairing: HubPairingInviteSchema,
    }),
    access: adminAccess,
  },
  pairDevice: {
    capability: "devices.pair",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Pair a device",
      action: "pair a device",
      description: "Allows {requesterKind} to pair a device.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Mint another device invite for the authenticated account.",
    args: z.tuple([
      z
        .object({ workspace: z.string().min(1).optional(), ttlMs: pairingTtl })
        .strict()
        .optional(),
    ]),
    returns: z.object({
      userId: z.string(),
      handle: z.string(),
      workspace: z.string(),
      pairing: HubPairingInviteSchema,
    }),
    access: writeAccess,
  },
  listDevices: {
    capability: "devices.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "View connected devices",
      action: "view connected devices",
      description: "Allows {requesterKind} to view connected devices.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
    description: "List the caller's paired devices; administrators see every account's devices.",
    args: z.tuple([]),
    returns: z.object({ serverId: z.string(), devices: z.array(HubDeviceSchema) }),
    access: readAccess,
  },
  revokeDevice: {
    capability: "devices.revoke",
    tier: {
      tier: "critical",
      session: "family",
      residency: "identity",
      family: "hubControl.retire",
      rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
    },
    presentation: {
      title: "Disconnect a device",
      action: "disconnect a device",
      description: "Allows {requesterKind} to disconnect a device.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Revoke a device and close all of its child sessions.",
    args: z.tuple([z.string().min(1)]),
    returns: z.object({ revoked: z.boolean(), closedSessions: z.number() }),
    access: destructiveAccess,
  },
  revokeUser: {
    capability: "users.revoke",
    tier: {
      tier: "critical",
      session: "family",
      residency: "identity",
      family: "hubControl.retire",
      rationale: "C2: removes authority or identity membership; §2 default {code, session} family",
    },
    presentation: {
      title: "Revoke a user's access",
      action: "revoke a user's access",
      description: "Allows {requesterKind} to revoke a user's access.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Revoke an account, credentials, memberships, and live deputies.",
    args: z.tuple([userRef]),
    returns: z
      .object({
        revoked: z.boolean(),
        userId: z.string(),
        handle: z.string(),
        closedSessions: z.number().int().nonnegative(),
        cleanup: z.array(RevokedUserCleanupResultSchema),
      })
      .strict(),
    access: destructiveAccess,
  },
  setRole: {
    capability: "workspace.members.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Change a workspace member's role",
      action: "change a workspace member's role",
      description: "Allows {requesterKind} to change a workspace member's role.",
      group: "accounts",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Set an account role; root-only at the hub.",
    args: z.tuple([
      z
        .object({ ...userRefFields, role: z.enum(["admin", "member"]) })
        .strict()
        .refine(requireUserRef, "userId or handle is required"),
    ]),
    returns: z.object({
      userId: z.string(),
      handle: z.string(),
      role: z.enum(["admin", "member"]),
    }),
    access: adminAccess,
  },
  updateProfile: {
    capability: "account.profile.update",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.mutate",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Change an account profile",
      action: "change an account profile",
      description: "Allows {requesterKind} to change an account profile.",
      group: "accounts",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
    description: "Update the authenticated account profile, or another account as root.",
    args: z.tuple([
      z
        .object({
          userId: z.string().optional(),
          handle: z.string().optional(),
          displayName: z.string().optional(),
          avatar: z.string().nullable().optional(),
          color: z.string().nullable().optional(),
        })
        .strict(),
    ]),
    returns: HubUserSchema.extend({ avatar: z.string().optional(), color: z.string().optional() }),
    access: writeAccess,
  },
  getProfile: {
    capability: "account.profile.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "identity",
      family: "hubControl.read",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "View an account profile",
      action: "view an account profile",
      description: "Allows {requesterKind} to view an account profile.",
      group: "accounts",
      authorityCategory: {
        domain: "accounts",
        verb: "see",
      },
    },
    description: "Read the authenticated account profile, or a specified account.",
    args: z.tuple([z.object({ userId: z.string().optional() }).strict().optional()]),
    returns: HubUserSchema.extend({
      avatar: z.string().optional(),
      color: z.string().optional(),
    }).nullable(),
    access: readAccess,
  },
});

export type HubWorkspaceRoute = z.infer<typeof HubWorkspaceRouteSchema>;
export type HubDevice = z.infer<typeof HubDeviceSchema>;
export type HubPairingInvite = z.infer<typeof HubPairingInviteSchema>;
export type HubReadyPayload = z.infer<typeof HubReadyPayloadSchema>;
export type HubUserPresence = z.infer<typeof HubUserPresenceSchema>;
