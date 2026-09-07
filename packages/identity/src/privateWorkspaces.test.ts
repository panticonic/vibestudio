import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { IdentityDb } from "./identityDb.js";
import { MembershipStore } from "./membership.js";
import { UserStore } from "./userStore.js";

const pin = {
  url: "git+https://example.test/base.git",
  ref: "refs/tags/v1",
  commit: "1".repeat(40),
  snapshot: `v1-sha256:${"2".repeat(64)}` as const,
};

describe("private workspace ownership", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    cleanups.length = 0;
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-private-workspaces-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const databasePath = path.join(root, "identity.db");
    const db = new IdentityDb({ path: databasePath, readOnly: false });
    cleanups.push(() => db.close());
    const central = new CentralDataManager({ databasePath });
    cleanups.push(() => central.close());
    const users = new UserStore(db);
    const alice = users.createRoot({ handle: "alice", displayName: "Alice" });
    const bob = users.inviteUser({
      handle: "bob",
      displayName: "Bob",
      role: "member",
      createdBy: alice.id,
    });
    const childDb = new IdentityDb({ path: databasePath, readOnly: true });
    cleanups.push(() => childDb.close());
    return {
      databasePath,
      db,
      central,
      users,
      alice,
      bob,
      members: new MembershipStore(db, users),
      childMembers: new MembershipStore(childDb, new UserStore(childDb)),
    };
  }

  it("reserves one pair per account and preserves incomplete creation and exact source pins", () => {
    const { central, alice, bob } = setup();
    const first = central.ensurePrivateWorkspaces(alice.id, { personal: pin, system: pin });
    const different = { ...pin, commit: "3".repeat(40) };
    expect(
      central.ensurePrivateWorkspaces(alice.id, { personal: different, system: different })
    ).toEqual(first);
    expect(central.getWorkspaceCreationIntent(first.system.name)?.rootTemplate).toEqual(pin);
    const second = central.ensurePrivateWorkspaces(bob.id, { personal: pin, system: pin });
    expect(
      new Set([...Object.values(first), ...Object.values(second)].map((w) => w.workspaceId)).size
    ).toBe(4);
    expect(central.listWorkspaces().filter((w) => w.privateRole === "system")).toHaveLength(2);
  });

  it("returns designations from every registry query and preserves them across handles", () => {
    const { databasePath, db, central, alice, members } = setup();
    const pair = central.ensurePrivateWorkspaces(alice.id, { personal: pin, system: pin });
    central.setLastWorkspaceForUser(alice.id, pair.personal.name);
    const personalPolicy = {
      incoming: [
        {
          workspaceId: "ws_project",
          userId: alice.id,
          target: "main",
          operation: "notes.read",
          purpose: "call" as const,
        },
      ],
      outgoing: [],
    };
    const closedPolicy = { incoming: [], outgoing: [] };
    const independentWriter = new IdentityDb({ path: databasePath, readOnly: false });
    cleanups.push(() => independentWriter.close());
    independentWriter.setWorkspaceRpcPolicy(
      pair.personal.workspaceId,
      personalPolicy,
      closedPolicy,
      alice.id,
      30
    );
    expect(() =>
      db.setWorkspaceRpcPolicy(
        pair.personal.workspaceId,
        { incoming: [], outgoing: [] },
        closedPolicy,
        alice.id,
        31
      )
    ).toThrow(/changed; reload/);
    expect(() =>
      db.setWorkspaceRpcPolicy(pair.system.workspaceId, personalPolicy, closedPolicy, alice.id, 32)
    ).toThrow(/incoming RPC policy is immutable and closed/);

    expect(central.getWorkspaceEntry(pair.personal.name)).toEqual(pair.personal);
    expect(central.getLastWorkspaceForUser(alice.id)).toEqual(pair.personal);
    const latest = central.getLastOpenedWorkspace();
    expect(latest?.privateRole).toBe(
      latest?.workspaceId === pair.personal.workspaceId ? "personal" : "system"
    );

    const independent = new CentralDataManager({ databasePath });
    cleanups.push(() => independent.close());
    expect(independent.ensurePrivateWorkspaces(alice.id, { personal: pin, system: pin })).toEqual(
      pair
    );
    expect(independent.listWorkspaces()).toHaveLength(2);
    const restartedReader = new IdentityDb({ path: databasePath, readOnly: true });
    cleanups.push(() => restartedReader.close());
    const restartedMembership = new MembershipStore(
      restartedReader,
      new UserStore(restartedReader)
    );
    expect(restartedMembership.has(alice.id, pair.personal.workspaceId)).toBe(true);
    expect(restartedReader.getPrivateWorkspaceOwner(pair.system.workspaceId)).toEqual({
      userId: alice.id,
      role: "system",
    });
    expect(restartedReader.getWorkspaceRpcPolicy(pair.personal.workspaceId)).toEqual(
      personalPolicy
    );
    expect(restartedReader.getWorkspaceRpcPolicy(pair.system.workspaceId)).toEqual({
      incoming: [],
      outgoing: [],
    });
    expect(() => restartedReader.getWorkspaceRpcPolicy("ws_missing")).toThrow(
      /Unknown workspace id/
    );
    expect(members.list(alice.id)).toEqual(
      expect.arrayContaining([pair.personal.workspaceId, pair.system.workspaceId])
    );
  });

  it("denies other users, including root, on both hub and existing child readers", () => {
    const { central, alice, bob, members, childMembers, db } = setup();
    const pair = central.ensurePrivateWorkspaces(bob.id, { personal: pin, system: pin });
    for (const workspace of Object.values(pair)) {
      for (const store of [members, childMembers]) {
        expect(store.has(bob.id, workspace.workspaceId)).toBe(true);
        expect(store.has(alice.id, workspace.workspaceId)).toBe(false);
      }
      expect(() => members.add(alice.id, workspace.workspaceId, alice.id)).toThrow(
        /cannot be shared/
      );
      expect(() =>
        db.addMembership({
          userId: alice.id,
          workspaceId: workspace.workspaceId,
          addedBy: alice.id,
          addedAt: 1,
          role: "member",
        })
      ).toThrow(/cannot be shared/);
      expect(() => members.remove(bob.id, workspace.workspaceId)).toThrow(
        /ownership cannot be removed/
      );
    }
  });

  it("rolls back both reservations when either source is invalid", () => {
    const { central, alice } = setup();
    expect(() =>
      central.ensurePrivateWorkspaces(alice.id, {
        personal: pin,
        system: { ...pin, commit: "invalid" },
      })
    ).toThrow();
    expect(central.listWorkspaces()).toEqual([]);
    expect(
      Object.keys(central.ensurePrivateWorkspaces(alice.id, { personal: pin, system: pin }))
    ).toEqual(["personal", "system"]);
  });

  it("retains shared membership and rejects a revoked private owner without replacing state", () => {
    const { central, alice, bob, users, members, childMembers } = setup();
    const shared = central.addWorkspace("Project");
    members.add(bob.id, shared.workspaceId, alice.id);
    expect(childMembers.has(bob.id, shared.workspaceId)).toBe(true);
    const pair = central.ensurePrivateWorkspaces(bob.id, { personal: pin, system: pin });
    users.revokeUser(bob.id);
    expect(childMembers.has(bob.id, pair.personal.workspaceId)).toBe(false);
    expect(() => central.ensurePrivateWorkspaces(bob.id, { personal: pin, system: pin })).toThrow(
      /not a live user/
    );
    expect(central.listWorkspaces()).toHaveLength(3);
  });

  it("requires explicit ordinary membership for root and honors its removal", () => {
    const { central, alice, members, childMembers } = setup();
    const project = central.addWorkspace("Project");
    expect(childMembers.has(alice.id, project.workspaceId)).toBe(false);
    members.add(alice.id, project.workspaceId, alice.id, "admin");
    expect(childMembers.has(alice.id, project.workspaceId)).toBe(true);
    expect(childMembers.isAdmin(alice.id, project.workspaceId)).toBe(true);
    members.add(alice.id, project.workspaceId, alice.id, "member");
    expect(childMembers.isAdmin(alice.id, project.workspaceId)).toBe(false);
    expect(members.remove(alice.id, project.workspaceId)).toBe(true);
    expect(childMembers.has(alice.id, project.workspaceId)).toBe(false);
    expect(members.list(alice.id)).toEqual([]);
  });
});
