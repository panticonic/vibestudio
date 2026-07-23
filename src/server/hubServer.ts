import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { z } from "zod";
import {
  createAndRegisterWorkspace,
  deleteAndUnregisterWorkspace,
  deleteUnregisteredWorkspace,
  getCentralConfigPaths,
  recoverStagedWorkspaceDeletions,
} from "@vibestudio/workspace/loader";
import { EPHEMERAL_DEV_WORKSPACE_NAME } from "@vibestudio/workspace-contracts/ephemeral";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { getWorkspaceDir } from "@vibestudio/env-paths";
import { TokenManager, type TokenEntry } from "@vibestudio/shared/tokenManager";
import {
  DEVICE_ID_PATTERN,
  DEVICE_REFRESH_TOKEN_PATTERN,
  SERVER_BOOT_ID_PATTERN,
  SERVER_ID_PATTERN,
} from "@vibestudio/shared/deviceCredentials";
import { resolveHostConfig } from "@vibestudio/shared/hostConfig";
import {
  createConnectDeepLink,
  createConnectPairUrl,
  PAIRING_CODE_PATTERN,
  PAIRING_PROTOCOL_VERSION,
  selectedWorkspaceUrl,
  WORKSPACE_ROUTE_PREFIX,
  type ConnectPairing,
} from "@vibestudio/shared/connect";
import {
  hubControlMethods,
  HubReadyPayloadSchema,
  type HubPairingInvite,
  type HubReadyPayload,
} from "@vibestudio/service-schemas/hubControl";
import {
  getAdminTokenPath,
  loadPersistedAdminToken,
  savePersistedAdminToken,
} from "@vibestudio/shared/centralAuth";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { MembershipStore } from "@vibestudio/identity/membership";
import { type User, type UserRole } from "@vibestudio/identity/types";
import {
  RevokedUserCleanupResultSchema,
  type RevokedUserCleanupResult,
} from "@vibestudio/identity/revocationCleanup";
import { GovernanceLog } from "@vibestudio/shared/governance/governanceLog";
import { type MembershipGovernanceRecord } from "@vibestudio/shared/governance/types";
import {
  DEFAULT_PAIRING_CODE_TTL_MS,
  DeviceAuthStore,
  hashSecret,
  type PairedDeviceCredential,
} from "./hostCore/deviceAuthStore.js";
import { updateAccountProfile } from "./hostCore/accountProfile.js";
import {
  WorkspaceChildAgentCredentialMintInputSchema,
  WorkspaceChildAgentCredentialRevokeEntityInputSchema,
  WorkspaceChildAgentCredentialRevokeInputSchema,
  WorkspaceChildDeviceTouchInputSchema,
  WorkspaceChildGovernanceAppendInputSchema,
  WorkspaceChildGovernanceQueryInputSchema,
  WorkspaceChildPresenceReportInputSchema,
} from "./workspaceChildHubPort.js";
import { shellCallerId } from "./hostCore/auth/model.js";
import { authError, authErrorStatus } from "./hostCore/auth/errors.js";
import { bridgeDuplexSockets } from "./socketBridge.js";
import {
  RoutedRoomStore,
  routedRoomStatePath,
  workspaceReachPaths,
} from "./hostCore/routedRoomStore.js";
import { writeFileAtomicSync } from "../atomicFile.js";
import { ServiceDispatcher, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { EventService } from "@vibestudio/shared/eventsService";
import { authorizeVerifiedCaller } from "./services/authorityRuntime.js";
import { defineServiceHandler, mapServiceHandlers } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";

declare const __filename: string;

const HUB_PROCESS_LEASE_TTL_MS = 30_000;
const HUB_PROCESS_LEASE_HEARTBEAT_MS = 5_000;

export interface HubServerArgs {
  appRoot?: string;
  bootstrapWorkspace?: string;
  logLevel?: string;
  readyFile?: string;
  ephemeral?: boolean;
  servePanels?: boolean;
  gatewayPort?: number;
  host?: string;
  bindHost?: string;
  requireMobileReady?: boolean;
  requireElectronReady?: boolean;
  headlessHostAutospawn?: boolean;
}

export interface WorkspaceRuntime {
  name: string;
  advertisedName: string;
  /** Opaque stable registry id (`ws_<rand>`, WP2) — membership rows key on this. */
  workspaceId: string;
  port: number;
  publicUrl: string;
  child: ChildProcess;
  ready: Record<string, unknown>;
  /** Per-process runtime token for the child's exact typed hub ports. */
  runtimeToken: string;
}

interface HubWorkspacePresenceSnapshot {
  serverBootId: string;
  revision: number;
  users: Map<string, number>;
}

interface PendingWorkspaceRuntime {
  promise: Promise<WorkspaceRuntime>;
  child?: ChildProcess;
}

export interface HubRuntimeState {
  appRoot: string;
  args: HubServerArgs;
  centralData: CentralDataManager;
  deviceAuthStore: DeviceAuthStore;
  /** Hub-owned identity DB, opened READ-WRITE — the hub is the sole writer (WP0 §2). */
  identityDb: IdentityDb;
  userStore: UserStore;
  membershipStore: MembershipStore;
  /**
   * Host governance log (WP5 §5.1): the hub appends one
   * `MembershipGovernanceRecord` per role-gated admin op (invite/revoke/
   * add-member/remove-member/role-change) — it is the process that holds the
   * verified acting subject. Optional so tests can run without a log dir.
   */
  governanceLog?: GovernanceLog;
  tokenManager: TokenManager;
  serverBootId: string;
  adminToken: string;
  tokenSource: "env" | "persisted" | "generated";
  version: string;
  gatewayPort: number;
  protocol: "http" | "https";
  externalHost: string;
  bindHost: string;
  connectUrl: string;
  /** Absolute path to `identity.db`; handed to children as a READ-ONLY handle. */
  identityDbPath: string;
  /** Exact child-runtime identities mapped to the workspace they represent. */
  workspaceChildTokens: Map<string, string>;
  /** Freshly registered workspaces whose first startup units may self-approve. */
  autoApproveStartupWorkspaceIds?: Set<string>;
  /** Latest live-session projection reported by each workspace child (WP8 §4.4). */
  workspacePresence: Map<string, HubWorkspacePresenceSnapshot>;
  runtimes: Map<string, WorkspaceRuntime | PendingWorkspaceRuntime>;
  /** Stable machine-level control/pairing ingress; never owned by a workspace child. */
  controlTransport?: HubControlTransport;
  shuttingDown: boolean;
}

interface HubControlTransport {
  ingress: import("./webrtcIngress.js").WebRtcIngress;
  pairing: Omit<ConnectPairing, "code" | "room">;
  rpcServer: import("./rpcServer.js").RpcServer;
  grantStore: import("./services/capabilityGrantStore.js").CapabilityGrantStore;
  inviteExpiryTimers: Map<string, NodeJS.Timeout>;
}

const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const HubPairingCredentialBodySchema = z
  .object({
    code: z.string().regex(PAIRING_CODE_PATTERN, "Invalid pairing code format"),
    label: z.string().trim().min(1).max(128).optional(),
    platform: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const HubCompletePairingBodySchema = HubPairingCredentialBodySchema;

export const HubDeviceCredentialBodySchema = z
  .object({
    deviceId: z.string().regex(DEVICE_ID_PATTERN, "Invalid device id format"),
    refreshToken: z.string().regex(DEVICE_REFRESH_TOKEN_PATTERN, "Invalid refresh token format"),
  })
  .strict();

const WorkspaceChildReadySchema = z
  .object({
    workspaceName: z.string().regex(WORKSPACE_NAME_RE),
    workspaceId: z.string().min(1),
    workspaceDir: z.string().min(1),
    isEphemeral: z.boolean(),
    gatewayUrl: z.string().url(),
    rpcUrl: z.string().url(),
    workerdUrl: z.string().url(),
    adminToken: z.string().min(1),
    pairing: z
      .object({
        fp: z.string().min(1),
        sig: z.string().min(1),
        v: z.literal(PAIRING_PROTOCOL_VERSION),
        ice: z.enum(["all", "relay"]),
      })
      .strict(),
    serverId: z.string().regex(SERVER_ID_PATTERN),
    serverBootId: z.string().regex(SERVER_BOOT_ID_PATTERN),
    tokenFilePath: z.string().min(1),
    gatewayPort: z.number().int().min(1).max(65_535),
    workerdPort: z.number().int().min(0).max(65_535),
    pid: z.number().int().positive(),
    version: z.string().min(1),
  })
  .strict();

function parseEnvPort(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res: http.ServerResponse, status: number, payload: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  // Hub RPC carries inline avatars up to 256 KiB; keep bounded headroom for the
  // envelope while preventing unbounded buffering on public routes.
  const body = await readBody(req, 512 * 1024);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function remoteErrorPayload(error: unknown): { error: string; code?: string } {
  const record = asRecord(error);
  const code = typeof record?.["code"] === "string" ? record["code"] : undefined;
  return {
    error: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  };
}

function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

/**
 * Hub-side acting-user subject (WP2 §3) — `UserSubject` plus the host-resolved
 * role for the management gates, and the authenticated device (when the caller
 * is a device-backed shell) so routing can hand back its signaling room.
 */
export interface HubSubject {
  userId: string;
  handle: string;
  role: UserRole;
  /** Present when the caller authenticated as a device (`shell:<deviceId>`). */
  deviceId?: string;
}

/**
 * The local operator's viewer for hub-internal surfaces that have no acting
 * user (startup ready file). It SEES like
 * root but is not a user identity — every human-facing RPC resolves a real
 * subject via `hubSubjectFor` instead (the admin machine token was retired as
 * a human root, WP1 / plan §2.2).
 */
const LOCAL_OPERATOR_VIEW: HubSubject = { userId: "", handle: "local-operator", role: "root" };

const SHELL_CALLER_PREFIX = "shell:";

/**
 * Resolve the acting user from an authenticated hub caller (WP2 §3) — the hub
 * counterpart to the child's `UserSubjectSource`. Only device-backed shell
 * callers map to a human via the device→user FK in the shared identity DB;
 * anything else (including the machine admin token) is not a user identity.
 */
function hubSubjectFor(state: HubRuntimeState, caller: TokenEntry): HubSubject {
  if (caller.callerKind === "shell" && caller.callerId.startsWith(SHELL_CALLER_PREFIX)) {
    const deviceId = caller.callerId.slice(SHELL_CALLER_PREFIX.length);
    const userId = state.deviceAuthStore.userFor(deviceId);
    const user = userId ? state.userStore.getUser(userId) : null;
    if (user && user.revokedAt === undefined) {
      return { userId: user.id, handle: user.handle, role: user.role, deviceId };
    }
  }
  throw authError("EACCES", "Caller is not a recognized user", 403);
}

/** Management gate (WP2 §3): passes for `root`/`admin`, rejects `member`. */
function requireRole(subject: HubSubject, role: "admin"): HubSubject {
  if (subject.role === "root" || subject.role === role) return subject;
  throw authError("EACCES", `Requires the ${role} role`, 403);
}

/** Display name → opaque stable workspaceId via the registry (WP2 §4). */
function requireWorkspaceId(state: HubRuntimeState, name: string): string {
  const workspaceId = state.centralData.getWorkspaceIdByName(name);
  if (!workspaceId) throw new Error(`Unknown workspace "${name}"`);
  return workspaceId;
}

function requireWorkspaceName(state: HubRuntimeState, workspaceId: string): string {
  const entry = state.centralData
    .listWorkspaces()
    .find((workspace) => workspace.workspaceId === workspaceId);
  if (!entry) throw new Error(`Unknown workspace id "${workspaceId}"`);
  return entry.name;
}

/**
 * Hub-side membership pre-filter (WP2 §4) — a UX short-circuit so a non-member
 * never spawns a child; the AUTHORITATIVE gate is the child's `has()` check on
 * connect. Root is implicitly a member of everything; a workspace the registry
 * does not know yet (first `--init` spawn, the ephemeral `dev` alias) can have
 * no membership rows, so it is reachable only by root.
 */
function assertMember(state: HubRuntimeState, subject: HubSubject, workspaceName: string): void {
  const workspaceId = requireWorkspaceId(state, workspaceName);
  if (subject.role === "root") return;
  if (state.membershipStore.has(subject.userId, workspaceId)) return;
  throw authError("EACCES", `Not a member of workspace "${workspaceName}"`, 403);
}

/** Resolve a management-target user by `userId` or `handle` (live users only). */
function requireTargetUser(
  state: HubRuntimeState,
  ref: { userId?: unknown; handle?: unknown }
): User {
  const user = findTargetUser(state, ref);
  if (!user || user.revokedAt !== undefined) {
    throw new Error("Unknown user — pass { userId } or { handle } of a live user");
  }
  return user;
}

function findTargetUser(
  state: HubRuntimeState,
  ref: { userId?: unknown; handle?: unknown }
): User | null {
  return typeof ref.userId === "string" && ref.userId
    ? state.userStore.getUser(ref.userId)
    : typeof ref.handle === "string" && ref.handle
      ? state.userStore.getByHandle(ref.handle)
      : null;
}

/**
 * Append a WP5 `MembershipGovernanceRecord` for a role-gated hub admin op
 * (WP9 §6). The append is part of the acknowledged operation: callers await it
 * and either compensate a reversible identity mutation or surface a retryable
 * error. Governance writes are never detached background work.
 */
async function recordMembershipOp(state: HubRuntimeState, input: MembershipOpInput): Promise<void> {
  await state.governanceLog?.append(membershipGovernanceRecord(input));
}

interface MembershipOpInput {
  op: MembershipGovernanceRecord["op"];
  actor: HubSubject;
  target: { userId: string; handle?: string };
  workspaceId?: string;
  role?: UserRole;
}

function membershipGovernanceRecord(input: MembershipOpInput): MembershipGovernanceRecord {
  const record: MembershipGovernanceRecord = {
    kind: "membership",
    op: input.op,
    actor: {
      userId: input.actor.userId,
      handle: input.actor.handle,
      ...(input.actor.deviceId !== undefined ? { deviceId: input.actor.deviceId } : {}),
    },
    target: input.target,
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    at: Date.now(),
  };
  return record;
}

async function recordMembershipOps(
  state: HubRuntimeState,
  inputs: readonly MembershipOpInput[]
): Promise<void> {
  await state.governanceLog?.appendMany(inputs.map(membershipGovernanceRecord));
}

async function ensureRevocationGovernance(
  state: HubRuntimeState,
  input: Omit<MembershipOpInput, "op">
): Promise<void> {
  if (!state.governanceLog) return;
  if (await state.governanceLog.hasMembershipOperation("revoke-user", input.target.userId)) {
    return;
  }
  await recordMembershipOp(state, { ...input, op: "revoke-user" });
}

async function cleanupRevokedUserInRuntime(
  runtime: WorkspaceRuntime,
  userId: string,
  fetchImpl: typeof fetch = fetch
): Promise<RevokedUserCleanupResult> {
  if (runtime.child.exitCode !== null) {
    throw new Error(`Workspace "${runtime.advertisedName}" exited before revocation cleanup`);
  }
  const adminToken =
    typeof runtime.ready["adminToken"] === "string" ? runtime.ready["adminToken"] : null;
  if (!adminToken) throw new Error(`Workspace "${runtime.advertisedName}" has no admin token`);
  const response = await fetchImpl(
    `http://127.0.0.1:${runtime.port}/_r/s/revocation/cleanup-user`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userId }),
    }
  );
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      typeof (payload as Record<string, unknown>)["error"] === "string"
        ? String((payload as Record<string, unknown>)["error"])
        : `HTTP ${response.status}`;
    throw new Error(`Workspace "${runtime.advertisedName}" cleanup failed: ${message}`);
  }
  return RevokedUserCleanupResultSchema.parse(payload);
}

async function processUserRevocationCleanup(
  state: HubRuntimeState,
  userId: string,
  teardownLastWorkspaceId?: string
): Promise<RevokedUserCleanupResult[]> {
  const completed: RevokedUserCleanupResult[] = [];
  const failures: string[] = [];
  const workspaces = state.centralData.listWorkspaces();
  const tasks = state.identityDb
    .listUserRevocationCleanup(userId)
    .sort((a, b) =>
      a.workspaceId === teardownLastWorkspaceId
        ? 1
        : b.workspaceId === teardownLastWorkspaceId
          ? -1
          : a.workspaceId.localeCompare(b.workspaceId)
    );
  for (const task of tasks) {
    const workspace = workspaces.find((entry) => entry.workspaceId === task.workspaceId);
    if (!workspace) {
      state.identityDb.completeUserRevocationCleanup(userId, task.workspaceId);
      continue;
    }
    try {
      const runtime = await ensureWorkspaceRuntime(state, workspace.name);
      const result = await cleanupRevokedUserInRuntime(runtime, userId);
      state.identityDb.completeUserRevocationCleanup(userId, task.workspaceId);
      completed.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.identityDb.failUserRevocationCleanup(userId, task.workspaceId, message);
      failures.push(`${workspace.name}: ${message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Revocation cleanup is pending: ${failures.join("; ")}`);
  }
  return completed;
}

async function closeDeviceSessionsAcrossChildren(
  state: HubRuntimeState,
  deviceId: string,
  teardownLastWorkspaceId?: string,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  let closed = 0;
  const runtimes = [...state.runtimes.values()]
    .filter((entry): entry is WorkspaceRuntime => !("promise" in entry))
    .sort((a, b) =>
      a.workspaceId === teardownLastWorkspaceId
        ? 1
        : b.workspaceId === teardownLastWorkspaceId
          ? -1
          : a.workspaceId.localeCompare(b.workspaceId)
    );
  for (const entry of runtimes) {
    if (entry.child.exitCode !== null) continue;
    const adminToken =
      typeof entry.ready["adminToken"] === "string" ? entry.ready["adminToken"] : null;
    if (!adminToken) continue;
    try {
      const response = await fetchImpl(
        `http://127.0.0.1:${entry.port}/_r/s/sessions/close-device`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ deviceId }),
        }
      );
      if (!response.ok) continue;
      const payload = (await response.json()) as Record<string, unknown>;
      if (typeof payload["closed"] === "number") closed += payload["closed"];
    } catch (error) {
      console.warn(
        `[Hub] closing device sessions in workspace "${entry.advertisedName}" failed:`,
        error
      );
    }
  }
  return closed;
}

async function closeUserSessionsInRuntime(
  runtime: WorkspaceRuntime,
  userId: string,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  if (runtime.child.exitCode !== null) return 0;
  const adminToken =
    typeof runtime.ready["adminToken"] === "string" ? runtime.ready["adminToken"] : null;
  if (!adminToken) return 0;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/_r/s/sessions/close-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ userId }),
    });
    if (!response.ok) return 0;
    const payload = (await response.json()) as Record<string, unknown>;
    return typeof payload["closed"] === "number" ? payload["closed"] : 0;
  } catch {
    return 0;
  }
}

/**
 * Authenticate a device credential presented in a request body and resolve its
 * owning user — the HTTP-route counterpart of `hubSubjectFor` (WP2 §4).
 */
function subjectForDeviceCredential(
  state: HubRuntimeState,
  payload: { deviceId: string; refreshToken: string }
): HubSubject {
  const deviceId = payload["deviceId"];
  const refreshToken = payload["refreshToken"];
  state.deviceAuthStore.validateRefresh(deviceId, refreshToken);
  const userId = state.deviceAuthStore.userFor(deviceId);
  const user = userId ? state.userStore.getUser(userId) : null;
  if (!user || user.revokedAt !== undefined) {
    throw authError("EACCES", "Device is not bound to a recognized user", 403);
  }
  return { userId: user.id, handle: user.handle, role: user.role, deviceId };
}

function responseForCredential(
  state: HubRuntimeState,
  credential: PairedDeviceCredential
): Record<string, unknown> {
  return {
    deviceId: credential.deviceId,
    refreshToken: credential.refreshToken,
    userId: credential.userId,
    label: credential.label,
    ...(credential.platform ? { platform: credential.platform } : {}),
    shellToken: state.tokenManager.ensureToken(shellCallerId(credential.deviceId), "shell"),
    callerId: shellCallerId(credential.deviceId),
    serverId: state.deviceAuthStore.getServerId(),
    serverBootId: state.serverBootId,
    workspaceId: credential.workspaceId,
  };
}

/**
 * Membership-filtered workspace listing (WP2 §4): root sees the full registry,
 * everyone else only the workspaces they hold a membership row for. This is a
 * UX filter — the authoritative entry gate is the child's `has()` on connect.
 */
function listHubWorkspaces(
  state: HubRuntimeState,
  viewer: HubSubject
): Array<Record<string, unknown>> {
  const registered = state.centralData.listWorkspaces();
  const visible =
    viewer.role === "root"
      ? registered
      : registered.filter((entry) => state.membershipStore.has(viewer.userId, entry.workspaceId));
  const entries: Array<Record<string, unknown>> = visible.map((entry) => ({
    name: entry.name,
    workspaceId: entry.workspaceId,
    lastOpened: entry.lastOpened,
    running: isRuntimeRunning(state, entry.name),
    ...(isWorkspaceEphemeral(state, entry.name) ? { ephemeral: true } : {}),
  }));
  return entries;
}

function hubUserPresence(
  state: HubRuntimeState,
  viewer: HubSubject,
  user: User
): Record<string, unknown> {
  const visible = new Map(
    listHubWorkspaces(state, viewer).map((entry) => [String(entry["workspaceId"]), entry])
  );
  const workspaces: Array<{ workspace: string; workspaceId: string; endpoints: number }> = [];
  for (const [workspaceId, snapshot] of state.workspacePresence) {
    const entry = visible.get(workspaceId);
    const endpoints = snapshot.users.get(user.id);
    if (!entry || endpoints === undefined) continue;
    workspaces.push({
      workspace: String(entry["name"]),
      workspaceId,
      endpoints,
    });
  }
  workspaces.sort((a, b) => a.workspace.localeCompare(b.workspace));
  return {
    userId: user.id,
    handle: user.handle,
    displayName: user.displayName,
    workspaces,
  };
}

export function applyHubWorkspacePresenceReport(
  state: HubRuntimeState,
  workspaceId: string,
  rawReport: unknown
): boolean {
  const report = WorkspaceChildPresenceReportInputSchema.parse(rawReport);
  const previous = state.workspacePresence.get(workspaceId);
  if (previous?.serverBootId === report.serverBootId && report.revision <= previous.revision) {
    return false;
  }
  const users = new Map<string, number>();
  for (const entry of report.users) {
    const user = state.userStore.getUser(entry.userId);
    if (
      user &&
      user.revokedAt === undefined &&
      (user.role === "root" || state.membershipStore.has(entry.userId, workspaceId))
    ) {
      users.set(entry.userId, entry.endpoints);
    }
  }
  state.workspacePresence.set(workspaceId, {
    serverBootId: report.serverBootId,
    revision: report.revision,
    users,
  });
  return true;
}

/** Canonical, secret-free process handoff consumed by desktop and scripts. */
export function buildHubReadyPayload(
  state: HubRuntimeState,
  rootInvite: HubReadyPayload["rootInvite"],
  pid = process.pid
): HubReadyPayload {
  return HubReadyPayloadSchema.parse({
    mode: "hub",
    gatewayUrl: `${state.protocol}://${state.externalHost}:${state.gatewayPort}`,
    rootInvite,
    serverId: state.deviceAuthStore.getServerId(),
    serverBootId: state.serverBootId,
    gatewayPort: state.gatewayPort,
    pid,
    version: state.version,
    workspaces: listHubWorkspaces(state, LOCAL_OPERATOR_VIEW),
  });
}

/**
 * Infer the single target workspace when an invite omits one — narrowed to the
 * VIEWER's visible set (WP2 §4) so an admin's invite never defaults to a
 * workspace they cannot see.
 */
function resolveInviteWorkspace(state: HubRuntimeState, viewer: HubSubject, raw: unknown): string {
  if (typeof raw === "string" && raw.trim()) return normalizeWorkspaceName(raw);
  const workspaces = listHubWorkspaces(state, viewer);
  const visibleNames = new Set(
    workspaces
      .map((entry) => entry["name"])
      .filter((name): name is string => typeof name === "string")
  );
  const runningWorkspaces = Array.from(state.runtimes.keys()).filter((name) =>
    visibleNames.has(name)
  );
  if (runningWorkspaces.length === 1) return normalizeWorkspaceName(runningWorkspaces[0]);
  if (workspaces.length === 1 && typeof workspaces[0]?.["name"] === "string") {
    return normalizeWorkspaceName(workspaces[0]["name"]);
  }
  throw new Error(
    workspaces.length === 0
      ? "No workspace is configured; pass { workspace } after creating one."
      : "Multiple workspaces are configured; pass { workspace } to mint a workspace-scoped WebRTC invite."
  );
}

function isRuntimeRunning(state: HubRuntimeState, name: string): boolean {
  const runtime = state.runtimes.get(name);
  return !!runtime && !("promise" in runtime) && runtime.child.exitCode === null;
}

function isWorkspaceEphemeral(state: HubRuntimeState, name: string): boolean {
  const ephemeral = state.centralData.getEphemeralWorkspace();
  return ephemeral?.ownerBootId === state.serverBootId && ephemeral.name === name;
}

function workspaceConfigExists(name: string): boolean {
  return fs.existsSync(path.join(getWorkspaceDir(name), "source", "meta/vibestudio.yml"));
}

function normalizeWorkspaceName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Workspace name is required");
  }
  const name = raw.trim();
  if (!WORKSPACE_NAME_RE.test(name)) {
    throw new Error("Workspace name must contain only letters, numbers, hyphens, and underscores");
  }
  return name;
}

export function selectBootstrapWorkspace(
  args: Pick<HubServerArgs, "bootstrapWorkspace" | "ephemeral">,
  registered: readonly { name: string }[]
): { name: string; lifecycle: "existing" | "register" | "ephemeral" } {
  if (args.ephemeral) {
    const name = normalizeWorkspaceName(args.bootstrapWorkspace ?? EPHEMERAL_DEV_WORKSPACE_NAME);
    if (name !== EPHEMERAL_DEV_WORKSPACE_NAME) {
      throw new Error("Ephemeral hubs use the canonical dev workspace");
    }
    return { name, lifecycle: "ephemeral" };
  }
  if (args.bootstrapWorkspace) {
    return { name: normalizeWorkspaceName(args.bootstrapWorkspace), lifecycle: "register" };
  }
  const existing = registered[0];
  if (existing) {
    return { name: normalizeWorkspaceName(existing.name), lifecycle: "existing" };
  }
  return { name: "default", lifecycle: "register" };
}

/**
 * Re-establish every independently durable workspace reach contract without
 * coupling hub availability to any one child. A failed child remains absent
 * from the runtime map and a later route request retries it with the original
 * concrete error, while the machine control plane and healthy workspaces can
 * finish starting.
 */
export async function restoreRoutedWorkspaceRuntimes(
  workspaces: readonly { name: string }[],
  start: (name: string) => Promise<unknown>,
  reportFailure: (name: string, error: unknown) => void = (name, error) => {
    console.error(
      `[Hub] Workspace "${name}" reach restoration failed; runtime is unavailable:`,
      error
    );
  }
): Promise<void> {
  await Promise.all(
    workspaces.map(async ({ name }) => {
      try {
        await start(name);
      } catch (error) {
        reportFailure(name, error);
      }
    })
  );
}

function workspaceEndpointUrl(state: HubRuntimeState, name: string): string {
  return selectedWorkspaceUrl(state.connectUrl, name).toString().replace(/\/$/, "");
}

function pairingTtl(raw: unknown): number {
  const ttlMs = raw === undefined ? DEFAULT_PAIRING_CODE_TTL_MS : raw;
  if (
    typeof ttlMs !== "number" ||
    !Number.isInteger(ttlMs) ||
    ttlMs < 30_000 ||
    ttlMs > DEFAULT_PAIRING_CODE_TTL_MS
  ) {
    throw new Error("ttlMs must be an integer from 30000 to 3600000");
  }
  return ttlMs;
}

interface ChildReach {
  room: string;
  fp: string;
  sig: string;
  v: typeof PAIRING_PROTOCOL_VERSION;
  ice: "all" | "relay";
}

function requireControlTransport(state: HubRuntimeState): HubControlTransport {
  if (!state.controlTransport) throw new Error("Hub control ingress is not ready");
  return state.controlTransport;
}

function reachFromControlTransport(transport: HubControlTransport, room: string): ChildReach {
  return { room, ...transport.pairing };
}

function clearControlInviteExpiry(transport: HubControlTransport, codeHash: string): void {
  const timer = transport.inviteExpiryTimers.get(codeHash);
  if (timer) clearTimeout(timer);
  transport.inviteExpiryTimers.delete(codeHash);
}

function scheduleControlInviteExpiry(
  state: HubRuntimeState,
  codeHash: string,
  expiresAt: number
): void {
  const transport = requireControlTransport(state);
  clearControlInviteExpiry(transport, codeHash);
  const expire = (): void => {
    transport.inviteExpiryTimers.delete(codeHash);
    for (const room of state.deviceAuthStore.cleanupControlRooms(Date.now())) {
      void transport.ingress.disarmRoom(room.room).catch((error) => {
        console.warn(`[Hub] Failed to disarm expired control room ${room.room}:`, error);
      });
    }
  };
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    expire();
    return;
  }
  const timer = setTimeout(expire, remainingMs);
  timer.unref();
  transport.inviteExpiryTimers.set(codeHash, timer);
}

async function armControlInvite(
  state: HubRuntimeState,
  invite: { code: string; room: string; expiresAt: number }
): Promise<ChildReach> {
  const transport = requireControlTransport(state);
  await transport.ingress.armRoom(invite.room, {});
  scheduleControlInviteExpiry(state, hashSecret(invite.code), invite.expiresAt);
  return reachFromControlTransport(transport, invite.room);
}

async function disarmControlInvite(state: HubRuntimeState, code: string): Promise<void> {
  const transport = requireControlTransport(state);
  const codeHash = hashSecret(code);
  clearControlInviteExpiry(transport, codeHash);
  const room = state.deviceAuthStore.cancelPairingInvite(code);
  if (room) await transport.ingress.disarmRoom(room.room);
}

/** Stop stable hub reach only after the revoked caller's final response drains. */
function retireDeviceControlReach(
  state: HubRuntimeState,
  deviceId: string,
  controlRoom: string | null
): void {
  const transport = state.controlTransport;
  if (!transport || !controlRoom) return;
  const retired = transport.rpcServer.retireCaller(shellCallerId(deviceId));
  void retired
    .then(() => transport.ingress.disarmRoom(controlRoom))
    .catch((error) => {
      console.warn(`[Hub] Failed to disarm revoked device control room ${controlRoom}:`, error);
    });
}

async function completeControlPairing(
  state: HubRuntimeState,
  code: string,
  input: { label?: string; platform?: string }
): Promise<PairedDeviceCredential> {
  const transport = requireControlTransport(state);
  const codeHash = hashSecret(code);
  const bootstrapRoot = !state.identityDb.hasUsers();
  const credential = state.deviceAuthStore.completePairing({
    code,
    ...(bootstrapRoot
      ? {
          createRootUser: () =>
            state.userStore.createRoot({ handle: "root", displayName: "Root" }).id,
        }
      : {}),
    label: input.label ?? "Vibestudio client",
    platform: input.platform,
  });
  clearControlInviteExpiry(transport, codeHash);
  await transport.ingress.armRoom(credential.controlRoom, { deviceId: credential.deviceId });
  return credential;
}

type ChildRouteRequest = { deviceId: string };

/** Ask a child to arm ingress only. No identity row is ever written there. */
async function armChildReach(
  runtime: Pick<WorkspaceRuntime, "port" | "ready" | "advertisedName">,
  input: ChildRouteRequest,
  fetchImpl: typeof fetch = fetch
): Promise<ChildReach> {
  const adminToken =
    typeof runtime.ready["adminToken"] === "string" ? runtime.ready["adminToken"] : null;
  if (!adminToken) throw new Error(`Workspace "${runtime.advertisedName}" has no control token`);
  const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/_r/s/internal/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof body["error"] === "string"
        ? body["error"]
        : `Workspace route failed with HTTP ${response.status}`
    );
  }
  if (
    typeof body["room"] !== "string" ||
    typeof body["fp"] !== "string" ||
    typeof body["sig"] !== "string" ||
    body["v"] !== PAIRING_PROTOCOL_VERSION ||
    (body["ice"] !== "all" && body["ice"] !== "relay")
  ) {
    throw new Error(`Workspace "${runtime.advertisedName}" returned invalid reach coordinates`);
  }
  return {
    room: body["room"],
    fp: body["fp"],
    sig: body["sig"],
    v: PAIRING_PROTOCOL_VERSION,
    ice: body["ice"],
  };
}

function pairingInviteFromReach(
  state: HubRuntimeState,
  code: string,
  expiresAt: number,
  reach: ChildReach
): HubPairingInvite {
  const pairing = { ...reach, code };
  return {
    ...pairing,
    deepLink: createConnectDeepLink(pairing),
    pairUrl: createConnectPairUrl(pairing),
    expiresInMs: Math.max(1, expiresAt - Date.now()),
    expiresAt,
    serverId: state.deviceAuthStore.getServerId(),
    serverBootId: state.serverBootId,
  };
}

function isRefreshShellPath(upstreamPath: string): boolean {
  return new URL(upstreamPath, "http://workspace.local").pathname === "/_r/s/auth/refresh-shell";
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) {
      throw authError("REQUEST_BODY_TOO_LARGE", "Request body too large", 413);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function handleAuthRoute(
  state: HubRuntimeState,
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    if (route === "complete-pairing") {
      const body = HubCompletePairingBodySchema.parse(await readJson(req));
      const credential = await completeControlPairing(state, body.code, body);
      sendJson(res, 200, responseForCredential(state, credential));
      return;
    }

    if (route === "refresh-shell") {
      const { deviceId, refreshToken } = HubDeviceCredentialBodySchema.parse(await readJson(req));
      const device = state.deviceAuthStore.validateRefresh(deviceId, refreshToken);
      sendJson(res, 200, {
        shellToken: state.tokenManager.ensureToken(shellCallerId(deviceId), "shell"),
        callerId: shellCallerId(deviceId),
        deviceId,
        label: device.label,
        serverId: state.deviceAuthStore.getServerId(),
        serverBootId: state.serverBootId,
        workspaceId: null,
      });
      return;
    }

    sendJson(res, 404, { error: "Unknown auth route", code: "NOT_FOUND" });
  } catch (error) {
    sendJson(res, authErrorStatus(error) ?? 400, remoteErrorPayload(error));
  }
}

async function handleInternalRoute(
  state: HubRuntimeState,
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    const token = bearerToken(req);
    const boundWorkspaceId = token ? state.workspaceChildTokens.get(token) : undefined;
    if (!boundWorkspaceId) {
      sendJson(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" });
      return;
    }
    const rawBody = await readJson(req);
    // A child can exit while a request body is being read. Re-check the scoped
    // runtime/process token so a delayed report from the retired process cannot
    // overwrite the replacement child's state.
    if (!token || state.workspaceChildTokens.get(token) !== boundWorkspaceId) {
      sendJson(res, 401, { error: "Workspace child runtime expired", code: "UNAUTHORIZED" });
      return;
    }
    if (route === "agent-credential/mint") {
      const body = WorkspaceChildAgentCredentialMintInputSchema.parse(rawBody);
      const result = state.deviceAuthStore.mintAgentCredential({
        entityId: body.entityId,
        ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
      });
      sendJson(res, 200, result);
      return;
    }
    if (route === "device/touch") {
      const body = WorkspaceChildDeviceTouchInputSchema.parse(rawBody);
      const device = state.identityDb.getDevice(body.deviceId);
      if (!device || device.revokedAt !== undefined) {
        throw authError("DEVICE_NOT_PAIRED", "Device is not paired", 401);
      }
      if (!state.membershipStore.has(device.userId, boundWorkspaceId)) {
        throw authError("EACCES", "Device owner is not a workspace member", 403);
      }
      state.identityDb.touchDevice(body.deviceId);
      sendJson(res, 200, { touched: true });
      return;
    }
    if (route === "presence/report") {
      const updated = applyHubWorkspacePresenceReport(state, boundWorkspaceId, rawBody);
      sendJson(res, 200, { updated });
      return;
    }
    if (route === "agent-credential/revoke") {
      const body = WorkspaceChildAgentCredentialRevokeInputSchema.parse(rawBody);
      sendJson(res, 200, { revoked: state.deviceAuthStore.revokeAgentCredential(body.agentId) });
      return;
    }
    if (route === "agent-credential/revoke-entity") {
      const body = WorkspaceChildAgentCredentialRevokeEntityInputSchema.parse(rawBody);
      sendJson(res, 200, {
        revokedAgentIds: state.deviceAuthStore.revokeAgentCredentialsForEntity(body.entityId),
      });
      return;
    }
    if (route === "governance/append-approval") {
      const body = WorkspaceChildGovernanceAppendInputSchema.parse(rawBody);
      if (!state.governanceLog) throw new Error("Governance log is unavailable");
      await state.governanceLog.append({
        ...body.record,
        workspaceId: boundWorkspaceId,
      });
      sendJson(res, 200, { appended: true });
      return;
    }
    if (route === "governance/query") {
      const body = WorkspaceChildGovernanceQueryInputSchema.parse(rawBody);
      const query = body.query ?? {};
      const requestedLimit = query.limit ?? 100;
      const records =
        (await state.governanceLog?.query({
          filter: {
            ...query.filter,
            workspaceId: boundWorkspaceId,
          },
          limit: Math.max(1, Math.min(500, Math.trunc(requestedLimit))),
          ...(query.after !== undefined ? { after: query.after } : {}),
        })) ?? [];
      sendJson(res, 200, { records });
      return;
    }
    sendJson(res, 404, { error: "Unknown internal route", code: "NOT_FOUND" });
  } catch (error) {
    sendJson(res, authErrorStatus(error) ?? 400, remoteErrorPayload(error));
  }
}

/** Revoke one user and every reach rooted in that identity. */
export async function revokeHubUser(
  state: HubRuntimeState,
  subject: HubSubject,
  input: { userId?: unknown; handle?: unknown }
): Promise<{
  revoked: boolean;
  userId: string;
  handle: string;
  closedSessions: number;
  cleanup: RevokedUserCleanupResult[];
}> {
  requireRole(subject, "admin");
  const target = findTargetUser(state, { userId: input.userId, handle: input.handle });
  if (!target) throw new Error("Unknown user — pass { userId } or { handle }");
  if (target.role === "root") state.userStore.revokeUser(target.id);

  const deviceIds = state.identityDb.listDevicesForUser(target.id).map((device) => device.deviceId);
  const controlRooms = new Map(
    deviceIds.map((deviceId) => [deviceId, state.deviceAuthStore.getDeviceControlRoom(deviceId)])
  );
  const workspaceIds = state.centralData.listWorkspaces().map((entry) => entry.workspaceId);
  const revoked = state.userStore.revokeUser(target.id, workspaceIds);
  for (const deviceId of deviceIds) {
    state.tokenManager.revokeToken(shellCallerId(deviceId));
    retireDeviceControlReach(state, deviceId, controlRooms.get(deviceId) ?? null);
  }
  await ensureRevocationGovernance(state, {
    actor: subject,
    target: { userId: target.id, handle: target.handle },
  });
  const cleanup = await processUserRevocationCleanup(state, target.id);
  return {
    revoked,
    userId: target.id,
    handle: target.handle,
    closedSessions: cleanup.reduce((sum, result) => sum + result.closedSessions, 0),
    cleanup,
  };
}

/** Revoke one device and retire its hub/workspace transport reach. */
export async function revokeHubDevice(
  state: HubRuntimeState,
  subject: HubSubject,
  deviceId: string
): Promise<{ revoked: boolean; closedSessions: number }> {
  const device = state.identityDb.getDevice(deviceId);
  if (!device) throw new Error("Unknown device");
  if (device.userId !== subject.userId) requireRole(subject, "admin");
  const controlRoom = state.deviceAuthStore.getDeviceControlRoom(deviceId);
  const revoked = state.deviceAuthStore.revokeDevice(deviceId);
  if (revoked) {
    state.tokenManager.revokeToken(shellCallerId(deviceId));
    retireDeviceControlReach(state, deviceId, controlRoom);
  }
  const closedSessions = revoked ? await closeDeviceSessionsAcrossChildren(state, deviceId) : 0;
  return { revoked, closedSessions };
}

/** One semantic hub-control dispatcher for the hub-owned RPC ingress. */
async function executeHubControl(
  state: HubRuntimeState,
  subject: HubSubject,
  method: string,
  args: unknown[],
  respond: (result: unknown) => void
): Promise<void> {
  if (state.shuttingDown) throw new Error("Hub is shutting down");

  if (method === "listWorkspaces") {
    respond(listHubWorkspaces(state, subject));
    return;
  }
  if (method === "listUserPresence") {
    const opts = asRecord(args[0]) ?? {};
    const target = requireTargetUser(state, {
      userId: opts["userId"],
      handle: opts["handle"],
    });
    respond(hubUserPresence(state, subject, target));
    return;
  }
  if (method === "routeWorkspace") {
    // WP1 §5 / WP2 §4: membership pre-filter, spawn/attach the child, and
    // return the coordinates for the client to reach the CHILD's ingress
    // directly — the hub never relays media/RPC (child owns its DTLS pipe).
    const opts = asRecord(args[0]) ?? {};
    const workspaceId = typeof opts["workspaceId"] === "string" ? opts["workspaceId"] : "";
    const name = requireWorkspaceName(state, workspaceId);
    assertMember(state, subject, name);
    const runtime = await ensureWorkspaceRuntime(state, name);
    if (!subject.deviceId) throw new Error("Workspace routing requires a paired device");
    const workspaceReach = await armChildReach(runtime, { deviceId: subject.deviceId });
    const childServerId = runtime.ready["serverId"];
    const childServerBootId = runtime.ready["serverBootId"];
    if (typeof childServerId !== "string" || typeof childServerBootId !== "string") {
      throw new Error(`Workspace "${name}" returned no canonical server identity`);
    }
    state.centralData.setLastWorkspaceForUser(subject.userId, name);
    respond({
      workspace: runtime.advertisedName,
      workspaceId: runtime.workspaceId,
      running: true,
      serverUrl: runtime.publicUrl,
      workspaceReach,
      serverId: childServerId,
      serverBootId: childServerBootId,
    });
    return;
  }
  if (method === "createWorkspace") {
    requireRole(subject, "admin");
    const opts = asRecord(args[0]) ?? {};
    const name = normalizeWorkspaceName(opts["workspace"]);
    const entry = createAndRegisterWorkspace(name, state.centralData, {
      ...(typeof opts["forkFrom"] === "string" ? { forkFrom: opts["forkFrom"] } : {}),
    });
    try {
      if (subject.role !== "root") {
        state.membershipStore.add(subject.userId, entry.workspaceId, subject.userId);
        await recordMembershipOp(state, {
          op: "add-member",
          actor: subject,
          target: { userId: subject.userId, handle: subject.handle },
          workspaceId: entry.workspaceId,
        });
      }
    } catch (error) {
      deleteAndUnregisterWorkspace(name, state.centralData);
      throw error;
    }
    respond({ ...entry, running: false });
    return;
  }
  if (method === "ensureEphemeralWorkspace") {
    requireRole(subject, "admin");
    const existing = state.centralData.getEphemeralWorkspace();
    if (existing) {
      if (
        existing.ownerBootId !== state.serverBootId ||
        existing.name !== EPHEMERAL_DEV_WORKSPACE_NAME
      ) {
        throw new Error("Another ephemeral workspace lifecycle is already registered");
      }
      respond({
        workspaceId: existing.workspaceId,
        name: existing.name,
        lastOpened: existing.lastOpened,
        running: isRuntimeRunning(state, existing.name),
        ephemeral: true,
      });
      return;
    }
    const entry = state.centralData.addEphemeralWorkspace(
      EPHEMERAL_DEV_WORKSPACE_NAME,
      state.serverBootId
    );
    respond({
      workspaceId: entry.workspaceId,
      name: entry.name,
      lastOpened: entry.lastOpened,
      running: false,
      ephemeral: true,
    });
    return;
  }
  if (method === "deleteWorkspace") {
    requireRole(subject, "admin");
    const opts = asRecord(args[0]) ?? {};
    const name = normalizeWorkspaceName(opts["workspace"]);
    const workspaceId = requireWorkspaceId(state, name);
    const active = state.runtimes.get(name);
    if (active) {
      const runtime = "promise" in active ? await active.promise : active;
      // Removing desired ownership before signaling makes the exit handler
      // recognize this as an intentional stop, never an availability fault.
      if (state.runtimes.get(name) === active || state.runtimes.get(name) === runtime) {
        state.runtimes.delete(name);
      }
      await terminateWorkspaceChild(runtime.child);
      state.workspacePresence.delete(workspaceId);
    }
    const removedWorkspaceId = isWorkspaceEphemeral(state, name)
      ? removeOwnedEphemeralWorkspace(state.centralData, state.serverBootId)
      : deleteAndUnregisterWorkspace(name, state.centralData);
    respond({ deleted: removedWorkspaceId !== null, workspaceId: removedWorkspaceId });
    return;
  }
  if (method === "addWorkspaceMember") {
    requireRole(subject, "admin");
    const opts = asRecord(args[0]) ?? {};
    const target = requireTargetUser(state, { userId: opts["userId"], handle: opts["handle"] });
    const name = normalizeWorkspaceName(opts["workspace"]);
    const workspaceId = requireWorkspaceId(state, name);
    const priorMembership = state.identityDb
      .listMembers(workspaceId)
      .find((existing) => existing.userId === target.id);
    const membership = state.membershipStore.add(target.id, workspaceId, subject.userId);
    try {
      await recordMembershipOp(state, {
        op: "add-member",
        actor: subject,
        target: { userId: target.id, handle: target.handle },
        workspaceId,
      });
    } catch (error) {
      // `add` is an upsert. Restore a previous row exactly rather than
      // deleting a membership that predated this failed governance write.
      // Use the DB directly for the new-row case so explicit root rows are
      // also compensated (MembershipStore.remove intentionally no-ops root).
      if (priorMembership) state.identityDb.addMembership(priorMembership);
      else state.identityDb.removeMembership(target.id, workspaceId);
      throw error;
    }
    respond({ ...membership, workspace: name, handle: target.handle });
    return;
  }
  if (method === "removeWorkspaceMember") {
    requireRole(subject, "admin");
    const opts = asRecord(args[0]) ?? {};
    const target = requireTargetUser(state, { userId: opts["userId"], handle: opts["handle"] });
    const name = normalizeWorkspaceName(opts["workspace"]);
    const workspaceId = requireWorkspaceId(state, name);
    const priorMembership = state.identityDb
      .listMembers(workspaceId)
      .find((membership) => membership.userId === target.id);
    const removed = state.membershipStore.remove(target.id, workspaceId);
    if (removed) {
      try {
        await recordMembershipOp(state, {
          op: "remove-member",
          actor: subject,
          target: { userId: target.id, handle: target.handle },
          workspaceId,
        });
      } catch (error) {
        if (priorMembership) state.identityDb.addMembership(priorMembership);
        throw error;
      }
    }
    const active = state.runtimes.get(name);
    const closedSessions =
      removed && active && !("promise" in active)
        ? await closeUserSessionsInRuntime(active, target.id)
        : 0;
    respond({ removed, closedSessions });
    return;
  }
  if (method === "listWorkspaceMembers") {
    requireRole(subject, "admin");
    const opts = asRecord(args[0]) ?? {};
    const name = normalizeWorkspaceName(opts["workspace"]);
    const workspaceId = requireWorkspaceId(state, name);
    const storedMembers = state.membershipStore.listMembers(workspaceId);
    const root = state.userStore
      .listUsers()
      .find((user) => user.role === "root" && user.revokedAt === undefined);
    const membershipRows =
      root && !storedMembers.some((row) => row.userId === root.id)
        ? [
            {
              userId: root.id,
              workspaceId,
              addedBy: root.id,
              addedAt: root.createdAt,
              implicit: true,
            },
            ...storedMembers,
          ]
        : storedMembers;
    const members = membershipRows.map((row) => {
      const user = state.userStore.getUser(row.userId);
      return {
        ...row,
        handle: user?.handle ?? null,
        displayName: user?.displayName ?? null,
        role: user?.role ?? null,
      };
    });
    respond({ workspace: name, workspaceId, members });
    return;
  }
  if (method === "inviteUser") {
    // WP1 §6: root/admin creates a NEW user; the pairing code is bound to
    // that user so the first device to redeem it is issued as them.
    requireRole(subject, "admin");
    const opts = asRecord(args[0]) ?? {};
    const handle = typeof opts["handle"] === "string" ? opts["handle"].trim() : "";
    if (!handle) throw new Error("hubControl.inviteUser requires { handle }");
    const displayName =
      typeof opts["displayName"] === "string" && opts["displayName"].trim()
        ? opts["displayName"].trim()
        : handle;
    const role = opts["role"] === "admin" ? "admin" : "member";
    const workspaceNames = Array.isArray(opts["workspaces"])
      ? [...new Set(opts["workspaces"].map((name) => normalizeWorkspaceName(name)))]
      : [];
    if (workspaceNames.length === 0) {
      throw new Error("hubControl.inviteUser requires at least one workspace");
    }
    const primaryWorkspaceName = workspaceNames[0];
    if (!primaryWorkspaceName) throw new Error("hubControl.inviteUser requires a workspace");
    // Resolve every workspace to its opaque id BEFORE creating the user so
    // an unknown name fails the whole invite, not half of it.
    const workspaceIds = workspaceNames.map((name) => requireWorkspaceId(state, name));
    const ttlMs = pairingTtl(opts["ttlMs"]);
    const invited = state.userStore.inviteUser({
      handle,
      displayName,
      role,
      createdBy: subject.userId,
    });
    let pairing: import("./hostCore/deviceAuthStore.js").PairingInvite | null = null;
    let reach: ChildReach;
    try {
      for (const workspaceId of workspaceIds) {
        state.membershipStore.add(invited.id, workspaceId, subject.userId);
      }
      pairing = state.deviceAuthStore.createPairingInvite(ttlMs, {
        workspaceId: requireWorkspaceId(state, primaryWorkspaceName),
        userId: invited.id,
        intent: "invite-user",
      });
      reach = await armControlInvite(state, pairing);
    } catch (error) {
      if (pairing) await disarmControlInvite(state, pairing.code);
      state.userStore.rollbackInvite(invited.id);
      throw error;
    }
    try {
      await recordMembershipOps(state, [
        {
          op: "invite-user",
          actor: subject,
          target: { userId: invited.id, handle: invited.handle },
          role,
        },
        ...workspaceIds.map((workspaceId) => ({
          op: "add-member" as const,
          actor: subject,
          target: { userId: invited.id, handle: invited.handle },
          workspaceId,
        })),
      ]);
    } catch (error) {
      if (pairing) await disarmControlInvite(state, pairing.code);
      state.userStore.rollbackInvite(invited.id);
      throw error;
    }
    if (!pairing) throw new Error("Invite pairing was not created");
    respond({
      user: {
        userId: invited.id,
        handle: invited.handle,
        displayName: invited.displayName,
        role: invited.role,
      },
      workspaces: workspaceNames,
      pairing: pairingInviteFromReach(state, pairing.code, pairing.expiresAt, reach),
    });
    return;
  }
  if (method === "pairDevice") {
    // WP1 §6: any authenticated member adds a device to THEMSELF — the code
    // is bound to the caller's own userId, never someone else's.
    const opts = asRecord(args[0]) ?? {};
    const ttlMs = pairingTtl(opts["ttlMs"]);
    const workspace = resolveInviteWorkspace(state, subject, opts["workspace"]);
    assertMember(state, subject, workspace);
    const workspaceId = requireWorkspaceId(state, workspace);
    const pairing = state.deviceAuthStore.createPairingInvite(ttlMs, {
      workspaceId,
      userId: subject.userId,
      intent: "pair-device",
    });
    let reach: ChildReach;
    try {
      reach = await armControlInvite(state, pairing);
    } catch (error) {
      await disarmControlInvite(state, pairing.code);
      throw error;
    }
    respond({
      userId: subject.userId,
      handle: subject.handle,
      workspace,
      pairing: pairingInviteFromReach(state, pairing.code, pairing.expiresAt, reach),
    });
    return;
  }
  if (method === "revokeUser") {
    const opts = asRecord(args[0]) ?? {};
    respond(
      await revokeHubUser(state, subject, {
        userId: opts["userId"],
        handle: opts["handle"],
      })
    );
    return;
  }
  if (method === "setRole") {
    // WP9 §6: role assignment is ROOT-only (the one gate stricter than
    // root/admin). `UserStore.setRole` enforces root immutability — the
    // root user cannot be demoted and nobody can be promoted to root.
    if (subject.role !== "root") {
      throw authError("EACCES", "Requires the root role", 403);
    }
    const opts = asRecord(args[0]) ?? {};
    const role = opts["role"];
    if (role !== "admin" && role !== "member") {
      throw new Error('hubControl.setRole requires { role: "admin" | "member" }');
    }
    const target = requireTargetUser(state, { userId: opts["userId"], handle: opts["handle"] });
    const priorRole = target.role;
    state.userStore.setRole(target.id, role);
    try {
      await recordMembershipOp(state, {
        op: "role-change",
        actor: subject,
        target: { userId: target.id, handle: target.handle },
        role,
      });
    } catch (error) {
      state.userStore.setRole(target.id, priorRole);
      throw error;
    }
    respond({ userId: target.id, handle: target.handle, role });
    return;
  }
  if (method === "updateProfile") {
    // WP6 §6: personalization is a HUB write — the hub is the sole identity
    // writer (WP0 §2). Self-service for any member; editing ANOTHER user's
    // profile is root-only. Handle renames validate against the regex +
    // reserved set inside `UserStore.renameHandle`. Children serve the
    // matching live READS (`account.getProfile`/`resolveProfiles`) off the
    // shared DB, so this write re-renders everywhere without roster rewrites.
    const opts = asRecord(args[0]) ?? {};
    const targetUserId =
      typeof opts["userId"] === "string" && opts["userId"] ? opts["userId"] : subject.userId;
    if (targetUserId !== subject.userId && subject.role !== "root") {
      throw authError("EACCES", "Only root may update another user's profile", 403);
    }
    const profile = updateAccountProfile(
      { userStore: state.userStore },
      {
        userId: targetUserId,
        ...(typeof opts["displayName"] === "string" ? { displayName: opts["displayName"] } : {}),
        // `null` is the wire form of "clear this field"; absent = untouched.
        ...("avatar" in opts
          ? { avatar: opts["avatar"] === null ? null : String(opts["avatar"]) }
          : {}),
        ...("color" in opts
          ? { color: opts["color"] === null ? null : String(opts["color"]) }
          : {}),
        ...(typeof opts["handle"] === "string" ? { handle: opts["handle"] } : {}),
      }
    );
    respond(profile);
    return;
  }
  if (method === "getProfile") {
    const opts = asRecord(args[0]) ?? {};
    const targetUserId =
      typeof opts["userId"] === "string" && opts["userId"] ? opts["userId"] : subject.userId;
    const user = state.userStore.getUser(targetUserId);
    respond(
      user
        ? {
            userId: user.id,
            handle: user.handle,
            displayName: user.displayName,
            role: user.role,
            ...(user.color !== undefined ? { color: user.color } : {}),
            ...(user.avatarBlob !== undefined ? { avatar: user.avatarBlob } : {}),
          }
        : null
    );
    return;
  }
  if (method === "listDevices") {
    const visibleDevices =
      subject.role === "root" || subject.role === "admin"
        ? state.deviceAuthStore.listDevices()
        : state.identityDb.listDevicesForUser(subject.userId);
    respond({
      serverId: state.deviceAuthStore.getServerId(),
      devices: visibleDevices.map(({ refreshTokenHash: _secret, ...device }) => device),
    });
    return;
  }
  if (method === "revokeDevice") {
    const deviceId = typeof args[0] === "string" ? args[0] : "";
    respond(await revokeHubDevice(state, subject, deviceId));
    return;
  }

  throw new Error(`Unknown hub RPC method: ${method}`);
}

function createDirectHubControlService(state: HubRuntimeState): ServiceDefinition {
  const invoke = async (
    ctx: ServiceContext,
    method: keyof typeof hubControlMethods & string,
    args: unknown[]
  ): Promise<unknown> => {
    const subject = hubSubjectFor(state, {
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
    });
    const definition = hubControlMethods[method];
    let responded = false;
    let result: unknown;
    await executeHubControl(state, subject, method, args, (value) => {
      responded = true;
      result = definition.returns?.parse(value) ?? value;
    });
    if (!responded) throw new Error(`Hub control method ${method} produced no response`);
    return result;
  };

  return {
    name: "hubControl",
    description: "Machine-level workspace and account control",
    authority: { principals: ["user", "host"] },
    methods: hubControlMethods,
    handler: defineServiceHandler(
      "hubControl",
      hubControlMethods,
      mapServiceHandlers(hubControlMethods, (method, ctx, args) =>
        invoke(ctx, method as keyof typeof hubControlMethods & string, args)
      )
    ),
  };
}

async function startHubControlTransport(
  state: HubRuntimeState,
  configDir: string
): Promise<HubControlTransport> {
  const reachRoot = path.join(configDir, "server-auth", "webrtc");

  const dispatcher = new ServiceDispatcher();
  const { CapabilityGrantStore } = await import("./services/capabilityGrantStore.js");
  const grantStore = new CapabilityGrantStore({
    statePath: path.join(configDir, "hub-control-state"),
  });
  const { createApprovalQueue } = await import("./services/approvalQueue.js");
  const approvalQueue = createApprovalQueue({
    eventService: new EventService(),
    autoApprove:
      process.env["NODE_ENV"] === "development" &&
      (process.env["VIBESTUDIO_HUB_AUTO_APPROVE"] === "1" ||
        process.env["VIBESTUDIO_AUTO_APPROVE"] === "1"),
  });
  const { AcquisitionCoordinator } = await import("./services/acquisitionCoordinator.js");
  const acquisitions = new AcquisitionCoordinator({ approvalQueue, grantStore });
  dispatcher.setAuthorityAcquirer({
    request: (input) => acquisitions.request(input),
    acquire: (input, signal) => acquisitions.requestAndWait(input, signal),
    consume: (grantId) => acquisitions.consume(grantId),
    invalidate: (snapshotDigest, ownerRuntimeId, callerPrincipal) =>
      acquisitions.invalidate(snapshotDigest, ownerRuntimeId, callerPrincipal),
  });
  dispatcher.registerService(createDirectHubControlService(state));
  const { createAuthorityService } = await import("./services/authorityService.js");
  dispatcher.registerService(createAuthorityService({ dispatcher, acquisitions }));
  const { createShellApprovalService } = await import("./services/shellApprovalService.js");
  dispatcher.registerService(
    createShellApprovalService({
      approvalQueue,
      capabilityGrantStore: grantStore,
      deviceLabelFor: (deviceId) => state.identityDb.getDevice(deviceId)?.label,
    })
  );
  dispatcher.setAuthorityResolver(({ caller, capability, resourceKey, tier }) =>
    authorizeVerifiedCaller(caller, {
      workspaceId: "hub",
      workspaceMember: true,
      sessionId: `hub-control:${caller.runtime.id}`,
      audience: "hub-control",
      capability,
      resourceKey,
      tier,
      grantStore,
    })
  );
  dispatcher.markInitialized();
  const { RpcServer } = await import("./rpcServer.js");
  const { createHubCredentialRedeemer } = await import("./services/authService.js");
  const rpcServer = new RpcServer({
    tokenManager: state.tokenManager,
    dispatcher,
    relayAuthorization: ({ targetId }) => ({
      ok: false,
      reason: `Hub control transport cannot relay to runtime target ${targetId}`,
    }),
    userSubjectSource: {
      resolve: (callerId, callerKind) => {
        if (callerKind !== "shell" || !callerId.startsWith(SHELL_CALLER_PREFIX)) return null;
        const userId = state.deviceAuthStore.userFor(callerId.slice(SHELL_CALLER_PREFIX.length));
        const user = userId ? state.userStore.getUser(userId) : null;
        return user && user.revokedAt === undefined
          ? { userId: user.id, handle: user.handle }
          : null;
      },
    },
    liveCallerGate: (caller) => {
      if (caller.runtime.kind !== "shell" || !caller.runtime.id.startsWith(SHELL_CALLER_PREFIX)) {
        return false;
      }
      const userId = state.deviceAuthStore.userFor(
        caller.runtime.id.slice(SHELL_CALLER_PREFIX.length)
      );
      const user = userId ? state.userStore.getUser(userId) : null;
      return !!user && user.revokedAt === undefined;
    },
    redeemPairingCredential: createHubCredentialRedeemer({
      deviceAuthStore: state.deviceAuthStore,
      tokenManager: state.tokenManager,
      resolveUser: (userId) => state.userStore.getUser(userId),
      redeemPairingCode: (code, input) => completeControlPairing(state, code, input),
    }),
  });
  rpcServer.initHandlers();

  const { resolveSignalingUrl } = await import("@vibestudio/shared/connect");
  const signalUrl = resolveSignalingUrl({ env: process.env }).url;
  const { ensurePersistentCert } = await import("../node/webrtc/cert.js");
  const { assertNodeDatachannelAvailable } = await import("../node/webrtc/nodeDatachannelPeer.js");
  assertNodeDatachannelAvailable();
  const identityFile = path.join(reachRoot, "identity.pem");
  const cert = ensurePersistentCert({ identityPemFile: identityFile });
  const clientIce: import("@vibestudio/shared/connect").TurnPolicy =
    process.env["VIBESTUDIO_WEBRTC_ICE"] === "relay" ? "relay" : "all";
  const serverIce: import("@vibestudio/shared/connect").TurnPolicy =
    process.env["VIBESTUDIO_WEBRTC_SERVER_ICE"] === "relay"
      ? "relay"
      : process.env["VIBESTUDIO_WEBRTC_SERVER_ICE"] === "all"
        ? "all"
        : clientIce;
  const { startWebRtcIngress } = await import("./webrtcIngress.js");
  const ingress = startWebRtcIngress({
    rpcServer,
    signalUrl,
    certificatePemFile: cert.certificatePemFile,
    keyPemFile: cert.keyPemFile,
    iceTransportPolicy: serverIce,
  });
  const transport: HubControlTransport = {
    ingress,
    pairing: {
      fp: cert.fingerprint,
      sig: signalUrl,
      v: PAIRING_PROTOCOL_VERSION,
      ice: clientIce,
    },
    rpcServer,
    grantStore,
    inviteExpiryTimers: new Map(),
  };
  state.controlTransport = transport;

  state.deviceAuthStore.cleanupControlRooms(Date.now());
  for (const room of state.deviceAuthStore.listControlRooms()) {
    await ingress.armRoom(room.room, {
      ...(room.kind === "device" ? { deviceId: room.deviceId } : {}),
    });
    if (room.kind === "invite") {
      scheduleControlInviteExpiry(state, room.codeHash, room.expiresAt);
    }
  }
  return transport;
}

function parseWorkspaceProxyUrl(rawUrl: string): { name: string; upstreamPath: string } | null {
  try {
    const url = new URL(rawUrl, "http://hub.local");
    if (!url.pathname.startsWith(WORKSPACE_ROUTE_PREFIX)) return null;
    const rest = url.pathname.slice(WORKSPACE_ROUTE_PREFIX.length);
    const [encodedName = "", ...remaining] = rest.split("/");
    if (!encodedName) return null;
    const name = normalizeWorkspaceName(decodeURIComponent(encodedName));
    const pathRemainder = remaining.length > 0 ? `/${remaining.join("/")}` : "/";
    return { name, upstreamPath: `${pathRemainder}${url.search}` };
  } catch {
    return null;
  }
}

async function existingWorkspaceRuntime(
  state: HubRuntimeState,
  advertisedName: string
): Promise<WorkspaceRuntime | null> {
  const current = state.runtimes.get(advertisedName);
  if (!current) return null;
  const runtime = "promise" in current ? await current.promise : current;
  return workspaceChildExited(runtime.child) ? null : runtime;
}

async function runtimeForProxyRequest(
  state: HubRuntimeState,
  parsed: { name: string; upstreamPath: string },
  req: http.IncomingMessage
): Promise<{ runtime: WorkspaceRuntime; body?: Buffer } | null> {
  const existing = await existingWorkspaceRuntime(state, parsed.name);
  if (existing) return { runtime: existing };

  if (req.method !== "POST" || !isRefreshShellPath(parsed.upstreamPath)) {
    return null;
  }

  const body = await readBody(req, 64 * 1024);
  const payload = HubDeviceCredentialBodySchema.parse(
    body.length > 0 ? JSON.parse(body.toString("utf8")) : {}
  );
  // Spawn-through-refresh honors the same membership pre-filter as
  // workspace.route: a non-member request never starts a child (WP2 §4).
  const subject = subjectForDeviceCredential(state, payload);
  assertMember(state, subject, parsed.name);
  const runtime = await ensureWorkspaceRuntime(state, parsed.name);
  return { runtime, body };
}

async function proxyHttpRequest(
  state: HubRuntimeState,
  parsed: { name: string; upstreamPath: string },
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let resolved: { runtime: WorkspaceRuntime; body?: Buffer } | null;
  try {
    resolved = await runtimeForProxyRequest(state, parsed, req);
  } catch (error) {
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 400;
    sendJson(res, status, remoteErrorPayload(error));
    return;
  }
  if (!resolved) {
    sendText(res, 404, "Workspace is not running");
    return;
  }
  const { runtime, body } = resolved;
  const headers = { ...req.headers, host: `127.0.0.1:${runtime.port}` };
  if (body) {
    headers["content-length"] = String(body.byteLength);
    delete headers["transfer-encoding"];
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: runtime.port,
      method: req.method,
      path: parsed.upstreamPath,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.on("error", (error) => {
        if (!res.destroyed) res.destroy(error);
      });
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) sendText(res, 502, `Workspace proxy error: ${error.message}`);
    else res.destroy(error);
  });
  req.on("error", (error) => {
    upstream.destroy(error);
  });
  res.on("error", () => {
    upstream.destroy();
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}

async function proxyUpgrade(
  state: HubRuntimeState,
  parsed: { name: string; upstreamPath: string },
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> {
  try {
    const runtime = await existingWorkspaceRuntime(state, parsed.name);
    if (!runtime) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const upstream = http.request({
      host: "127.0.0.1",
      port: runtime.port,
      method: req.method,
      path: parsed.upstreamPath,
      headers: { ...req.headers, host: `127.0.0.1:${runtime.port}` },
    });
    const onClientConnectError = () => {
      upstream.destroy();
    };
    const onClientConnectClose = () => {
      upstream.destroy();
    };
    const onUpstreamRequestError = () => {
      if (!socket.destroyed) {
        socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
      socket.destroy();
    };
    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      upstream.off("error", onUpstreamRequestError);
      socket.off("error", onClientConnectError);
      socket.off("close", onClientConnectClose);
      socket.write(
        `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`
      );
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) socket.write(`${key}: ${item}\r\n`);
        } else if (value !== undefined) {
          socket.write(`${key}: ${value}\r\n`);
        }
      }
      socket.write("\r\n");
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      bridgeDuplexSockets(socket, upstreamSocket);
    });
    upstream.on("error", onUpstreamRequestError);
    socket.on("error", onClientConnectError);
    socket.on("close", onClientConnectClose);
    upstream.end();
  } catch {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
}

async function ensureWorkspaceRuntime(
  state: HubRuntimeState,
  advertisedName: string,
  options: { reuseEphemeralDiskName?: string } = {}
): Promise<WorkspaceRuntime> {
  requireWorkspaceId(state, advertisedName);
  const current = state.runtimes.get(advertisedName);
  if (current) {
    if ("promise" in current) return current.promise;
    if (!workspaceChildExited(current.child)) return current;
    state.runtimes.delete(advertisedName);
  }
  return beginWorkspaceRuntimeStart(state, advertisedName, (onSpawn) =>
    startWorkspaceRuntime(state, advertisedName, onSpawn, options)
  );
}

function beginWorkspaceRuntimeStart(
  state: HubRuntimeState,
  advertisedName: string,
  start: (onSpawn: (child: ChildProcess) => void) => Promise<WorkspaceRuntime>
): Promise<WorkspaceRuntime> {
  const pending: PendingWorkspaceRuntime = { promise: null as never };
  const started = start((child) => {
    pending.child = child;
  });
  const promise = started
    .then((runtime) => {
      if (workspaceChildExited(runtime.child)) {
        throw new Error(
          `Workspace runtime "${advertisedName}" exited while readiness was being published`
        );
      }
      if (state.runtimes.get(advertisedName) === pending) {
        state.runtimes.set(advertisedName, runtime);
      }
      return runtime;
    })
    .catch((error: unknown) => {
      if (state.runtimes.get(advertisedName) === pending) {
        state.runtimes.delete(advertisedName);
      }
      throw error;
    });
  pending.promise = promise;
  state.runtimes.set(advertisedName, pending);
  return promise;
}

/**
 * Environment for a spawned workspace child. Exported for tests.
 *
 * Identity is one hub-owned store (WP0 §2): the child opens `identity.db`
 * query-only via `VIBESTUDIO_IDENTITY_DB_PATH` to resolve subjects and rosters.
 * Each advertised workspace keeps its own DTLS identity and routed-room state
 * under the canonical advertised workspace directory. A replacement process
 * (including a fresh ephemeral dev checkout) therefore preserves its pinned
 * fingerprint, while different advertised workspaces remain isolated.
 *
 * `workspaceId` is the registry's OPAQUE stable id (WP2) — the child gates
 * connections with `membershipStore.has(subject.userId, workspaceId)`, so it
 * must match the id membership rows are keyed by, never the display name.
 */
export function buildWorkspaceChildEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  appRoot: string;
  advertisedWorkspaceName: string;
  childWorkspaceName: string;
  workspaceId: string;
  hubUrl: string;
  identityDbPath: string;
  workspaceChildToken: string;
  ephemeral: boolean;
  autoApproveStartupUnits: boolean;
}): NodeJS.ProcessEnv {
  const reach = workspaceReachPaths(input.advertisedWorkspaceName);
  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    VIBESTUDIO_APP_ROOT: input.appRoot,
    VIBESTUDIO_HOST: "127.0.0.1",
    VIBESTUDIO_BIND_HOST: "127.0.0.1",
    VIBESTUDIO_WORKSPACE: input.childWorkspaceName,
    // The disk coordinate can differ from the user-facing catalog name (the
    // ephemeral dev workspace is the canonical example). Child RPCs must
    // report the catalog name so clients can route back through the hub.
    VIBESTUDIO_ADVERTISED_WORKSPACE: input.advertisedWorkspaceName,
    VIBESTUDIO_WORKSPACE_ID: input.workspaceId,
    // Routed signaling rooms are a property of the advertised workspace, not
    // of one child process's disk checkout. This is identical for persistent
    // workspaces and crucial for ephemeral dev, whose random checkout is
    // deleted on every restart while paired devices must retain their room.
    VIBESTUDIO_ROUTED_ROOM_STATE_PATH: reach.routesFile,
    VIBESTUDIO_IDENTITY_DB_PATH: input.identityDbPath,
    VIBESTUDIO_WORKSPACE_CHILD_TOKEN: input.workspaceChildToken,
    // Every child gets a distinct loopback-management capability. Never pass
    // through the hub's operator token from baseEnv.
    VIBESTUDIO_ADMIN_TOKEN: randomBytes(32).toString("hex"),
    // The certificate identifies the advertised logical workspace. Ephemeral
    // dev may replace its random checkout on every launch, but paired clients
    // must continue to see the fingerprint they pinned for `dev`.
    VIBESTUDIO_WEBRTC_IDENTITY: reach.identityFile,
    VIBESTUDIO_PROCESS_ROLE: "workspace-child",
    VIBESTUDIO_HUB_URL: input.hubUrl,
  };
  delete env["VIBESTUDIO_GATEWAY_PORT"];
  delete env["VIBESTUDIO_WORKSPACE_DIR"];
  if (input.ephemeral) {
    env["VIBESTUDIO_WORKSPACE_EPHEMERAL"] = "1";
  } else {
    delete env["VIBESTUDIO_WORKSPACE_EPHEMERAL"];
  }
  // An explicit unattended-run policy belongs to the supervising process and
  // must survive the hub/workspace process boundary. The per-workspace bit is
  // additive: it grants the same policy to a freshly bootstrapped workspace,
  // but must not erase a policy the caller deliberately supplied.
  if (
    input.autoApproveStartupUnits ||
    input.baseEnv["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"] === "1"
  ) {
    env["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"] = "1";
  } else {
    delete env["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"];
  }
  return env;
}

/** Rotate the ephemeral dev checkout at the point a replacement runtime is
 * actually started. A crashed child's disk stays available until then so its
 * durable test trajectories and logs remain inspectable; normal hub shutdown
 * still removes the currently recorded checkout. */
export function prepareEphemeralWorkspaceDisk(
  centralData: CentralDataManager,
  ownerBootId: string,
  workspaceId: string,
  nextDiskName: string,
  removeWorkspace: typeof deleteUnregisteredWorkspace = deleteUnregisteredWorkspace
): void {
  const cleanup = centralData.rotateEphemeralWorkspaceDiskName(
    ownerBootId,
    workspaceId,
    nextDiskName
  );
  if (cleanup) {
    removeWorkspace(cleanup, centralData, ownerBootId);
  }
}

/**
 * Release only the checkout owned by this process instance. There is no marker
 * read before the compare-and-remove: a displaced shutdown receives no cleanup
 * ticket and therefore has no filesystem coordinate it may delete.
 */
export function removeOwnedEphemeralWorkspace(
  centralData: CentralDataManager,
  ownerBootId: string,
  removeWorkspace: typeof deleteUnregisteredWorkspace = deleteUnregisteredWorkspace
): string | null {
  const removal = centralData.removeEphemeralWorkspace(ownerBootId, ownerBootId);
  if (removal?.cleanup) removeWorkspace(removal.cleanup, centralData, ownerBootId);
  return removal?.workspace.workspaceId ?? null;
}

export function buildWorkspaceChildArgs(input: {
  entry: string;
  workspaceName: string;
  appRoot: string;
  readyFile: string;
  logLevel?: string;
  requireMobileReady?: boolean;
  requireElectronReady?: boolean;
}): string[] {
  const args = [
    input.entry,
    "--workspace",
    input.workspaceName,
    "--app-root",
    input.appRoot,
    "--ready-file",
    input.readyFile,
    "--host",
    "127.0.0.1",
    "--bind-host",
    "127.0.0.1",
    "--serve-panels",
    "--init",
  ];
  if (input.logLevel) args.push("--log-level", input.logLevel);
  if (input.requireMobileReady) args.push("--require-mobile-ready");
  if (input.requireElectronReady) args.push("--require-electron-ready");
  return args;
}

async function startWorkspaceRuntime(
  state: HubRuntimeState,
  advertisedName: string,
  onSpawn: (child: ChildProcess) => void,
  options: { reuseEphemeralDiskName?: string } = {}
): Promise<WorkspaceRuntime> {
  const isEphemeralDevWorkspace = isWorkspaceEphemeral(state, advertisedName);
  const workspaceId = requireWorkspaceId(state, advertisedName);
  // A new child instance owns a fresh report stream. Never retain endpoints
  // from a prior process while the replacement is starting.
  state.workspacePresence.delete(workspaceId);
  const shouldAutoApproveDefaultStartup =
    advertisedName === "default" &&
    state.autoApproveStartupWorkspaceIds?.has(workspaceId) === true &&
    !workspaceConfigExists("default");
  if (options.reuseEphemeralDiskName && !isEphemeralDevWorkspace) {
    throw new Error("Only an ephemeral dev runtime may reuse an ephemeral disk coordinate");
  }
  if (options.reuseEphemeralDiskName && !/^dev-[0-9a-f]{8}$/.test(options.reuseEphemeralDiskName)) {
    throw new Error("Invalid ephemeral restart disk coordinate");
  }
  const childWorkspaceName =
    options.reuseEphemeralDiskName ??
    (isEphemeralDevWorkspace ? `dev-${randomBytes(4).toString("hex")}` : advertisedName);
  if (options.reuseEphemeralDiskName && !fs.existsSync(getWorkspaceDir(childWorkspaceName))) {
    throw new Error(
      `Cannot recover workspace "${advertisedName}": owned checkout "${childWorkspaceName}" is missing`
    );
  }
  // Runtime startup consumes an explicitly registered workspace; it never
  // creates catalog state as a routing side effect. Ephemeral dev children use
  // a random disk name but retain the registered advertised workspace id.
  if (isEphemeralDevWorkspace) {
    prepareEphemeralWorkspaceDisk(
      state.centralData,
      state.serverBootId,
      workspaceId,
      childWorkspaceName
    );
  }
  const readyDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `vibestudio-workspace-${advertisedName}-`)
  );
  const readyFile = path.join(readyDir, "ready.json");
  const publicUrl = workspaceEndpointUrl(state, advertisedName);
  const childArgs = buildWorkspaceChildArgs({
    entry: process.argv.slice(1, 2)[0] ?? "",
    workspaceName: childWorkspaceName,
    appRoot: state.appRoot,
    readyFile,
    logLevel: state.args.logLevel,
    requireMobileReady: state.args.requireMobileReady,
    requireElectronReady: state.args.requireElectronReady,
  });

  const childEnv = buildWorkspaceChildEnv({
    baseEnv: process.env,
    appRoot: state.appRoot,
    advertisedWorkspaceName: advertisedName,
    childWorkspaceName,
    workspaceId,
    hubUrl: state.connectUrl,
    identityDbPath: state.identityDbPath,
    workspaceChildToken: randomBytes(32).toString("base64url"),
    ephemeral: isEphemeralDevWorkspace === true,
    autoApproveStartupUnits: shouldAutoApproveDefaultStartup,
  });
  const runtimeToken = childEnv["VIBESTUDIO_WORKSPACE_CHILD_TOKEN"];
  if (!runtimeToken) throw new Error("Workspace child environment has no runtime identity token");
  state.workspaceChildTokens.set(runtimeToken, workspaceId);

  const child = spawn(process.execPath, [...process.execArgv, ...childArgs], {
    cwd: state.appRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    // The hub owns this complete runtime tree. A distinct POSIX process group
    // lets graceful shutdown reach the child first and lets an explicit
    // repeated signal stop workerd/extension-host descendants as one unit.
    detached: process.platform !== "win32",
  });
  onSpawn(child);

  // A supervising CLI/PTY may close stdout while several workspace children
  // are still draining final shutdown output. Node emits EPIPE both to the
  // write callback and as a stream `error`; guard the latter once per stream so
  // a normal closed consumer cannot crash the hub.
  for (const destination of [process.stdout, process.stderr]) {
    const tagged = destination as NodeJS.WriteStream & { __vibestudioEpipeGuard?: boolean };
    if (tagged.__vibestudioEpipeGuard) continue;
    tagged.__vibestudioEpipeGuard = true;
    destination.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        // The stream is already in an error path; avoid recursively writing to
        // stderr. Retain the failure for debuggers without turning it into an
        // unhandled process-level exception.
        process.exitCode = 1;
      }
    });
  }

  const forwardOutput = (destination: NodeJS.WriteStream, prefix: string, chunk: unknown) => {
    if (destination.destroyed || !destination.writable) return;
    destination.write(`${prefix}${String(chunk)}`, (error) => {
      // The wrapper CLI can close its pipe while the workspace child emits its
      // final shutdown lines. A broken parent pipe is a completed output path,
      // not a fatal hub error. Supplying the callback consumes that async write
      // failure; non-EPIPE errors remain visible through the normal stream.
      if (error && (error as NodeJS.ErrnoException).code !== "EPIPE") {
        console.error(`[Hub] Failed to forward workspace output:`, error);
      }
    });
  };
  child.stdout?.on("data", (chunk) =>
    forwardOutput(process.stdout, `[workspace:${advertisedName}] `, chunk)
  );
  child.stderr?.on("data", (chunk) =>
    forwardOutput(process.stderr, `[workspace:${advertisedName}:err] `, chunk)
  );
  child.on("exit", (code, signal) => {
    void handleWorkspaceChildExit(state, {
      advertisedName,
      childWorkspaceName,
      workspaceId,
      runtimeToken,
      child,
      code,
      signal,
    }).catch((error) => {
      console.error(
        `[Hub] Workspace "${advertisedName}" exit reconciliation failed; runtime remains unavailable:`,
        error
      );
    });
  });

  let ready: Record<string, unknown>;
  let port: number;
  try {
    ready = WorkspaceChildReadySchema.parse(await waitForReadyFile(readyFile, child));
    if (ready["workspaceName"] !== childWorkspaceName || ready["workspaceId"] !== workspaceId) {
      throw new Error(
        `Workspace "${advertisedName}" ready identity does not match its spawn ` +
          `(expected name=${JSON.stringify(childWorkspaceName)} id=${JSON.stringify(workspaceId)}, ` +
          `received name=${JSON.stringify(ready["workspaceName"])} id=${JSON.stringify(ready["workspaceId"])})`
      );
    }
    port = ready["gatewayPort"] as number;
    state.centralData.touchWorkspace(advertisedName);
    state.autoApproveStartupWorkspaceIds?.delete(workspaceId);
  } catch (error) {
    await terminateWorkspaceChild(child);
    state.workspaceChildTokens.delete(runtimeToken);
    throw error;
  } finally {
    fs.rmSync(readyDir, { recursive: true, force: true });
  }
  return {
    name: childWorkspaceName,
    advertisedName,
    workspaceId,
    port,
    publicUrl,
    child,
    ready,
    runtimeToken,
  };
}

type ProcessSignalDeps = {
  platform?: NodeJS.Platform;
  killProcess?: typeof process.kill;
};

function workspaceChildExited(child: ChildProcess): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

type WorkspaceChildExitInput = {
  advertisedName: string;
  childWorkspaceName: string;
  workspaceId: string;
  runtimeToken: string;
  child: ChildProcess;
  code: number | null;
  signal: NodeJS.Signals | null;
};

type WorkspaceChildExitDeps = {
  shouldRestart?: (state: HubRuntimeState, advertisedName: string) => boolean;
  reap?: (child: ChildProcess) => Promise<void>;
  restart?: (
    state: HubRuntimeState,
    input: WorkspaceChildExitInput,
    reaped: Promise<void>
  ) => Promise<WorkspaceRuntime>;
};

function workspaceRuntimeIsDesired(state: HubRuntimeState, advertisedName: string): boolean {
  if (!state.centralData.hasWorkspace(advertisedName)) return false;
  if (isWorkspaceEphemeral(state, advertisedName)) return true;
  const routeFile = routedRoomStatePath(advertisedName);
  return fs.existsSync(routeFile) && new RoutedRoomStore(routeFile).list().length > 0;
}

function restartExitedWorkspaceRuntime(
  state: HubRuntimeState,
  input: WorkspaceChildExitInput,
  reaped: Promise<void>
): Promise<WorkspaceRuntime> {
  return beginWorkspaceRuntimeStart(state, input.advertisedName, async (onSpawn) => {
    await reaped;
    return startWorkspaceRuntime(state, input.advertisedName, onSpawn, {
      reuseEphemeralDiskName: isWorkspaceEphemeral(state, input.advertisedName)
        ? input.childWorkspaceName
        : undefined,
    });
  });
}

/**
 * Converge the runtime registry after an observed OS exit. A ready child with
 * durable demand is replaced immediately; ephemeral recovery reuses the exact
 * hub-owned checkout so run/DO state survives the process fault. Intentional
 * stops remove the map entry before signaling and are therefore ignored here.
 */
export async function handleWorkspaceChildExit(
  state: HubRuntimeState,
  input: WorkspaceChildExitInput,
  deps: WorkspaceChildExitDeps = {}
): Promise<void> {
  state.workspaceChildTokens.delete(input.runtimeToken);
  state.workspacePresence.delete(input.workspaceId);
  const current = state.runtimes.get(input.advertisedName);
  if (!current || current.child !== input.child) return;
  const wasReady = !("promise" in current);
  state.runtimes.delete(input.advertisedName);

  const reaped = (deps.reap ?? reapWorkspaceChildProcessGroup)(input.child);
  const exitDescription = `code=${input.code ?? "null"}, signal=${input.signal ?? "null"}, pid=${input.child.pid ?? "unknown"}`;
  if (state.shuttingDown) {
    console.log(
      `[Hub] Workspace "${input.advertisedName}" exited during shutdown (${exitDescription})`
    );
    await reaped;
    return;
  }
  console.error(
    `[Hub] Workspace "${input.advertisedName}" exited unexpectedly (${exitDescription})`
  );

  if (
    !wasReady ||
    !(deps.shouldRestart ?? workspaceRuntimeIsDesired)(state, input.advertisedName)
  ) {
    await reaped;
    return;
  }

  try {
    const runtime = await (deps.restart ?? restartExitedWorkspaceRuntime)(state, input, reaped);
    console.log(
      `[Hub] Workspace "${input.advertisedName}" recovered on child ${runtime.child.pid ?? "unknown"} using checkout "${runtime.name}"`
    );
  } catch (error) {
    console.error(
      `[Hub] Workspace "${input.advertisedName}" recovery failed; runtime remains unavailable:`,
      error
    );
  }
}

/** Kill and prove absence of the exact detached process group owned by a child. */
export async function reapWorkspaceChildProcessGroup(
  child: ChildProcess,
  deps: ProcessSignalDeps & {
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const pid = child.pid;
  if (platform === "win32" || !Number.isInteger(pid) || (pid ?? 0) <= 0) return;
  const killProcess = deps.killProcess ?? process.kill;
  try {
    killProcess(-(pid as number), "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }

  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.timeoutMs ?? 5_000);
  while (true) {
    try {
      killProcess(-(pid as number), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (now() >= deadline) {
      throw new Error(`Workspace child process group ${pid} survived SIGKILL`);
    }
    await pause(25);
  }
}

/** Signal the workspace runtime and every process it owns. */
export function signalWorkspaceChildTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  deps: ProcessSignalDeps = {}
): boolean {
  const platform = deps.platform ?? process.platform;
  const killProcess = deps.killProcess ?? process.kill;
  if (platform !== "win32" && Number.isInteger(child.pid) && (child.pid ?? 0) > 0) {
    try {
      killProcess(-(child.pid as number), signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return child.kill(signal);
}

/**
 * Request ordered workspace shutdown and wait for the OS exit event. The first
 * signal goes only to the workspace server because it owns workerd and service
 * drain ordering. A repeated hub signal separately calls
 * signalWorkspaceChildTree(SIGKILL). There is deliberately no elapsed-time
 * cutoff between those explicit lifecycle actions.
 */
export async function terminateWorkspaceChild(
  child: ChildProcess,
  deps: { reap?: (child: ChildProcess) => Promise<void> } = {}
): Promise<void> {
  if (!workspaceChildExited(child)) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const delivered = child.kill("SIGTERM");
    if (!delivered && !workspaceChildExited(child)) {
      throw new Error(`Could not signal workspace child ${child.pid ?? "unknown"}`);
    }
    await exited;
  }
  await (deps.reap ?? reapWorkspaceChildProcessGroup)(child);
}

async function waitForReadyFile(
  readyFile: string,
  child: ChildProcess
): Promise<Record<string, unknown>> {
  // Readiness is a state transition, not a duration. Cold protected-root
  // validation can legitimately take several minutes and already emits
  // per-service watchdog/progress output. Treat process exit as failure; do
  // not kill a live, progressing workspace because a machine-local deadline
  // happened to expire.
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Workspace runtime exited before readiness (code ${child.exitCode})`);
    }
    try {
      return JSON.parse(fs.readFileSync(readyFile, "utf8")) as Record<string, unknown>;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function resolveAdminToken(): { adminToken: string; tokenSource: HubRuntimeState["tokenSource"] } {
  const envToken = process.env["VIBESTUDIO_ADMIN_TOKEN"];
  if (envToken) return { adminToken: envToken, tokenSource: "env" };
  const persisted = loadPersistedAdminToken();
  if (persisted) return { adminToken: persisted, tokenSource: "persisted" };
  const adminToken = randomBytes(32).toString("hex");
  try {
    savePersistedAdminToken(adminToken);
  } catch (error) {
    console.warn(`[Hub] Failed to persist admin token at ${getAdminTokenPath()}:`, error);
  }
  return { adminToken, tokenSource: "generated" };
}

/** Open the registry and identity views over the hub's one canonical database. */
export function openHubDataStores(databasePath: string): {
  centralData: CentralDataManager;
  identityDb: IdentityDb;
} {
  const centralData = new CentralDataManager({ databasePath });
  try {
    return {
      centralData,
      identityDb: new IdentityDb({ path: databasePath, readOnly: false }),
    };
  } catch (error) {
    centralData.close();
    throw error;
  }
}

/**
 * Claim the hub's externally visible ownership boundary before opening or
 * mutating central state. A second hub must fail at listen(2), while the first
 * still owns its ephemeral lifecycle, rather than treating that live state as
 * crash residue and deleting it.
 */
async function startHubGateway(input: {
  requestedPort?: number;
  bindHost: string;
  getState(): HubRuntimeState | null;
}): Promise<{ server: http.Server; port: number }> {
  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      const state = input.getState();
      if (!state) {
        sendText(res, 503, "Hub starting");
        return;
      }
      const rawUrl = req.url ?? "/";
      const proxied = parseWorkspaceProxyUrl(rawUrl);
      if (proxied) {
        await proxyHttpRequest(state, proxied, req, res);
        return;
      }
      const url = new URL(rawUrl, "http://hub.local");
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          mode: "hub",
          serverId: state.deviceAuthStore.getServerId(),
          serverBootId: state.serverBootId,
          gatewayPort: state.gatewayPort,
          pid: process.pid,
          version: state.version,
        });
        return;
      }
      if (url.pathname.startsWith("/_r/s/auth/")) {
        await handleAuthRoute(state, url.pathname.slice("/_r/s/auth/".length), req, res);
        return;
      }
      if (url.pathname.startsWith("/_r/s/internal/")) {
        await handleInternalRoute(state, url.pathname.slice("/_r/s/internal/".length), req, res);
        return;
      }
      if (url.pathname === "/rpc") {
        const control = state.controlTransport;
        if (!control) {
          sendText(res, 503, "Hub control starting");
          return;
        }
        await control.rpcServer.handleGatewayHttpRequest(req, res);
        return;
      }
      sendText(res, 404, "Not Found");
    })().catch((error) => {
      if (!res.headersSent) sendJson(res, 500, remoteErrorPayload(error));
      else res.destroy(error);
    });
  };

  const server = http.createServer(requestHandler);
  server.on("upgrade", (req, socket, head) => {
    const state = input.getState();
    if (!state) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://hub.local");
    if (url.pathname === "/rpc") {
      const control = state.controlTransport;
      if (!control) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      control.rpcServer.handleGatewayWsUpgrade(req, socket, head);
      return;
    }
    const proxied = parseWorkspaceProxyUrl(req.url ?? "/");
    if (!proxied) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void proxyUpgrade(state, proxied, req, socket, head);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.requestedPort ?? 0, input.bindHost, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Hub listen failed"));
      else resolve(address.port);
    });
  });
  return { server, port };
}

export async function runHubServer(input: { args: HubServerArgs; appRoot: string }): Promise<void> {
  const args = input.args;
  const appRoot = input.appRoot;
  const requestedGatewayPort = args.gatewayPort ?? parseEnvPort("VIBESTUDIO_GATEWAY_PORT");
  const hostConfig = resolveHostConfig({
    workerdPort: 0,
    gatewayPort: requestedGatewayPort ?? 0,
    host: args.host,
    bindHost: args.bindHost,
  });
  let state: HubRuntimeState | null = null;
  const { server, port: gatewayPort } = await startHubGateway({
    requestedPort: requestedGatewayPort,
    bindHost: hostConfig.bindHost,
    getState: () => state,
  });

  const centralPaths = getCentralConfigPaths();
  // CentralDataManager owns workspace registry rows referenced by identity DB
  // foreign keys, so an identity-path override must move both stores together.
  const identityDbPath =
    process.env["VIBESTUDIO_IDENTITY_DB_PATH"] ??
    path.join(centralPaths.configDir, "server-auth", "identity.db");
  const serverBootId = `boot_${randomBytes(18).toString("base64url")}`;
  const { centralData, identityDb } = openHubDataStores(identityDbPath);
  try {
    centralData.claimHubProcessLease({
      ownerBootId: serverBootId,
      gatewayPort,
      pid: process.pid,
      ttlMs: HUB_PROCESS_LEASE_TTL_MS,
    });
  } catch (error) {
    identityDb.close();
    centralData.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  let processLeaseLost = false;
  const processLeaseHeartbeat = setInterval(() => {
    if (processLeaseLost) return;
    try {
      if (centralData.renewHubProcessLease(serverBootId, HUB_PROCESS_LEASE_TTL_MS)) return;
      console.error(`[Hub] Lost machine-control lease for ${serverBootId}; terminating`);
    } catch (error) {
      console.error(`[Hub] Could not renew machine-control lease for ${serverBootId}:`, error);
    }
    processLeaseLost = true;
    process.kill(process.pid, "SIGTERM");
  }, HUB_PROCESS_LEASE_HEARTBEAT_MS);
  processLeaseHeartbeat.unref();
  const staleEphemeral = centralData.getEphemeralWorkspace();
  if (staleEphemeral) {
    centralData.removeEphemeralWorkspace(serverBootId, staleEphemeral.ownerBootId);
  }
  for (const cleanup of centralData.listEphemeralWorkspaceCleanups(serverBootId)) {
    deleteUnregisteredWorkspace(cleanup, centralData, serverBootId);
  }
  recoverStagedWorkspaceDeletions(centralData);
  const version =
    process.env["VIBESTUDIO_APP_VERSION"] ?? process.env["npm_package_version"] ?? "0.1.0";
  const tokenManager = new TokenManager();
  const { adminToken, tokenSource } = resolveAdminToken();
  tokenManager.setAdminToken(adminToken);
  // The hub owns the single identity DB as the SOLE writer (WP0 §2). It opens
  // `identity.db` read-write; every workspace child opens the SAME file
  // read-only (PRAGMA query_only) via the path handed down in the spawn env.
  const deviceAuthStore = new DeviceAuthStore({
    db: identityDb,
    serverIdPath: path.join(path.dirname(identityDbPath), "server-id.json"),
  });
  const userStore = new UserStore(identityDb);
  const membershipStore = new MembershipStore(identityDb, userStore);
  const bootstrap = selectBootstrapWorkspace(args, centralData.listWorkspaces());
  const bootstrapWorkspace = bootstrap.name;
  let bootstrapWasCreated = false;
  if (bootstrap.lifecycle === "ephemeral") {
    centralData.addEphemeralWorkspace(bootstrapWorkspace, serverBootId);
    bootstrapWasCreated = true;
  } else if (bootstrap.lifecycle === "register") {
    bootstrapWasCreated = !centralData.hasWorkspace(bootstrapWorkspace);
    centralData.addWorkspace(bootstrapWorkspace);
  }
  const bootstrapWorkspaceId = centralData.getWorkspaceIdByName(bootstrapWorkspace);
  if (!bootstrapWorkspaceId) {
    throw new Error(`Bootstrap workspace "${bootstrapWorkspace}" is not registered`);
  }
  // Membership-governance records land in the host governance log (WP5 §5.1),
  // the same SQLite governance database that carries approval provenance.
  const governanceLog = new GovernanceLog();
  // Root bootstrap (WP0 §4): on a fresh identity DB the startup pairing invite
  // IS the root invite — the first device to redeem it triggers createRoot and
  // is issued with the new root's userId (see the complete-pairing route). Once
  // a root exists, new humans arrive by invite (WP1), so no startup code is minted.
  const needsRootBootstrap = !identityDb.hasUsers();
  const startupPairing = needsRootBootstrap
    ? deviceAuthStore.createPairingInvite(DEFAULT_PAIRING_CODE_TTL_MS, {
        workspaceId: bootstrapWorkspaceId,
        intent: "root-bootstrap",
      })
    : null;
  // No public ingress: the hub is loopback HTTP only. connectUrl is the loopback
  // gateway URL; remote reach is the per-workspace WebRTC pipe (answerer seam).
  const gatewayUrl = `${hostConfig.protocol}://${hostConfig.externalHost}:${gatewayPort}`;
  const connectUrl = gatewayUrl.replace(/\/$/, "");
  state = {
    appRoot,
    args,
    centralData,
    deviceAuthStore,
    identityDb,
    userStore,
    membershipStore,
    governanceLog,
    tokenManager,
    serverBootId,
    adminToken,
    tokenSource,
    version,
    gatewayPort,
    protocol: hostConfig.protocol,
    externalHost: hostConfig.externalHost,
    bindHost: hostConfig.bindHost,
    connectUrl,
    identityDbPath,
    workspaceChildTokens: new Map(),
    autoApproveStartupWorkspaceIds: new Set(
      bootstrapWasCreated && bootstrapWorkspace === "default" ? [bootstrapWorkspaceId] : []
    ),
    workspacePresence: new Map(),
    runtimes: new Map(),
    shuttingDown: false,
  };
  const activeState = state;
  await startHubControlTransport(activeState, centralPaths.configDir);

  let startupInvite: HubPairingInvite | null = null;
  // Prewarm every registered workspace runtime WITHOUT blocking hub readiness.
  // A persisted device room is a live reach contract, so routed children must
  // restart for returning clients — but pairing and hub control must not wait
  // out a ~20s child cold boot. Routing coalesces onto the pending start, so a
  // client that arrives mid-boot awaits the same runtime promise instead of
  // spawning a duplicate.
  void restoreRoutedWorkspaceRuntimes(centralData.listWorkspaces(), (name) =>
    ensureWorkspaceRuntime(activeState, name)
  );
  let revocationCleanupDrain: Promise<void> | null = null;
  const drainRevocationCleanup = (): Promise<void> => {
    if (revocationCleanupDrain) return revocationCleanupDrain;
    revocationCleanupDrain = (async () => {
      const userIds = [
        ...new Set(identityDb.listUserRevocationCleanup().map((task) => task.userId)),
      ];
      for (const userId of userIds) await processUserRevocationCleanup(activeState, userId);
    })().finally(() => {
      revocationCleanupDrain = null;
    });
    return revocationCleanupDrain;
  };
  void drainRevocationCleanup().catch((error) => {
    console.error("[Hub] Initial revoked-user cleanup retry failed:", error);
  });
  const revocationCleanupTimer = setInterval(() => {
    void drainRevocationCleanup().catch((error) => {
      console.error("[Hub] Revoked-user cleanup retry failed:", error);
    });
  }, 10_000);
  revocationCleanupTimer.unref();
  if (startupPairing) {
    let rootReach: ChildReach;
    try {
      rootReach = await armControlInvite(state, startupPairing);
    } catch (error) {
      await disarmControlInvite(state, startupPairing.code);
      throw error;
    }
    startupInvite = pairingInviteFromReach(
      state,
      startupPairing.code,
      startupPairing.expiresAt,
      rootReach
    );
  }

  console.log("vibestudio-server hub ready:");
  console.log(`  Gateway:     ${gatewayUrl} (loopback)`);
  console.log(`  Token file:  ${getAdminTokenPath()}${tokenSource === "env" ? " (env)" : ""}`);
  if (startupPairing) {
    console.log(`  Root Pair URL: ${startupInvite?.pairUrl ?? "unavailable"}`);
  } else {
    console.log("  Identity:    root already bootstrapped (add users via invite)");
  }

  if (args.readyFile) {
    const payload = buildHubReadyPayload(state, startupInvite);
    writeFileAtomicSync(args.readyFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  const workspaceChildren = (): ChildProcess[] => [
    ...new Set(
      [...activeState.runtimes.values()]
        .map((runtime) => runtime.child)
        .filter((child): child is ChildProcess => child !== undefined)
    ),
  ];

  async function shutdown(): Promise<void> {
    if (!state || state.shuttingDown) return;
    state.shuttingDown = true;
    clearInterval(revocationCleanupTimer);
    console.log("[Hub] Shutting down...");
    if (state.controlTransport) {
      for (const timer of state.controlTransport.inviteExpiryTimers.values()) clearTimeout(timer);
      state.controlTransport.inviteExpiryTimers.clear();
      await state.controlTransport.ingress.close();
      await state.controlTransport.rpcServer.stop();
      state.controlTransport.grantStore.close();
    }
    const childProcesses = workspaceChildren();
    await Promise.all(childProcesses.map((child) => terminateWorkspaceChild(child)));
    if (state.centralData.getEphemeralWorkspace()?.ownerBootId === state.serverBootId) {
      try {
        removeOwnedEphemeralWorkspace(state.centralData, state.serverBootId);
      } catch (error) {
        // Keep the lifecycle marker intact so the next startup retries cleanup.
        console.error("[Hub] Ephemeral workspace cleanup will retry on next startup:", error);
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await state.governanceLog?.close();
    clearInterval(processLeaseHeartbeat);
    state.centralData.releaseHubProcessLease(state.serverBootId);
    state.centralData.close();
    state.identityDb.close();
    process.exit(0);
  }

  const onShutdownSignal = (signal: NodeJS.Signals): void => {
    if (state?.shuttingDown) {
      console.error(
        `[Hub] Received ${signal} during shutdown; force-stopping workspace process trees`
      );
      for (const child of workspaceChildren()) {
        if (!workspaceChildExited(child)) signalWorkspaceChildTree(child, "SIGKILL");
      }
      return;
    }
    console.log(`[Hub] Received ${signal}; starting ordered shutdown`);
    void shutdown();
  };
  process.on("SIGTERM", () => onShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => onShutdownSignal("SIGINT"));
}
