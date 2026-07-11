/** Typed authenticated child-to-hub control plane. */

import { z } from "zod";
import {
  normalizeFingerprint,
  PAIRING_CODE_PATTERN,
  PAIRING_PROTOCOL_VERSION,
  PAIRING_ROOM_PATTERN,
  parseConnectLink,
  parseSignalingEndpoint,
} from "../connect.js";
import { SERVER_BOOT_ID_PATTERN, SERVER_ID_PATTERN } from "../deviceCredentials.js";
import { defineServiceMethods } from "../typedServiceClient.js";

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
    srv: z.string().min(1).optional(),
  })
  .strict();

export const HubWorkspaceRouteSchema = z
  .object({
    workspace: z.string(),
    workspaceId: z.string(),
    running: z.literal(true),
    serverUrl: z.string(),
    controlReach: HubReachSchema,
    workspaceReach: HubReachSchema,
    serverId: z.string().regex(SERVER_ID_PATTERN),
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
  })
  .strict();

export const HubPairingInviteSchema = HubReachSchema.extend({
  code: z.string().regex(PAIRING_CODE_PATTERN),
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
        parsed.srv === invite.srv;
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
    connectUrl: z.string().url(),
    rootInvites: z
      .object({ desktop: HubPairingInviteSchema, mobile: HubPairingInviteSchema })
      .strict()
      .nullable(),
    serverId: z.string().regex(SERVER_ID_PATTERN),
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
    gatewayPort: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    version: z.string().min(1),
    workspaces: z.array(HubWorkspaceEntrySchema),
  })
  .strict()
  .superRefine((ready, ctx) => {
    if (!ready.rootInvites) return;
    for (const kind of ["desktop", "mobile"] as const) {
      const invite = ready.rootInvites[kind];
      if (invite.serverId !== ready.serverId) {
        ctx.addIssue({
          code: "custom",
          path: ["rootInvites", kind, "serverId"],
          message: "Invite serverId does not match the ready-file serverId",
        });
      }
      if (invite.serverBootId !== ready.serverBootId) {
        ctx.addIssue({
          code: "custom",
          path: ["rootInvites", kind, "serverBootId"],
          message: "Invite serverBootId does not match the ready-file serverBootId",
        });
      }
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

export const hubControlMethods = defineServiceMethods({
  listWorkspaces: {
    description: "List workspaces visible to the authenticated account.",
    args: z.tuple([]),
    returns: z.array(HubWorkspaceEntrySchema),
    access: readAccess,
  },
  routeWorkspace: {
    description: "Route the authenticated device directly into a workspace child.",
    args: z.tuple([z.object({ workspace: z.string().min(1) }).strict()]),
    returns: HubWorkspaceRouteSchema,
    access: readAccess,
  },
  createWorkspace: {
    description: "Create and register a workspace through the hub control plane.",
    args: z.tuple([
      z.object({ workspace: z.string().min(1), forkFrom: z.string().min(1).optional() }).strict(),
    ]),
    returns: HubWorkspaceEntrySchema,
    access: writeAccess,
  },
  deleteWorkspace: {
    description: "Delete a workspace and cascade every membership row.",
    args: z.tuple([z.object({ workspace: z.string().min(1) }).strict()]),
    returns: z.object({ deleted: z.boolean(), workspaceId: z.string().nullable() }),
    access: destructiveAccess,
  },
  addWorkspaceMember: {
    description: "Add an existing account to a workspace.",
    args: z.tuple([
      z
        .object({ ...userRefFields, workspace: z.string().min(1) })
        .strict()
        .refine(requireUserRef, "userId or handle is required"),
    ]),
    returns: z.record(z.string(), z.unknown()),
    access: adminAccess,
  },
  removeWorkspaceMember: {
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
    description: "List the account membership projection for one workspace.",
    args: z.tuple([z.object({ workspace: z.string().min(1) }).strict()]),
    returns: z.object({
      workspace: z.string(),
      workspaceId: z.string(),
      members: z.array(z.record(z.string(), z.unknown())),
    }),
    access: readAccess,
  },
  listUserPresence: {
    description:
      "List the visible workspaces where a user currently has a live human endpoint.",
    args: z.tuple([userRef]),
    returns: HubUserPresenceSchema,
    access: readAccess,
  },
  inviteUser: {
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
    description: "List the caller's paired devices; administrators see every account's devices.",
    args: z.tuple([]),
    returns: z.object({ serverId: z.string(), devices: z.array(HubDeviceSchema) }),
    access: readAccess,
  },
  revokeDevice: {
    description: "Revoke a device and close all of its child sessions.",
    args: z.tuple([z.string().min(1)]),
    returns: z.object({ revoked: z.boolean(), closedSessions: z.number() }),
    access: destructiveAccess,
  },
  revokeUser: {
    description: "Revoke an account, credentials, memberships, and live deputies.",
    args: z.tuple([userRef]),
    returns: z.record(z.string(), z.unknown()),
    access: destructiveAccess,
  },
  setRole: {
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
export type HubPairingInvite = z.infer<typeof HubPairingInviteSchema>;
export type HubReadyPayload = z.infer<typeof HubReadyPayloadSchema>;
export type HubUserPresence = z.infer<typeof HubUserPresenceSchema>;
