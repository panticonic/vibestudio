import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PAIRING_CODE_TTL_MS, DeviceAuthStore } from "./deviceAuthStore.js";

function tempFile(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-device-auth-")),
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
