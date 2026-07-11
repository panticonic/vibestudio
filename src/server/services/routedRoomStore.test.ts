import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceRoutedRoom, RoutedRoomStore } from "./routedRoomStore.js";
import { PairingActivationStore } from "./pairingActivationStore.js";

const DEVICE_ID = `dev_${"d".repeat(24)}`;
const CODE_HASH = "a".repeat(64);

function statePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "routed-room-store-")), "routes.json");
}

describe("RoutedRoomStore", () => {
  it("persists exact routes and atomically promotes an invite across reopen", () => {
    const filePath = statePath();
    const first = new RoutedRoomStore(filePath);
    first.upsert({
      kind: "invite",
      codeHash: CODE_HASH,
      room: "room-invite",
      expiresAt: 2_000_000_000_000,
    });
    first.upsert({ kind: "user", userId: `usr_${"u".repeat(24)}`, room: "room-user" });

    const promoted = first.promoteInvite(CODE_HASH, DEVICE_ID);
    expect(promoted.route).toEqual({
      kind: "device",
      purpose: "control",
      deviceId: DEVICE_ID,
      room: "room-invite",
    });
    expect(promoted.replacedDeviceRoute).toBeNull();

    const reopened = new RoutedRoomStore(filePath);
    expect(reopened.list()).toEqual([
      { kind: "device", purpose: "control", deviceId: DEVICE_ID, room: "room-invite" },
      { kind: "user", userId: `usr_${"u".repeat(24)}`, room: "room-user" },
    ]);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("keeps the previous durable and live route when replacement arming fails", async () => {
    const store = new RoutedRoomStore(statePath());
    const previous = {
      kind: "device" as const,
      purpose: "workspace" as const,
      deviceId: DEVICE_ID,
      room: "room-previous",
    };
    const replacement = { ...previous, room: "room-replacement" };
    const liveRooms = new Map([[`workspace:${DEVICE_ID}`, previous.room]]);
    store.upsert(previous);
    const ingress = {
      armRoom: vi.fn(async () => {
        throw new Error("signaling unavailable");
      }),
      disarmRoom: vi.fn(async () => undefined),
    };

    await expect(
      replaceRoutedRoom(store, liveRooms, replacement, ingress, { deviceId: DEVICE_ID })
    ).rejects.toThrow("signaling unavailable");

    expect(store.get(`workspace:${DEVICE_ID}`)).toEqual(previous);
    expect(liveRooms.get(`workspace:${DEVICE_ID}`)).toBe(previous.room);
    expect(ingress.disarmRoom).not.toHaveBeenCalled();
  });

  it("commits an armed replacement before disarming the previous room", async () => {
    const store = new RoutedRoomStore(statePath());
    const previous = {
      kind: "device" as const,
      purpose: "workspace" as const,
      deviceId: DEVICE_ID,
      room: "room-previous",
    };
    const replacement = { ...previous, room: "room-replacement" };
    const key = `workspace:${DEVICE_ID}`;
    const liveRooms = new Map([[key, previous.room]]);
    store.upsert(previous);
    const ingress = {
      armRoom: vi.fn(async () => {
        expect(store.get(key)).toEqual(previous);
        expect(liveRooms.get(key)).toBe(previous.room);
      }),
      disarmRoom: vi.fn(async (room: string) => {
        expect(room).toBe(previous.room);
        expect(store.get(key)).toEqual(replacement);
        expect(liveRooms.get(key)).toBe(replacement.room);
      }),
    };

    await replaceRoutedRoom(store, liveRooms, replacement, ingress, { deviceId: DEVICE_ID });

    expect(ingress.armRoom).toHaveBeenCalledWith(replacement.room, { deviceId: DEVICE_ID });
    expect(ingress.disarmRoom).toHaveBeenCalledOnce();
  });

  it("rejects corrupt, unknown, duplicate-key, and duplicate-room state", () => {
    const invalidStates: unknown[] = [
      { schemaVersion: 0, routes: [] },
      { schemaVersion: 1, routes: [], legacy: true },
      {
        schemaVersion: 1,
        routes: [
          { kind: "device", purpose: "control", deviceId: DEVICE_ID, room: "room-one" },
          { kind: "device", purpose: "control", deviceId: DEVICE_ID, room: "room-two" },
        ],
      },
      {
        schemaVersion: 1,
        routes: [
          { kind: "device", purpose: "control", deviceId: DEVICE_ID, room: "same-room" },
          { kind: "invite", codeHash: CODE_HASH, room: "same-room", expiresAt: 123 },
        ],
      },
    ];
    for (const invalid of invalidStates) {
      const filePath = statePath();
      fs.writeFileSync(filePath, JSON.stringify(invalid));
      expect(() => new RoutedRoomStore(filePath)).toThrow(/canonical schema/u);
    }
    const filePath = statePath();
    fs.writeFileSync(filePath, "{truncated");
    expect(() => new RoutedRoomStore(filePath)).toThrow(/unreadable/u);
  });

  it("fails instead of assigning one room to multiple principals", () => {
    const store = new RoutedRoomStore(statePath());
    store.upsert({
      kind: "device",
      purpose: "control",
      deviceId: DEVICE_ID,
      room: "owned-room",
    });
    expect(() =>
      store.upsert({
        kind: "invite",
        codeHash: CODE_HASH,
        room: "owned-room",
        expiresAt: 123,
      })
    ).toThrow(/already owned/u);
  });

  it("resumes pair → promotion after a child restart and preserves the reconnect room", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routed-room-restart-"));
    const routesPath = path.join(root, "routes.json");
    const activationsPath = path.join(root, "activations.json");
    const beforeRestart = new RoutedRoomStore(routesPath);
    beforeRestart.upsert({
      kind: "invite",
      codeHash: CODE_HASH,
      room: "stable-reconnect-room",
      expiresAt: 2_000_000_000_000,
    });
    const proposed = new PairingActivationStore(activationsPath).prepare(
      CODE_HASH,
      2_000_000_000_000
    );

    // Process boundary: both stores are reopened from disk before the child
    // acknowledges route promotion.
    const restartedRoutes = new RoutedRoomStore(routesPath);
    const restartedActivations = new PairingActivationStore(activationsPath);
    expect(restartedActivations.get(CODE_HASH)).toEqual(proposed);
    restartedRoutes.promoteInvite(CODE_HASH, proposed.deviceId);

    expect(new RoutedRoomStore(routesPath).list()).toEqual([
      {
        kind: "device",
        purpose: "control",
        deviceId: proposed.deviceId,
        room: "stable-reconnect-room",
      },
    ]);
  });
});
