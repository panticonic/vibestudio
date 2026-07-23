import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCanonicalSqliteDatabase } from "@vibestudio/sqlite";
import type { MissionCharter } from "@vibestudio/shared/authority/mission";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { MissionRegistry } from "./missionRegistry.js";
import { MISSION_MIGRATION_PLAN } from "./missionSchema.js";

const charter = (): MissionCharter => ({
  taskSpec: "Post a nightly summary",
  harness: { unit: "workers/system-agent", ev: "a".repeat(64) },
  skills: [],
  toolExposure: {
    services: ["notification.post"],
    userlandServices: [],
    evalNetwork: "none",
    declaredOrigins: [],
  },
  model: { modelId: "openai-codex:gpt-5.3-codex-spark", params: {} },
  trigger: { kind: "cron", cron: "0 2 * * *" },
});

describe("MissionRegistry", () => {
  it("migrates the mission registry forward without rewriting mission rows", () => {
    const migration = MISSION_MIGRATION_PLAN.migrations?.[0];
    if (!migration) throw new Error("Expected the v1 mission migration");
    const db = new DatabaseSync(":memory:");
    for (const object of migration.from.objects) db.exec(object.sql);
    db.exec(`PRAGMA user_version = ${migration.from.version}`);
    db.prepare(
      `INSERT INTO missions
       (mission_id,name,revision,charter_json,owner_user_id,owner_device_id,state,
        closure_digest,standing_restrictions_json,seeded,created_at,updated_at)
       VALUES ('msn_preserved','Preserved',1,'{}','u','d','draft','digest','[]',0,1,1)`
    ).run();

    expect(
      openCanonicalSqliteDatabase(db, MISSION_MIGRATION_PLAN, {
        description: "test mission registry",
      })
    ).toEqual({
      kind: "migrated",
      fromVersion: 1,
      version: 2,
      migrations: ["bind-seeded-missions-to-product-snapshot"],
    });
    expect(db.prepare("SELECT mission_id, seed_snapshot_state FROM missions").get()).toEqual({
      mission_id: "msn_preserved",
      seed_snapshot_state: null,
    });
    db.close();
  });

  it("never lets an ordinary approved unit become a mission conduit", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => false,
    });
    const draft = registry.createDraft({
      name: "Nightly",
      charter: charter(),
      owner: { userId: "u", deviceId: "d" },
    });
    expect(() =>
      registry.approve({
        missionId: draft.missionId,
        permissions: [],
        decidedBy: "user:u",
        contextIntegrityReady: true,
      })
    ).toThrow(/not a product-blessed conduit/);
    registry.close();
    grants.close();
  });

  it("gates approval on integrity and lapses authority on charter drift", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const draft = registry.createDraft({
      name: "Nightly",
      charter: charter(),
      owner: { userId: "u", deviceId: "d" },
    });
    expect(() =>
      registry.approve({
        missionId: draft.missionId,
        permissions: [],
        decidedBy: "user:u",
        contextIntegrityReady: false,
      })
    ).toThrow(/trust update/);
    registry.approve({
      missionId: draft.missionId,
      permissions: [
        {
          capability: "service:notification.post",
          resource: { kind: "exact", key: "service:notification.post" },
        },
      ],
      decidedBy: "user:u",
      contextIntegrityReady: true,
    });
    expect(
      registry.startSession({
        missionId: draft.missionId,
        sessionId: "chat",
        taskRef: "task",
        runId: "run",
      }).missionId
    ).toBe(draft.missionId);
    expect(registry.factForSession("chat")?.closureDigest).toBe(draft.closureDigest);
    registry.finishSession({ sessionId: "chat", runId: "run", outcome: "complete", now: 100 });
    expect(registry.factForSession("chat")).toBeNull();
    expect(() =>
      registry.finishSession({ sessionId: "chat", runId: "different", outcome: "complete" })
    ).toThrow(/not active/);
    expect(
      registry.startSession({
        missionId: draft.missionId,
        sessionId: "chat-2",
        taskRef: "task",
        runId: "run-2",
      }).missionId
    ).toBe(draft.missionId);
    expect(
      registry.edit(draft.missionId, {
        charter: { ...charter(), taskSpec: "Different" },
        actingUserId: "u",
      }).state
    ).toBe("needs-reapproval");
    expect(registry.factForSession("chat-2")).toBeNull();
    expect(() =>
      registry.startSession({
        missionId: draft.missionId,
        sessionId: "chat-3",
        taskRef: "task",
        runId: "run-3",
      })
    ).toThrow(/not active at its approved closure/);
    registry.close();
    grants.close();
  });

  it("reconciles seeded missions against product snapshots without duplicate authority", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const seed = (snapshotByte: string, now: number) =>
      registry.upsertSeeded({
        productSnapshotState: `state:${snapshotByte.repeat(64)}`,
        missionId: "msn_system_agent",
        name: "System Agent",
        charter: charter(),
        permissions: [
          {
            capability: "service:notification.post",
            resource: { kind: "exact", key: "service:notification.post" },
          },
        ],
        standingRestrictions: [
          { capability: "service:credential.delete", resourceKey: "service:credential.delete" },
        ],
        now,
      });

    expect(seed("1", 10)).toMatchObject({
      missionId: "msn_system_agent",
      state: "active",
      seeded: true,
      owner: { userId: "system", deviceId: "system" },
    });
    expect(grants.listAuthorityGrants()).toHaveLength(2);
    seed("1", 20);
    expect(grants.listAuthorityGrants()).toHaveLength(2);

    expect(seed("2", 30).revision).toBe(1);
    const all = grants.listAuthorityGrants();
    expect(all).toHaveLength(4);
    expect(all.filter((grant) => grant.revokedAt === undefined)).toHaveLength(2);
    expect(all.filter((grant) => grant.provenance === "seed")).toHaveLength(4);

    registry.close();
    grants.close();
  });

  it("keeps a seeded mission inert when cross-store grant minting is interrupted", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const originalIssue = grants.issue.bind(grants);
    let calls = 0;
    grants.issue = ((input) => {
      calls += 1;
      if (calls === 2) throw new Error("simulated grant-store interruption");
      return originalIssue(input);
    }) as CapabilityGrantStore["issue"];

    expect(() =>
      registry.upsertSeeded({
        productSnapshotState: `state:${"1".repeat(64)}`,
        missionId: "msn_system_agent",
        name: "System Agent",
        charter: charter(),
        permissions: [
          {
            capability: "service:notification.post",
            resource: { kind: "exact", key: "service:notification.post" },
          },
        ],
        standingRestrictions: [
          { capability: "service:credential.delete", resourceKey: "service:credential.delete" },
        ],
        now: 10,
      })
    ).toThrow(/simulated grant-store interruption/);
    expect(registry.get("msn_system_agent")?.state).toBe("needs-reapproval");
    expect(() =>
      registry.startSession({
        missionId: "msn_system_agent",
        sessionId: "invalid",
        taskRef: "task",
        runId: "invalid",
      })
    ).toThrow(/not active/);

    grants.issue = originalIssue;
    expect(
      registry.upsertSeeded({
        productSnapshotState: `state:${"1".repeat(64)}`,
        missionId: "msn_system_agent",
        name: "System Agent",
        charter: charter(),
        permissions: [
          {
            capability: "service:notification.post",
            resource: { kind: "exact", key: "service:notification.post" },
          },
        ],
        standingRestrictions: [
          { capability: "service:credential.delete", resourceKey: "service:credential.delete" },
        ],
        now: 20,
      }).state
    ).toBe("active");

    registry.close();
    grants.close();
  });

  it("re-mints standing restrictions at the newly approved closure", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const draft = registry.createDraft({
      name: "Restricted",
      charter: charter(),
      owner: { userId: "u", deviceId: "d" },
      now: 10,
    });
    registry.approve({
      missionId: draft.missionId,
      permissions: [],
      standingRestrictions: [
        { capability: "service:credential.delete", resourceKey: "service:credential.delete" },
      ],
      decidedBy: "user:u",
      contextIntegrityReady: true,
      now: 20,
    });
    registry.edit(draft.missionId, {
      charter: { ...charter(), taskSpec: "Changed task" },
      actingUserId: "u",
      now: 30,
    });
    const approved = registry.approve({
      missionId: draft.missionId,
      permissions: [],
      decidedBy: "user:u",
      contextIntegrityReady: true,
      now: 40,
    });
    const denials = grants
      .listAuthorityGrants()
      .filter(
        (grant) => grant.effect === "deny" && grant.capability === "service:credential.delete"
      );
    expect(approved.standingRestrictions).toEqual([
      { capability: "service:credential.delete", resourceKey: "service:credential.delete" },
    ]);
    expect(denials).toHaveLength(2);
    expect(denials.filter((grant) => grant.revokedAt === undefined)).toHaveLength(1);
    expect(denials.find((grant) => grant.revokedAt === undefined)?.subject).toBe(
      `mission:${approved.missionId}@${approved.closureDigest}`
    );

    registry.close();
    grants.close();
  });

  it("keeps user-owned missions private and owner-controlled", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const alice = registry.createDraft({
      name: "Alice nightly",
      charter: charter(),
      owner: { userId: "alice", deviceId: "alice-laptop" },
    });
    registry.createDraft({
      name: "Bob nightly",
      charter: charter(),
      owner: { userId: "bob", deviceId: "bob-phone" },
    });

    expect(registry.listForUser("alice").map((mission) => mission.name)).toEqual(["Alice nightly"]);
    expect(registry.getForUser(alice.missionId, "bob")).toBeNull();
    expect(() =>
      registry.edit(alice.missionId, {
        name: "Stolen",
        actingUserId: "bob",
      })
    ).toThrow(/not owned/);
    expect(() =>
      registry.approve({
        missionId: alice.missionId,
        permissions: [],
        decidedBy: "user:bob",
        contextIntegrityReady: true,
      })
    ).toThrow(/not owned/);

    registry.approve({
      missionId: alice.missionId,
      permissions: [],
      decidedBy: "user:alice",
      contextIntegrityReady: true,
    });
    expect(() => registry.pause(alice.missionId, "bob")).toThrow(/not owned/);
    expect(registry.pause(alice.missionId, "alice").state).toBe("paused");
    expect(() => registry.resume(alice.missionId, "bob")).toThrow(/not owned/);
    expect(registry.resume(alice.missionId, "alice").state).toBe("active");
    expect(() => registry.retire(alice.missionId, "bob")).toThrow(/not owned/);
    expect(registry.retire(alice.missionId, "alice").state).toBe("retired");

    registry.close();
    grants.close();
  });

  it("rejects grants and calls outside the reviewed exposure", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const draft = registry.createDraft({
      name: "Nightly",
      charter: charter(),
      owner: { userId: "u", deviceId: "d" },
    });
    expect(() =>
      registry.approve({
        missionId: draft.missionId,
        permissions: [
          { capability: "service:credential.delete", resource: { kind: "exact", key: "x" } },
        ],
        decidedBy: "user:u",
        contextIntegrityReady: true,
      })
    ).toThrow(/exceeds tool exposure/);
    registry.close();
    grants.close();
  });

  it("binds userland service authority to the reviewed provider EV", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const providerEv = "b".repeat(64);
    const userlandCharter: MissionCharter = {
      ...charter(),
      toolExposure: {
        ...charter().toolExposure,
        userlandServices: [
          {
            name: "notes",
            provider: "workers/notes",
            providerEv,
            upgradePolicy: "pinned",
          },
        ],
      },
    };
    const draft = registry.createDraft({
      name: "Notes",
      charter: userlandCharter,
      owner: { userId: "u", deviceId: "d" },
    });
    registry.approve({
      missionId: draft.missionId,
      permissions: [
        {
          capability: "workspace-service:notes",
          resource: { kind: "prefix", prefix: "do:workers/notes:" },
        },
      ],
      decidedBy: "user:u",
      contextIntegrityReady: true,
    });
    registry.startSession({
      missionId: draft.missionId,
      sessionId: "notes-run",
      taskRef: "task",
      runId: "run",
    });
    expect(() =>
      registry.assertUserlandServiceExposure({
        sessionId: "notes-run",
        name: "notes",
        provider: "workers/notes",
        providerEv,
      })
    ).not.toThrow();
    expect(() =>
      registry.assertUserlandServiceExposure({
        sessionId: "notes-run",
        name: "notes",
        provider: "workers/notes",
        providerEv: "c".repeat(64),
      })
    ).toThrow(/does not expose/);
    registry.close();
    grants.close();
  });

  it("enforces reviewed network reach and requires explicit redirect mediation", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const start = (
      name: string,
      evalNetwork: MissionCharter["toolExposure"]["evalNetwork"],
      declaredOrigins: string[]
    ) => {
      const draft = registry.createDraft({
        name,
        charter: {
          ...charter(),
          toolExposure: { ...charter().toolExposure, evalNetwork, declaredOrigins },
        },
        owner: { userId: "u", deviceId: "d" },
      });
      registry.approve({
        missionId: draft.missionId,
        permissions: [],
        decidedBy: "user:u",
        contextIntegrityReady: true,
      });
      const sessionId = `${name}-session`;
      registry.startSession({
        missionId: draft.missionId,
        sessionId,
        taskRef: "task",
        runId: `${name}-run`,
      });
      return sessionId;
    };

    const offline = start("offline", "none", []);
    expect(() => registry.assertNetworkExposure(offline, "https://example.com")).toThrow(
      /does not expose network egress/
    );

    const declared = start("declared", "declared-origins", ["https://api.example.com"]);
    expect(registry.assertNetworkExposure(declared, "https://api.example.com")).toBe(true);
    expect(() => registry.assertNetworkExposure(declared, "https://other.example.com")).toThrow(
      /does not expose network origin/
    );

    const unrestricted = start("unrestricted", "unrestricted", []);
    expect(registry.assertNetworkExposure(unrestricted, "https://any.example.com")).toBe(false);
    expect(registry.assertNetworkExposure("interactive-session", "https://any.example.com")).toBe(
      false
    );

    registry.close();
    grants.close();
  });
});
