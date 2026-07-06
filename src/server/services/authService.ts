import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { authMethods, CreatePairingInviteArgsSchema } from "@vibestudio/shared/serviceSchemas/auth";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { ServiceWithRoutes } from "../serviceWithHttpRoutes.js";
import type { DeviceAuthStore } from "./deviceAuthStore.js";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { AuditLog } from "@vibestudio/shared/credentials/audit";
import type { PendingUnitBatchApproval } from "@vibestudio/shared/approvals";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { isPanelSlotId } from "@vibestudio/shared/panel/ids";
import {
  agentCallerId,
  connectionInfoResponse,
  createPairingInviteResponse,
  responseForCredential,
  shellCallerId,
  type AuthConnectionInfo,
  type PairingRoomArmer,
} from "./auth/model.js";
import { auditPairingEvent } from "./auth/audit.js";
import { refreshPrincipalGrantResponse } from "./auth/principalGrants.js";
import { sendAuthError } from "./auth/httpErrors.js";
import { createCapabilityAuthorizer, type CapabilityAuthorizer } from "./capabilityAuthorizer.js";

const IssueDeviceBodySchema = z.object({
  label: z.string().min(1).max(128).optional(),
  platform: z.string().min(1).max(64).optional(),
});

const CreatePairingCodeBodySchema = z.object({
  ttlMs: z
    .number()
    .int()
    .min(30_000)
    .max(60 * 60 * 1000)
    .optional(),
});

const CompletePairingBodySchema = z.object({
  code: z.string().min(16).max(512),
  label: z.string().min(1).max(128).optional(),
  platform: z.string().min(1).max(64).optional(),
});

const RefreshShellBodySchema = z.object({
  deviceId: z.string().min(1).max(128),
  refreshToken: z.string().min(16).max(512),
});

const RefreshPrincipalGrantBodySchema = RefreshShellBodySchema.extend({
  principal: z.string().min(1).max(128).optional(),
  source: z.string().min(1).max(256).optional(),
});
const MobileAppBootstrapBodySchema = RefreshShellBodySchema.extend({
  source: z.string().min(1).max(256).optional(),
});

const RevokeDeviceBodySchema = z.object({
  deviceId: z.string().min(1).max(128),
});

const RefreshAgentBodySchema = z.object({
  // The full presentable credential: `agent:<agentId>:<secret>`.
  agentToken: z.string().min(8).max(512),
});

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

/**
 * Redeem a device-pairing credential presented as a session token — the
 * over-the-pipe equivalent of the loopback HTTP `/complete-pairing` +
 * `/refresh-shell` endpoints (which a remote WebRTC client cannot reach):
 *   - a QR pairing `code` (fresh device) → `completePairing` → a newly issued
 *     device credential (returned so the auth-result hands it to the client to
 *     persist), or
 *   - `refresh:<deviceId>:<refreshToken>` (returning device) → `validateRefresh`.
 * Both resolve to the device's `shell:<deviceId>` principal. Returns null when
 * the token is neither (handleAuth then rejects it as an invalid token). Wired
 * into `RpcServer`'s `redeemPairingCredential` dep so it runs ONLY after the
 * grant/bearer checks miss.
 */
export function createPairingRedeemer(deps: {
  deviceAuthStore: DeviceAuthStore;
  tokenManager: TokenManager;
}) {
  const REFRESH_PREFIX = "refresh:";
  const AGENT_PREFIX = "agent:";
  return (token: string, ctx: { clientLabel?: string; clientPlatform?: string }) => {
    if (token.startsWith(AGENT_PREFIX)) {
      // `agent:<agentId>:<secret>` — an entity-scoped agent credential (§3.2).
      // Redeems to the `agent:<entityId>` principal, kind `agent`, and carries a
      // host-verified binding onto the connection (stamped by handleAuth, never
      // from client input).
      const parsed = parseAgentToken(token);
      if (!parsed) return null;
      const binding = deps.deviceAuthStore.validateAgentToken(parsed.agentId, parsed.secret);
      if (!binding) return null;
      const callerId = agentCallerId(binding.entityId);
      const agentBinding = {
        entityId: binding.entityId,
        contextId: binding.contextId,
        channelId: binding.channelId,
        agentId: binding.agentId,
      };
      deps.tokenManager.ensureToken(callerId, "agent", { agentBinding });
      return {
        callerId,
        callerKind: "agent" as const,
        agentBinding,
      };
    }
    if (token.startsWith(REFRESH_PREFIX)) {
      const rest = token.slice(REFRESH_PREFIX.length);
      const sep = rest.indexOf(":");
      if (sep <= 0) return null;
      const deviceId = rest.slice(0, sep);
      const refreshToken = rest.slice(sep + 1);
      if (!refreshToken) return null;
      try {
        deps.deviceAuthStore.validateRefresh(deviceId, refreshToken);
      } catch {
        return null;
      }
      deps.tokenManager.ensureToken(shellCallerId(deviceId), "shell");
      return { callerId: shellCallerId(deviceId), callerKind: "shell" as const };
    }
    if (!deps.deviceAuthStore.hasPendingPairingCode(token)) return null;
    let credential;
    try {
      credential = deps.deviceAuthStore.completePairing({
        code: token,
        label: ctx.clientLabel,
        platform: ctx.clientPlatform,
      });
    } catch {
      return null;
    }
    deps.tokenManager.ensureToken(shellCallerId(credential.deviceId), "shell");
    return {
      callerId: shellCallerId(credential.deviceId),
      callerKind: "shell" as const,
      deviceCredential: { deviceId: credential.deviceId, refreshToken: credential.refreshToken },
    };
  };
}

/** Parse a presentable agent credential `agent:<agentId>:<secret>`. */
function parseAgentToken(token: string): { agentId: string; secret: string } | null {
  const AGENT_PREFIX = "agent:";
  if (!token.startsWith(AGENT_PREFIX)) return null;
  const rest = token.slice(AGENT_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const agentId = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!secret) return null;
  return { agentId, secret };
}

export function createAuthService(deps: {
  tokenManager: TokenManager;
  deviceAuthStore: DeviceAuthStore;
  getServerBootId: () => string;
  getWorkspaceId: () => string;
  getConnectionInfo?: () => AuthConnectionInfo;
  /**
   * The live WebRTC ingress pool (null when WebRTC is off). Pairing invites
   * mint one fresh signaling room each and arm it here (plan §2.1).
   */
  getWebRtcIngress?: () => PairingRoomArmer | null;
  connectionGrants?: ConnectionGrantService;
  auditLog?: Pick<AuditLog, "append">;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  capabilityAuthorizer?: CapabilityAuthorizer;
  ensureMobileAppReady?: (source?: string | null) => Promise<{
    ready: boolean;
    reason?: string;
    details?: string[];
    approvalRequired?: boolean;
    approvals?: PendingUnitBatchApproval[];
  }>;
  getMobileAppBootstrap?: (source?: string | null) => unknown | null | Promise<unknown | null>;
  registerMobileAppPrincipal?: (
    deviceId: string,
    source?: string | null
  ) => string | null | Promise<string | null>;
  retireMobileAppPrincipal?: (deviceId: string) => void;
  resolveRuntimeEntity?: (id: string) => Promise<EntityRecord | null>;
}): ServiceWithRoutes {
  const capabilityAuthorizer =
    deps.capabilityAuthorizer ??
    createCapabilityAuthorizer({ hasAppCapability: deps.hasAppCapability });
  const definition: ServiceDefinition = {
    name: "auth",
    description: "Gateway authentication bootstrap routes",
    policy: { allowed: ["server", "shell"] },
    methods: authMethods,
    handler: async (ctx, method, args) => {
      if (method === "grantConnection") {
        capabilityAuthorizer.require(ctx.caller, "panel-hosting");
        if (!deps.connectionGrants) throw new Error("Connection grants are not configured");
        const principalId = args[0] as string;
        // Boundary defense at the RPC ingress: a slot id ("panel:tree/…") names a
        // tree position, not a connectable principal. Reject it loudly here so a
        // slot/entity mix-up by ANY caller fails at the grant rather than minting a
        // grant that can never satisfy authorizePanelConnection (leases are keyed
        // by the panel ENTITY id "panel:nav-…").
        if (isPanelSlotId(principalId)) {
          throw new Error(
            `grantConnection: "${principalId}" is a panel SLOT id; connection grants require a ` +
              `runtime principal (the panel ENTITY id "panel:nav-…"), not a tree slot.`
          );
        }
        return deps.connectionGrants.grant(principalId, ctx.caller.runtime.id);
      }
      if (method === "getConnectionInfo") {
        return {
          ...connectionInfoResponse(deps),
          callerKind: ctx.caller.runtime.kind,
          ...(ctx.caller.agentBinding ? { agentBinding: ctx.caller.agentBinding } : {}),
        };
      }
      if (method === "createPairingInvite") {
        capabilityAuthorizer.require(ctx.caller, "connection-management");
        const body = CreatePairingInviteArgsSchema.parse(args[0] ?? {});
        const response = createPairingInviteResponse(deps, body.ttlMs);
        await auditPairingEvent(deps, {
          type: "device_pairing.invite_created",
          callerId: ctx.caller.runtime.id,
          expiresAt: typeof response["expiresAt"] === "number" ? response["expiresAt"] : undefined,
          method: "rpc",
        });
        return response;
      }
      async function resolveAgentCredentialTarget(
        methodName: string,
        entityId: string
      ): Promise<EntityRecord> {
        if (!deps.resolveRuntimeEntity) {
          throw new Error(`auth.${methodName} requires runtime entity resolution`);
        }
        const record = await deps.resolveRuntimeEntity(entityId);
        if (!record || record.status !== "active") {
          throw new Error(`auth.${methodName} target entity is not active: ${entityId}`);
        }
        if (record.kind !== "session") {
          throw new Error(`auth.${methodName} target entity must be a session`);
        }
        return record;
      }

      function assertAgentCredentialOwner(
        methodName: string,
        callerId: string,
        record: EntityRecord
      ): void {
        if (record.parentId !== callerId && record.id !== callerId) {
          throw new Error(`auth.${methodName} caller does not own target entity ${record.id}`);
        }
      }

      if (method === "mintAgentCredential") {
        const input = args[0] as {
          entityId: string;
          channelId: string;
          ttlMs?: number;
          scopes?: string[];
        };
        const record = await resolveAgentCredentialTarget("mintAgentCredential", input.entityId);
        if (ctx.caller.runtime.kind !== "server") {
          assertAgentCredentialOwner("mintAgentCredential", ctx.caller.runtime.id, record);
        }
        return deps.deviceAuthStore.mintAgentCredential({
          ...input,
          contextId: record.contextId,
        });
      }
      if (method === "revokeAgentCredential") {
        const agentId = args[0] as string;
        const existing = deps.deviceAuthStore.getAgentCredential(agentId);
        if (!existing) return { revoked: false };
        if (existing.revokedAt) return { revoked: false };
        const record = await resolveAgentCredentialTarget(
          "revokeAgentCredential",
          existing.entityId
        );
        if (ctx.caller.runtime.kind !== "server") {
          assertAgentCredentialOwner("revokeAgentCredential", ctx.caller.runtime.id, record);
        }
        const revoked = deps.deviceAuthStore.revokeAgentCredential(agentId);
        if (revoked) deps.tokenManager.revokeToken(agentCallerId(existing.entityId));
        return { revoked };
      }
      if (method === "listDevices") {
        return {
          serverId: deps.deviceAuthStore.getServerId(),
          // Strip secrets AND the device's signaling room — knowing another
          // device's room lets a caller squat/evict its signaling slot.
          devices: deps.deviceAuthStore
            .listDevices()
            .map(({ refreshTokenHash: _secret, room: _room, ...device }) => device),
        };
      }
      if (method === "revokeDevice") {
        const deviceId = args[0] as string;
        const revoked = deps.deviceAuthStore.revokeDevice(deviceId);
        deps.tokenManager.revokeToken(shellCallerId(deviceId));
        deps.retireMobileAppPrincipal?.(deviceId);
        if (revoked) {
          await auditPairingEvent(deps, {
            type: "device_pairing.device_revoked",
            callerId: ctx.caller.runtime.id,
            deviceId,
            method: "rpc",
          });
        }
        return { revoked };
      }
      throw new Error(`Unknown auth method: ${method}`);
    },
  };

  const routes: ServiceRouteDecl[] = [
    {
      serviceName: "auth",
      path: "/issue-device",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        try {
          const body = IssueDeviceBodySchema.parse(await readJson(req));
          const credential = deps.deviceAuthStore.issueDevice({
            label: body.label ?? "Vibestudio client",
            platform: body.platform,
          });
          sendJson(res, 200, responseForCredential(deps, credential, { includeShellToken: true }));
        } catch (error) {
          sendAuthError(res, error, 400);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/create-pairing-code",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        try {
          const body = CreatePairingCodeBodySchema.parse(await readJson(req));
          const response = createPairingInviteResponse(deps, body.ttlMs);
          await auditPairingEvent(deps, {
            type: "device_pairing.invite_created",
            callerId: "admin-token",
            expiresAt:
              typeof response["expiresAt"] === "number" ? response["expiresAt"] : undefined,
            method: "http-admin",
          });
          sendJson(res, 200, response);
        } catch (error) {
          sendAuthError(res, error, 400);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/complete-pairing",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          const body = CompletePairingBodySchema.parse(await readJson(req));
          const credential = deps.deviceAuthStore.completePairing({
            code: body.code,
            label: body.label,
            platform: body.platform,
          });
          await auditPairingEvent(deps, {
            type: "device_pairing.redeemed",
            callerId: "public-pairing-code",
            deviceId: credential.deviceId,
            label: credential.label,
            platform: credential.platform,
            method: "http-public",
          });
          sendJson(res, 200, responseForCredential(deps, credential, { includeShellToken: true }));
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/refresh-shell",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          const body = RefreshShellBodySchema.parse(await readJson(req));
          const device = deps.deviceAuthStore.validateRefresh(body.deviceId, body.refreshToken);
          const shellToken = deps.tokenManager.ensureToken(shellCallerId(body.deviceId), "shell");
          sendJson(res, 200, {
            shellToken,
            callerId: shellCallerId(body.deviceId),
            deviceId: body.deviceId,
            label: device.label,
            serverId: deps.deviceAuthStore.getServerId(),
            serverBootId: deps.getServerBootId(),
            workspaceId: deps.getWorkspaceId(),
          });
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/refresh-agent",
      methods: ["POST"],
      auth: "public",
      // Mirror of /refresh-shell for entity-scoped agent credentials (§3.2):
      // exchange an `agent:<agentId>:<secret>` credential for a short-lived
      // caller (bearer) token so HTTP `POST /rpc` works with one auth model
      // everywhere. The WS/WebRTC paths use the same credential directly via the
      // redeemer; this route is the HTTP-only leg.
      handler: async (req, res) => {
        try {
          const body = RefreshAgentBodySchema.parse(await readJson(req));
          const parsed = parseAgentToken(body.agentToken);
          const binding = parsed
            ? deps.deviceAuthStore.validateAgentToken(parsed.agentId, parsed.secret)
            : null;
          if (!binding) {
            sendJson(res, 401, {
              error: "Invalid or expired agent credential",
              code: "INVALID_AGENT_CREDENTIAL",
            });
            return;
          }
          const callerId = agentCallerId(binding.entityId);
          const agentBinding = {
            entityId: binding.entityId,
            contextId: binding.contextId,
            channelId: binding.channelId,
            agentId: binding.agentId,
          };
          const token = deps.tokenManager.ensureToken(callerId, "agent", { agentBinding });
          sendJson(res, 200, {
            token,
            callerId,
            callerKind: "agent",
            entityId: binding.entityId,
            contextId: binding.contextId,
            channelId: binding.channelId,
            agentId: binding.agentId,
            serverId: deps.deviceAuthStore.getServerId(),
            serverBootId: deps.getServerBootId(),
            workspaceId: deps.getWorkspaceId(),
          });
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/refresh-principal-grant",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          const body = RefreshPrincipalGrantBodySchema.parse(await readJson(req));
          sendJson(res, 200, await refreshPrincipalGrantResponse(deps, body));
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/mobile-app-bootstrap",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          if (!deps.getMobileAppBootstrap) {
            sendJson(res, 503, {
              error: "Mobile app bootstrap is not configured",
              code: "MOBILE_BOOTSTRAP_UNAVAILABLE",
            });
            return;
          }
          const body = MobileAppBootstrapBodySchema.parse(await readJson(req));
          deps.deviceAuthStore.validateRefresh(body.deviceId, body.refreshToken);
          const readiness = await deps.ensureMobileAppReady?.(body.source ?? null);
          if (readiness && !readiness.ready) {
            const approvalRequired = readiness.approvalRequired === true;
            sendJson(res, approvalRequired ? 409 : 503, {
              error: [
                readiness.reason ?? "No approved React Native workspace app is available",
                ...(readiness.details?.length ? readiness.details : []),
              ].join(": "),
              code: approvalRequired ? "MOBILE_APP_APPROVAL_REQUIRED" : "MOBILE_APP_UNAVAILABLE",
              ...(approvalRequired ? { approvals: readiness.approvals ?? [] } : {}),
            });
            return;
          }
          const bootstrap = await deps.getMobileAppBootstrap(body.source ?? null);
          if (!bootstrap) {
            sendJson(res, 404, {
              error: "No approved React Native workspace app is available",
              code: "MOBILE_APP_UNAVAILABLE",
            });
            return;
          }
          sendJson(res, 200, {
            serverId: deps.deviceAuthStore.getServerId(),
            serverBootId: deps.getServerBootId(),
            workspaceId: deps.getWorkspaceId(),
            bootstrap,
          });
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/devices",
      methods: ["GET"],
      auth: "admin-token",
      handler: async (_req, res) => {
        sendJson(res, 200, {
          serverId: deps.deviceAuthStore.getServerId(),
          devices: deps.deviceAuthStore
            .listDevices()
            .map(({ refreshTokenHash: _secret, room: _room, ...device }) => device),
        });
      },
    },
    {
      serviceName: "auth",
      path: "/revoke-device",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        try {
          const body = RevokeDeviceBodySchema.parse(await readJson(req));
          const revoked = deps.deviceAuthStore.revokeDevice(body.deviceId);
          deps.tokenManager.revokeToken(shellCallerId(body.deviceId));
          deps.retireMobileAppPrincipal?.(body.deviceId);
          if (revoked) {
            await auditPairingEvent(deps, {
              type: "device_pairing.device_revoked",
              callerId: "admin-token",
              deviceId: body.deviceId,
              method: "http-admin",
            });
          }
          sendJson(res, 200, { revoked });
        } catch (error) {
          sendAuthError(res, error, 400);
        }
      },
    },
  ];

  return { definition, routes };
}
