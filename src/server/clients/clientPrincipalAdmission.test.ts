import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityDb, type ClientPrincipalRow } from "@vibestudio/identity/identityDb";
import { MembershipStore } from "@vibestudio/identity/membership";
import { UserStore } from "@vibestudio/identity/userStore";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { TokenManager } from "@vibestudio/shared/tokenManager";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { DeviceAuthStore } from "../hostCore/deviceAuthStore.js";
import { createCloseClientPrincipalsRoute } from "../clientPrincipalRoutes.js";
import { createLiveCallerGate } from "../services/liveCallerGate.js";
import { createWorkspaceCredentialRedeemer } from "../services/authService.js";
import { hasClientCapability } from "../services/clientTrust.js";
import { resolveCodeIdentity } from "../services/principalIdentity.js";
import { ClientPrincipals, createClientSessionRetirer } from "./clientPrincipals.js";

const DEVICE_KEY = "a".repeat(64);
const PRINCIPAL = "client:app:desktop:dev_alice";
const DIGEST = "d".repeat(64);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * One hub identity.db, written by the hub and mirrored read-only into each
 * workspace server, which keeps only its own EntityCache. Mirrors production:
 * the System workspace attests and mints through the hub, any workspace redeems.
 */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-client-admission-"));
  dirs.push(dir);
  const databasePath = path.join(dir, "identity.db");
  const central = new CentralDataManager({ databasePath });
  const system = central.addWorkspace("system").workspaceId;
  const shared = central.addWorkspace("shared").workspaceId;
  central.close();

  const hub = new IdentityDb({ path: databasePath, readOnly: false });
  const hubUsers = new UserStore(hub);
  const alice = hubUsers.createRoot({ handle: "alice", displayName: "Alice" });
  const bob = hubUsers.inviteUser({
    handle: "bob",
    displayName: "Bob",
    role: "member",
    createdBy: alice.id,
  });
  const serverIdPath = path.join(dir, "server-id.json");
  // The hub creates the stable server id before any workspace child starts.
  new DeviceAuthStore({ db: hub, serverIdPath });
  const hubMembership = new MembershipStore(hub, hubUsers);
  for (const workspaceId of [system, shared]) hubMembership.add(alice.id, workspaceId, alice.id);
  hubMembership.add(bob.id, system, alice.id);
  for (const [deviceId, userId, deviceKey] of [
    ["dev_alice", alice.id, DEVICE_KEY],
    ["dev_bob", bob.id, "b".repeat(64)],
  ] as const) {
    hub.upsertDevice({
      deviceId,
      refreshTokenHash: "h",
      transport: { kind: "iroh", deviceKey },
      userId,
      label: deviceId,
      createdAt: 2,
    });
  }

  const attest = (over: Partial<ClientPrincipalRow> = {}) =>
    hub.upsertClientPrincipal({
      principalId: PRINCIPAL,
      userId: alice.id,
      deviceId: "dev_alice",
      clientId: "app",
      runtime: "desktop",
      source: "clients/app",
      buildKey: "bk1",
      effectiveVersion: "v1",
      executionDigest: DIGEST,
      authority: { requests: [], provides: [] },
      capabilities: ["device-session"],
      attesterWorkspaceId: system,
      attestedAt: 5,
      ...over,
    });

  /** A workspace server's auth stack over its own read-only identity handle. */
  function workspaceServer(workspaceId: string) {
    const identity = new IdentityDb({ path: databasePath, readOnly: true });
    const users = new UserStore(identity);
    const membership = new MembershipStore(identity, users);
    const deviceAuthStore = new DeviceAuthStore({
      db: identity,
      serverIdPath,
    });
    const entityCache = new EntityCache();
    const principals = new ClientPrincipals({ workspaceId, entityCache });
    const redeem = createWorkspaceCredentialRedeemer({
      deviceAuthStore,
      identity,
      admitClientPrincipal: (principal) => principals.admit(principal),
      tokenManager: new TokenManager(),
      resolveUser: (userId) => users.getUser(userId),
      resolveRuntimeEntity: () => null,
    });
    const gate = createLiveCallerGate({
      workspaceId,
      userStore: users,
      membershipStore: membership,
      deviceAuthStore,
      clientPrincipals: identity,
      entityCache,
      isLiveExtension: async () => false,
    });
    /** Redeem a credential then build the caller the RPC server would admit. */
    const connect = async (token: string, deviceKey?: string) => {
      const paired = await redeem(token, {
        transport: deviceKey ? { kind: "iroh", deviceKey } : { kind: "local" },
      });
      if (!paired) return null;
      const caller = createVerifiedCaller(
        paired.callerId,
        "client",
        resolveCodeIdentity(entityCache, paired.callerId) ?? undefined,
        null,
        paired.subject
      );
      return { paired, caller, admitted: membership.has(paired.subject.userId, workspaceId) };
    };
    return { identity, entityCache, principals, gate, connect, membership };
  }

  return { hub, alice, bob, system, shared, attest, workspaceServer };
}

describe("hub-attested client principals across workspaces", () => {
  it("mints at System, redeems in another workspace, and checks capabilities live", async () => {
    const { hub, alice, system, shared, attest, workspaceServer } = setup();
    attest();
    const { token } = hub.mintClientCredential({ principalId: PRINCIPAL, deviceKey: DEVICE_KEY });
    const systemServer = workspaceServer(system);
    const sharedServer = workspaceServer(shared);

    // The shared workspace never saw the attestation; it admits from the hub's row.
    const connection = await sharedServer.connect(token, DEVICE_KEY);
    expect(connection?.paired).toEqual({
      callerId: PRINCIPAL,
      callerKind: "client",
      subject: { userId: alice.id, handle: "alice" },
      authorizedBy: "shell:dev_alice",
    });
    expect(connection?.admitted).toBe(true);
    const record = sharedServer.entityCache.resolveActive(PRINCIPAL);
    expect(record).toMatchObject({
      kind: "client",
      activeBuildKey: "bk1",
      activeExecutionDigest: DIGEST,
      source: { repoPath: "clients/app", effectiveVersion: "v1" },
    });
    expect(
      await sharedServer.gate(
        connection!.caller,
        (connection!.paired as { authorizedBy?: string }).authorizedBy
      )
    ).toBe(true);
    expect(hasClientCapability(sharedServer.identity, PRINCIPAL, "device-session")).toBe(true);
    expect(hasClientCapability(sharedServer.identity, PRINCIPAL, "other" as never)).toBe(false);

    // Each workspace derives its own routed context for the same principal.
    await systemServer.connect(token, DEVICE_KEY);
    expect(systemServer.entityCache.resolveContext(PRINCIPAL)).not.toBe(
      sharedServer.entityCache.resolveContext(PRINCIPAL)
    );

    // A credential bound to this device key is useless from another endpoint or over loopback.
    expect(await sharedServer.connect(token, "c".repeat(64))).toBeNull();
    expect(await sharedServer.connect(token)).toBeNull();
  });

  it("refuses another user's device in a workspace the user is not a member of", async () => {
    const { hub, bob, shared, attest, workspaceServer } = setup();
    attest({ principalId: "client:app:desktop:dev_bob", userId: bob.id, deviceId: "dev_bob" });
    const { token } = hub.mintClientCredential({
      principalId: "client:app:desktop:dev_bob",
      deviceKey: "b".repeat(64),
    });
    const sharedServer = workspaceServer(shared);
    const connection = await sharedServer.connect(token, "b".repeat(64));
    expect(connection?.paired.subject.userId).toBe(bob.id);
    // The entry gate (membership.has on the redeemed subject) and every later frame refuse him.
    expect(connection?.admitted).toBe(false);
    expect(
      await sharedServer.gate(
        connection!.caller,
        (connection!.paired as { authorizedBy?: string }).authorizedBy
      )
    ).toBe(false);
  });

  it("closes a session whose principal was re-attested with a new build digest", async () => {
    const { hub, shared, attest, workspaceServer } = setup();
    attest();
    const { token } = hub.mintClientCredential({ principalId: PRINCIPAL, deviceKey: DEVICE_KEY });
    const sharedServer = workspaceServer(shared);
    const connection = await sharedServer.connect(token, DEVICE_KEY);
    expect(await sharedServer.gate(connection!.caller)).toBe(true);

    attest({ buildKey: "bk2", executionDigest: "e".repeat(64) });

    // This workspace saw no event: the next frame still ends the stale session...
    expect(await sharedServer.gate(connection!.caller)).toBe(false);
    // ...and the old credential no longer redeems, while a fresh one does.
    expect(await sharedServer.connect(token, DEVICE_KEY)).toBeNull();
    const fresh = hub.mintClientCredential({ principalId: PRINCIPAL, deviceKey: DEVICE_KEY });
    const next = await sharedServer.connect(fresh.token, DEVICE_KEY);
    expect(await sharedServer.gate(next!.caller)).toBe(true);
    expect(sharedServer.entityCache.resolveActive(PRINCIPAL)?.activeExecutionDigest).toBe(
      "e".repeat(64)
    );
  });

  it("revocation closes live sessions through the close-principals route and survives a restart", async () => {
    const { hub, shared, attest, workspaceServer } = setup();
    attest();
    const { token } = hub.mintClientCredential({ principalId: PRINCIPAL, deviceKey: DEVICE_KEY });
    const sharedServer = workspaceServer(shared);
    const connection = await sharedServer.connect(token, DEVICE_KEY);

    const retired: Array<[string, string | undefined, string | undefined]> = [];
    const route = createCloseClientPrincipalsRoute({
      retireClientPrincipalSessions: createClientSessionRetirer({
        principals: sharedServer.principals,
        rpc: () => ({
          getPrincipalConnections: () => [{}] as never,
          retireCaller: async (id, kind, reason) => {
            retired.push([id, kind, reason]);
          },
        }),
      }),
    });
    const revoked = hub.revokeClientPrincipals({ deviceId: "dev_alice" }, "device revoked");
    expect(revoked).toEqual([PRINCIPAL]);

    let body = "";
    await route.handler(
      Object.assign(
        (async function* () {
          yield Buffer.from(JSON.stringify({ principalIds: revoked, reason: "trust-revoked" }));
        })(),
        {}
      ) as never,
      {
        writeHead: () => undefined,
        end: (chunk: string) => {
          body = chunk;
        },
      } as never,
      {}
    );
    expect(JSON.parse(body)).toEqual({ closed: 1 });
    expect(retired).toEqual([[PRINCIPAL, "client", "trust-revoked"]]);
    expect(sharedServer.entityCache.resolveActive(PRINCIPAL)).toBeNull();
    expect(await sharedServer.gate(connection!.caller)).toBe(false);
    expect(hasClientCapability(sharedServer.identity, PRINCIPAL, "device-session")).toBe(false);

    // A workspace restarted after the revoke has an empty cache and still refuses the credential,
    // even if it never received the close event.
    const restarted = workspaceServer(shared);
    expect(await restarted.connect(token, DEVICE_KEY)).toBeNull();
    expect(restarted.entityCache.resolveActive(PRINCIPAL)).toBeNull();
  });
});
