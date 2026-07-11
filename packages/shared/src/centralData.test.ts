import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CentralDataManager } from "./centralData.js";

describe("CentralDataManager SQLite control store", () => {
  let tempRoot: string;
  let databasePath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-central-data-"));
    databasePath = path.join(tempRoot, "identity.db");
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const localServer = {
    gatewayPort: 4321,
    pid: 999,
    serverId: "srv-1",
    serverBootId: "boot-1",
    startedAt: 1234,
    version: "1.0.0",
  };

  function manager(now?: () => number): CentralDataManager {
    return new CentralDataManager({ databasePath, ...(now ? { now } : {}) });
  }

  it("registers a workspace once and preserves its opaque id", () => {
    const first = manager();
    first.addWorkspace("client");
    const workspaceId = first.getWorkspaceIdByName("client");
    first.close();

    const second = manager();
    second.addWorkspace("client");
    expect(second.getWorkspaceIdByName("client")).toBe(workspaceId);
    expect(second.listWorkspaces()).toHaveLength(1);
    second.close();
  });

  it("never creates catalog rows as a side effect of touch", () => {
    const central = manager();
    central.touchWorkspace("missing");
    expect(central.getWorkspaceEntry("missing")).toBeNull();
    central.close();
  });

  it("serializes row updates from independent process handles without lost data", () => {
    const first = manager();
    const second = manager();
    first.addWorkspace("alpha");
    second.addWorkspace("beta");
    first.setHubRuntime(localServer);
    second.setKeepServerOnQuit(true);

    expect(
      first
        .listWorkspaces()
        .map((entry) => entry.name)
        .sort()
    ).toEqual(["alpha", "beta"]);
    expect(second.getHubRuntime()).toEqual(localServer);
    expect(first.getKeepServerOnQuit()).toBe(true);
    first.close();
    second.close();
  });

  it("records, reads, and clears the singleton local hub runtime", () => {
    const central = manager();
    central.setHubRuntime(localServer);
    expect(central.getHubRuntime()).toEqual(localServer);
    central.clearHubRuntime();
    expect(central.getHubRuntime()).toBeNull();
    central.close();
  });

  it("stores independent authenticated-user resume cursors", () => {
    const central = manager();
    central.addWorkspace("alpha");
    central.addWorkspace("beta");
    central.setLastWorkspaceForUser("usr_alice", "alpha");
    central.setLastWorkspaceForUser("usr_bob", "beta");

    expect(central.getLastWorkspaceForUser("usr_alice")?.name).toBe("alpha");
    expect(central.getLastWorkspaceForUser("usr_bob")?.name).toBe("beta");
    central.close();
  });

  it("rejects corrupt preference values instead of coercing them", () => {
    const central = manager();
    central.close();
    const db = new DatabaseSync(databasePath);
    db.prepare("INSERT INTO hub_preferences (key, value) VALUES (?, ?)").run(
      "keep_server_on_quit",
      "yes"
    );
    db.close();

    const reopened = manager();
    expect(() => reopened.getKeepServerOnQuit()).toThrow(/Invalid keep_server_on_quit/);
    reopened.close();
  });

  it("cascades a deleted workspace out of resume cursors", () => {
    const central = manager();
    central.addWorkspace("alpha");
    central.setLastWorkspaceForUser("usr_alice", "alpha");
    const removedId = central.removeWorkspace("alpha");
    expect(removedId).toMatch(/^ws_/);
    expect(central.getLastWorkspaceForUser("usr_alice")).toBeNull();
    central.close();
  });

  it("recovers a crash-marked ephemeral workspace without touching persistent workspaces", () => {
    const first = manager();
    first.addWorkspace("default");
    const ephemeral = first.addEphemeralWorkspace("dev");
    first.setEphemeralWorkspaceDiskName(ephemeral.workspaceId, "dev-deadbeef");
    const db = new DatabaseSync(databasePath);
    db.prepare(
      `INSERT INTO users (id, handle, display_name, role, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("usr_member", "member", "Member", "member", 1);
    db.prepare(
      `INSERT INTO membership (user_id, workspace_id, added_by, added_at)
       VALUES (?, ?, ?, ?)`
    ).run("usr_member", ephemeral.workspaceId, "usr_member", 1);
    db.prepare(
      `INSERT INTO user_workspace_targets (user_id, workspace_id, last_opened)
       VALUES (?, ?, ?)`
    ).run("usr_member", ephemeral.workspaceId, 1);
    db.close();
    first.close();

    const recovered = manager();
    expect(recovered.removeEphemeralWorkspace()).toEqual({
      ...ephemeral,
      diskName: "dev-deadbeef",
    });
    expect(recovered.listWorkspaces().map((entry) => entry.name)).toEqual(["default"]);
    expect(recovered.getLastWorkspaceForUser("usr_member")).toBeNull();
    expect(recovered.removeEphemeralWorkspace()).toBeNull();
    recovered.close();
  });

  it("never adopts a persistent workspace as ephemeral", () => {
    const central = manager();
    central.addWorkspace("dev");
    expect(() => central.addEphemeralWorkspace("dev")).toThrow(/Cannot shadow persistent/);
    expect(central.getWorkspaceEntry("dev")).not.toBeNull();
    central.close();
  });

  it("atomically cascades workspace deletion across every workspace-owned control row", () => {
    const central = manager();
    central.addWorkspace("alpha");
    const workspaceId = central.getWorkspaceIdByName("alpha")!;
    const db = new DatabaseSync(databasePath);
    db.prepare(
      `INSERT INTO users (id, handle, display_name, role, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("usr_member", "member", "Member", "member", 1);
    db.prepare(
      `INSERT INTO membership (user_id, workspace_id, added_by, added_at)
       VALUES (?, ?, ?, ?)`
    ).run("usr_member", workspaceId, "usr_member", 1);
    db.prepare(
      `INSERT INTO user_revocation_cleanup (user_id, workspace_id)
       VALUES (?, ?)`
    ).run("usr_member", workspaceId);
    db.prepare(
      `INSERT INTO user_workspace_targets (user_id, workspace_id, last_opened)
       VALUES (?, ?, ?)`
    ).run("usr_member", workspaceId, 1);

    // Abort at the final catalog statement. The preceding explicit cascades
    // must roll back with it rather than leaving a half-deleted identity view.
    db.exec(`
      CREATE TRIGGER inject_workspace_delete_failure
      BEFORE DELETE ON workspaces
      BEGIN
        SELECT RAISE(ABORT, 'injected delete failure');
      END
    `);
    expect(() => central.removeWorkspace("alpha")).toThrow(/injected delete failure/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM membership").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM user_revocation_cleanup").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM user_workspace_targets").get()).toEqual({
      count: 1,
    });
    expect(central.getWorkspaceIdByName("alpha")).toBe(workspaceId);

    db.exec("DROP TRIGGER inject_workspace_delete_failure");
    expect(central.removeWorkspace("alpha")).toBe(workspaceId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM membership").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM user_revocation_cleanup").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM user_workspace_targets").get()).toEqual({
      count: 0,
    });
    db.close();
    central.close();
  });

  it("rejects stale control schemas instead of migrating or retaining legacy columns", () => {
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        last_opened INTEGER NOT NULL,
        local_server_json TEXT
      )
    `);
    db.prepare(
      "INSERT INTO workspaces (workspace_id, name, last_opened, local_server_json) VALUES (?, ?, ?, ?)"
    ).run("legacy-id", "keep-me", 1, "legacy-payload");
    db.close();
    const before = fs.readFileSync(databasePath);

    expect(() => manager()).toThrow(/Unsupported hub-control schema/);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    const unchanged = new DatabaseSync(databasePath);
    expect(unchanged.prepare("SELECT * FROM workspaces").all()).toEqual([
      {
        workspace_id: "legacy-id",
        name: "keep-me",
        last_opened: 1,
        local_server_json: "legacy-payload",
      },
    ]);
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    unchanged.close();
  });

  it("rejects unexpected legacy tables instead of leaving dead structures in place", () => {
    const central = manager();
    central.close();
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE local_servers (workspace TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    db.close();

    expect(() => manager()).toThrow(/unexpected \[table:local_servers\]/);
  });

  it("rejects a missing canonical table without recreating it", () => {
    const central = manager();
    central.close();
    const db = new DatabaseSync(databasePath);
    db.exec("DROP TABLE hub_runtime");
    db.close();
    const before = fs.readFileSync(databasePath);

    expect(() => manager()).toThrow(/missing \[table:hub_runtime\]/);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    const unchanged = new DatabaseSync(databasePath);
    expect(
      unchanged
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'hub_runtime'")
        .get()
    ).toBeUndefined();
    unchanged.close();
  });
});
