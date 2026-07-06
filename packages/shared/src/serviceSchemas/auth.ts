/**
 * Wire schema for the server "auth" gateway authentication service.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the auth method groups. These touch device
// pairing/credentials, so even reads are connection-management 'admin'.
const AUTH_READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const AUTH_ADMIN_READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const AUTH_PAIRING_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const AUTH_GRANT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const AUTH_REVOKE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};

export const CreatePairingInviteArgsSchema = z.object({
  ttlMs: z
    .number()
    .int()
    .min(30_000)
    .max(60 * 60 * 1000)
    .optional()
    .describe("Invite lifetime in milliseconds (30s–1h); defaults to the server's standard TTL."),
});

/** The entity/context/channel binding surfaced for an `agent`-kind connection. */
export const AgentBindingSchema = z.object({
  entityId: z.string(),
  contextId: z.string(),
  channelId: z.string(),
  agentId: z.string(),
});

export const ConnectionInfoResponseSchema = z.object({
  serverUrl: z.string(),
  protocol: z.enum(["http", "https"]).optional(),
  externalHost: z.string().optional(),
  gatewayPort: z.number().nullable().optional(),
  serverId: z.string(),
  serverBootId: z.string(),
  workspaceId: z.string().nullable().optional(),
  /**
   * Authenticated caller kind of THIS connection (present on getConnectionInfo).
   * Lets a client confirm it authenticated as `agent` (vs `shell`) and, when it
   * did, read its host-verified `agentBinding`. Omitted on the pairing-invite
   * responses that reuse this schema (they carry no per-connection caller).
   */
  callerKind: z
    .enum(["shell", "panel", "app", "worker", "do", "extension", "server", "agent"])
    .optional(),
  /** Entity/context binding for an `agent`-kind connection (host-verified). */
  agentBinding: AgentBindingSchema.optional(),
});

export const authMethods = defineServiceMethods({
  grantConnection: {
    description:
      "Mint a short-lived connection token for a panel/app caller (requires the panel-hosting capability), granting it access to the gateway.",
    args: z.tuple([z.string()]),
    returns: z.object({ token: z.string() }),
    policy: { allowed: ["server", "shell", "app"] },
    access: AUTH_GRANT_ACCESS,
  },
  getConnectionInfo: {
    description:
      "Report how clients should reach this gateway: server/connect URLs, protocol, server identity, and current workspace.",
    args: z.tuple([]),
    returns: ConnectionInfoResponseSchema,
    access: AUTH_READ_ACCESS,
  },
  createPairingInvite: {
    description:
      "Create a one-time device-pairing invite (code + deep link) for this server; requires the connection-management capability and is audit-logged.",
    args: z.tuple([CreatePairingInviteArgsSchema.optional()]),
    // Matches PairingInviteResponse (ConnectionInfoResponse + pairing fields)
    // produced by `createPairingInviteResponse` in src/server/services/auth/model.ts.
    returns: ConnectionInfoResponseSchema.extend({
      code: z.string(),
      expiresInMs: z.number(),
      expiresAt: z.number(),
      deepLink: z.string().nullable(),
      // The invite's freshly minted signaling room (null without WebRTC ingress).
      room: z.string().nullable(),
    }),
    policy: { allowed: ["server", "shell", "app"] },
    access: AUTH_PAIRING_ACCESS,
    examples: [{ args: [{ ttlMs: 300_000 }] }],
  },
  listDevices: {
    description: "List paired devices for this server (refresh-token secrets stripped).",
    args: z.tuple([]),
    // Matches the handler in src/server/services/authService.ts: DeviceRecord
    // rows with `refreshTokenHash` stripped before they cross the wire.
    returns: z.object({
      serverId: z.string(),
      devices: z.array(
        z.object({
          deviceId: z.string(),
          label: z.string(),
          platform: z.string().optional(),
          createdAt: z.number(),
          lastUsedAt: z.number().optional(),
          revokedAt: z.number().optional(),
        })
      ),
    }),
    access: AUTH_ADMIN_READ_ACCESS,
  },
  revokeDevice: {
    description:
      "Revoke a paired device by id, invalidating its shell token and retiring any mobile-app principal; audit-logged. Returns whether a device was revoked.",
    args: z.tuple([z.string()]),
    returns: z.object({ revoked: z.boolean() }),
    access: AUTH_REVOKE_ACCESS,
  },
  mintAgentCredential: {
    description:
      "Mint an entity-scoped agent credential (caller kind `agent`, principal `agent:<entityId>`) bound to a runtime session and channel. The host derives context from the target session. Returns { agentId, agentToken } where agentToken is the full `agent:<agentId>:<token>` string. Callable only by the server or by the extension that owns the target session.",
    args: z.tuple([
      z.object({
        entityId: z.string().describe("Runtime entity id the credential is bound to."),
        channelId: z.string().describe("Primary channel the agent is invited into."),
        ttlMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Credential lifetime in milliseconds; omit for no expiry (entity-lifetime)."),
        scopes: z
          .array(z.string())
          .optional()
          .describe("Optional capability scopes carried on the credential."),
      }),
    ]),
    returns: z.object({ agentId: z.string(), agentToken: z.string() }),
    policy: { allowed: ["extension", "server"] },
    access: AUTH_PAIRING_ACCESS,
    examples: [{ args: [{ entityId: "session:s1", channelId: "chan-1" }] }],
  },
  revokeAgentCredential: {
    description:
      "Revoke a single entity-scoped agent credential by agentId. Callable only by the server or by the extension that owns the target session. Returns whether a credential was revoked.",
    args: z.tuple([z.string().describe("Agent credential id (agt_…).")]),
    returns: z.object({ revoked: z.boolean() }),
    policy: { allowed: ["extension", "server"] },
    access: AUTH_REVOKE_ACCESS,
  },
});
