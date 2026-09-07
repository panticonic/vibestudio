import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { IdentityDb } from "./identityDb.js";

function restoreV13Membership(db: DatabaseSync): void {
  db.exec(`DROP INDEX membership_by_workspace;
    ALTER TABLE membership RENAME TO membership_current;
    CREATE TABLE membership (
      user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, workspace_id));
    INSERT INTO membership (user_id, workspace_id, added_by, added_at)
      SELECT user_id, workspace_id, added_by, added_at FROM membership_current;
    DROP TABLE membership_current;
    CREATE INDEX membership_by_workspace ON membership(workspace_id)`);
}

describe("identity package schema cut", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades v14 pairing suggestions without changing accounts, devices, memberships, or live invites", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-identity-v14-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const central = new CentralDataManager({ databasePath });
    const workspace = central.addWorkspace("kept", "ws_kept");
    central.close();
    const identity = new IdentityDb({ path: databasePath, readOnly: false, now: () => 10 });
    identity.insertUser({
      id: "usr_kept",
      handle: "kept",
      displayName: "Kept",
      role: "root",
      createdAt: 1,
    });
    identity.addMembership({
      userId: "usr_kept",
      workspaceId: workspace.workspaceId,
      addedBy: "usr_kept",
      addedAt: 1,
      role: "admin",
    });
    identity.upsertDevice({
      deviceId: "dev_kept",
      userId: "usr_kept",
      refreshTokenHash: "token-hash",
      transport: { kind: "local" },
      label: "Kept",
      createdAt: 1,
    });
    const invite = {
      code: "kept-invite",
      userId: "usr_kept",
      workspaceId: workspace.workspaceId,
      intent: "pair-device" as const,
      createdAt: 1,
      expiresAt: 1000,
    };
    identity.insertPairingInvite(invite);
    identity.close();
    const old = new DatabaseSync(databasePath);
    old.exec(`ALTER TABLE pairing_codes RENAME TO pairing_codes_current;
      CREATE TABLE pairing_codes (
        code TEXT PRIMARY KEY, user_id TEXT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        intent TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      INSERT INTO pairing_codes SELECT * FROM pairing_codes_current;
      DROP TABLE pairing_codes_current;
      PRAGMA user_version = 14`);
    const tables = ["users", "devices", "workspaces", "membership", "pairing_codes"];
    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all());
    old.close();

    const migrated = new IdentityDb({ path: databasePath, readOnly: false, now: () => 10 });
    expect(migrated.listPairingCodes()).toEqual([invite]);
    const verified = new DatabaseSync(databasePath);
    expect(tables.map((table) => verified.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(verified.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
    verified.close();
    migrated.insertPairingInvite({
      code: "account-only",
      workspaceId: null,
      intent: "root-bootstrap",
      createdAt: 10,
      expiresAt: 1000,
    });
    migrated.close();
    const reader = new IdentityDb({ path: databasePath, readOnly: true, now: () => 10 });
    expect(
      reader.listPairingCodes().find((entry) => entry.code === "account-only")?.workspaceId
    ).toBeNull();
    reader.close();
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
      /schema version is 0, expected 15/
    );
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(() => new IdentityDb({ path: databasePath, readOnly: true })).toThrow(
      /schema version is 0, expected 15/
    );
    expect(fs.readFileSync(databasePath)).toEqual(before);

    const unchanged = new DatabaseSync(databasePath);
    expect(unchanged.prepare("SELECT * FROM users").all()).toEqual([
      { id: "old-user", handle: "keep-me" },
    ]);
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    unchanged.close();
  });

  it("transactionally upgrades the shipped v11 schema without losing account state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-identity-v11-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const identity = new IdentityDb({ path: databasePath, readOnly: false });
    identity.insertUser({
      id: "usr_kept",
      handle: "kept",
      displayName: "Kept User",
      role: "member",
      createdAt: 1,
    });
    identity.upsertDevice({
      deviceId: "old-device",
      refreshTokenHash: "old-token",
      transport: { kind: "local" },
      userId: "usr_kept",
      label: "Old remote laptop",
      createdAt: 2,
    });
    identity.close();

    const old = new DatabaseSync(databasePath);
    restoreV13Membership(old);
    old.exec(`
      DROP TABLE user_workspaces;
      DROP TABLE workspace_rpc_policy;
      DROP INDEX devices_by_endpoint;
      DROP INDEX devices_by_user;
      ALTER TABLE devices RENAME TO devices_v13;
      CREATE TABLE devices (
        device_id TEXT PRIMARY KEY,
        refresh_token_hash TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        label TEXT NOT NULL,
        platform TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      INSERT INTO devices
      SELECT device_id, refresh_token_hash, user_id, label, platform, created_at, last_used_at, revoked_at
      FROM devices_v13;
      DROP TABLE devices_v13;
      CREATE INDEX devices_by_user ON devices(user_id);
      CREATE TABLE control_rooms (
        room TEXT PRIMARY KEY,
        invite_code_hash TEXT UNIQUE REFERENCES pairing_codes(code) ON DELETE CASCADE,
        device_id TEXT UNIQUE REFERENCES devices(device_id) ON DELETE CASCADE,
        invite_expires_at INTEGER,
        CHECK (
          (invite_code_hash IS NOT NULL AND device_id IS NULL AND invite_expires_at IS NOT NULL AND invite_expires_at > 0)
          OR
          (invite_code_hash IS NULL AND device_id IS NOT NULL AND invite_expires_at IS NULL)
        )
      );
      INSERT INTO control_rooms(room, device_id) VALUES ('old-room', 'old-device');
      PRAGMA user_version = 11;
    `);
    old.close();

    const migrated = new IdentityDb({ path: databasePath, readOnly: false });
    expect(migrated.getUserByHandle("kept")?.id).toBe("usr_kept");
    expect(migrated.getDevice("old-device")).toMatchObject({
      deviceId: "old-device",
      transport: { kind: "local" },
      userId: "usr_kept",
    });
    migrated.close();
    const verified = new DatabaseSync(databasePath);
    expect(verified.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
    expect(
      verified.prepare("SELECT name FROM sqlite_schema WHERE name = 'control_rooms'").get()
    ).toBeUndefined();
    verified.close();
  });

  it("upgrades v13 by adding private designations without changing existing hub state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-identity-v13-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const identity = new IdentityDb({ path: databasePath, readOnly: false });
    identity.insertUser({
      id: "usr_kept",
      handle: "kept",
      displayName: "Kept User",
      role: "member",
      createdAt: 1,
    });
    identity.close();

    const central = new CentralDataManager({ databasePath, now: () => 20 });
    const workspace = central.addWorkspace("kept-workspace", "ws_kept");
    central.setLastWorkspaceForUser("usr_kept", workspace.name);
    central.setKeepServerOnQuit(true);
    central.close();
    const membership = new IdentityDb({ path: databasePath, readOnly: false });
    membership.addMembership({
      userId: "usr_kept",
      workspaceId: workspace.workspaceId,
      addedBy: "usr_kept",
      addedAt: 10,
      role: "member",
    });
    membership.close();

    const old = new DatabaseSync(databasePath);
    restoreV13Membership(old);
    old.exec(
      "DROP TABLE user_workspaces; DROP TABLE workspace_rpc_policy; PRAGMA user_version = 13"
    );
    old.close();

    const migrated = new IdentityDb({ path: databasePath, readOnly: false });
    expect(migrated.getUserByHandle("kept")?.id).toBe("usr_kept");
    expect(migrated.listWorkspacesForUser("usr_kept")).toEqual(["ws_kept"]);
    expect(migrated.getPrivateWorkspaceOwner("ws_kept")).toBeNull();
    migrated.close();
    const reopened = new CentralDataManager({ databasePath });
    expect(reopened.listWorkspaces()).toEqual([workspace]);
    expect(reopened.getLastWorkspaceForUser("usr_kept")).toEqual(workspace);
    expect(reopened.getKeepServerOnQuit()).toBe(true);
    reopened.close();

    const verified = new DatabaseSync(databasePath);
    expect(verified.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
    expect(verified.prepare("SELECT * FROM user_workspaces").all()).toEqual([]);
    expect(verified.prepare("SELECT * FROM workspace_rpc_policy").all()).toEqual([]);
    verified.close();
  });

  it("records old root access once without inheriting later private workspaces or restoring removed access", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-identity-root-cutover-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const identity = new IdentityDb({ path: databasePath, readOnly: false });
    for (const [id, role] of [
      ["usr_root", "root"],
      ["usr_member", "member"],
    ] as const) {
      identity.insertUser({ id, handle: id, displayName: id, role, createdAt: 1 });
    }
    identity.close();
    const central = new CentralDataManager({ databasePath });
    central.addWorkspace("project", "ws_project");
    central.close();
    const old = new DatabaseSync(databasePath);
    restoreV13Membership(old);
    old.exec(
      "DROP TABLE user_workspaces; DROP TABLE workspace_rpc_policy; PRAGMA user_version = 13"
    );
    old.close();

    const migrated = new IdentityDb({ path: databasePath, readOnly: false });
    expect(migrated.listWorkspacesForUser("usr_root")).toEqual(["ws_project"]);
    expect(migrated.getMembership("usr_root", "ws_project")?.role).toBe("admin");
    migrated.removeMembership("usr_root", "ws_project");
    migrated.close();
    const afterCutover = new CentralDataManager({ databasePath });
    const pin = {
      url: "git+https://example.test/workspace.git",
      ref: "refs/tags/v1",
      commit: "a".repeat(40),
      snapshot: `v1-sha256:${"b".repeat(64)}` as const,
    };
    const pair = afterCutover.ensurePrivateWorkspaces("usr_member", { personal: pin, system: pin });
    afterCutover.close();
    const reopened = new IdentityDb({ path: databasePath, readOnly: false });
    expect(reopened.listWorkspacesForUser("usr_root")).toEqual([]);
    expect(reopened.getPrivateWorkspaceOwner(pair.personal.workspaceId)).toEqual({
      userId: "usr_member",
      role: "personal",
    });
    reopened.close();
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

  it("consumes an invite and persists the device's exact Iroh Endpoint ID atomically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-iroh-pairing-"));
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
      userId: "usr_alice",
      workspaceId,
      intent: "pair-device",
      createdAt: 1_000,
      expiresAt: 61_000,
    });
    const device = {
      deviceId: `dev_${"d".repeat(24)}`,
      refreshTokenHash: "b".repeat(64),
      transport: { kind: "iroh" as const, endpointId: "c".repeat(64) },
      userId: "usr_alice",
      label: "Phone",
      createdAt: 1_000,
    };
    const completed = identity.completePairing({
      code: codeHash,
      createDevice: () => ({ device, refreshToken: "r".repeat(43) }),
    });
    expect(completed).toMatchObject({ device, workspaceId });
    expect(identity.getPairingCode(codeHash)).toBeNull();
    expect(identity.getDeviceForEndpoint(device.transport.endpointId)?.deviceId).toBe(
      device.deviceId
    );
    expect(
      identity.completePairing({
        code: codeHash,
        createDevice: () => {
          throw new Error("consumed code must not issue twice");
        },
      })
    ).toBeNull();
    identity.close();
  });

  it("expires pairing capabilities without leaving transport routing state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-pairing-expiry-"));
    roots.push(root);
    const databasePath = path.join(root, "identity.db");
    const central = new CentralDataManager({ databasePath });
    const workspaceId = central.addWorkspace("test").workspaceId;
    central.close();
    const identity = new IdentityDb({ path: databasePath, readOnly: false });
    const codeHash = "d".repeat(64);
    identity.insertPairingInvite({
      code: codeHash,
      workspaceId,
      intent: "root-bootstrap",
      createdAt: 1,
      expiresAt: 10,
    });
    expect(identity.deleteExpiredPairingInvites(10)).toEqual([
      { code: codeHash, workspaceId, intent: "root-bootstrap", createdAt: 1, expiresAt: 10 },
    ]);
    expect(identity.getPairingCode(codeHash)).toBeNull();
    identity.close();
  });
});
