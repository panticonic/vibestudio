import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PAIRING_CODE_TTL_MS, DeviceAuthStore } from "./deviceAuthStore.js";

function tempFile(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-device-auth-")),
    "auth",
    "devices.json"
  );
}

describe("DeviceAuthStore", () => {
  it("pairs a device, persists only refresh-token hashes, and refresh-validates after reload", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);

    const code = store.createPairingCode();
    expect(store.hasPendingPairingCode(code)).toBe(true);
    const credential = store.completePairing({
      code,
      label: "Phone",
      platform: "mobile",
    });
    expect(store.hasPendingPairingCode(code)).toBe(false);

    expect(credential.deviceId).toMatch(/^dev_/);
    expect(credential.refreshToken).toBeTruthy();
    expect(store.completePairing.bind(store, { code })).toThrow(/invalid or expired/i);

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(raw.serverId).toMatch(/^srv_/);
    expect(raw.devices).toHaveLength(1);
    expect(raw.devices[0].refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(raw)).not.toContain(credential.refreshToken);

    const reloaded = new DeviceAuthStore(filePath, () => now);
    now = 2000;
    const device = reloaded.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(device.label).toBe("Phone");
    expect(reloaded.listDevices()[0]!.lastUsedAt).toBe(2000);
  });

  it("rejects expired, invalid, and revoked credentials", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);

    const expiredCode = store.createPairingCode(10);
    now = 1011;
    expect(() => store.completePairing({ code: expiredCode })).toThrow(/invalid or expired/i);

    const credential = store.issueDevice({ label: "Desktop", platform: "electron" });
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
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);
    const credential = store.issueDevice({ label: "Desktop" });

    // First refresh persists (previous lastUsedAt was unset).
    now = 100_000;
    store.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).devices[0].lastUsedAt).toBe(100_000);

    // A reconnect within the persist interval updates memory but NOT disk.
    now = 101_000;
    store.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(store.listDevices()[0]!.lastUsedAt).toBe(101_000);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).devices[0].lastUsedAt).toBe(100_000);

    // Past the interval it persists again.
    now = 200_000;
    store.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).devices[0].lastUsedAt).toBe(200_000);
  });

  it("fails loud with the path and a recovery hint when the store JSON is corrupt", () => {
    const filePath = tempFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ this is not valid json ", "utf8");
    expect(() => new DeviceAuthStore(filePath)).toThrow(/corrupt/i);
    expect(() => new DeviceAuthStore(filePath)).toThrow(
      new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    expect(() => new DeviceAuthStore(filePath)).toThrow(/recovery/i);
  });

  it("defaults pairing codes to a one hour lifetime", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);

    const code = store.createPairingCode();
    now += DEFAULT_PAIRING_CODE_TTL_MS - 1;
    expect(store.hasPendingPairingCode(code)).toBe(true);

    now += 2;
    expect(store.hasPendingPairingCode(code)).toBe(false);
    expect(() => store.completePairing({ code })).toThrow(/invalid or expired/i);
  });
});

describe("DeviceAuthStore agent credentials (§3.2)", () => {
  it("mints an entity-scoped credential, persists only the token hash, and validates the secret", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);

    const { agentId, agentToken } = store.mintAgentCredential({
      entityId: "session:s1",
      contextId: "ctx-abc",
      channelId: "chan-1",
    });
    expect(agentId).toMatch(/^agt_/);
    expect(agentToken).toBe(`agent:${agentId}:${agentToken.split(":")[2]}`);
    const secret = agentToken.split(":")[2]!;

    // Only the sha256 hash is persisted — never the clear secret.
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(raw.agents).toHaveLength(1);
    expect(raw.agents[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(raw)).not.toContain(secret);

    // Validation returns the binding (no secret material) after reload.
    now = 2000;
    const reloaded = new DeviceAuthStore(filePath, () => now);
    const binding = reloaded.validateAgentToken(agentId, secret);
    expect(binding).toEqual({
      agentId,
      entityId: "session:s1",
      contextId: "ctx-abc",
      channelId: "chan-1",
    });
    expect(reloaded.validateAgentToken(agentId, "wrong-secret")).toBeNull();
    expect(reloaded.validateAgentToken("agt_missing", secret)).toBeNull();
  });

  it("honors expiry and revocation", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);

    const expiring = store.mintAgentCredential({
      entityId: "e1",
      contextId: "c1",
      channelId: "ch1",
      ttlMs: 100,
    });
    const secret = expiring.agentToken.split(":")[2]!;
    expect(store.validateAgentToken(expiring.agentId, secret)).not.toBeNull();
    now = 1101;
    expect(store.validateAgentToken(expiring.agentId, secret)).toBeNull();

    now = 1000;
    const live = store.mintAgentCredential({ entityId: "e2", contextId: "c2", channelId: "ch2" });
    const liveSecret = live.agentToken.split(":")[2]!;
    expect(store.revokeAgentCredential(live.agentId)).toBe(true);
    expect(store.revokeAgentCredential(live.agentId)).toBe(false);
    expect(store.validateAgentToken(live.agentId, liveSecret)).toBeNull();
  });

  it("revokes every outstanding credential for a retired entity", () => {
    const filePath = tempFile();
    const store = new DeviceAuthStore(filePath, () => 1000);
    const a = store.mintAgentCredential({ entityId: "ent", contextId: "c", channelId: "ch" });
    const b = store.mintAgentCredential({ entityId: "ent", contextId: "c", channelId: "ch" });
    const other = store.mintAgentCredential({ entityId: "keep", contextId: "c", channelId: "ch" });

    const revoked = store.revokeAgentCredentialsForEntity("ent");
    expect(revoked.sort()).toEqual([a.agentId, b.agentId].sort());
    expect(store.validateAgentToken(a.agentId, a.agentToken.split(":")[2]!)).toBeNull();
    expect(store.validateAgentToken(b.agentId, b.agentToken.split(":")[2]!)).toBeNull();
    // The unrelated entity's credential is untouched.
    expect(store.validateAgentToken(other.agentId, other.agentToken.split(":")[2]!)).not.toBeNull();
  });
});

describe("DeviceAuthStore pairing rooms (per-invite rooms, plan §2.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists the invite's room onto the device record across reload and re-tags on redemption", () => {
    const filePath = tempFile();
    const store = new DeviceAuthStore(filePath, () => 1000);
    const redeemed: Array<{ room: string; deviceId: string }> = [];
    store.onPairingRoomRedeemed((room, deviceId) => redeemed.push({ room, deviceId }));

    const code = store.createPairingCode(60_000, { room: "room-invite-1" });
    const credential = store.completePairing({ code, label: "Phone" });

    expect(redeemed).toEqual([{ room: "room-invite-1", deviceId: credential.deviceId }]);
    expect(store.listDevices()[0]!.room).toBe("room-invite-1");

    const reloaded = new DeviceAuthStore(filePath, () => 2000);
    const device = reloaded.listDevices().find((d) => d.deviceId === credential.deviceId);
    expect(device?.room).toBe("room-invite-1");
  });

  it("releases the room when the invite expires unredeemed (proactive timer)", () => {
    vi.useFakeTimers();
    const filePath = tempFile();
    const store = new DeviceAuthStore(filePath);
    const released: string[] = [];
    store.onPairingRoomReleased((room) => released.push(room));

    const code = store.createPairingCode(10_000, { room: "room-expiring" });
    vi.advanceTimersByTime(9_999);
    expect(released).toEqual([]);
    expect(store.hasPendingPairingCode(code)).toBe(true);

    vi.advanceTimersByTime(2);
    expect(released).toEqual(["room-expiring"]);
    expect(store.hasPendingPairingCode(code)).toBe(false);
    // Release fires exactly once even when the dead code is presented again.
    expect(() => store.completePairing({ code })).toThrow(/invalid or expired/i);
    expect(released).toEqual(["room-expiring"]);
  });

  it("releases the room on lazy expiry too (code presented after its TTL)", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);
    const released: string[] = [];
    store.onPairingRoomReleased((room) => released.push(room));

    const code = store.createPairingCode(10, { room: "room-lazy" });
    now = 1011;
    expect(store.hasPendingPairingCode(code)).toBe(false);
    expect(released).toEqual(["room-lazy"]);
  });

  it("does not release the room at TTL once the invite was redeemed", () => {
    vi.useFakeTimers();
    const filePath = tempFile();
    const store = new DeviceAuthStore(filePath);
    const released: string[] = [];
    store.onPairingRoomReleased((room) => released.push(room));

    const code = store.createPairingCode(10_000, { room: "room-redeemed" });
    store.completePairing({ code, label: "Phone" });
    vi.advanceTimersByTime(20_000);
    expect(released).toEqual([]);
  });

  it("releases the device's room on revocation", () => {
    const filePath = tempFile();
    const store = new DeviceAuthStore(filePath, () => 1000);
    const released: string[] = [];
    store.onPairingRoomReleased((room) => released.push(room));

    const code = store.createPairingCode(60_000, { room: "room-revoked" });
    const credential = store.completePairing({ code, label: "Phone" });
    expect(released).toEqual([]);

    expect(store.revokeDevice(credential.deviceId)).toBe(true);
    expect(released).toEqual(["room-revoked"]);
    // Double revoke does not re-fire.
    expect(store.revokeDevice(credential.deviceId)).toBe(false);
    expect(released).toEqual(["room-revoked"]);
  });

  it("guards a live device's room against release while releasing unbound rooms", () => {
    vi.useFakeTimers();
    const filePath = tempFile();
    const store = new DeviceAuthStore(filePath);
    const released: string[] = [];
    store.onPairingRoomReleased((room) => released.push(room));

    const liveCode = store.createPairingCode(60_000, { room: "room-live" });
    store.completePairing({ code: liveCode, label: "Phone" });
    expect(store.listDevices()[0]!.room).toBe("room-live");

    // Pending invite that (incorrectly) shares the live device's room.
    store.createPairingCode(10_000, { room: "room-live" });
    // Pending invite on an unrelated room.
    store.createPairingCode(10_000, { room: "room-idle" });

    vi.advanceTimersByTime(20_000);

    // The live device's room is protected; only the unbound room is released.
    expect(released).toEqual(["room-idle"]);
  });

  it("hasEverPaired reflects durable pairing state, not the pending-code map", () => {
    vi.useFakeTimers();
    const filePath = tempFile();
    const store = new DeviceAuthStore(filePath);
    expect(store.hasEverPaired()).toBe(false);

    // A pending (never-redeemed) invite does not count as "paired".
    const code = store.createPairingCode(10_000, { room: "room-x" });
    expect(store.hasEverPaired()).toBe(false);

    store.completePairing({ code, label: "Phone" });
    expect(store.hasEverPaired()).toBe(true);

    // Persists across reload even after the code has long expired.
    vi.advanceTimersByTime(3_600_000);
    const reloaded = new DeviceAuthStore(filePath);
    expect(reloaded.hasEverPaired()).toBe(true);
  });

  it("codes without rooms never fire room hooks", () => {
    vi.useFakeTimers();
    const filePath = tempFile();
    const store = new DeviceAuthStore(filePath);
    const released: string[] = [];
    const redeemed: string[] = [];
    store.onPairingRoomReleased((room) => released.push(room));
    store.onPairingRoomRedeemed((room) => redeemed.push(room));

    const expiring = store.createPairingCode(10_000);
    const code = store.createPairingCode(10_000);
    const credential = store.completePairing({ code, label: "Desktop" });
    vi.advanceTimersByTime(20_000);
    expect(store.hasPendingPairingCode(expiring)).toBe(false);
    store.revokeDevice(credential.deviceId);
    expect(released).toEqual([]);
    expect(redeemed).toEqual([]);
    expect(store.listDevices()[0]!.room).toBeUndefined();
  });
});
