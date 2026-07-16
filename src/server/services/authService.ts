import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  authMethods,
  RefreshAgentResponseSchema,
  RefreshShellResponseSchema,
} from "@vibestudio/service-schemas/auth";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { ServiceWithRoutes } from "../serviceWithHttpRoutes.js";
import {
  AGENT_ID_PATTERN,
  AGENT_SECRET_PATTERN,
  AGENT_TOKEN_PATTERN,
  type DeviceAuthStore,
  type PairedDeviceCredential,
} from "../hostCore/deviceAuthStore.js";
import {
  DEVICE_ID_PATTERN,
  DEVICE_REFRESH_TOKEN_PATTERN,
} from "@vibestudio/shared/deviceCredentials";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { User } from "@vibestudio/identity/types";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { AuditLog } from "@vibestudio/credential-client/audit";
import type { PendingUnitBatchApproval } from "@vibestudio/shared/approvals";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { isPanelSlotId } from "@vibestudio/shared/panel/ids";
import {
  agentCallerId,
  connectionInfoResponse,
  shellCallerId,
  type AuthConnectionInfo,
} from "../hostCore/auth/model.js";
import { refreshPrincipalGrantResponse } from "../hostCore/auth/principalGrants.js";
import { sendAuthError } from "../hostCore/auth/httpErrors.js";
import { authError, authErrorCode } from "../hostCore/auth/errors.js";
import { createCapabilityAuthorizer, type CapabilityAuthorizer } from "./capabilityAuthorizer.js";
import {
  bindingForLiveAgentEntity,
  ownerForLiveAgentEntity,
} from "../hostCore/auth/agentEntity.js";

export const RefreshShellBodySchema = z
  .object({
    deviceId: z.string().regex(DEVICE_ID_PATTERN, "Invalid device id format"),
    refreshToken: z.string().regex(DEVICE_REFRESH_TOKEN_PATTERN, "Invalid refresh token format"),
  })
  .strict();

export const RefreshPrincipalGrantBodySchema = RefreshShellBodySchema.extend({
  principal: z.string().min(1).max(128).optional(),
  source: z.string().min(1).max(256).optional(),
}).strict();
export const MobileAppBootstrapBodySchema = RefreshShellBodySchema.extend({
  source: z.string().min(1).max(256).optional(),
}).strict();

export const RefreshAgentBodySchema = z
  .object({
    // The full presentable credential: `agent:<agentId>:<secret>`.
    agentToken: z.string().regex(AGENT_TOKEN_PATTERN, "Invalid agent token format"),
  })
  .strict();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > 64 * 1024) {
      throw authError("REQUEST_BODY_TOO_LARGE", "Request body exceeds 64 KiB", 413);
    }
    chunks.push(buffer);
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

interface DeviceCredentialRedeemerDeps {
  deviceAuthStore: DeviceAuthStore;
  tokenManager: TokenManager;
  touchDevice?: (deviceId: string) => Promise<void>;
  resolveUser: (userId: string) => User | null;
}

interface WorkspaceCredentialRedeemerDeps extends DeviceCredentialRedeemerDeps {
  resolveRuntimeEntity: (entityId: string) => EntityRecord | null | Promise<EntityRecord | null>;
}

const REFRESH_PREFIX = "refresh:";
const AGENT_PREFIX = "agent:";

async function redeemReturningDevice(deps: DeviceCredentialRedeemerDeps, token: string) {
  if (!token.startsWith(REFRESH_PREFIX)) return null;
  const rest = token.slice(REFRESH_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const deviceId = rest.slice(0, sep);
  const refreshToken = rest.slice(sep + 1);
  if (!DEVICE_ID_PATTERN.test(deviceId) || !DEVICE_REFRESH_TOKEN_PATTERN.test(refreshToken)) {
    return null;
  }
  try {
    const device = deps.deviceAuthStore.validateRefresh(deviceId, refreshToken);
    const user = deps.resolveUser(device.userId);
    if (!user || user.revokedAt !== undefined) return null;
    await deps.touchDevice?.(deviceId);
    deps.tokenManager.ensureToken(shellCallerId(deviceId), "shell");
    return {
      callerId: shellCallerId(deviceId),
      callerKind: "shell" as const,
      subject: { userId: user.id, handle: user.handle },
    };
  } catch {
    return null;
  }
}

async function redeemAgentCredential(deps: WorkspaceCredentialRedeemerDeps, token: string) {
  if (!token.startsWith(AGENT_PREFIX)) return null;
  const parsed = parseAgentToken(token);
  if (!parsed) return null;
  const authenticated = deps.deviceAuthStore.validateAgentToken(parsed.agentId, parsed.secret);
  if (!authenticated) return null;
  const entity = await deps.resolveRuntimeEntity(authenticated.entityId);
  const agentBinding = bindingForLiveAgentEntity(entity, authenticated.agentId);
  const ownerUserId = ownerForLiveAgentEntity(entity);
  if (!agentBinding || !ownerUserId) return null;
  const subject =
    ownerUserId === SYSTEM_USER_ID
      ? { userId: SYSTEM_USER_ID, handle: SYSTEM_USER_ID }
      : (() => {
          const user = deps.resolveUser(ownerUserId);
          return user && user.revokedAt === undefined
            ? { userId: user.id, handle: user.handle }
            : null;
        })();
  if (!subject) return null;
  const callerId = agentCallerId(authenticated.entityId);
  deps.tokenManager.ensureToken(callerId, "agent", { agentBinding });
  return {
    callerId,
    callerKind: "agent" as const,
    agentBinding,
    subject,
  };
}

/** Stable hub ingress: returning devices and new pairing invites only. */
export function createHubCredentialRedeemer(
  deps: DeviceCredentialRedeemerDeps & {
    redeemPairingCode: (
      code: string,
      input: { label?: string; platform?: string }
    ) => Promise<PairedDeviceCredential>;
  }
) {
  return async (token: string, ctx: { clientLabel?: string; clientPlatform?: string }) => {
    if (token.startsWith(REFRESH_PREFIX)) return redeemReturningDevice(deps, token);
    if (token.startsWith(AGENT_PREFIX)) return null;
    try {
      const credential = await deps.redeemPairingCode(token, {
        label: ctx.clientLabel,
        platform: ctx.clientPlatform,
      });
      const user = deps.resolveUser(credential.userId);
      if (!user || user.revokedAt !== undefined) return null;
      deps.tokenManager.ensureToken(shellCallerId(credential.deviceId), "shell");
      return {
        callerId: shellCallerId(credential.deviceId),
        callerKind: "shell" as const,
        deviceCredential: {
          deviceId: credential.deviceId,
          refreshToken: credential.refreshToken,
        },
        pairingContext: { workspaceId: credential.workspaceId },
        subject: { userId: user.id, handle: user.handle },
      };
    } catch (error) {
      const authClass = authErrorCode(error) ?? "PAIRING_REDEEM_FAILED";
      console.warn(
        `[auth] device pairing redemption failed: ${authClass}` +
          (ctx.clientLabel ? ` label=${ctx.clientLabel}` : "") +
          (ctx.clientPlatform ? ` platform=${ctx.clientPlatform}` : "")
      );
      return null;
    }
  };
}

/** Workspace ingress: already-issued devices and workspace-scoped agents only. */
export function createWorkspaceCredentialRedeemer(deps: WorkspaceCredentialRedeemerDeps) {
  return async (token: string) => {
    if (token.startsWith(REFRESH_PREFIX)) return redeemReturningDevice(deps, token);
    if (token.startsWith(AGENT_PREFIX)) return redeemAgentCredential(deps, token);
    return null;
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
  if (!AGENT_ID_PATTERN.test(agentId) || !AGENT_SECRET_PATTERN.test(secret)) return null;
  return { agentId, secret };
}

// =============================================================================
// User bootstrap / invite / self-pair (WP0 §4)
//
// Hub-side identity operations. The hub is the sole identity writer, so these
// take a read-write `UserStore`/`MembershipStore`. Caller-ROLE gates
// (`inviteUser` is root/admin-only, `pairDevice` is any member for their own
// devices) are applied by the caller/WP9 against `subject.role`; these
// functions implement the OPERATION only. WP1 wires them onto the hub's auth
// surface (RPC method + startup bootstrap print).
// =============================================================================

/**
 * Synthetic owner used by in-process/bootstrap entities with no human account.
 * Agent redemption derives this from the live entity like any other owner.
 */
const SYSTEM_USER_ID = "system";

/**
 * The runtime deputy entity kinds retired on user revocation (WP9 §6.5 step 4).
 * A revoked user's agent/worker/DO deputies keep ACTING autonomously; panels
 * (UI surfaces) are excluded — a revoked user's panel TREES are ARCHIVED (soft-
 * closed, recoverable by root) per §6.5 step 5, not torn down here. `session`
 * covers inert agent-session entities that carry agent credentials.
 */
const REVOCABLE_DEPUTY_KINDS: ReadonlySet<EntityRecord["kind"]> = new Set([
  "worker",
  "do",
  "session",
]);

/**
 * WP9 §6.5 step 4 — retire a revoked user's running deputies.
 *
 * Agents/workers/DOs a user spawned inherit their `userId` (WP0 §6) and would
 * otherwise keep acting "as" the now-revoked human. This retires every ACTIVE
 * deputy entity owned by `userId` through the runtime's existing retire path,
 * which already revokes the entity's agent credentials
 * (`deviceAuthStore.revokeAgentCredentialsForEntity`) and its live
 * `agent:<entityId>` token — so no deputy can re-authenticate or keep
 * approving/committing on a revoked account.
 *
 * Runs in the OWNING workspace child (which holds the entity store + runtime).
 * The hub's identity teardown (`UserStore.revokeUser`) — account/device/
 * membership state — is a SEPARATE step; the revoke flow drives this per
 * workspace child after the account is flagged revoked. See the followups for
 * the one-line `revokeUser` wiring seam (index.ts / hub own that trigger).
 */
export async function retireRevokedUserDeputies(
  deps: {
    /** Snapshot of live runtime entities (e.g. the entity store's `listActive`). */
    listActiveEntities: () => Promise<EntityRecord[]> | EntityRecord[];
    /** Administrative retire of ONE entity by id (the runtime retire path). */
    retireEntity: (id: string) => Promise<void>;
  },
  userId: string
): Promise<{ retired: string[] }> {
  // The synthetic `system` subject is not a revocable human — never sweep it.
  if (!userId || userId === SYSTEM_USER_ID) return { retired: [] };
  const active = await deps.listActiveEntities();
  const deputies = active.filter(
    (entity) =>
      entity.ownerUserId === userId &&
      entity.status === "active" &&
      REVOCABLE_DEPUTY_KINDS.has(entity.kind)
  );
  const retired: string[] = [];
  for (const entity of deputies) {
    await deps.retireEntity(entity.id);
    retired.push(entity.id);
  }
  return { retired };
}

export function createAuthService(deps: {
  tokenManager: TokenManager;
  deviceAuthStore: DeviceAuthStore;
  /** Read-only live-role lookup. Omission denies role-gated operations. */
  roleOf?: (userId: string) => "root" | "admin" | "member" | null;
  /** All agent-credential mutations cross the child→hub capability channel. */
  agentCredentialWriter?: {
    mint(input: {
      entityId: string;
      ttlMs?: number;
    }): Promise<{ agentId: string; agentToken: string }>;
    revoke(agentId: string): Promise<boolean>;
  };
  getServerBootId: () => string;
  getWorkspaceId: () => string;
  getConnectionInfo: () => AuthConnectionInfo;
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
    createCapabilityAuthorizer({
      hasAppCapability: deps.hasAppCapability,
      // WP9 §3: resolve the caller's LIVE role from the hub-owned identity DB so
      // `isRootOrAdmin` reflects promotions/demotions immediately (never a value
      // frozen onto the connection). Both hub and child hold a read handle;
      // undefined where no identity store is wired, in which case role gates
      // deny (no role can be affirmed).
      roleOf: deps.roleOf,
    });

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
    if (!bindingForLiveAgentEntity(record, "credential-check")) {
      throw new Error(`auth.${methodName} target session has no exact live agent binding`);
    }
    if (!ownerForLiveAgentEntity(record)) {
      throw new Error(`auth.${methodName} target session has no owner`);
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

  const definition: ServiceDefinition = {
    name: "auth",
    description: "Gateway authentication bootstrap routes",
    policy: { allowed: ["server", "shell"] },
    methods: authMethods,
    handler: defineServiceHandler("auth", authMethods, {
      grantConnection: (ctx, [principalId]) => {
        capabilityAuthorizer.require(ctx.caller, "panel-hosting");
        if (!deps.connectionGrants) throw new Error("Connection grants are not configured");
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
      },
      getConnectionInfo: (ctx) => ({
        ...connectionInfoResponse(deps),
        callerKind: ctx.caller.runtime.kind,
        ...(ctx.caller.agentBinding ? { agentBinding: ctx.caller.agentBinding } : {}),
      }),
      mintAgentCredential: async (ctx, [input]) => {
        if (!deps.agentCredentialWriter) throw new Error("Hub identity writer is not configured");
        const record = await resolveAgentCredentialTarget("mintAgentCredential", input.entityId);
        if (ctx.caller.runtime.kind !== "server") {
          assertAgentCredentialOwner("mintAgentCredential", ctx.caller.runtime.id, record);
        }
        const issued = await deps.agentCredentialWriter.mint(input);
        // A rotated entity credential gets a fresh ephemeral bearer as well.
        deps.tokenManager.revokeToken(agentCallerId(record.id));
        return issued;
      },
      revokeAgentCredential: async (ctx, [agentId]) => {
        if (!deps.agentCredentialWriter) throw new Error("Hub identity writer is not configured");
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
        const revoked = await deps.agentCredentialWriter.revoke(agentId);
        if (revoked) deps.tokenManager.revokeToken(agentCallerId(existing.entityId));
        return { revoked };
      },
    }),
  };

  const routes: ServiceRouteDecl[] = [
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
          sendJson(
            res,
            200,
            RefreshShellResponseSchema.parse({
              shellToken,
              callerId: shellCallerId(body.deviceId),
              deviceId: body.deviceId,
              label: device.label,
              serverId: deps.deviceAuthStore.getServerId(),
              serverBootId: deps.getServerBootId(),
              workspaceId: deps.getWorkspaceId(),
            })
          );
        } catch (error) {
          sendAuthError(res, error, 400);
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
          const authenticated = parsed
            ? deps.deviceAuthStore.validateAgentToken(parsed.agentId, parsed.secret)
            : null;
          const entity = authenticated
            ? await deps.resolveRuntimeEntity?.(authenticated.entityId)
            : null;
          const agentBinding = authenticated
            ? bindingForLiveAgentEntity(entity ?? null, authenticated.agentId)
            : null;
          if (!authenticated || !agentBinding || !ownerForLiveAgentEntity(entity ?? null)) {
            sendJson(res, 401, {
              error: "Invalid or expired agent credential",
              code: "INVALID_AGENT_CREDENTIAL",
            });
            return;
          }
          const callerId = agentCallerId(authenticated.entityId);
          const token = deps.tokenManager.ensureToken(callerId, "agent", { agentBinding });
          sendJson(
            res,
            200,
            RefreshAgentResponseSchema.parse({
              token,
              callerId,
              callerKind: "agent",
              entityId: agentBinding.entityId,
              contextId: agentBinding.contextId,
              channelId: agentBinding.channelId,
              agentId: agentBinding.agentId,
              serverId: deps.deviceAuthStore.getServerId(),
              serverBootId: deps.getServerBootId(),
              workspaceId: deps.getWorkspaceId(),
            })
          );
        } catch (error) {
          sendAuthError(res, error, 400);
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
          sendAuthError(res, error, 400);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/mobile-app-bootstrap",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        const startedAt = Date.now();
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
            console.info(
              `[mobile-bootstrap] not ready elapsedMs=${Date.now() - startedAt} reason=${JSON.stringify(readiness.reason ?? "unavailable")}`
            );
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
            console.info(`[mobile-bootstrap] no bootstrap elapsedMs=${Date.now() - startedAt}`);
            sendJson(res, 404, {
              error: "No approved React Native workspace app is available",
              code: "MOBILE_APP_UNAVAILABLE",
            });
            return;
          }
          const bootstrapBuildKey =
            typeof bootstrap === "object" && "buildKey" in bootstrap
              ? String(bootstrap.buildKey)
              : "unknown";
          console.info(
            `[mobile-bootstrap] ready elapsedMs=${Date.now() - startedAt} build=${bootstrapBuildKey}`
          );
          sendJson(res, 200, {
            serverId: deps.deviceAuthStore.getServerId(),
            serverBootId: deps.getServerBootId(),
            workspaceId: deps.getWorkspaceId(),
            bootstrap,
          });
        } catch (error) {
          console.error(
            `[mobile-bootstrap] failed elapsedMs=${Date.now() - startedAt}: ${error instanceof Error ? error.message : String(error)}`
          );
          sendAuthError(res, error, 401);
        }
      },
    },
  ];

  return { definition, routes };
}
