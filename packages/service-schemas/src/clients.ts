/**
 * Wire schema for the server "clients" service: the one place a host resolves,
 * launches and lists clients (docs/client-hosts-and-clients-plan.md §4.5, §4.7).
 *
 * Every host calls these on its device shell session. Resolution is server-side:
 * a host never reads the workspace manifest to decide what to run.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  CLIENT_CAPABILITIES,
  CLIENT_RUNTIMES,
  HOST_KINDS,
  type ClientCapability,
} from "@vibestudio/workspace-contracts/clients";

const READ_ACCESS: MethodAccessDescriptor = { sensitivity: "read" };
const WRITE_ACCESS: MethodAccessDescriptor = { sensitivity: "write" };

const CLOSED = {
  kind: "closed",
  reason: "Clients are launched by the trusted host that owns this device's connection.",
} as const;

export const ClientRuntimeSchema = z.enum(CLIENT_RUNTIMES);
export const HostKindSchema = z.enum(HOST_KINDS);
export const ClientCapabilitySchema = z.enum(
  CLIENT_CAPABILITIES as unknown as [ClientCapability, ...ClientCapability[]]
);

export const HostDescriptorSchema = z
  .object({
    host: HostKindSchema,
    hostVersion: z.string().min(1).max(64),
    runtimes: z
      .object({
        web: z.string().min(1).max(64).optional(),
        "react-native": z.string().min(1).max(64).optional(),
        terminal: z.string().min(1).max(64).optional(),
      })
      .strict(),
    capabilities: z.array(ClientCapabilitySchema).max(64),
  })
  .strict();

const IntentParamsSchema = z.record(z.string().min(1).max(64), z.string().max(65_536));

export const ClientSelectionSchema = z.union([
  z.object({ default: z.literal(true) }).strict(),
  z
    .object({
      id: z.string().min(1).max(64),
      intent: z.string().min(1).max(64).optional(),
      params: IntentParamsSchema.optional(),
    })
    .strict(),
  z.object({ source: z.string().min(1).max(256) }).strict(),
]);

export const ClientLaunchRequestSchema = z
  .object({
    host: HostDescriptorSchema,
    select: ClientSelectionSchema,
    /** Launch this retained build instead of the current one. */
    rollbackTo: z.string().min(1).max(128).optional(),
  })
  .strict();

const ClientIntentDeclSchema = z
  .object({
    name: z.string().min(1).max(64),
    kind: z.enum(["foreground", "background"]),
    title: z.string().optional(),
    params: z.record(z.string(), z.enum(["string", "text"])).optional(),
    dynamic: z.string().optional(),
    handler: z.string().optional(),
    accepts: z.array(z.string()).optional(),
  })
  .strict();

export const ClientArtifactDescriptorSchema = z
  .object({
    path: z.string().min(1),
    role: z.string().min(1),
    contentType: z.string(),
    platform: z.string().min(1).optional(),
    integrity: z.string().regex(/^sha256-[0-9a-f]{64}$/u),
  })
  .strict();

export const ReadyClientSchema = z
  .object({
    source: z.string().min(1),
    id: z.string().min(1),
    runtime: ClientRuntimeSchema,
    title: z.string().min(1),
    icon: z.string().optional(),
    buildKey: z.string().min(1),
    executionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    effectiveVersion: z.string().min(1),
    hostAbi: z.string().min(1),
    artifacts: z.array(ClientArtifactDescriptorSchema),
    grantedCapabilities: z.array(ClientCapabilitySchema),
    deniedOptional: z.array(ClientCapabilitySchema),
    intent: z.object({ name: z.string(), params: z.record(z.string(), z.string()) }).optional(),
  })
  .strict();

export const ClientLaunchResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("approval-required"), approvals: z.array(z.unknown()) }).strict(),
  z
    .object({
      state: z.literal("preparing"),
      phase: z.enum(["resolve", "extensions", "build"]),
      reason: z.string(),
    })
    .strict(),
  z.object({ state: z.literal("ready"), client: ReadyClientSchema }).strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.string(),
      missing: z
        .object({
          capabilities: z.array(z.string()).optional(),
          hostAbi: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

export const ClientListingSchema = z
  .object({
    source: z.string().min(1),
    id: z.string().min(1),
    runtime: ClientRuntimeSchema,
    title: z.string().min(1),
    icon: z.string().optional(),
    hostAbi: z.string().min(1),
    status: z.enum([
      "not-built",
      "pending-approval",
      "building",
      "available",
      "running",
      "stopped",
      "error",
    ]),
    isDefault: z.boolean(),
    trusted: z.boolean(),
    unavailableReason: z.string().optional(),
    intents: z.array(ClientIntentDeclSchema),
    terminalCommand: z.string().optional(),
    activeBuildKey: z.string().nullable(),
    canRollback: z.boolean(),
  })
  .strict();

export const ClientIntentInvocationSchema = z
  .object({
    id: z.string().min(1).max(64),
    intent: z.string().min(1).max(64),
    params: IntentParamsSchema.optional(),
  })
  .strict();

export const ClientIntentResultSchema = z
  .object({
    /** The handler's text result, once it has finished. */
    text: z.string(),
  })
  .strict();

export const ClientIntegrationSnapshotSchema = z
  .object({
    clients: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          icon: z.string().optional(),
          intents: z.array(ClientIntentDeclSchema),
          terminalCommand: z.string().optional(),
          entries: z.record(
            z.string(),
            z.array(
              z
                .object({
                  title: z.string(),
                  params: z.record(z.string(), z.string()),
                })
                .strict()
            )
          ),
        })
        .strict()
    ),
  })
  .strict();

export const ClientPrincipalGrantRequestSchema = z
  .object({
    /** The exact build the host verified and is about to run. */
    source: z.string().min(1).max(256),
    buildKey: z.string().min(1).max(128),
    executionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

export const ClientPrincipalGrantResponseSchema = z
  .object({
    /** One-use connection grant; redeem it as the auth token of a new RPC session. */
    connectionGrant: z.string().min(1),
    expiresAt: z.number().int(),
    /** `client:<id>:<runtime>:<deviceId>` */
    principalId: z.string().min(1),
    deviceId: z.string().min(1),
    serverId: z.string().min(1),
    serverBootId: z.string().min(1),
    workspaceId: z.string().min(1),
  })
  .strict();
export type ClientPrincipalGrantResponse = z.infer<typeof ClientPrincipalGrantResponseSchema>;

const hostTier = (family: "clients.read" | "clients.launch", rationale: string) =>
  ({
    tier: "open",
    session: "family",
    residency: "supervision",
    family,
    rationale,
  }) as const;

export const clientsMethods = defineServiceMethods({
  launch: {
    website: CLOSED,
    tier: hostTier(
      "clients.launch",
      "A device host launches an admitted System client; admission is the unit install review, not this call."
    ),
    description:
      "Resolve the client a host asked for, prepare its build and required extensions, and report whether it needs review, is preparing, is ready (with its verified artifacts and granted capabilities) or cannot run on this host.",
    args: z.tuple([ClientLaunchRequestSchema]),
    returns: ClientLaunchResultSchema,
    authority: { principals: ["host", "user"] },
    access: WRITE_ACCESS,
  },
  list: {
    website: CLOSED,
    tier: hostTier("clients.read", "Lists the System workspace's declared clients for a host."),
    description:
      "List the clients this workspace declares, with whether the calling host can run each and which is its default.",
    args: z.tuple([HostDescriptorSchema]),
    returns: z.array(ClientListingSchema),
    authority: { principals: ["host", "user"] },
    access: READ_ACCESS,
  },
  invokeIntent: {
    website: CLOSED,
    tier: hostTier(
      "clients.launch",
      "Runs a client's declared background intent as that client's principal; the handler's own authority applies."
    ),
    description:
      "Run a client's background intent server-side and return its declared result, without loading any client code on the device.",
    args: z.tuple([HostDescriptorSchema, ClientIntentInvocationSchema]),
    returns: ClientIntentResultSchema,
    authority: { principals: ["host", "user"] },
    access: WRITE_ACCESS,
  },
  integrationSnapshot: {
    website: CLOSED,
    tier: hostTier(
      "clients.read",
      "Reads the launch surfaces (intents and dynamic entries) a host projects onto the OS."
    ),
    description:
      "Return every client this host can run with its intents and current dynamic entries, for launchers, shortcut menus, App Intents and widgets.",
    args: z.tuple([HostDescriptorSchema]),
    returns: ClientIntegrationSnapshotSchema,
    authority: { principals: ["host", "user"] },
    access: READ_ACCESS,
  },
});
