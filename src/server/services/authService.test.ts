import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { User } from "@vibestudio/identity/types";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { Gateway } from "../gateway.js";
import { RouteRegistry } from "../routeRegistry.js";
import {
  createAuthService,
  createHubCredentialRedeemer,
  createWorkspaceCredentialRedeemer,
  RefreshAgentBodySchema,
  RefreshShellBodySchema,
} from "./authService.js";
import { DeviceAuthStore } from "../hostCore/deviceAuthStore.js";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { ClientPrincipalGrantRequestSchema } from "@vibestudio/service-schemas/clients";
import type { ClientPrincipal } from "../clients/clientPrincipals.js";

function makePanelRecord(id: string): EntityRecord {
  return {
    id,
    kind: "panel",
    source: { repoPath: "", effectiveVersion: "" },
    activeBuildKey: `build:${id}`,
    activeExecutionDigest: "a".repeat(64),
    activeAuthority: { requests: [], provides: [] },
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

/**
 * Device refresh resolves the owning account before minting a grant. Tests that
 * do not exercise revocation still need a live owner, so resolve every id.
 */
const testResolveUser = (userId: string): User => ({
  id: userId,
  handle: userId,
  displayName: userId,
  role: "root",
  createdAt: 0,
});

describe("workspace child auth clean cutover", () => {
  it("exposes only refresh and runtime credential routes", () => {
    const identity = makeIdentity({ withRoot: true });
    const service = createAuthService({
      resolveUser: testResolveUser,
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
    ]);
    expect(service.definition.methods).toHaveProperty("grantClientPrincipal");
    expect(service.definition.methods).not.toHaveProperty("getMobileAppBootstrap");
    expect(service.definition.methods).not.toHaveProperty("grantAppPrincipal");
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
    const build = { source: "clients/chat", buildKey: "build-1", executionDigest: "d".repeat(64) };
    expect(ClientPrincipalGrantRequestSchema.safeParse(build).success).toBe(true);
    expect(
      ClientPrincipalGrantRequestSchema.safeParse({ ...build, callerId: "legacy-caller" }).success
    ).toBe(false);
    expect(ClientPrincipalGrantRequestSchema.safeParse({ principal: "app:mobile" }).success).toBe(
      false
    );
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
      resolveUser: testResolveUser,
      tokenManager,
      deviceAuthStore: identity.deviceAuthStore,
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
    });
    const routeRegistry = new RouteRegistry();
    routeRegistry.registerHttpServiceRoutes(service.routes ?? []);
    const gateway = new Gateway({
      workerdPort: 9,
      routeRegistry,
      adminToken: "admin-secret",
      tokenManager,
    });
    try {
      const port = await gateway.start(0);
      const issued = identity.deviceAuthStore.issueDevice({
        transport: { kind: "local" },
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
      resolveUser: testResolveUser,
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
      resolveUser: testResolveUser,
      tokenManager: new TokenManager(),
      deviceAuthStore: makeAuthStore(),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
      connectionGrants,
    });

    const subject = { userId: "usr_test", handle: "test" };
    const granted = (await service.definition.handler(
      { caller: createVerifiedCaller("shell:test", "shell", null, null, subject) },
      "grantConnection",
      ["panel:one"]
    )) as { token: string; expiresAt: number };

    expect(granted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(connectionGrants.redeem(granted.token)).toEqual({
      principalId: "panel:one",
      issuedBy: "shell:test",
      subject,
    });
    connectionGrants.stop();
  });

  it("repairs a missing active-entity projection before issuing a grant", async () => {
    const entityCache = new EntityCache();
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const active = makePanelRecord("panel:durable");
    const resolveRuntimeEntity = vi.fn(async (id: string) => {
      if (id !== active.id) return null;
      entityCache._onActivate(active);
      return active;
    });
    const service = createAuthService({
      resolveUser: testResolveUser,
      tokenManager: new TokenManager(),
      deviceAuthStore: makeAuthStore(),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
      connectionGrants,
      resolveRuntimeEntity,
    });

    const granted = (await service.definition.handler(
      { caller: createVerifiedCaller("shell:test", "shell") },
      "grantConnection",
      [active.id]
    )) as { token: string };

    expect(resolveRuntimeEntity).toHaveBeenCalledWith(active.id);
    expect(connectionGrants.redeem(granted.token)?.principalId).toBe(active.id);
    connectionGrants.stop();
  });

  it("allows panel-hosting app callers to issue panel connection grants", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:mobile"));
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      resolveUser: testResolveUser,
      tokenManager: new TokenManager(),
      deviceAuthStore: makeAuthStore(),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
      connectionGrants,
      hasClientCapability: (callerId, capability) =>
        callerId === "client:browser:web:device-1" && capability === "panel-hosting",
    });

    expect(service.definition.methods?.["grantConnection"]?.authority).toEqual({
      principals: ["host", "user", "code"],
    });

    const granted = (await service.definition.handler(
      { caller: createVerifiedCaller("client:browser:web:device-1", "client") },
      "grantConnection",
      ["panel:mobile"]
    )) as { token: string; expiresAt: number };

    expect(granted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(connectionGrants.redeem(granted.token)).toEqual({
      principalId: "panel:mobile",
      issuedBy: "client:browser:web:device-1",
    });
    connectionGrants.stop();
  });

  it("rejects app panel connection grants without panel-hosting capability", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:mobile"));
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      resolveUser: testResolveUser,
      tokenManager: new TokenManager(),
      deviceAuthStore: makeAuthStore(),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      getConnectionInfo,
      connectionGrants,
      hasClientCapability: () => false,
    });

    await expect(
      service.definition.handler(
        { caller: createVerifiedCaller("client:other:web:device-1", "client") },
        "grantConnection",
        ["panel:mobile"]
      )
    ).rejects.toThrow(/panel-hosting/);
    connectionGrants.stop();
  });
});
describe("auth.grantClientPrincipal", () => {
  const BUILD = {
    source: "clients/terminal-browser",
    buildKey: "build-terminal",
    executionDigest: "d".repeat(64),
  };

  function makeClientPrincipalRecord(principal: ClientPrincipal): EntityRecord {
    return {
      id: principal.principalId,
      kind: "client",
      source: { repoPath: principal.source, effectiveVersion: principal.effectiveVersion },
      activeBuildKey: principal.buildKey,
      activeExecutionDigest: "a".repeat(64),
      activeAuthority: { requests: [], provides: [] },
      contextId: "ctx-client-device",
      key: principal.principalId,
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    };
  }

  function makeGrantService(
    opts: {
      grantClientPrincipal?: Parameters<typeof createAuthService>[0]["grantClientPrincipal"];
    } = {}
  ) {
    const identity = makeIdentity({ withRoot: true });
    const device = identity.deviceAuthStore.issueDevice({
      transport: { kind: "iroh", endpointId: "c".repeat(64) },
      userId: identity.rootId!,
      label: "Laptop",
    });
    const entityCache = new EntityCache();
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const principalFor = (deviceId: string): ClientPrincipal => ({
      principalId: `client:browser:terminal:${deviceId}`,
      id: "browser",
      runtime: "terminal",
      source: BUILD.source,
      buildKey: BUILD.buildKey,
      effectiveVersion: "ev-terminal",
    });
    const grantClientPrincipal = vi.fn(
      opts.grantClientPrincipal ??
        (async (deviceId: string) => {
          const principal = principalFor(deviceId);
          entityCache._onActivate(makeClientPrincipalRecord(principal));
          return principal;
        })
    );
    const service = createAuthService({
      resolveUser: testResolveUser,
      tokenManager: new TokenManager(),
      deviceAuthStore: identity.deviceAuthStore,
      getServerBootId: () => "boot_grant",
      getWorkspaceId: () => "workspace_grant",
      getConnectionInfo,
      connectionGrants,
      grantClientPrincipal,
    });
    const subject = { userId: identity.rootId!, handle: "root" };
    const shellCaller = (remoteEndpointId?: string) => ({
      ...createVerifiedCaller(`shell:${device.deviceId}`, "shell", null, null, subject),
      ...(remoteEndpointId ? { remoteEndpointId } : {}),
    });
    return {
      service,
      identity,
      device,
      subject,
      shellCaller,
      connectionGrants,
      grantClientPrincipal,
    };
  }

  it("rejects callers that are not an authenticated device shell", async () => {
    const { service, grantClientPrincipal, connectionGrants, device, subject } = makeGrantService();
    try {
      for (const caller of [
        createVerifiedCaller("panel:one", "panel", null, null, subject),
        createVerifiedCaller(`shell:${device.deviceId}`, "client", null, null, subject),
      ]) {
        await expect(
          service.definition.handler({ caller }, "grantClientPrincipal", [BUILD])
        ).rejects.toMatchObject({ code: "EACCES" });
      }
      expect(grantClientPrincipal).not.toHaveBeenCalled();
    } finally {
      connectionGrants.stop();
    }
  });

  it("rejects a shell whose subject does not own the device", async () => {
    const { service, grantClientPrincipal, connectionGrants, device } = makeGrantService();
    try {
      for (const subject of [null, { userId: "usr_other", handle: "other" }]) {
        const caller = createVerifiedCaller(
          `shell:${device.deviceId}`,
          "shell",
          null,
          null,
          subject
        );
        await expect(
          service.definition.handler({ caller }, "grantClientPrincipal", [BUILD])
        ).rejects.toMatchObject({ code: "EACCES" });
      }
      expect(grantClientPrincipal).not.toHaveBeenCalled();
    } finally {
      connectionGrants.stop();
    }
  });

  it("requires the exact build the host verified", () => {
    expect(ClientPrincipalGrantRequestSchema.safeParse(BUILD).success).toBe(true);
    expect(ClientPrincipalGrantRequestSchema.safeParse({ source: BUILD.source }).success).toBe(
      false
    );
    expect(
      ClientPrincipalGrantRequestSchema.safeParse({ ...BUILD, principal: "terminal-app" }).success
    ).toBe(false);
  });

  it("mints a grant for the device's client principal bound to the caller endpoint", async () => {
    const { service, shellCaller, device, subject, connectionGrants, grantClientPrincipal } =
      makeGrantService();
    const endpoint = "e".repeat(64);
    try {
      const response = (await service.definition.handler(
        { caller: shellCaller(endpoint) },
        "grantClientPrincipal",
        [BUILD]
      )) as { connectionGrant: string; principalId: string };

      expect(grantClientPrincipal).toHaveBeenCalledWith(device.deviceId, BUILD);
      const principalId = `client:browser:terminal:${device.deviceId}`;
      expect(response).toEqual({
        connectionGrant: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: expect.any(Number),
        principalId,
        deviceId: device.deviceId,
        serverId: expect.any(String),
        serverBootId: "boot_grant",
        workspaceId: "workspace_grant",
      });
      // The grant is bound to the requesting endpoint: another path cannot redeem it.
      expect(connectionGrants.validate(response.connectionGrant)).toBeNull();
      expect(connectionGrants.redeem(response.connectionGrant, endpoint)).toEqual({
        principalId,
        issuedBy: `shell:${device.deviceId}`,
        subject,
        remoteEndpointId: endpoint,
      });
    } finally {
      connectionGrants.stop();
    }
  });

  it("omits the endpoint for loopback callers", async () => {
    const { service, shellCaller, device, subject, connectionGrants } = makeGrantService();
    try {
      const response = (await service.definition.handler(
        { caller: shellCaller() },
        "grantClientPrincipal",
        [BUILD]
      )) as { connectionGrant: string; principalId: string };
      expect(connectionGrants.redeem(response.connectionGrant)).toEqual({
        principalId: `client:browser:terminal:${device.deviceId}`,
        issuedBy: `shell:${device.deviceId}`,
        subject,
      });
    } finally {
      connectionGrants.stop();
    }
  });

  it("carries the registry's refusal to the host and mints no grant", async () => {
    const { service, shellCaller, connectionGrants } = makeGrantService({
      grantClientPrincipal: async () => {
        throw new Error("build-terminal is no longer the active build of clients/terminal-browser");
      },
    });
    try {
      await expect(
        service.definition.handler({ caller: shellCaller() }, "grantClientPrincipal", [BUILD])
      ).rejects.toMatchObject({
        code: "PRINCIPAL_UNAVAILABLE",
        message: expect.stringContaining("no longer the active build"),
      });
    } finally {
      connectionGrants.stop();
    }
  });
});

async function postLocal<T>(
  port: number,
  pathname: string,
  body: unknown,
  bearer?: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...extraHeaders,
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
      resolveUser: testResolveUser,
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
      ).rejects.toThrow(/no authority branch admits|approval-required|missing-grant/i);
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

  it("delegates account pairing redemption without workspace navigation context", async () => {
    const { deviceAuthStore, rootId, redeem } = hubFixture();
    const { code } = deviceAuthStore.createPairingInvite(60_000, {
      userId: rootId!,
    });
    const result = await redeem(code, {
      clientLabel: "laptop",
      clientPlatform: "desktop",
      transport: { kind: "local" },
    });
    expect(result).toMatchObject({
      callerKind: "shell",
      subject: { userId: rootId, handle: "root" },
    });
    expect(result).not.toHaveProperty("pairingContext");
    expect(
      result && "deviceCredential" in result ? result.deviceCredential.deviceId : null
    ).toMatch(/^dev_/);
    await expect(redeem(code, { transport: { kind: "local" } })).rejects.toMatchObject({
      code: "PAIRING_CODE_INVALID_OR_EXPIRED",
    });
    expect(deviceAuthStore.listDevices()).toHaveLength(1);
  });

  it("validates a returning device without issuing another credential", async () => {
    const touchDevice = vi.fn(async () => undefined);
    const { deviceAuthStore, rootId, redeem } = hubFixture(touchDevice);
    const issued = deviceAuthStore.issueDevice({
      transport: { kind: "local" },
      userId: rootId!,
      label: "phone",
    });
    const result = await redeem("refresh:" + issued.deviceId + ":" + issued.refreshToken, {
      transport: { kind: "local" },
    });
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
    const result = await redeem(issued.agentToken, { transport: { kind: "local" } });
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
    await expect(
      hub.redeem(agent.agentToken, { transport: { kind: "local" } })
    ).resolves.toBeNull();

    const workspace = workspaceFixture();
    const invite = workspace.deviceAuthStore.createPairingInvite(60_000, {
      userId: workspace.rootId!,
    });
    await expect(
      workspace.redeem(invite.code, { transport: { kind: "local" } })
    ).resolves.toBeNull();
  });
});
