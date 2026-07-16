import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  replaceRoutedRoom,
  routedRoomKey,
  RoutedRoomStore,
  workspaceReachPaths,
} from "./routedRoomStore.js";

const DEVICE_ID = `dev_${"d".repeat(24)}`;
const OTHER_DEVICE_ID = `dev_${"e".repeat(24)}`;

function statePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "routed-room-store-")), "routes.json");
}

describe("RoutedRoomStore", () => {
  it("persists and reopens the device-owned workspace route", () => {
    const filePath = statePath();
    const first = new RoutedRoomStore(filePath);
    first.upsert({ kind: "device", deviceId: DEVICE_ID, room: "room-device" });

    expect(new RoutedRoomStore(filePath).list()).toEqual([
      { kind: "device", deviceId: DEVICE_ID, room: "room-device" },
    ]);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({ schemaVersion: 3 });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("keys the route by its paired device", () => {
    expect(routedRoomKey({ kind: "device", deviceId: DEVICE_ID, room: "room-device" })).toBe(
      `device:${DEVICE_ID}`
    );
  });

  it("keeps the previous durable route when replacement arming fails", async () => {
    const store = new RoutedRoomStore(statePath());
    const previous = {
      kind: "device" as const,
      deviceId: DEVICE_ID,
      room: "room-previous",
    };
    const replacement = { ...previous, room: "room-replacement" };
    store.upsert(previous);
    const ingress = {
      armRoom: vi.fn(async () => {
        throw new Error("signaling unavailable");
      }),
      disarmRoom: vi.fn(async () => undefined),
    };

    await expect(replaceRoutedRoom(store, replacement, ingress)).rejects.toThrow(
      "signaling unavailable"
    );

    expect(store.get(`device:${DEVICE_ID}`)).toEqual(previous);
    expect(ingress.disarmRoom).not.toHaveBeenCalled();
  });

  it("commits an armed replacement before disarming the previous room", async () => {
    const store = new RoutedRoomStore(statePath());
    const previous = {
      kind: "device" as const,
      deviceId: DEVICE_ID,
      room: "room-previous",
    };
    const replacement = { ...previous, room: "room-replacement" };
    const key = `device:${DEVICE_ID}`;
    store.upsert(previous);
    const ingress = {
      armRoom: vi.fn(async () => {
        expect(store.get(key)).toEqual(previous);
      }),
      disarmRoom: vi.fn(async (room: string) => {
        expect(room).toBe(previous.room);
        expect(store.get(key)).toEqual(replacement);
      }),
    };

    await replaceRoutedRoom(store, replacement, ingress);

    expect(ingress.armRoom).toHaveBeenCalledWith(replacement.room, { deviceId: DEVICE_ID });
    expect(ingress.disarmRoom).toHaveBeenCalledOnce();
  });

  it("disarms a newly armed room when the durable commit is rejected", async () => {
    const store = new RoutedRoomStore(statePath());
    const previous = { kind: "device" as const, deviceId: DEVICE_ID, room: "room-previous" };
    store.upsert(previous);
    store.upsert({ kind: "device", deviceId: OTHER_DEVICE_ID, room: "room-owned" });
    const ingress = {
      armRoom: vi.fn(async () => undefined),
      disarmRoom: vi.fn(async () => undefined),
    };

    await expect(
      replaceRoutedRoom(store, { ...previous, room: "room-owned" }, ingress)
    ).rejects.toThrow(/already owned/u);

    expect(store.get(`device:${DEVICE_ID}`)).toEqual(previous);
    expect(ingress.disarmRoom).toHaveBeenCalledWith("room-owned");
  });

  it("rejects old, unknown, duplicate-key, and duplicate-room state", () => {
    const invalidStates: unknown[] = [
      { schemaVersion: 1, routes: [] },
      { schemaVersion: 2, routes: [], legacy: true },
      {
        schemaVersion: 3,
        routes: [{ kind: "device", purpose: "workspace", deviceId: DEVICE_ID, room: "room-one" }],
      },
      {
        schemaVersion: 3,
        routes: [{ kind: "invite", codeHash: "a".repeat(64), room: "room-invite", expiresAt: 123 }],
      },
      {
        schemaVersion: 3,
        routes: [{ kind: "user", userId: `usr_${"u".repeat(24)}`, room: "room-user" }],
      },
      {
        schemaVersion: 3,
        routes: [
          { kind: "device", deviceId: DEVICE_ID, room: "room-one" },
          { kind: "device", deviceId: DEVICE_ID, room: "room-two" },
        ],
      },
      {
        schemaVersion: 3,
        routes: [
          { kind: "device", deviceId: DEVICE_ID, room: "same-room" },
          { kind: "device", deviceId: OTHER_DEVICE_ID, room: "same-room" },
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
    store.upsert({ kind: "device", deviceId: DEVICE_ID, room: "owned-room" });
    expect(() =>
      store.upsert({ kind: "device", deviceId: OTHER_DEVICE_ID, room: "owned-room" })
    ).toThrow(/already owned/u);
  });

  it("exposes only the identity and route files under workspace reach", () => {
    expect(Object.keys(workspaceReachPaths("example")).sort()).toEqual([
      "identityFile",
      "root",
      "routesFile",
    ]);
  });
});
