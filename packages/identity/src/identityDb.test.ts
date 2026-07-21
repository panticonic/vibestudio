import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { IdentityDb } from "./identityDb.js";

describe("identity package schema cut", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unexpected legacy tables instead of retaining them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-identity-schema-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const identity = new IdentityDb({ path: databasePath, readOnly: false });
    identity.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec("CREATE TABLE pairing_rooms (room TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    raw.close();
    const before = fs.readFileSync(databasePath);

    expect(() => new IdentityDb({ path: databasePath, readOnly: false })).toThrow(
      /unexpected \[table:pairing_rooms\]/
    );
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });

  it("does not upgrade or mutate a nonempty pre-cutover identity database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-identity-precut-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const raw = new DatabaseSync(databasePath);
    raw.exec("CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT NOT NULL)");
    raw.prepare("INSERT INTO users (id, handle) VALUES (?, ?)").run("old-user", "keep-me");
    raw.close();
    const before = fs.readFileSync(databasePath);

    expect(() => new IdentityDb({ path: databasePath, readOnly: false })).toThrow(
      /schema version 0 predates production baseline 10/
    );
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(() => new IdentityDb({ path: databasePath, readOnly: true })).toThrow(
      /schema version 0 predates production baseline 10/
    );
    expect(fs.readFileSync(databasePath)).toEqual(before);

    const unchanged = new DatabaseSync(databasePath);
    expect(unchanged.prepare("SELECT * FROM users").all()).toEqual([
      { id: "old-user", handle: "keep-me" },
    ]);
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    unchanged.close();
  });

  it("rejects a missing canonical identity table without recreating it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-identity-missing-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    new IdentityDb({ path: databasePath, readOnly: false }).close();
    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TABLE pairing_codes");
    raw.close();
    const before = fs.readFileSync(databasePath);

    expect(() => new IdentityDb({ path: databasePath, readOnly: false })).toThrow(
      /missing \[table:pairing_codes\]/
    );
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });

  it("persists revocation cleanup work atomically and retries it across restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-identity-cleanup-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const identity = new IdentityDb({ path: databasePath, readOnly: false });
    identity.insertUser({
      id: "usr_alice",
      handle: "alice",
      displayName: "Alice",
      role: "member",
      createdAt: 1,
    });

    expect(identity.revokeUser("usr_alice", 10, ["ws_beta", "ws_alpha", "ws_alpha"])).toBe(true);
    expect(identity.listUserRevocationCleanup("usr_alice")).toEqual([
      { userId: "usr_alice", workspaceId: "ws_alpha", attempts: 0 },
      { userId: "usr_alice", workspaceId: "ws_beta", attempts: 0 },
    ]);
    identity.failUserRevocationCleanup("usr_alice", "ws_alpha", "child unavailable");
    identity.close();

    const restarted = new IdentityDb({ path: databasePath, readOnly: false });
    expect(restarted.listUserRevocationCleanup("usr_alice")[0]).toEqual({
      userId: "usr_alice",
      workspaceId: "ws_alpha",
      attempts: 1,
      lastError: "child unavailable",
    });
    expect(restarted.completeUserRevocationCleanup("usr_alice", "ws_alpha")).toBe(true);
    expect(restarted.completeUserRevocationCleanup("usr_alice", "ws_alpha")).toBe(false);
    expect(restarted.listUserRevocationCleanup("usr_alice")).toEqual([
      { userId: "usr_alice", workspaceId: "ws_beta", attempts: 0 },
    ]);
    restarted.close();
  });

  it("owns invite and promoted device control rooms in the pairing transaction", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-control-rooms-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const central = new CentralDataManager({ databasePath });
    const workspaceId = central.addWorkspace("test").workspaceId;
    central.close();
    const identity = new IdentityDb({ path: databasePath, readOnly: false, now: () => 1_000 });
    identity.insertUser({
      id: "usr_alice",
      handle: "alice",
      displayName: "Alice",
      role: "member",
      createdAt: 1,
    });
    const codeHash = "a".repeat(64);
    identity.insertPairingInvite({
      code: codeHash,
      room: "control-room",
      userId: "usr_alice",
      workspaceId,
      intent: "pair-device",
      createdAt: 1_000,
      expiresAt: 61_000,
    });
    expect(identity.getInviteControlRoom(codeHash)).toEqual({
      kind: "invite",
      room: "control-room",
      codeHash,
      expiresAt: 61_000,
    });
    const conflictingCodeHash = "e".repeat(64);
    expect(() =>
      identity.insertPairingInvite({
        code: conflictingCodeHash,
        room: "control-room",
        userId: "usr_alice",
        workspaceId,
        intent: "pair-device",
        createdAt: 1_000,
        expiresAt: 61_000,
      })
    ).toThrow();
    expect(identity.getPairingCode(conflictingCodeHash)).toBeNull();

    const device = {
      deviceId: `dev_${"d".repeat(24)}`,
      refreshTokenHash: "b".repeat(64),
      userId: "usr_alice",
      label: "Phone",
      createdAt: 1_000,
    };
    const refreshToken = "r".repeat(43);
    const completed = identity.completePairing({
      code: codeHash,
      createDevice: () => ({ device, refreshToken }),
    });
    expect(completed).toEqual({
      device,
      refreshToken,
      controlRoom: "control-room",
      workspaceId,
    });
    expect(identity.getPairingCode(codeHash)).toBeNull();
    expect(identity.listControlRooms()).toEqual([
      { kind: "device", room: "control-room", deviceId: device.deviceId },
    ]);
    expect(
      identity.completePairing({
        code: codeHash,
        createDevice: () => {
          throw new Error("a consumed code must not issue another credential");
        },
      })
    ).toBeNull();

    expect(identity.revokeDevice(device.deviceId, 2_000)?.revokedAt).toBe(2_000);
    expect(identity.listControlRooms()).toEqual([]);
    identity.close();
  });

  it("expires a pairing code and its invite room together", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-control-expiry-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const central = new CentralDataManager({ databasePath });
    const workspaceId = central.addWorkspace("test").workspaceId;
    central.close();
    const identity = new IdentityDb({ path: databasePath, readOnly: false });
    const codeHash = "d".repeat(64);
    identity.insertPairingInvite({
      code: codeHash,
      room: "expiring-room",
      workspaceId,
      intent: "root-bootstrap",
      createdAt: 1,
      expiresAt: 10,
    });

    expect(identity.deleteExpiredPairingInvites(10)).toEqual([
      { kind: "invite", room: "expiring-room", codeHash, expiresAt: 10 },
    ]);
    expect(identity.getPairingCode(codeHash)).toBeNull();
    expect(identity.listControlRooms()).toEqual([]);
    identity.close();
  });
});
