import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { UserStore } from "@vibestudio/identity/userStore";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { DEFAULT_PAIRING_CODE_TTL_MS, DeviceAuthStore } from "./deviceAuthStore.js";

/**
 * Build a hub-side store over an in-memory identity DB with a seeded root user.
 * Devices/agent credentials FK to a user, so every device/pairing test needs an
 * owner. The store persists only the server id to `serverIdPath`; devices,
 * agent credentials, and pairing codes live in the DB. `db`/`serverIdPath` are
 * returned so a test can re-open a fresh store over the SAME durable state
 * (the store keeps no device state of its own).
 */
function makeStore(now?: () => number): {
  store: DeviceAuthStore;
  db: IdentityDb;
  userId: string;
  workspaceId: string;
  serverIdPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-device-auth-"));
  const serverIdPath = path.join(dir, "auth", "server-id.json");
  const databasePath = path.join(dir, "identity.db");
  const nowOpt = now ? { now } : {};
  const central = new CentralDataManager({ databasePath, ...nowOpt });
  const workspaceId = central.addWorkspace("test").workspaceId;
  central.close();
  const db = new IdentityDb({ path: databasePath, readOnly: false, ...nowOpt });
  const userId = new UserStore(db, now).createRoot({ handle: "root", displayName: "Root" }).id;
  const store = new DeviceAuthStore({ db, serverIdPath, ...nowOpt });
  return { store, db, userId, workspaceId, serverIdPath };
}

describe("DeviceAuthStore", () => {
  it("pairs a device, persists only refresh-token hashes, and refresh-validates after reload", () => {
    let now = 1000;
    const { store, db, userId, workspaceId, serverIdPath } = makeStore(() => now);

    const code = store.createPairingCode(undefined, { workspaceId, userId });
    const credential = store.completePairing({
      code,
      label: "Phone",
      platform: "mobile",
    });
    expect(credential.deviceId).toMatch(/^dev_/);
    expect(credential.refreshToken).toBeTruthy();
    expect(credential.userId).toBe(userId);
    expect(store.completePairing.bind(store, { code })).toThrow(/invalid or expired/i);

    // The server id lives in the JSON sibling; the DB row keeps only the sha256
    // hash of the refresh token — never the clear secret — bound to its owner.
    expect(JSON.parse(fs.readFileSync(serverIdPath, "utf8")).serverId).toMatch(/^srv_/);
    const stored = db.getDevice(credential.deviceId);
    expect(stored?.userId).toBe(userId);
    expect(stored?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.refreshTokenHash).not.toBe(credential.refreshToken);

    const reloaded = new DeviceAuthStore({ db, serverIdPath, now: () => now });
    now = 2000;
    const device = reloaded.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(device.label).toBe("Phone");
    expect(reloaded.listDevices()[0]!.lastUsedAt).toBe(2000);
  });

  it("rejects expired, invalid, and revoked credentials", () => {
    let now = 1000;
    const { store, userId, workspaceId } = makeStore(() => now);

    const expiredCode = store.createPairingCode(10, { workspaceId, userId });
    now = 1011;
    expect(() => store.completePairing({ code: expiredCode })).toThrow(/invalid or expired/i);

    const credential = store.issueDevice({ userId, label: "Desktop", platform: "electron" });
    expect(() => store.validateRefresh(credential.deviceId, "wrong-refresh-token")).toThrow(
      /invalid/i
    );

    expect(store.revokeDevice(credential.deviceId)).toBe(true);
    expect(store.revokeDevice(credential.deviceId)).toBe(false);
    expect(() => store.validateRefresh(credential.deviceId, credential.refreshToken)).toThrow(
      /not paired/i
    );
  });

  it("throttles lastUsedAt persistence for a churny reconnecting device", () => {
    let now = 1000;
    const { store, db, userId } = makeStore(() => now);
    const credential = store.issueDevice({ userId, label: "Desktop" });
    const touch = vi.spyOn(db, "touchDevice");

    // First refresh persists (previous lastUsedAt was unset).
    now = 100_000;
    store.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(touch).toHaveBeenCalledTimes(1);

    // A reconnect within the persist interval updates memory but NOT disk.
    now = 101_000;
    store.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(touch).toHaveBeenCalledTimes(1);

    // Past the interval it persists again.
    now = 200_000;
    store.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it("fails loud with the path and a recovery hint when server-id state is corrupt", () => {
    const { db, serverIdPath } = makeStore();
    fs.writeFileSync(serverIdPath, "{ this is not valid json ", "utf8");
    expect(() => new DeviceAuthStore({ db, serverIdPath })).toThrow(/unsupported server id state/i);
    expect(() => new DeviceAuthStore({ db, serverIdPath })).toThrow(
      new RegExp(serverIdPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    expect(() => new DeviceAuthStore({ db, serverIdPath })).toThrow(/delete it to initialize/i);
  });

  it("defaults pairing codes to a one hour lifetime", () => {
    let now = 1000;
    const { store, userId, workspaceId } = makeStore(() => now);

    const code = store.createPairingCode(undefined, { workspaceId, userId });
    now += DEFAULT_PAIRING_CODE_TTL_MS - 1;
    expect(store.completePairing({ code }).userId).toBe(userId);

    const expiredCode = store.createPairingCode(undefined, { workspaceId, userId });
    now += DEFAULT_PAIRING_CODE_TTL_MS + 1;
    expect(() => store.completePairing({ code: expiredCode })).toThrow(/invalid or expired/i);
  });

  it("keeps pending pairing codes and their absolute deadline across hub restart", () => {
    const { store, db, userId, workspaceId, serverIdPath } = makeStore(() => 1000);
    const code = store.createPairingCode(60_000, { workspaceId, userId });
    const expiresAt = store.pairingCodeExpiresAt(code);

    const restarted = new DeviceAuthStore({ db, serverIdPath, now: () => 2000 });
    expect(restarted.pairingCodeExpiresAt(code)).toBe(expiresAt);
    expect(restarted.completePairing({ code }).userId).toBe(userId);
  });

  it("durably replays one proposed issuance across the promotion crash window", () => {
    let now = 1000;
    const { store, db, userId, workspaceId, serverIdPath } = makeStore(() => now);
    const code = store.createPairingCode(60_000, { workspaceId, userId });
    const proposedCredential = {
      deviceId: `dev_${"p".repeat(24)}`,
      refreshToken: "q".repeat(43),
    };
    const first = store.completePairing({ code, proposedCredential, label: "Phone" });

    const restarted = new DeviceAuthStore({ db, serverIdPath, now: () => now });
    expect(
      restarted.completePairing({ code, proposedCredential, label: "Phone after retry" })
    ).toEqual(first);
    expect(() =>
      restarted.completePairing({
        code,
        proposedCredential: { ...proposedCredential, refreshToken: "x".repeat(43) },
      })
    ).toThrow(/invalid or expired/i);

    now = 61_000;
    expect(() => restarted.completePairing({ code, proposedCredential })).toThrow(
      /invalid or expired/i
    );
  });

  it("creates root only after consuming a live root-bootstrap code", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-root-pairing-"));
    const databasePath = path.join(dir, "identity.db");
    const central = new CentralDataManager({ databasePath });
    const workspaceId = central.addWorkspace("test").workspaceId;
    central.close();
    const db = new IdentityDb({ path: databasePath, readOnly: false });
    const users = new UserStore(db);
    const store = new DeviceAuthStore({ db, serverIdPath: path.join(dir, "server-id.json") });
    let createCalls = 0;
    const createRootUser = () => {
      createCalls += 1;
      return users.createRoot({ handle: "root", displayName: "Root" }).id;
    };

    expect(() => store.completePairing({ code: "not-a-code", createRootUser })).toThrow(
      /invalid or expired/i
    );
    expect(createCalls).toBe(0);
    expect(db.hasUsers()).toBe(false);

    const wrongIntent = store.createPairingCode(60_000, {
      workspaceId,
      intent: "pair-device",
    });
    expect(() => store.completePairing({ code: wrongIntent, createRootUser })).toThrow(
      /not bound/i
    );
    expect(createCalls).toBe(0);
    expect(db.hasUsers()).toBe(false);

    const code = store.createPairingCode(60_000, { workspaceId, intent: "root-bootstrap" });
    expect(() =>
      store.completePairing({
        code,
        createRootUser: () => {
          users.createRoot({ handle: "root", displayName: "Root" });
          throw new Error("injected device-issuance boundary failure");
        },
      })
    ).toThrow("injected device-issuance boundary failure");
    expect(db.hasUsers()).toBe(false);

    const credential = store.completePairing({ code, createRootUser });
    expect(createCalls).toBe(1);
    expect(users.getUser(credential.userId)?.role).toBe("root");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels an unreturned code and rolls back its unactivated invited user", () => {
    const { store, db, userId, workspaceId } = makeStore(() => 1000);
    const users = new UserStore(db, () => 1000);
    const invited = users.inviteUser({
      handle: "mara",
      displayName: "Mara",
      role: "member",
      createdBy: userId,
    });
    const code = store.createPairingCode(60_000, {
      workspaceId,
      userId: invited.id,
      intent: "invite-user",
    });

    expect(store.cancelPairingCode(code)).toBe(true);
    expect(() => store.completePairing({ code })).toThrow(/invalid or expired/i);
    expect(users.rollbackInvite(invited.id)).toBe(true);
    expect(users.getByHandle("mara")).toBeNull();
    expect(
      users.inviteUser({
        handle: "mara",
        displayName: "Mara",
        role: "member",
        createdBy: userId,
      }).handle
    ).toBe("mara");
  });
});

describe("DeviceAuthStore agent credentials (§3.2)", () => {
  it("mints an entity-scoped credential, persists only the token hash, and validates the secret", () => {
    let now = 1000;
    const { store, db, userId, serverIdPath } = makeStore(() => now);

    const { agentId, agentToken } = store.mintAgentCredential({
      entityId: "session:s1",
      contextId: "ctx-abc",
      channelId: "chan-1",
      userId,
    });
    expect(agentId).toMatch(/^agt_/);
    expect(agentToken).toBe(`agent:${agentId}:${agentToken.split(":")[2]}`);
    const secret = agentToken.split(":")[2]!;

    // Only the sha256 hash is persisted — never the clear secret — plus the
    // spawning user's id (inherited into the binding, WP0 §3.3).
    const storedAgent = db.getAgentCredential(agentId);
    expect(storedAgent?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedAgent?.tokenHash).not.toBe(secret);
    expect(storedAgent?.userId).toBe(userId);

    // Validation returns the binding (no secret material) after reload.
    now = 2000;
    const reloaded = new DeviceAuthStore({ db, serverIdPath, now: () => now });
    const binding = reloaded.validateAgentToken(agentId, secret);
    expect(binding).toEqual({
      agentId,
      entityId: "session:s1",
      contextId: "ctx-abc",
      channelId: "chan-1",
      userId,
    });
    expect(reloaded.validateAgentToken(agentId, "wrong-secret")).toBeNull();
    expect(reloaded.validateAgentToken("agt_missing", secret)).toBeNull();
  });

  it("honors expiry and revocation", () => {
    let now = 1000;
    const { store, userId } = makeStore(() => now);

    const expiring = store.mintAgentCredential({
      entityId: "e1",
      contextId: "c1",
      channelId: "ch1",
      userId,
      ttlMs: 100,
    });
    const secret = expiring.agentToken.split(":")[2]!;
    expect(store.validateAgentToken(expiring.agentId, secret)).not.toBeNull();
    now = 1101;
    expect(store.validateAgentToken(expiring.agentId, secret)).toBeNull();

    now = 1000;
    const live = store.mintAgentCredential({
      entityId: "e2",
      contextId: "c2",
      channelId: "ch2",
      userId,
    });
    const liveSecret = live.agentToken.split(":")[2]!;
    expect(store.revokeAgentCredential(live.agentId)).toBe(true);
    expect(store.revokeAgentCredential(live.agentId)).toBe(false);
    expect(store.validateAgentToken(live.agentId, liveSecret)).toBeNull();
  });

  it("revokes every outstanding credential for a retired entity", () => {
    const { store, userId } = makeStore(() => 1000);
    const a = store.mintAgentCredential({
      entityId: "ent",
      contextId: "c",
      channelId: "ch",
      userId,
    });
    const b = store.mintAgentCredential({
      entityId: "ent",
      contextId: "c",
      channelId: "ch",
      userId,
    });
    const other = store.mintAgentCredential({
      entityId: "keep",
      contextId: "c",
      channelId: "ch",
      userId,
    });

    const revoked = store.revokeAgentCredentialsForEntity("ent");
    expect(revoked.sort()).toEqual([a.agentId, b.agentId].sort());
    expect(store.validateAgentToken(a.agentId, a.agentToken.split(":")[2]!)).toBeNull();
    expect(store.validateAgentToken(b.agentId, b.agentToken.split(":")[2]!)).toBeNull();
    // The unrelated entity's credential is untouched.
    expect(store.validateAgentToken(other.agentId, other.agentToken.split(":")[2]!)).not.toBeNull();
  });
});

describe("DeviceAuthStore hub/child ownership", () => {
  it("rejects malformed or pre-cutover server-id state instead of replacing it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-server-id-state-"));
    const serverIdPath = path.join(dir, "server-id.json");
    const db = new IdentityDb({ path: ":memory:", readOnly: false });

    for (const invalid of [
      "not-json",
      JSON.stringify({ serverId: "legacy-server-id" }),
      JSON.stringify({ serverId: `srv_${"s".repeat(24)}`, room: "retired-room" }),
    ]) {
      fs.writeFileSync(serverIdPath, invalid);
      expect(() => new DeviceAuthStore({ db, serverIdPath })).toThrow(
        /Unsupported server id state/
      );
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects legacy identity schemas instead of migrating persisted transport rooms", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-legacy-identity-"));
    const dbPath = path.join(dir, "identity.db");
    new IdentityDb({ path: dbPath, readOnly: false }).close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE devices ADD COLUMN room TEXT");
    raw.close();
    const before = fs.readFileSync(dbPath);

    expect(() => new IdentityDb({ path: dbPath, readOnly: false })).toThrow(
      /Unsupported identity schema.*table:devices definition is not canonical/i
    );
    expect(fs.readFileSync(dbPath)).toEqual(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("enforces the real hub-writer/read-only-child boundary end to end", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-readonly-child-"));
    const dbPath = path.join(dir, "identity.db");
    const serverIdPath = path.join(dir, "server-id.json");
    const central = new CentralDataManager({ databasePath: dbPath });
    const workspaceId = central.addWorkspace("test").workspaceId;
    central.close();
    const hubDb = new IdentityDb({ path: dbPath, readOnly: false });
    const userId = new UserStore(hubDb).createRoot({ handle: "root", displayName: "Root" }).id;
    const hub = new DeviceAuthStore({ db: hubDb, serverIdPath });
    const device = hub.issueDevice({ userId, label: "Laptop" });
    const agent = hub.mintAgentCredential({
      entityId: "session:one",
      contextId: "ctx",
      channelId: "channel",
      userId,
    });

    const childDb = new IdentityDb({ path: dbPath, readOnly: true });
    const child = new DeviceAuthStore({ db: childDb, serverIdPath });
    expect(child.validateRefresh(device.deviceId, device.refreshToken).userId).toBe(userId);
    const [, agentId, secret] = agent.agentToken.split(":");
    expect(child.validateAgentToken(agentId!, secret!)).toMatchObject({
      userId,
      entityId: "session:one",
    });

    expect(() => child.createPairingCode(60_000, { workspaceId, userId })).toThrow(/read-only/i);
    expect(() =>
      child.mintAgentCredential({
        entityId: "session:two",
        contextId: "ctx",
        channelId: "channel",
        userId,
      })
    ).toThrow(/read-only/i);
    expect(() => child.revokeDevice(device.deviceId)).toThrow(/read-only/i);

    childDb.close();
    hubDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
