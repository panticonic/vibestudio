import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CentralDataManager } from "./centralData.js";

const ROOT_TEMPLATE = {
  url: "git+https://example.test/base.git",
  ref: "refs/tags/v1",
  commit: "1".repeat(40),
};

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

  function manager(now?: () => number): CentralDataManager {
    return new CentralDataManager({ databasePath, ...(now ? { now } : {}) });
  }

  function addCreationUser(id = "usr_creator") {
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "INSERT INTO users (id, handle, display_name, role, created_at) VALUES (?, ?, ?, 'member', 1)"
    ).run(id, id, id);
    db.close();
  }

  it("keeps one creation receipt and audit across restart, initialization, deletion, and exact retries", () => {
    const central = manager();
    addCreationUser();
    const owner = { userId: "usr_creator" };
    const input = {
      operationId: "client-operation-0001",
      workspace: "new-workspace",
      rootTemplate: ROOT_TEMPLATE,
    };
    const created = central.createWorkspaceOperation(
      owner,
      input,
      () => ROOT_TEMPLATE,
      () => {}
    );
    expect(created.state).toBe("registered");
    expect(central.pendingWorkspaceCreationAudits()).toHaveLength(1);
    central.close();
    const reopened = manager();
    expect(
      reopened.createWorkspaceOperation(
        owner,
        input,
        () => {
          throw new Error("Retry must use its retained pin");
        },
        () => {}
      )
    ).toEqual(created);
    expect(reopened.listWorkspaces()).toHaveLength(1);
    expect(() =>
      reopened.createWorkspaceOperation(
        owner,
        { ...input, workspace: "other" },
        () => ROOT_TEMPLATE,
        () => {}
      )
    ).toThrow(/different inputs/);
    reopened.completeWorkspaceCreation(created.workspaceId);
    expect(reopened.workspaceCreationReceipt(owner, input.operationId)?.state).toBe("ready");
    reopened.removeWorkspace(created.name);
    expect(reopened.workspaceCreationReceipt(owner, input.operationId)?.state).toBe("deleted");
    expect(
      reopened.createWorkspaceOperation(
        owner,
        input,
        () => ROOT_TEMPLATE,
        () => {}
      )
    ).toMatchObject({ ...created, state: "deleted" });
    expect(reopened.listWorkspaces()).toHaveLength(0);
    const audit = reopened.pendingWorkspaceCreationAudits()[0]!;
    reopened.acknowledgeWorkspaceCreationAudit(audit.operationId!);
    expect(reopened.pendingWorkspaceCreationAudits()).toEqual([]);
    reopened.close();
  });

  it("rolls back registry, membership, receipt, and audit if live authority ends at the effect boundary", () => {
    const central = manager();
    addCreationUser();
    let checks = 0;
    const input = { operationId: "client-operation-0002", workspace: "no-effect" };
    expect(() =>
      central.createWorkspaceOperation(
        { userId: "usr_creator" },
        input,
        () => ROOT_TEMPLATE,
        () => {
          if (++checks === 2) throw new Error("Document retired");
        }
      )
    ).toThrow("Document retired");
    expect(central.listWorkspaces()).toEqual([]);
    expect(central.pendingWorkspaceCreationAudits()).toEqual([]);
    expect(
      central.workspaceCreationReceipt({ userId: "usr_creator" }, input.operationId)
    ).toBeNull();
    const db = new DatabaseSync(databasePath);
    expect(db.prepare("SELECT count(*) AS count FROM membership").get()?.["count"]).toBe(0);
    db.close();
    central.close();
  });

  it("isolates durable website owners and refuses reconciliation after source membership is removed", () => {
    const central = manager();
    addCreationUser();
    central.addWorkspace("source", "ws_source");
    const db = new DatabaseSync(databasePath);
    db.exec(
      "INSERT INTO membership VALUES ('usr_creator', 'ws_source', 'usr_creator', 1, 'admin')"
    );
    const owner = {
      userId: "usr_creator",
      source: { workspaceId: "ws_source", subject: "website:authenticated-site" },
    };
    const input = { operationId: "client-operation-0003", workspace: "installed" };
    central.createWorkspaceOperation(
      owner,
      input,
      () => ROOT_TEMPLATE,
      () => {}
    );
    expect(
      central.workspaceCreationReceipt(
        { ...owner, source: { ...owner.source, subject: "website:other-site" } },
        input.operationId
      )
    ).toBeNull();
    expect(
      central.workspaceCreationReceipt({ userId: owner.userId }, input.operationId)
    ).toBeNull();
    db.exec("DELETE FROM membership WHERE workspace_id = 'ws_source'");
    expect(() => central.workspaceCreationReceipt(owner, input.operationId)).toThrow(
      /source membership/
    );
    db.close();
    central.close();
  });

  it("registers a caller-allocated id used by an external creation descriptor", () => {
    const central = manager();
    expect(central.addWorkspace("external", "ws_preallocated").workspaceId).toBe("ws_preallocated");
    central.close();
  });

  it("persists and idempotently clears the exact child-owned creation intent", () => {
    const central = manager();
    const entry = central.addWorkspaceCreation("new-workspace", ROOT_TEMPLATE, "ws_pending");
    expect(entry.workspaceId).toBe("ws_pending");
    expect(central.getWorkspaceCreationIntent("new-workspace")).toEqual({
      version: 1,
      workspaceId: "ws_pending",
      purpose: "use",
      rootTemplate: ROOT_TEMPLATE,
    });
    expect(central.completeWorkspaceCreation("ws_pending")).toBe(true);
    expect(central.completeWorkspaceCreation("ws_pending")).toBe(false);
    expect(central.getWorkspaceCreationIntent("new-workspace")).toBeNull();
    central.close();
  });

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
    second.setKeepServerOnQuit(true);

    expect(
      first
        .listWorkspaces()
        .map((entry) => entry.name)
        .sort()
    ).toEqual(["alpha", "beta"]);
    expect(first.getKeepServerOnQuit()).toBe(true);
    first.close();
    second.close();
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
      `INSERT INTO membership (user_id, workspace_id, added_by, added_at, role)
       VALUES (?, ?, ?, ?, ?)`
    ).run("usr_member", workspaceId, "usr_member", 1, "member");
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
    db.exec("DROP TABLE hub_process_lease");
    db.close();
    const before = fs.readFileSync(databasePath);

    expect(() => manager()).toThrow(/missing \[table:hub_process_lease\]/);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    const unchanged = new DatabaseSync(databasePath);
    expect(
      unchanged
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'hub_process_lease'")
        .get()
    ).toBeUndefined();
    unchanged.close();
  });
});
