/**
 * Wire schema for the server "auth" gateway authentication service.
 */

import { z } from "zod";
import type {
  MethodAccessDescriptor,
  ServiceAuthorityPolicy,
} from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

// Access descriptors for gateway connection and entity-scoped agent auth.
const AUTH_READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const AUTH_CONNECTION_INFO_POLICY: ServiceAuthorityPolicy = {
  principals: ["host", "user", "code"],
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

/** Live entity/context/channel projection surfaced for an `agent` connection. */
export const AgentBindingSchema = z
  .object({
    entityId: z.string(),
    contextId: z.string(),
    channelId: z.string(),
    agentId: z.string(),
  })
  .strict();

export const RefreshShellResponseSchema = z
  .object({
    shellToken: z.string().min(1),
    callerId: z.string().min(1),
    deviceId: z.string().min(1),
    label: z.string(),
    serverId: z.string().min(1),
    serverBootId: z.string().min(1),
    // The machine-control hub authenticates the device before a workspace is
    // selected; workspace children always return their concrete workspace id.
    workspaceId: z.string().min(1).nullable(),
  })
  .strict();

export const RefreshAgentResponseSchema = z
  .object({
    token: z.string().min(1),
    callerId: z.string().min(1),
    callerKind: z.literal("agent"),
    entityId: z.string().min(1),
    contextId: z.string().min(1),
    channelId: z.string().min(1),
    agentId: z.string().min(1),
    serverId: z.string().min(1),
    serverBootId: z.string().min(1),
    workspaceId: z.string().min(1),
  })
  .strict();

export const ConnectionInfoResponseSchema = z
  .object({
    serverUrl: z.string().min(1),
    protocol: z.enum(["http", "https"]),
    externalHost: z.string().min(1),
    gatewayPort: z.number().int().min(1).max(65_535),
    serverId: z.string().min(1),
    serverBootId: z.string().min(1),
    workspaceId: z.string().min(1),
    /** Authenticated caller kind of this connection. */
    callerKind: z.enum(["shell", "panel", "app", "worker", "do", "extension", "server", "agent"]),
    /** Host-verified entity/context binding, present only for an agent caller. */
    agentBinding: AgentBindingSchema.optional(),
  })
  .strict();

export const authMethods = defineServiceMethods({
  grantConnection: {
    capability: "connections.approve",
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "auth.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 default {code, session} family",
    },
    presentation: {
      title: "Allow a new client connection",
      action: "allow a new client connection",
      description: "Allows {requesterKind} to allow a new client connection.",
      group: "accounts",
      authorityCategory: {
        domain: "computer",
        verb: "manage",
      },
    },
    description:
      "Mint a short-lived connection token for a panel/app caller (requires the panel-hosting capability), granting it access to the gateway.",
    args: z.tuple([z.string()]),
    returns: z.object({ token: z.string() }),
    authority: { principals: ["host", "user", "code"] },
    access: AUTH_GRANT_ACCESS,
  },
  getConnectionInfo: {
    tier: {
      tier: "open",
      session: "family",
      residency: "identity",
      family: "auth.read",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Report how clients should reach this gateway: server/connect URLs, protocol, server identity, and current workspace.",
    args: z.tuple([]),
    returns: ConnectionInfoResponseSchema,
    authority: AUTH_CONNECTION_INFO_POLICY,
    access: AUTH_READ_ACCESS,
  },
  mintAgentCredential: {
    capability: "agent.credentials.manage",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "auth.control",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Create a sign-in key for an agent",
      action: "create a sign-in key for an agent",
      description: "Allows {requesterKind} to create a sign-in key for an agent.",
      group: "accounts",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
    description:
      "Rotate the authentication secret for a live self-bound agent session. The credential proves only the exact entity id; context, channel, and owner are resolved from the session entity whenever it authenticates. Returns { agentId, agentToken }. Callable only by the server or by the extension that owns the target session.",
    args: z.tuple([
      z
        .object({
          entityId: z.string().describe("Runtime entity id the credential is bound to."),
          ttlMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Credential lifetime in milliseconds; omit for no expiry (entity-lifetime)."),
        })
        .strict(),
    ]),
    returns: z.object({ agentId: z.string(), agentToken: z.string() }),
    authority: { principals: ["code", "host"] },
    access: AUTH_PAIRING_ACCESS,
    examples: [{ args: [{ entityId: "session:s1" }] }],
  },
  revokeAgentCredential: {
    capability: "agent.credentials.manage",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "grant-authority",
      family: "auth.retire",
      rationale:
        "G3: state change exceeds the calling task's scratch; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Revoke an agent's sign-in key",
      action: "revoke an agent's sign-in key",
      description: "Allows {requesterKind} to revoke an agent's sign-in key.",
      group: "accounts",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
    description:
      "Revoke a single entity-scoped agent credential by agentId. Callable only by the server or by the extension that owns the target session. Returns whether a credential was revoked.",
    args: z.tuple([z.string().describe("Agent credential id (agt_…).")]),
    returns: z.object({ revoked: z.boolean() }),
    authority: { principals: ["code", "host"] },
    access: AUTH_REVOKE_ACCESS,
  },
});
