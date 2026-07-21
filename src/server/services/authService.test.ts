import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { Gateway } from "../gateway.js";
import { RouteRegistry } from "../routeRegistry.js";
import {
  createAuthService,
  createHubCredentialRedeemer,
  createWorkspaceCredentialRedeemer,
  MobileAppBootstrapBodySchema,
  RefreshAgentBodySchema,
  RefreshPrincipalGrantBodySchema,
  RefreshShellBodySchema,
} from "./authService.js";
import { DeviceAuthStore } from "../hostCore/deviceAuthStore.js";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { PendingUnitBatchApproval } from "@vibestudio/shared/approvals";

function makePanelRecord(id: string): EntityRecord {
  return {
    id,
    kind: "panel",
    source: { repoPath: "", effectiveVersion: "" },
    activeExecutionDigest: "a".repeat(64),
    activeAuthority: { requests: [], delegations: [] },
    contextId: "",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  };
}

function makeSessionRecord(
  id: string,
  opts: {
    contextId?: string;
    channelId?: string;
    ownerUserId?: string;
    parentId?: string;
    status?: EntityRecord["status"];
  } = {}
): EntityRecord {
  const key = id.startsWith("session:") ? id.slice("session:".length) : id;
  const contextId = opts.contextId ?? "ctx-abc";
  return {
    id,
    kind: "session",
    source: { repoPath: "agent-cli", effectiveVersion: "" },
    contextId,
    key,
    agentBinding: {
      entityId: id,
      contextId,
      channelId: opts.channelId ?? "channel:agent",
    },
    parentId: opts.parentId,
    ownerUserId: opts.ownerUserId ?? "system",
    createdAt: Date.now(),
    status: opts.status ?? "active",
    cleanupComplete: true,
  };
}

/**
 * A hub identity DB + device store sharing ONE in-memory identity DB (the hub is
 * the sole identity writer). Devices, agent credentials, and pairing codes live
 * in the DB; only the stable server id is persisted to `serverIdPath`. Pass
 * `withRoot` to seed the single root account so the admin-token routes
 * (`/issue-device`) can resolve a device owner.
 */
function makeIdentity(opts: { withRoot?: boolean; now?: () => number } = {}): {
  db: IdentityDb;
  userStore: UserStore;
  deviceAuthStore: DeviceAuthStore;
  rootId: string | null;
  workspaceId: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-auth-id-"));
  const serverIdPath = path.join(dir, "auth", "server-id.json");
  const databasePath = path.join(dir, "identity.db");
  const nowOpt = opts.now ? { now: opts.now } : {};
  const central = new CentralDataManager({ databasePath, ...nowOpt });
  const workspaceId = central.addWorkspace("test").workspaceId;
  central.close();
  const db = new IdentityDb({ path: databasePath, readOnly: false, ...nowOpt });
  const userStore = new UserStore(db, opts.now);
  const rootId = opts.withRoot
    ? userStore.createRoot({ handle: "root", displayName: "Root" }).id
    : null;
  const deviceAuthStore = new DeviceAuthStore({ db, serverIdPath, ...nowOpt });
  return { db, userStore, deviceAuthStore, rootId, workspaceId };
}

/** A bare device store (own in-memory identity DB) for tests that never mint identity. */
function makeAuthStore(now?: () => number): DeviceAuthStore {
  return makeIdentity(now ? { now } : {}).deviceAuthStore;
}

const getConnectionInfo = () => ({
  serverUrl: "http://127.0.0.1:3030",
  protocol: "http" as const,
  externalHost: "127.0.0.1",
  gatewayPort: 3030,
});

describe("workspace child auth clean cutover", () => {
  it("exposes only refresh and runtime credential routes", () => {
    const identity = makeIdentity({ withRoot: true });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: identity.deviceAuthStore,
      roleOf: (userId) => identity.userStore.getUser(userId)?.role ?? null,
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
    });
    expect((service.routes ?? []).map((route) => route.path)).toEqual([
      "/refresh-shell",
      "/refresh-agent",
      "/refresh-principal-grant",
      "/mobile-app-bootstrap",
    ]);
    expect(service.definition.methods).not.toHaveProperty("createPairingInvite");
    expect(service.definition.methods).not.toHaveProperty("listDevices");
    expect(service.definition.methods).not.toHaveProperty("revokeDevice");
  });

  it("rejects unknown fields in every public credential exchange body", () => {
    const deviceCredential = {
      deviceId: `dev_${"d".repeat(24)}`,
      refreshToken: "r".repeat(43),
    };
    expect(RefreshShellBodySchema.safeParse(deviceCredential).success).toBe(true);
    expect(
      RefreshShellBodySchema.safeParse({ ...deviceCredential, room: "legacy-room" }).success
    ).toBe(false);
    expect(
      RefreshPrincipalGrantBodySchema.safeParse({
        ...deviceCredential,
        principal: "app:mobile",
        callerId: "legacy-caller",
      }).success
    ).toBe(false);
    expect(
      MobileAppBootstrapBodySchema.safeParse({
        ...deviceCredential,
        source: "app/mobile",
        workspace: "legacy-workspace",
      }).success
    ).toBe(false);
    expect(
      RefreshAgentBodySchema.safeParse({
        agentToken: `agent:agt_${"a".repeat(24)}:${"s".repeat(43)}`,
        deviceId: "legacy-device",
      }).success
    ).toBe(false);
  });

  it("returns precise HTTP errors for invalid, oversized, and rejected refresh requests", async () => {
    const tokenManager = new TokenManager();
    const identity = makeIdentity({ withRoot: true });
    const service = createAuthService({
      tokenManager,
      deviceAuthStore: identity.deviceAuthStore,
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
    });
    const routeRegistry = new RouteRegistry();
    routeRegistry.registerHttpServiceRoutes(service.routes ?? []);
    const gateway = new Gateway({
      externalHost: "127.0.0.1",
      bindHost: "127.0.0.1",
      workerdPort: 9,
      routeRegistry,
      adminToken: "admin-secret",
      tokenManager,
    });
    try {
      const port = await gateway.start(0);
      const issued = identity.deviceAuthStore.issueDevice({
        userId: identity.rootId!,
        label: "Laptop",
      });
      const credential = { deviceId: issued.deviceId, refreshToken: issued.refreshToken };

      expect(
        (
          await postLocal<{ code: string }>(port, "/_r/s/auth/refresh-shell", {
            ...credential,
            room: "retired-room",
          })
        ).status
      ).toBe(400);
      expect(
        (
          await postLocal<{ code: string }>(port, "/_r/s/auth/refresh-shell", {
            ...credential,
            padding: "x".repeat(70 * 1024),
          })
        ).status
      ).toBe(413);
      expect(
        (
          await postLocal<{ code: string }>(port, "/_r/s/auth/refresh-shell", {
            ...credential,
            refreshToken: "x".repeat(43),
          })
        ).status
      ).toBe(401);
    } finally {
      await gateway.stop();
    }
  });
});

describe("auth service connection grants", () => {
  it("rejects grants for unregistered principals", async () => {
    const entityCache = new EntityCache();
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: makeAuthStore(),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
      connectionGrants,
    });

    await expect(
      service.definition.handler(
        { caller: createVerifiedCaller("shell:test", "shell") },
        "grantConnection",
        ["panel:missing"]
      )
    ).rejects.toThrow(/unregistered/);
    connectionGrants.stop();
  });

  it("issues redeemable grants for registered principals", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:one"));
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: makeAuthStore(),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
      connectionGrants,
    });

    const granted = (await service.definition.handler(
      { caller: createVerifiedCaller("shell:test", "shell") },
      "grantConnection",
      ["panel:one"]
    )) as { token: string; expiresAt: number };

    expect(granted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(connectionGrants.redeem(granted.token)).toEqual({
      principalId: "panel:one",
      issuedBy: "shell:test",
    });
    connectionGrants.stop();
  });

  it("allows panel-hosting app callers to issue panel connection grants", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:mobile"));
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: makeAuthStore(),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
      connectionGrants,
      hasAppCapability: (callerId, capability) =>
        callerId === "app:apps/mobile:device-1" && capability === "panel-hosting",
    });

    expect(service.definition.methods?.["grantConnection"]?.authority).toEqual({
      principals: ["host", "user", "code"],
    });

    const granted = (await service.definition.handler(
      { caller: createVerifiedCaller("app:apps/mobile:device-1", "app") },
      "grantConnection",
      ["panel:mobile"]
    )) as { token: string; expiresAt: number };

    expect(granted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(connectionGrants.redeem(granted.token)).toEqual({
      principalId: "panel:mobile",
      issuedBy: "app:apps/mobile:device-1",
    });
    connectionGrants.stop();
  });

  it("rejects app panel connection grants without panel-hosting capability", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:mobile"));
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: makeAuthStore(),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
      connectionGrants,
      hasAppCapability: () => false,
    });

    await expect(
      service.definition.handler(
        { caller: createVerifiedCaller("app:apps/other:device-1", "app") },
        "grantConnection",
        ["panel:mobile"]
      )
    ).rejects.toThrow(/panel-hosting/);
    connectionGrants.stop();
  });

  it("returns mobile app approval requirements without blocking bootstrap", async () => {
    const tokenManager = new TokenManager();
    const routeRegistry = new RouteRegistry();
    const identity = makeIdentity({ withRoot: true });
    const authStore = identity.deviceAuthStore;
    const approvals = [
      {
        approvalId: "approval-mobile",
        kind: "unit-batch",
        callerId: "system:apps",
        callerKind: "system",
        repoPath: "apps/mobile",
        effectiveVersion: "ev-mobile",
        trigger: "startup",
        title: "Approve workspace apps",
        description: "Approve the mobile app",
        units: [
          {
            unitKind: "app",
            unitName: "@workspace-apps/mobile",
            displayName: "Mobile",
            target: "react-native",
            source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
            ev: "ev-mobile",
            capabilities: ["notifications"],
            dependencyEvs: {},
            externalDeps: {},
          },
        ],
        configWrite: null,
        requestedAt: 1,
      },
    ] satisfies PendingUnitBatchApproval[];
    const authService = createAuthService({
      tokenManager,
      deviceAuthStore: authStore,
      agentCredentialWriter: {
        mint: async (input) => authStore.mintAgentCredential(input),
        revoke: async (agentId) => authStore.revokeAgentCredential(agentId),
      },
      roleOf: (userId) => identity.userStore.getUser(userId)?.role ?? null,
      getServerBootId: () => "boot_mobile_approval",
      getWorkspaceId: () => "workspace_mobile_approval",
      getConnectionInfo,
      ensureMobileAppReady: async () => ({
        ready: false,
        approvalRequired: true,
        approvals,
        reason: "React Native workspace app requires approval",
      }),
      getMobileAppBootstrap: () => null,
    });
    routeRegistry.registerHttpServiceRoutes(authService.routes ?? []);
    const gateway = new Gateway({
      externalHost: "127.0.0.1",
      bindHost: "127.0.0.1",
      workerdPort: 9,
      routeRegistry,
      adminToken: "admin-secret",
      tokenManager,
    });
    try {
      const port = await gateway.start(0);
      const issued = identity.deviceAuthStore.issueDevice({
        userId: identity.rootId!,
        label: "Phone",
        platform: "mobile",
      });
      const response = await postLocal<{
        code: string;
        approvals: PendingUnitBatchApproval[];
      }>(port, "/_r/s/auth/mobile-app-bootstrap", {
        deviceId: issued.deviceId,
        refreshToken: issued.refreshToken,
      });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("MOBILE_APP_APPROVAL_REQUIRED");
      expect(response.body.approvals).toEqual([
        expect.objectContaining({
          approvalId: "approval-mobile",
          units: [expect.objectContaining({ target: "react-native" })],
        }),
      ]);
    } finally {
      await gateway.stop();
    }
  });
});
async function postLocal<T>(
  port: number,
  pathname: string,
  body: unknown,
  bearer?: string
): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

describe("auth.mintAgentCredential / revokeAgentCredential policy (§3.2)", () => {
  const makeDispatcher = () => {
    const dispatcher = createTestServiceDispatcher();
    const tokenManager = new TokenManager();
    const authStore = makeAuthStore();
    const records = new Map<string, EntityRecord>();
    const authService = createAuthService({
      tokenManager,
      deviceAuthStore: authStore,
      agentCredentialWriter: {
        mint: async (input) => authStore.mintAgentCredential(input),
        revoke: async (agentId) => authStore.revokeAgentCredential(agentId),
      },
      getServerBootId: () => "boot",
      getWorkspaceId: () => "ws",
      getConnectionInfo,
      resolveRuntimeEntity: async (id) => records.get(id) ?? null,
    });
    dispatcher.registerService(authService.definition);
    dispatcher.markInitialized();
    return { dispatcher, authStore, records, tokenManager };
  };

  it("lets the owning extension rotate + revoke authentication for a self-bound session", async () => {
    const { dispatcher, authStore, records, tokenManager } = makeDispatcher();
    const extensionId = "extension:agent-launcher";
    records.set(
      "session:s1",
      makeSessionRecord("session:s1", { contextId: "ctx-derived", parentId: extensionId })
    );
    const ext = { caller: createVerifiedCaller(extensionId, "extension") };

    const minted = (await dispatcher.dispatch(ext, "auth", "mintAgentCredential", [
      { entityId: "session:s1" },
    ])) as { agentId: string; agentToken: string };
    expect(minted.agentId).toMatch(/^agt_/);
    expect(minted.agentToken.startsWith(`agent:${minted.agentId}:`)).toBe(true);
    expect(
      authStore.validateAgentToken(minted.agentId, minted.agentToken.split(":")[2]!)
    ).toMatchObject({
      entityId: "session:s1",
    });
    const bearer = tokenManager.ensureToken("agent:session:s1", "agent");
    expect(tokenManager.validateToken(bearer)).not.toBeNull();

    const revoked = (await dispatcher.dispatch(ext, "auth", "revokeAgentCredential", [
      minted.agentId,
    ])) as { revoked: boolean };
    expect(revoked.revoked).toBe(true);
    expect(tokenManager.validateToken(bearer)).toBeNull();
  });

  it("lets the server mint for any active session but rejects a non-owning extension", async () => {
    const { dispatcher, authStore, records } = makeDispatcher();
    records.set(
      "session:s2",
      makeSessionRecord("session:s2", { contextId: "ctx-server", parentId: "extension:owner" })
    );

    const serverMinted = (await dispatcher.dispatch(
      { caller: createVerifiedCaller("server", "server") },
      "auth",
      "mintAgentCredential",
      [{ entityId: "session:s2" }]
    )) as { agentId: string; agentToken: string };
    expect(
      authStore.validateAgentToken(serverMinted.agentId, serverMinted.agentToken.split(":")[2]!)
    ).toMatchObject({ entityId: "session:s2" });

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("extension:other", "extension") },
        "auth",
        "mintAgentCredential",
        [{ entityId: "session:s2" }]
      )
    ).rejects.toThrow(/does not own target entity/);
  });

  it("denies non-code principals before lookup and non-owning code after lookup", async () => {
    const { dispatcher, records } = makeDispatcher();
    records.set(
      "session:owned",
      makeSessionRecord("session:owned", { parentId: "extension:owner" })
    );
    for (const kind of ["shell", "agent"] as const) {
      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller(`${kind}:x`, kind) },
          "auth",
          "mintAgentCredential",
          [{ entityId: "session:owned" }]
        )
      ).rejects.toThrow(/no authority branch admits/i);
    }
    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("panel:x", "panel") },
        "auth",
        "mintAgentCredential",
        [{ entityId: "session:owned" }]
      )
    ).rejects.toThrow(/does not own target entity/i);
  });
});

describe("transport-specific credential redemption", () => {
  function hubFixture(touchDevice?: (deviceId: string) => Promise<void>) {
    const identity = makeIdentity({ withRoot: true, now: () => 1234 });
    const tokenManager = new TokenManager();
    const redeem = createHubCredentialRedeemer({
      deviceAuthStore: identity.deviceAuthStore,
      tokenManager,
      redeemPairingCode: async (code, input) =>
        identity.deviceAuthStore.completePairing({ code, ...input }),
      ...(touchDevice ? { touchDevice } : {}),
      resolveUser: (userId) => identity.userStore.getUser(userId),
    });
    return { ...identity, tokenManager, redeem };
  }

  function workspaceFixture(touchDevice?: (deviceId: string) => Promise<void>) {
    const identity = makeIdentity({ withRoot: true, now: () => 1234 });
    const tokenManager = new TokenManager();
    const entities = new Map<string, EntityRecord>();
    const redeem = createWorkspaceCredentialRedeemer({
      deviceAuthStore: identity.deviceAuthStore,
      tokenManager,
      ...(touchDevice ? { touchDevice } : {}),
      resolveUser: (userId) => identity.userStore.getUser(userId),
      resolveRuntimeEntity: (entityId) => entities.get(entityId) ?? null,
    });
    return { ...identity, tokenManager, entities, redeem };
  }

  it("delegates pairing redemption and returns a subject-bearing device with its target", async () => {
    const { deviceAuthStore, rootId, workspaceId, redeem } = hubFixture();
    const { code } = deviceAuthStore.createPairingInvite(60_000, {
      workspaceId,
      userId: rootId!,
    });
    const result = await redeem(code, { clientLabel: "laptop", clientPlatform: "desktop" });
    expect(result).toMatchObject({
      callerKind: "shell",
      pairingContext: { workspaceId },
      subject: { userId: rootId, handle: "root" },
    });
    expect(
      result && "deviceCredential" in result ? result.deviceCredential.deviceId : null
    ).toMatch(/^dev_/);
    await expect(redeem(code, {})).resolves.toBeNull();
    expect(deviceAuthStore.listDevices()).toHaveLength(1);
  });

  it("validates a returning device without issuing another credential", async () => {
    const touchDevice = vi.fn(async () => undefined);
    const { deviceAuthStore, rootId, redeem } = hubFixture(touchDevice);
    const issued = deviceAuthStore.issueDevice({ userId: rootId!, label: "phone" });
    const result = await redeem("refresh:" + issued.deviceId + ":" + issued.refreshToken, {});
    expect(result).toMatchObject({
      callerId: "shell:" + issued.deviceId,
      callerKind: "shell",
      subject: { userId: rootId, handle: "root" },
    });
    expect(result).not.toHaveProperty("deviceCredential");
    expect(result).not.toHaveProperty("pairingContext");
    expect(touchDevice).toHaveBeenCalledWith(issued.deviceId);
  });

  it("derives agent coordinates and subject from the live session entity", async () => {
    const { deviceAuthStore, rootId, entities, redeem } = workspaceFixture();
    entities.set(
      "session:s1",
      makeSessionRecord("session:s1", {
        contextId: "ctx",
        channelId: "channel",
        ownerUserId: rootId!,
      })
    );
    const issued = deviceAuthStore.mintAgentCredential({
      entityId: "session:s1",
    });
    const result = await redeem(issued.agentToken);
    expect(result).toMatchObject({
      callerId: "agent:session:s1",
      agentBinding: { entityId: "session:s1", contextId: "ctx", channelId: "channel" },
      subject: { userId: rootId, handle: "root" },
    });
  });

  it("keeps hub pairing and workspace agent credentials on their owning ingress", async () => {
    const hub = hubFixture();
    const agent = hub.deviceAuthStore.mintAgentCredential({
      entityId: "session:hub-denied",
    });
    await expect(hub.redeem(agent.agentToken, {})).resolves.toBeNull();

    const workspace = workspaceFixture();
    const invite = workspace.deviceAuthStore.createPairingInvite(60_000, {
      workspaceId: workspace.workspaceId,
      userId: workspace.rootId!,
    });
    await expect(workspace.redeem(invite.code)).resolves.toBeNull();
  });
});
