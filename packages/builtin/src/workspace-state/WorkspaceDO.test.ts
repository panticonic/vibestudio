import { beforeEach, describe, expect, it } from "vitest";
import { ledgerTest } from "../../../../tests/helpers/ledgerTest.js";
import initSqlJs from "sql.js";

import { createTestDO } from "@vibestudio/durable/test-utils";
import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { WorkspaceDO } from "./WorkspaceDO.js";
import { WorkspaceDOTestable } from "./testFixture.js";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";

const SOURCE = "panels/example";
const VERSION = "v1";
const WORKSPACE_TABLES = [
  "entities",
  "runtime_resource_bindings",
  "slots",
  "panel_close_cleanup",
  "slot_history",
  "workspace_meta",
  "lifecycle_epochs",
  "lifecycle_leases",
  "lifecycle_ops",
  "do_alarms",
  "do_alarm_test_policies",
  "durable_work_owners",
  "context_edges",
];
const CURRENT_SCHEMA_VERSION = WorkspaceDO.schemaVersion;
const ACTIVE_AUTHORITY: UnitAuthorityManifest = {
  provides: [],
  requests: [
    {
      capability: "service:panel.getInfo",
      resource: { kind: "exact", key: "panel:getInfo" },
      tier: "gated",
      evidence: "exact",
    },
  ],
  // A validated envelope always carries its protocol declarations, so the
  // round trip through activation returns exactly what went in.
  serviceRequests: [],
};

async function createPreEngineDatabase() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`INSERT INTO state (key, value) VALUES ('application_marker', 'preserved')`);
  return db;
}

function panelInput(overrides: Partial<Parameters<WorkspaceDO["entityReserve"]>[0]> = {}) {
  return {
    kind: "panel" as const,
    source: { repoPath: SOURCE, effectiveVersion: VERSION },
    contextId: "ctx-1",
    key: "entry-1",
    ...overrides,
  };
}

function preparedPanelInput(overrides: Partial<Parameters<WorkspaceDO["entityActivate"]>[0]> = {}) {
  return panelInput({
    activeBuildKey: "b".repeat(64),
    activeExecutionDigest: "a".repeat(64),
    activeAuthority: ACTIVE_AUTHORITY,
    ...overrides,
  });
}

function doInput(overrides: Partial<Parameters<WorkspaceDO["entityActivate"]>[0]> = {}) {
  return {
    kind: "do" as const,
    source: { repoPath: SOURCE, effectiveVersion: VERSION },
    contextId: "ctx-1",
    className: "MyDO",
    key: "k1",
    ...overrides,
  };
}

function activateAlarmKey(
  instance: WorkspaceDO,
  key: { source: string; className: string; objectKey: string }
): EntityRecord {
  return instance.entityActivate(
    doInput({
      source: { repoPath: key.source, effectiveVersion: VERSION },
      className: key.className,
      key: key.objectKey,
    })
  );
}

describe("WorkspaceDO schema", () => {
  it("requires a fresh database for the current topology schema", async () => {
    const db = await createPreEngineDatabase();
    await expect(createTestDO(WorkspaceDOTestable, undefined, { db })).rejects.toThrow(
      /no current schema identity/u
    );
  });

  ledgerTest("execution.vcs-store", async () => {
    const { sql } = await createTestDO(WorkspaceDOTestable);
    for (const table of WORKSPACE_TABLES) {
      expect(
        sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).one()
      ).toEqual({ name: table });
    }
    expect(
      sql
        .exec(`PRAGMA table_info(entities)`)
        .toArray()
        .map((column) => column["name"])
    ).toEqual(
      expect.arrayContaining(["active_build_key", "active_execution_digest", "active_authority"])
    );
    expect(
      sql
        .exec(`PRAGMA table_info(do_alarms)`)
        .toArray()
        .map((column) => column["name"])
    ).toEqual([
      "source",
      "class_name",
      "object_key",
      "wake_at",
      "dispatch_generation",
      "dispatch_owner",
    ]);
    expect(sql.exec(`SELECT singleton, version FROM _vibestudio_schema`).one()).toEqual({
      singleton: 1,
      version: CURRENT_SCHEMA_VERSION,
    });
  });

  it("rejects drift in a stamped current schema", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`CREATE TABLE _vibestudio_schema (singleton INTEGER PRIMARY KEY, version INTEGER)`);
    db.run(`INSERT INTO _vibestudio_schema (singleton, version) VALUES (1, ?)`, [
      CURRENT_SCHEMA_VERSION,
    ]);
    await expect(createTestDO(WorkspaceDOTestable, undefined, { db })).rejects.toThrow(
      /schema identity table is malformed/
    );
  });
});

describe("WorkspaceDO.entityActivate", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("inserts a new active record when no prior row exists", () => {
    const rec = instance.entityActivate(panelInput());
    expect(rec).toMatchObject({
      id: canonicalEntityId({ kind: "panel", key: "entry-1" }),
      kind: "panel",
      status: "active",
      contextId: "ctx-1",
      key: "entry-1",
      cleanupComplete: true,
    });
    expect(rec.retiredAt).toBeUndefined();
  });

  it("is idempotent when called twice with identical identity on an active row", () => {
    const a = instance.entityActivate(panelInput());
    const b = instance.entityActivate(panelInput());
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("active");
    expect(b.createdAt).toBe(a.createdAt);
  });

  it("persists the validated authority envelope with the active incarnation", () => {
    const rec = instance.entityActivate(
      panelInput({
        activeExecutionDigest: "a".repeat(64),
        activeAuthority: ACTIVE_AUTHORITY,
      })
    );

    expect(rec.activeAuthority).toEqual(ACTIVE_AUTHORITY);
    expect(instance.entityResolve(rec.id)?.activeAuthority).toEqual(ACTIVE_AUTHORITY);
  });

  it("persists and exposes the immutable build key with the active incarnation", () => {
    const rec = instance.entityActivate(
      panelInput({
        activeBuildKey: "b".repeat(64),
        activeExecutionDigest: "a".repeat(64),
        activeAuthority: ACTIVE_AUTHORITY,
      })
    );

    expect(rec.activeBuildKey).toBe("b".repeat(64));
    expect(instance.entityResolve(rec.id)?.activeBuildKey).toBe("b".repeat(64));
  });

  it("restores the complete active executable incarnation after restart", async () => {
    const first = await createTestDO(WorkspaceDOTestable);
    const activated = first.instance.entityActivate(preparedPanelInput());

    const restarted = await createTestDO(WorkspaceDOTestable, undefined, { db: first.db });
    expect(restarted.instance.entityResolveActive(activated.id)).toMatchObject({
      id: activated.id,
      status: "active",
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "a".repeat(64),
      activeAuthority: ACTIVE_AUTHORITY,
    });
  });

  it("reserves a non-executable panel and activates that same incarnation in place", () => {
    const reserved = instance.entityReserve(
      panelInput({ source: { repoPath: SOURCE, effectiveVersion: "" } })
    );

    expect(reserved).toMatchObject({
      id: canonicalEntityId({ kind: "panel", key: "entry-1" }),
      status: "preparing",
      source: { repoPath: SOURCE, effectiveVersion: "" },
    });
    expect(instance.entityResolveActive(reserved.id)).toBeNull();

    const activated = instance.entityAdvanceExecution(preparedPanelInput());
    expect(activated).toMatchObject({
      id: reserved.id,
      status: "active",
      source: { repoPath: SOURCE, effectiveVersion: expect.any(String) },
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "a".repeat(64),
      activeAuthority: ACTIVE_AUTHORITY,
      createdAt: reserved.createdAt,
    });
    expect(instance.entityResolveActive(reserved.id)?.id).toBe(reserved.id);
  });

  it("reserves every code-backed kind through the same durable operation", () => {
    const input = {
      kind: "worker" as const,
      source: { repoPath: "workers/example", effectiveVersion: "" },
      contextId: "ctx-worker",
      key: "worker-1",
    };
    const reserved = instance.entityReserve(input);

    expect(reserved).toMatchObject({
      id: canonicalEntityId({
        kind: "worker",
        source: "workers/example",
        key: "worker-1",
      }),
      kind: "worker",
      status: "preparing",
    });
    expect(
      instance.entityAdvanceExecution({
        ...input,
        source: { repoPath: "workers/example", effectiveVersion: "ev-worker" },
        activeBuildKey: "b".repeat(64),
        activeExecutionDigest: "a".repeat(64),
        activeAuthority: ACTIVE_AUTHORITY,
      })
    ).toMatchObject({ kind: "worker", status: "active" });
  });

  it("commits a fresh panel's lifecycle owner in the reservation transaction", () => {
    const reserved = instance.entityReserve(
      panelInput({
        source: { repoPath: SOURCE, effectiveVersion: "" },
        lifecycleOwner: { contextId: "ctx-owner", entityId: "do:creator" },
      })
    );

    expect(instance.contextEdgeListByChild(reserved.contextId)).toEqual([
      {
        ownerContextId: "ctx-owner",
        kind: "lifecycle",
        ownerEntityId: "do:creator",
      },
    ]);
  });

  it("rejects a second lifecycle parent and rolls back the conflicting reservation", () => {
    instance.entityReserve(
      panelInput({
        source: { repoPath: SOURCE, effectiveVersion: "" },
        lifecycleOwner: { contextId: "ctx-owner-a", entityId: "do:creator-a" },
      })
    );

    expect(() =>
      instance.entityReserve(
        panelInput({
          source: { repoPath: "panels/other", effectiveVersion: "" },
          key: "entry-2",
          lifecycleOwner: { contextId: "ctx-owner-b", entityId: "do:creator-b" },
        })
      )
    ).toThrow(/already belongs to lifecycle owner ctx-owner-a/);
    expect(instance.entityResolve(canonicalEntityId({ kind: "panel", key: "entry-2" }))).toBeNull();
  });

  it("rejects malformed or unbound immutable build keys at the durable boundary", () => {
    expect(() =>
      instance.entityActivate(
        panelInput({ activeBuildKey: "not-a-build-key", activeExecutionDigest: "a".repeat(64) })
      )
    ).toThrow(/lowercase SHA-256 build key/);
    expect(() => instance.entityActivate(panelInput({ activeBuildKey: "b".repeat(64) }))).toThrow(
      /requires an activeExecutionDigest/
    );
  });

  it("never rebinds an incarnation that already selected a different build key", () => {
    instance.entityActivate(
      panelInput({
        activeBuildKey: "b".repeat(64),
        activeExecutionDigest: "a".repeat(64),
        activeAuthority: ACTIVE_AUTHORITY,
      })
    );

    expect(() =>
      instance.entityActivate(
        panelInput({
          activeBuildKey: "c".repeat(64),
          activeExecutionDigest: "d".repeat(64),
          activeAuthority: ACTIVE_AUTHORITY,
        })
      )
    ).toThrow(/activeBuildKey/);
  });

  it("advances a live identity only through the complete sealed execution transition", () => {
    const initial = instance.entityActivate(preparedPanelInput());
    const advanced = instance.entityAdvanceExecution(
      preparedPanelInput({
        source: { repoPath: SOURCE, effectiveVersion: "v2" },
        activeBuildKey: "c".repeat(64),
        activeExecutionDigest: "d".repeat(64),
      })
    );

    expect(advanced).toMatchObject({
      id: initial.id,
      source: { repoPath: SOURCE, effectiveVersion: "v2" },
      activeBuildKey: "c".repeat(64),
      activeExecutionDigest: "d".repeat(64),
      activeAuthority: ACTIVE_AUTHORITY,
      createdAt: initial.createdAt,
    });
    expect(() =>
      instance.entityAdvanceExecution(
        preparedPanelInput({
          source: { repoPath: "panels/other", effectiveVersion: "v3" },
          activeBuildKey: "e".repeat(64),
          activeExecutionDigest: "f".repeat(64),
        })
      )
    ).toThrow(/Identity collision/);
  });

  it("advances a source publication as one durable transaction", () => {
    instance.entityActivate(preparedPanelInput({ key: "one" }));
    instance.entityActivate(preparedPanelInput({ key: "two" }));

    expect(() =>
      instance.entityAdvanceExecutions([
        preparedPanelInput({
          key: "one",
          source: { repoPath: SOURCE, effectiveVersion: "v2" },
          activeBuildKey: "c".repeat(64),
          activeExecutionDigest: "d".repeat(64),
        }),
        preparedPanelInput({
          key: "two",
          contextId: "ctx-other",
          source: { repoPath: SOURCE, effectiveVersion: "v2" },
          activeBuildKey: "c".repeat(64),
          activeExecutionDigest: "d".repeat(64),
        }),
      ])
    ).toThrow(/Identity collision/);

    const records = instance.entityListActiveByKind("panel");
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.activeBuildKey === "b".repeat(64))).toBe(true);
  });

  it("rejects malformed active authority at the durable write boundary", () => {
    expect(() =>
      instance.entityActivate(
        panelInput({
          activeAuthority: { requests: [], extra: true } as never,
        })
      )
    ).toThrow(/unknown field.*extra/);
  });

  it("rejects non-canonical execution identity on new activations", () => {
    expect(() =>
      instance.entityActivate(panelInput({ activeExecutionDigest: "0123456789abcdef" }))
    ).toThrow(/lowercase SHA-256 digest/);
  });

  it("rejects authority that is not bound to an exact execution identity", () => {
    expect(() =>
      instance.entityActivate(panelInput({ activeAuthority: ACTIVE_AUTHORITY }))
    ).toThrow(/requires an activeExecutionDigest/);
  });

  it("treats a missing-to-bound owner transition as an identity collision", () => {
    const initial = instance.entityActivate(doInput());
    expect(initial.ownerUserId).toBeUndefined();

    expect(() => instance.entityActivate(doInput({ ownerUserId: "usr_alice" }))).toThrow(
      /ownerUserId/
    );
  });

  it("treats a missing-to-bound agent binding transition as an identity collision", () => {
    instance.entityActivate(doInput());

    expect(() =>
      instance.entityActivate(
        doInput({
          agentBinding: {
            entityId: "agent-1",
            contextId: "ctx-1",
            channelId: "channel-1",
          },
        })
      )
    ).toThrow(/agentBinding/);
  });

  it("normalizes agent bindings into only the non-derivable entity edge and channel", async () => {
    const { instance: isolated, sql } = await createTestDO(WorkspaceDOTestable);
    const sessionId = canonicalEntityId({ kind: "session", key: "external" });
    const session = isolated.entityActivate({
      kind: "session",
      source: { repoPath: "claude-code", effectiveVersion: "" },
      contextId: "ctx-agent",
      key: "external",
      agentBinding: {
        entityId: sessionId,
        contextId: "ctx-agent",
        channelId: "channel:external",
      },
    });
    const relay = isolated.entityActivate(
      doInput({
        contextId: "ctx-agent",
        agentBinding: {
          entityId: session.id,
          contextId: "ctx-agent",
          channelId: "channel:external",
        },
      })
    );

    expect(
      sql
        .exec(`SELECT agent_entity_id, agent_channel_id FROM entities WHERE id = ?`, session.id)
        .one()
    ).toEqual({ agent_entity_id: null, agent_channel_id: "channel:external" });
    expect(
      sql
        .exec(`SELECT agent_entity_id, agent_channel_id FROM entities WHERE id = ?`, relay.id)
        .one()
    ).toEqual({ agent_entity_id: session.id, agent_channel_id: "channel:external" });
    expect(
      sql
        .exec(`PRAGMA table_info(entities)`)
        .toArray()
        .map((row) => row["name"])
    ).not.toContain("agent_binding");
    expect(isolated.entityResolve(session.id)?.agentBinding).toEqual({
      entityId: session.id,
      contextId: "ctx-agent",
      channelId: "channel:external",
    });
    expect(isolated.entityResolve(relay.id)?.agentBinding).toEqual({
      entityId: session.id,
      contextId: "ctx-agent",
      channelId: "channel:external",
    });
  });

  it("idempotently binds an unbound cloned agent to its child channel", () => {
    const agent = instance.entityActivate(
      doInput({
        source: { repoPath: "workers/agent-worker", effectiveVersion: VERSION },
        className: "AiChatWorker",
        key: "agent-fork",
        contextId: "ctx-fork",
      })
    );

    const first = instance.entityRebindAgentChannel(agent.id, "chat-fork");
    const second = instance.entityRebindAgentChannel(agent.id, "chat-fork");

    expect(first.agentBinding).toEqual({
      entityId: agent.id,
      contextId: "ctx-fork",
      channelId: "chat-fork",
    });
    expect(second).toEqual(first);
  });

  it("does not convert an external relay into a self-hosted agent", () => {
    const relay = instance.entityActivate(
      doInput({
        agentBinding: {
          entityId: "session:external",
          contextId: "ctx-1",
          channelId: "chat-parent",
        },
      })
    );

    expect(() => instance.entityRebindAgentChannel(relay.id, "chat-fork")).toThrow(
      /relays another agent/
    );
  });

  it("reactivates a retired row with identical identity", () => {
    const initial = instance.entityActivate(panelInput());
    instance.entityRetire(initial.id);
    const retired = instance.entityResolve(initial.id);
    expect(retired?.status).toBe("retired");
    expect(retired?.retiredAt).toBeTypeOf("number");

    const reactivated = instance.entityActivate(panelInput());
    expect(reactivated.id).toBe(initial.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.retiredAt).toBeUndefined();
    expect(reactivated.cleanupComplete).toBe(true);
  });

  it("throws IDENTITY_COLLISION when source differs for a panel (canonical id collides on key)", () => {
    // panel canonical id is `panel:<key>` and is source-independent, so two
    // activates with the same key but different sources hit the same row.
    instance.entityActivate(panelInput({ key: "p1" }));
    expect(() =>
      instance.entityActivate({
        kind: "panel",
        source: { repoPath: "panels/other", effectiveVersion: VERSION },
        contextId: "ctx-1",
        key: "p1",
      })
    ).toThrow(/Identity collision/);
  });

  it("throws IDENTITY_COLLISION when effectiveVersion differs for a do (canonical id matches)", () => {
    instance.entityActivate(doInput());
    expect(() =>
      instance.entityActivate(doInput({ source: { repoPath: SOURCE, effectiveVersion: "v2" } }))
    ).toThrow(/Identity collision/);
  });

  it("throws IDENTITY_COLLISION when contextId differs", () => {
    instance.entityActivate(doInput());
    expect(() => instance.entityActivate(doInput({ contextId: "ctx-other" }))).toThrow(
      /Identity collision/
    );
  });

  it("allows stateArgs to change on an idempotent activate", () => {
    instance.entityActivate(doInput({ stateArgs: { a: 1 } }));
    const rec = instance.entityActivate(doInput({ stateArgs: { a: 2 } }));
    expect(rec.stateArgs).toEqual({ a: 1 });
  });
});

describe("WorkspaceDO.entityRetire", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("is idempotent on already-retired rows", () => {
    const rec = instance.entityActivate(panelInput());
    const first = instance.entityRetire(rec.id);
    const second = instance.entityRetire(rec.id);
    expect(first?.status).toBe("retired");
    expect(second?.status).toBe("retired");
    expect(second?.retiredAt).toBe(first?.retiredAt);
  });

  it("returns null when retiring a missing row", () => {
    expect(instance.entityRetire("panel:missing")).toBeNull();
  });
});

describe("WorkspaceDO runtime resource bindings", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  const binding = (slotId: string) => ({
    resource: { kind: "panel-slot", id: slotId },
    capabilities: ["panel.inspect"],
    scope: { kind: "agent-channel" as const, channelId: "channel-1" },
  });

  it("persists validated relationships independently of revocable grants", () => {
    const entity = instance.entityActivate(doInput());
    instance.runtimeResourceBindingsReplace(entity.id, [binding("slot-a"), binding("slot-b")]);

    expect(instance.runtimeResourceBindingEntities("panel-slot", ["slot-b", "slot-c"])).toEqual([
      entity.id,
    ]);
    instance.runtimeResourceBindingsRelease(entity.id);
    expect(instance.runtimeResourceBindingEntities("panel-slot", ["slot-a"])).toEqual([]);
  });

  it("removes relationships atomically with entity retirement", () => {
    const entity = instance.entityActivate(doInput());
    instance.runtimeResourceBindingsReplace(entity.id, [binding("slot-a")]);

    instance.entityRetire(entity.id);

    expect(instance.runtimeResourceBindingEntities("panel-slot", ["slot-a"])).toEqual([]);
  });

  it("rejects relationships for inactive entities", () => {
    expect(() =>
      instance.runtimeResourceBindingsReplace("do:panels/example:MyDO:missing", [binding("slot-a")])
    ).toThrow(/not active/u);
  });
});

describe("WorkspaceDO.entityGc", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("with {all:true, graceMs:0} deletes retired rows", () => {
    const rec = instance.entityActivate(panelInput());
    instance.entityRetire(rec.id);
    const deleted = instance.entityGc({ all: true, graceMs: 0 });
    expect(deleted).toEqual([rec.id]);
    expect(instance.entityResolve(rec.id)).toBeNull();
  });

  it("does not delete active rows", () => {
    const rec = instance.entityActivate(panelInput());
    const deleted = instance.entityGc({ all: true, graceMs: 0 });
    expect(deleted).toEqual([]);
    expect(instance.entityResolve(rec.id)).not.toBeNull();
  });

  it("does not delete retired rows referenced by slot_history", () => {
    const rec = instance.entityActivate(panelInput({ key: "slot-entry" }));
    instance.slotCreate({
      slotId: "slot-A",
      parentSlotId: null,
      initialEntry: {
        entryKey: rec.key,
        entityId: rec.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    instance.entityRetire(rec.id);
    const deleted = instance.entityGc({ all: true, graceMs: 0 });
    expect(deleted).toEqual([]);
    expect(instance.entityResolve(rec.id)).not.toBeNull();
  });

  it("respects the grace window", () => {
    const rec = instance.entityActivate(panelInput());
    instance.entityRetire(rec.id);
    // graceMs of 10 minutes is far longer than the just-now retirement.
    expect(instance.entityGc({ all: true, graceMs: 10 * 60 * 1000 })).toEqual([]);
    expect(instance.entityResolve(rec.id)).not.toBeNull();
  });
});

describe("WorkspaceDO slot operations", () => {
  let instance: WorkspaceDOTestable;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("resumes an identical slot creation without duplicating history", () => {
    const entity = instance.entityActivate(preparedPanelInput({ key: "retry-entry" }));
    const input = {
      slotId: "retry-slot",
      parentSlotId: null,
      initialEntry: {
        entryKey: entity.key,
        entityId: entity.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    };

    instance.slotCreate(input);
    expect(() => instance.slotCreate(input)).not.toThrow();
    expect(instance.panelTreeDetail("retry-slot")).toMatchObject({
      slot: { current_entry_key: "retry-entry", current_entity_id: entity.id },
      currentHistory: { cursor: 0, entry_key: "retry-entry" },
    });
    expect(instance.slotHistoryRelative("retry-slot", -1)).toBeNull();
    expect(instance.slotHistoryRelative("retry-slot", 1)).toBeNull();
  });

  it("binds root ownership into the resumable slot identity", () => {
    const input = {
      slotId: "owned-retry-slot",
      parentSlotId: null,
      ownerUserId: "user-a",
    };

    instance.slotCreate(input);
    expect(() => instance.slotCreate(input)).not.toThrow();
    expect(() => instance.slotCreate({ ...input, ownerUserId: "user-b" })).toThrow(/ownerUserId/);
    expect(
      instance
        .panelTreePage({
          group: { kind: "roots", ownerUserId: "user-a" },
          limit: 10,
        })
        .nodes.map((node) => node.slotId)
    ).toEqual(["owned-retry-slot"]);
  });

  it("treats equivalent JSON with different property order as the same retry", () => {
    const entity = instance.entityActivate(preparedPanelInput({ key: "canonical-entry" }));
    const base = {
      slotId: "canonical-slot",
      parentSlotId: null,
      initialEntry: {
        entryKey: entity.key,
        entityId: entity.id,
        source: SOURCE,
        contextId: "ctx-1",
        stateArgs: { theme: "dark", nested: { enabled: true, count: 2 } },
        options: { ref: "main", flags: { inspect: true, focus: false } },
      },
    };
    instance.slotCreate(base);

    expect(() =>
      instance.slotCreate({
        ...base,
        initialEntry: {
          ...base.initialEntry,
          stateArgs: { nested: { count: 2, enabled: true }, theme: "dark" },
          options: { flags: { focus: false, inspect: true }, ref: "main" },
        },
      })
    ).not.toThrow();
    expect(instance.slotHistoryRelative("canonical-slot", -1)).toBeNull();
  });

  it("rejects a reused slot id with a different durable identity", () => {
    const first = instance.entityActivate(preparedPanelInput({ key: "collision-a" }));
    const second = instance.entityActivate(preparedPanelInput({ key: "collision-b" }));
    instance.slotCreate({
      slotId: "collision-slot",
      parentSlotId: null,
      initialEntry: {
        entryKey: first.key,
        entityId: first.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });

    expect(() =>
      instance.slotCreate({
        slotId: "collision-slot",
        parentSlotId: null,
        initialEntry: {
          entryKey: second.key,
          entityId: second.id,
          source: SOURCE,
          contextId: "ctx-1",
        },
      })
    ).toThrow(/Slot identity collision/);
    expect(instance.panelTreeDetail("collision-slot")).toMatchObject({
      slot: { current_entry_key: "collision-a", current_entity_id: first.id },
    });
  });

  it("rejects a retry that changes history options under the same slot identity", () => {
    const entity = instance.entityActivate(preparedPanelInput({ key: "option-entry" }));
    const base = {
      slotId: "option-slot",
      parentSlotId: null,
      initialEntry: {
        entryKey: entity.key,
        entityId: entity.id,
        source: SOURCE,
        contextId: "ctx-1",
        options: { ref: "main" },
      },
    };
    instance.slotCreate(base);

    expect(() =>
      instance.slotCreate({
        ...base,
        initialEntry: { ...base.initialEntry, options: { ref: "feature" } },
      })
    ).toThrow(/options/);
  });

  it("keyset-pages sibling groups without reading the complete forest", () => {
    for (const index of ["oldest", "middle", "newest"] as const) {
      const entity = instance.entityActivate(preparedPanelInput({ key: `page-${index}` }));
      instance.slotCreateAs("user-a", {
        slotId: `slot-${index}`,
        parentSlotId: null,
        initialEntry: {
          entryKey: entity.key,
          entityId: entity.id,
          source: SOURCE,
          contextId: "ctx-1",
        },
      });
    }

    const first = instance.panelTreePage({
      group: { kind: "roots", ownerUserId: "user-a" },
      limit: 2,
    });
    expect(first.nodes.map((node) => node.slotId)).toEqual(["slot-newest", "slot-middle"]);
    expect(first.nodes.every((node) => !("kind" in node) && !("title" in node))).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = instance.panelTreePage({
      group: { kind: "roots", ownerUserId: "user-a" },
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.nodes.map((node) => node.slotId)).toEqual(["slot-oldest"]);
    expect(second.nextCursor).toBeNull();
  });

  it("streams ten thousand newest-first siblings through bounded keyset pages", () => {
    const sql = (
      instance as unknown as {
        sql: { exec(statement: string, ...bindings: unknown[]): { toArray(): unknown[] } };
      }
    ).sql;
    sql.exec(
      `WITH RECURSIVE sequence(i) AS (
         VALUES(1)
         UNION ALL
         SELECT i + 1 FROM sequence WHERE i < 10000
       )
       INSERT INTO slots (
         slot_id, parent_slot_id, current_entity_id, current_entry_key,
         sort_key, owner_user_id, created_at, closed_at
       )
       SELECT printf('bulk-%05d', i), NULL, NULL, NULL, -i, 'bulk-owner', i, NULL
         FROM sequence`
    );

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const page = instance.panelTreePage({
        group: { kind: "roots", ownerUserId: "bulk-owner" },
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      expect(page.nodes.length).toBeLessThanOrEqual(200);
      for (const node of page.nodes) {
        expect(seen.has(node.slotId)).toBe(false);
        seen.add(node.slotId);
      }
      pageCount += 1;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(pageCount).toBe(50);
    expect(seen.size).toBe(10_000);
    expect([...seen].slice(0, 3)).toEqual(["bulk-10000", "bulk-09999", "bulk-09998"]);
  });

  it("projects panel surface kind from durable navigation history", () => {
    const workspaceEntity = instance.entityActivate(preparedPanelInput({ key: "workspace" }));
    instance.slotCreate({
      slotId: "workspace-slot",
      parentSlotId: null,
      initialEntry: {
        entryKey: workspaceEntity.key,
        entityId: workspaceEntity.id,
        source: "panels/example",
        contextId: "ctx-1",
      },
    });
    const browserEntity = instance.entityActivate(
      preparedPanelInput({
        key: "browser",
        source: { repoPath: "browser:https://example.com", effectiveVersion: VERSION },
      })
    );
    instance.slotCreate({
      slotId: "browser-slot",
      parentSlotId: null,
      initialEntry: {
        entryKey: browserEntity.key,
        entityId: browserEntity.id,
        source: "browser:https://example.com",
        contextId: "ctx-1",
      },
    });

    const page = instance.panelTreePage({
      group: { kind: "roots", ownerUserId: null },
      limit: 10,
    });
    expect(page.nodes.map(({ slotId }) => slotId)).toEqual(["browser-slot", "workspace-slot"]);
    expect(page.nodes.every((node) => !("kind" in node) && !("title" in node))).toBe(true);
    expect(instance.panelTreePath("browser-slot")?.nodes.at(-1)).toMatchObject({
      slotId: "browser-slot",
      source: "browser:https://example.com",
      contextId: "ctx-1",
      runtimeEntityId: browserEntity.id,
    });
  });

  it("moves panels between stable adjacent anchors without client-side ranks", () => {
    for (const id of ["oldest", "middle", "newest"]) {
      instance.slotCreateAs("user-a", {
        slotId: id,
        parentSlotId: null,
      });
    }
    expect(
      instance
        .panelTreePage({
          group: { kind: "roots", ownerUserId: "user-a" },
          limit: 10,
        })
        .nodes.map((node) => node.slotId)
    ).toEqual(["newest", "middle", "oldest"]);

    instance.slotMove("oldest", null, { beforeSlotId: "newest", afterSlotId: "middle" }, "user-a");

    expect(
      instance
        .panelTreePage({
          group: { kind: "roots", ownerUserId: "user-a" },
          limit: 10,
        })
        .nodes.map((node) => node.slotId)
    ).toEqual(["newest", "oldest", "middle"]);
  });

  it("keyset-pages owner root groups independently of root siblings", () => {
    for (const ownerUserId of [null, "alice", "bob"]) {
      instance.slotCreateAs(ownerUserId ?? undefined, {
        slotId: `root-${ownerUserId ?? "system"}`,
        parentSlotId: null,
      });
    }
    const first = instance.panelTreeRootGroups({ limit: 2 });
    expect(first.groups.map((group) => group.ownerUserId)).toEqual([null, "alice"]);
    expect(first.nextCursor).not.toBeNull();
    const second = instance.panelTreeRootGroups({
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(second.groups.map((group) => group.ownerUserId)).toEqual(["bob"]);
    expect(second.nextCursor).toBeNull();
  });

  it("returns revision-consistent addressed detail without materializing history", () => {
    expect(instance.panelTreeRootGroups({ limit: 1 }).revision).toBe(0);
    const entryA = instance.entityActivate(preparedPanelInput({ key: "snapshot-a" }));
    const entryB = instance.entityActivate(preparedPanelInput({ key: "snapshot-b" }));
    instance.slotCreate({
      slotId: "snapshot-slot",
      parentSlotId: null,
      initialEntry: {
        entryKey: entryA.key,
        entityId: entryA.id,
        source: SOURCE,
        contextId: "ctx-1",
        stateArgs: { step: "a" },
      },
    });

    const created = instance.panelTreeDetail("snapshot-slot");
    expect(created).not.toBeNull();
    if (!created) throw new Error("expected panel detail");
    expect(created.revision).toBeGreaterThan(0);
    expect(created.slot.slot_id).toBe("snapshot-slot");
    expect(created.currentHistory).toMatchObject({
      entry_key: entryA.key,
      entity_id: entryA.id,
      state_args: JSON.stringify({ step: "a" }),
    });
    expect(created.entity.id).toBe(entryA.id);

    instance.slotCommitPreparedNavigation({
      slotId: "snapshot-slot",
      expectedCurrentEntityId: entryA.id,
      mutation: {
        kind: "append",
        entry: {
          entryKey: entryB.key,
          entityId: entryB.id,
          source: SOURCE,
          contextId: "ctx-1",
          stateArgs: { step: "b" },
        },
      },
    });
    const navigated = instance.panelTreeDetail("snapshot-slot");
    expect(navigated).not.toBeNull();
    if (!navigated) throw new Error("expected navigated detail");
    expect(navigated.revision).toBeGreaterThan(created.revision);
    expect(navigated.slot.current_entity_id).toBe(entryB.id);
    expect(navigated.currentHistory.entity_id).toBe(entryB.id);
    expect(instance.slotHistoryRelative("snapshot-slot", -1)?.entity_id).toBe(entryA.id);

    instance.slotUpdateCurrentStateArgs("snapshot-slot", { step: "updated" });
    const updated = instance.panelTreeDetail("snapshot-slot");
    expect(updated).not.toBeNull();
    if (!updated) throw new Error("expected updated detail");
    expect(updated.revision).toBeGreaterThan(navigated.revision);
    expect(updated.currentHistory.state_args).toBe(JSON.stringify({ step: "updated" }));
    expect(updated.entity.stateArgs).toEqual({ step: "updated" });
  });

  it("atomically appends, selects, and replaces prepared panel incarnations", () => {
    const entryA = instance.entityActivate(preparedPanelInput({ key: "a" }));
    const entryB = instance.entityActivate(preparedPanelInput({ key: "b" }));
    const entryC = instance.entityActivate(preparedPanelInput({ key: "c" }));

    instance.slotCreate({
      slotId: "slot-1",
      parentSlotId: null,
      initialEntry: {
        entryKey: entryA.key,
        entityId: entryA.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    const appended = instance.slotCommitPreparedNavigation({
      slotId: "slot-1",
      expectedCurrentEntityId: entryA.id,
      mutation: {
        kind: "append",
        entry: {
          entryKey: entryB.key,
          entityId: entryB.id,
          source: SOURCE,
          contextId: "ctx-1",
        },
      },
    });
    expect(appended).toEqual({
      previousEntityId: entryA.id,
      currentEntityId: entryB.id,
      currentEntryKey: entryB.key,
      cursor: 1,
    });

    const selected = instance.slotCommitPreparedNavigation({
      slotId: "slot-1",
      expectedCurrentEntityId: entryB.id,
      mutation: { kind: "select", entryKey: entryA.key },
    });
    expect(selected.cursor).toBe(0);

    const replaced = instance.slotCommitPreparedNavigation({
      slotId: "slot-1",
      expectedCurrentEntityId: entryA.id,
      mutation: {
        kind: "replace",
        entry: {
          entryKey: entryC.key,
          entityId: entryC.id,
          source: SOURCE,
          contextId: "ctx-1",
        },
      },
    });
    expect(replaced.cursor).toBe(0);
    const slot = instance.slotGet("slot-1");
    expect(slot?.current_entry_key).toBe(entryC.key);
    expect(slot?.current_entity_id).toBe(entryC.id);

    expect(instance.slotHistoryRelative("slot-1", -1)).toBeNull();
    expect(instance.slotHistoryRelative("slot-1", 1)?.entry_key).toBe(entryB.key);
  });

  it("commits active external-document panels without a code execution image", () => {
    const current = instance.entityActivate(preparedPanelInput({ key: "external-current" }));
    const external = instance.entityActivate(
      panelInput({
        key: "external-next",
        source: {
          repoPath: "browser:https://example.org/",
          effectiveVersion: "",
        },
      })
    );
    instance.slotCreate({
      slotId: "external-slot",
      parentSlotId: null,
      initialEntry: {
        entryKey: current.key,
        entityId: current.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });

    expect(
      instance.slotCommitPreparedNavigation({
        slotId: "external-slot",
        expectedCurrentEntityId: current.id,
        mutation: {
          kind: "append",
          entry: {
            entryKey: external.key,
            entityId: external.id,
            source: "browser:https://example.org/",
            contextId: "ctx-1",
          },
        },
      })
    ).toMatchObject({
      previousEntityId: current.id,
      currentEntityId: external.id,
      currentEntryKey: external.key,
    });
  });

  it("rejects stale or incomplete prepared swaps without changing history or current", () => {
    const e1 = instance.entityActivate(preparedPanelInput({ key: "e1" }));
    const incomplete = instance.entityActivate(panelInput({ key: "incomplete" }));
    const staleCandidate = instance.entityActivate(preparedPanelInput({ key: "stale" }));
    instance.slotCreate({
      slotId: "slot-r",
      parentSlotId: null,
      initialEntry: {
        entryKey: e1.key,
        entityId: e1.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    const beforeSlot = instance.slotGet("slot-r");
    const beforeDetail = instance.panelTreeDetail("slot-r");
    const beforeRevision = instance.panelTreeRootGroups({ limit: 1 }).revision;

    expect(() =>
      instance.slotCommitPreparedNavigation({
        slotId: "slot-r",
        expectedCurrentEntityId: e1.id,
        mutation: {
          kind: "append",
          entry: {
            entryKey: incomplete.key,
            entityId: incomplete.id,
            source: SOURCE,
            contextId: "ctx-1",
          },
        },
      })
    ).toThrow(/not active and complete/);
    expect(() =>
      instance.slotCommitPreparedNavigation({
        slotId: "slot-r",
        expectedCurrentEntityId: staleCandidate.id,
        mutation: {
          kind: "append",
          entry: {
            entryKey: staleCandidate.key,
            entityId: staleCandidate.id,
            source: SOURCE,
            contextId: "ctx-1",
          },
        },
      })
    ).toThrow(/changed during preparation/);

    expect(instance.slotGet("slot-r")).toEqual(beforeSlot);
    expect(instance.panelTreeDetail("slot-r")).toEqual(beforeDetail);
    expect(instance.panelTreeRootGroups({ limit: 1 }).revision).toBe(beforeRevision);
  });

  it("slotUpdateCurrentStateArgs mutates the current history entry without changing entity id", () => {
    const rec = instance.entityActivate(panelInput({ key: "state-1", stateArgs: { a: 1 } }));
    instance.slotCreate({
      slotId: "slot-state",
      parentSlotId: null,
      initialEntry: {
        entryKey: rec.key,
        entityId: rec.id,
        source: SOURCE,
        contextId: "ctx-1",
        stateArgs: { a: 1 },
      },
    });

    instance.slotUpdateCurrentStateArgs("slot-state", { a: 2 });

    const slot = instance.slotGet("slot-state");
    expect(slot?.current_entity_id).toBe(rec.id);
    expect(instance.panelTreeDetail("slot-state")?.currentHistory.state_args).toBe(
      JSON.stringify({ a: 2 })
    );
    expect(instance.entityResolve(rec.id)?.stateArgs).toEqual({ a: 2 });
  });

  it("re-owns an entire subtree to the destination root owner", () => {
    instance.slotCreateAs("alice", {
      slotId: "alice-root",
      parentSlotId: null,
    });
    instance.slotCreateAs("bob", {
      slotId: "bob-root",
      parentSlotId: null,
    });
    instance.slotCreateAs("bob", {
      slotId: "bob-child",
      parentSlotId: "bob-root",
    });
    instance.slotCreateAs("bob", {
      slotId: "bob-grandchild",
      parentSlotId: "bob-child",
    });

    instance.slotMove("bob-child", "alice-root", {}, "bob");

    expect(instance.slotGet("bob-child")).toMatchObject({
      parent_slot_id: "alice-root",
      owner_user_id: "alice",
    });
    expect(instance.slotGet("bob-grandchild")?.owner_user_id).toBe("alice");
  });

  it("attributes a promoted root to the acting mover", () => {
    instance.slotCreateAs("bob", {
      slotId: "bob-root",
      parentSlotId: null,
    });
    instance.slotCreateAs("bob", {
      slotId: "bob-child",
      parentSlotId: "bob-root",
    });

    instance.slotMove("bob-child", null, {}, "alice");

    expect(instance.slotGet("bob-child")).toMatchObject({
      parent_slot_id: null,
      owner_user_id: "alice",
    });
  });

  it("rejects a move below the slot's own descendant without corrupting the tree", () => {
    instance.slotCreateAs("alice", {
      slotId: "root",
      parentSlotId: null,
    });
    instance.slotCreateAs("alice", {
      slotId: "child",
      parentSlotId: "root",
    });

    expect(() => instance.slotMove("root", "child", {}, "alice")).toThrow("under its own subtree");
    expect(instance.slotGet("root")?.parent_slot_id).toBeNull();
    expect(instance.slotGet("child")?.parent_slot_id).toBe("root");
  });

  it("slotClose marks the slot closed and clears current pointers", () => {
    const rec = instance.entityActivate(panelInput({ key: "close-1" }));
    instance.slotCreate({
      slotId: "slot-c",
      parentSlotId: null,
      initialEntry: {
        entryKey: rec.key,
        entityId: rec.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    instance.slotClose("slot-c");
    const slot = instance.slotGet("slot-c");
    expect(slot?.closed_at).toBeTypeOf("number");
    expect(slot?.current_entry_key).toBeNull();
  });

  it("closes a subtree deeper than one thousand levels and pages cleanup in bounded batches", () => {
    const sql = (
      instance as unknown as {
        sql: { exec(statement: string, ...bindings: unknown[]): { toArray(): unknown[] } };
      }
    ).sql;
    sql.exec(
      `WITH RECURSIVE sequence(i) AS (
         VALUES(0)
         UNION ALL
         SELECT i + 1 FROM sequence WHERE i < 1200
       )
       INSERT INTO slots (
         slot_id, parent_slot_id, current_entity_id, current_entry_key,
         sort_key, owner_user_id, created_at, closed_at
       )
       SELECT printf('deep-%04d', i),
              CASE WHEN i = 0 THEN NULL ELSE printf('deep-%04d', i - 1) END,
              NULL, NULL, 0, 'deep-owner', i, NULL
         FROM sequence`
    );

    expect(instance.panelTreePath("deep-1200")?.nodes).toHaveLength(1201);
    expect(instance.slotClose("deep-0000")).toEqual({
      closeId: "deep-0000",
      closedCount: 1201,
    });
    expect(instance.slotCloseCleanupPage({ ownerUserId: "other", limit: 200 }).items).toEqual([]);
    expect(
      instance.slotCloseCleanupPage({ ownerUserId: "deep-owner", limit: 200 }).items
    ).toHaveLength(200);

    let cursor: string | undefined;
    let cleanupCount = 0;
    do {
      const page = instance.slotCloseCleanupPage({
        closeId: "deep-0000",
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      expect(page.items.length).toBeLessThanOrEqual(200);
      cleanupCount += page.items.length;
      instance.slotCloseCleanupAck(page.items.map(({ slotId }) => slotId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(cleanupCount).toBe(1201);
    expect(instance.slotCloseCleanupPage({ closeId: "deep-0000", limit: 200 }).items).toEqual([]);
    expect(instance.slotGet("deep-1200")?.closed_at).toBeTypeOf("number");
  });
});

describe("WorkspaceDO entity reads", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("entityResolveActive returns null after retire and a record while active", () => {
    const rec = instance.entityActivate(panelInput());
    expect(instance.entityResolveActive(rec.id)?.id).toBe(rec.id);
    instance.entityRetire(rec.id);
    expect(instance.entityResolveActive(rec.id)).toBeNull();
  });

  it("entityFindIncompleteCleanups returns retired rows with cleanup_complete=0", () => {
    const r1 = instance.entityActivate(panelInput({ key: "a" }));
    const r2 = instance.entityActivate(panelInput({ key: "b" }));
    instance.entityRetire(r1.id);
    instance.entityRetire(r2.id);
    instance.entityCleanupComplete(r1.id);
    const incomplete = instance.entityFindIncompleteCleanups();
    expect(incomplete.map((r: EntityRecord) => r.id)).toEqual([r2.id]);
  });
});

describe("WorkspaceDO lifecycle registry", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
    instance.alarmAdoptWorker("driver-1");
  });

  it("upserts, refreshes, lists, and clears active-work leases", () => {
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    instance.lifecycleLeaseUpsert({ ...key, detail: { turnId: "turn-1" } });
    instance.lifecycleLeaseUpsert({ ...key, detail: { turnId: "turn-2" } });

    expect(instance.lifecycleListLeases()).toMatchObject([
      { ...key, detail: { turnId: "turn-2" } },
    ]);

    instance.lifecycleLeaseClear(key);
    expect(instance.lifecycleListLeases()).toEqual([]);
  });

  it("registers work capability only for an active owner and removes it on retirement", () => {
    const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
    expect(() => instance.durableWorkOwnerRegister({ ...key, queues: ["agent-wake"] })).toThrow(
      /is not active/u
    );

    const entity = instance.entityActivate(doInput());
    instance.durableWorkOwnerRegister({
      ...key,
      queues: ["agent-effect", "agent-wake", "agent-wake"],
    });
    expect(instance.durableWorkOwnerList()).toEqual([
      { owner: key, queues: ["agent-effect", "agent-wake"] },
    ]);

    instance.entityRetire(entity.id);
    expect(instance.durableWorkOwnerList()).toEqual([]);
  });

  it("claims due alarms durably and acknowledges the exact generation", () => {
    const a = { source: "workers/poller", className: "PollerDO", objectKey: "p-1" };
    const b = { source: "workers/poller", className: "PollerDO", objectKey: "p-2" };
    activateAlarmKey(instance, a);
    activateAlarmKey(instance, b);

    instance.alarmSet({ ...a, wakeAt: 5_000 });
    instance.alarmSet({ ...b, wakeAt: 2_000 });
    // Replace a's wake time.
    instance.alarmSet({ ...a, wakeAt: 1_000 });

    expect(instance.alarmNextWakeAt(0)).toBe(1_000);

    const claims = instance.alarmClaimDue({
      now: 1_500,
      workerId: "driver-1",
      limit: 8,
    });
    expect(claims).toEqual([{ ...a, wakeAt: 1_000, dispatchGeneration: 1 }]);
    expect(instance.alarmNextWakeAt(1_500)).toBe(2_000);
    expect(
      instance.alarmClear({
        ...a,
        dispatchOwner: "driver-1",
        dispatchGeneration: claims[0]!.dispatchGeneration,
      })
    ).toBe("accepted");
    expect(instance.alarmNextWakeAt(1_500)).toBe(2_000);

    // Clearing removes a pending alarm.
    instance.alarmClear(b);
    expect(instance.alarmNextWakeAt(1_500)).toBeNull();
    expect(
      instance.alarmClaimDue({
        now: 10_000,
        workerId: "driver-1",
        limit: 8,
      })
    ).toEqual([]);
  });

  it("retains host-attested test authority with a derived alarm until acknowledgement", () => {
    const key = { source: "workers/poller", className: "PollerDO", objectKey: "test-case" };
    const testPolicy = {
      policyId: "system-test:permissions-list",
      kind: "orchestrator" as const,
    };
    activateAlarmKey(instance, key);

    instance.alarmSet({ ...key, wakeAt: 1_000, testPolicy });
    // A derived schedule update from the alarm driver has no ambient caller,
    // but it must not detach the authority of the durable work it is advancing.
    instance.alarmSet({ ...key, wakeAt: 2_000 });

    const [claim] = instance.alarmClaimDue({
      now: 2_000,
      workerId: "driver-1",
      limit: 1,
    });
    expect(claim).toEqual({ ...key, wakeAt: 2_000, dispatchGeneration: 1, testPolicy });
    instance.alarmClear({
      ...key,
      dispatchOwner: "driver-1",
      dispatchGeneration: claim!.dispatchGeneration,
    });
    expect(
      instance.alarmClaimDue({
        now: 2_000,
        workerId: "driver-1",
        limit: 1,
      })
    ).toEqual([]);
  });

  it("releases a prior claim only when a new scheduler generation is adopted", () => {
    const key = { source: "workers/poller", className: "PollerDO", objectKey: "reclaim" };
    activateAlarmKey(instance, key);
    instance.alarmSet({ ...key, wakeAt: 1_000 });

    const [first] = instance.alarmClaimDue({
      now: 1_000,
      workerId: "driver-1",
      limit: 1,
    });
    expect(instance.alarmNextWakeAt(1_000)).toBeNull();
    expect(() =>
      instance.alarmClaimDue({
        now: 1_000_000,
        workerId: "driver-2",
        limit: 1,
      })
    ).toThrow(/worker generation is not active/u);

    instance.alarmAdoptWorker("driver-2");
    const [second] = instance.alarmClaimDue({
      now: 1_000_000,
      workerId: "driver-2",
      limit: 1,
    });
    expect(second!.dispatchGeneration).toBe(first!.dispatchGeneration + 1);
    expect(
      instance.alarmClear({
        ...key,
        dispatchOwner: "driver-1",
        dispatchGeneration: first!.dispatchGeneration,
      })
    ).toBe("stale");
    expect(
      instance.alarmClear({
        ...key,
        dispatchOwner: "driver-2",
        dispatchGeneration: second!.dispatchGeneration,
      })
    ).toBe("accepted");
  });

  it("fences an active handler when a concurrent request replaces its wake", () => {
    const key = { source: "workers/poller", className: "PollerDO", objectKey: "replace" };
    activateAlarmKey(instance, key);
    instance.alarmSet({ ...key, wakeAt: 1_000 });
    const [claim] = instance.alarmClaimDue({
      now: 1_000,
      workerId: "driver-1",
      limit: 1,
    });

    instance.alarmSet({ ...key, wakeAt: 1_100 });
    expect(
      instance.alarmClear({
        ...key,
        dispatchOwner: "driver-1",
        dispatchGeneration: claim!.dispatchGeneration,
      })
    ).toBe("stale");
    expect(instance.alarmNextWakeAt(1_000)).toBe(1_100);
  });

  it("opens an epoch and snapshots live leases into prepare and resume ops", () => {
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    instance.lifecycleLeaseUpsert(key);

    const epochId = instance.lifecycleOpenEpoch({
      kind: "planned",
      reason: "restart",
      generation: 2,
    });
    expect(epochId).toMatch(/^epoch-/);

    const ops = instance.lifecycleListOps(epochId);
    expect(ops).toHaveLength(2);
    expect(ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...key, opKind: "prepare", status: "pending" }),
        expect.objectContaining({ ...key, opKind: "resume", status: "pending" }),
      ])
    );
  });

  it("returns lease-only crash targets even when no epoch or op exists", () => {
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    instance.lifecycleLeaseUpsert(key);

    expect(instance.lifecycleListResumeTargets()).toEqual([key]);
  });

  it("includes unfinished resume ops after the lease has been cleared", () => {
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    instance.lifecycleLeaseUpsert(key);
    const epochId = instance.lifecycleOpenEpoch({
      kind: "planned",
      reason: "restart",
      generation: 2,
    });
    instance.lifecycleLeaseClear(key);

    expect(instance.lifecycleListResumeTargets()).toEqual([key]);

    instance.lifecycleRecordOp({
      epochId,
      key,
      opKind: "resume",
      status: "resumed",
    });
    expect(instance.lifecycleListResumeTargets()).toEqual([]);
  });

  it("clears a DO lease when the matching entity is retired", () => {
    const rec = instance.entityActivate(doInput());
    const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
    instance.lifecycleLeaseUpsert(key);

    instance.entityRetire(rec.id);

    expect(instance.lifecycleListLeases()).toEqual([]);
  });

  it("clears a DO alarm on retirement and rejects late scheduling", () => {
    const rec = instance.entityActivate(doInput());
    const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
    instance.alarmSet({ ...key, wakeAt: 1_000 });

    instance.entityRetire(rec.id);
    expect(
      instance.alarmClaimDue({
        now: 1_000,
        workerId: "driver-1",
        limit: 1,
      })
    ).toEqual([]);
    expect(() => instance.alarmSet({ ...key, wakeAt: 2_000 })).toThrow(/is not active/u);
    expect(
      instance.alarmClaimDue({
        now: 2_000,
        workerId: "driver-1",
        limit: 1,
      })
    ).toEqual([]);
  });

  it("rejects scheduling when no matching active DO exists", () => {
    expect(() =>
      instance.alarmSet({
        source: "workers/missing",
        className: "MissingDO",
        objectKey: "missing",
        wakeAt: 1_000,
      })
    ).toThrow(/is not active/u);
    expect(instance.alarmNextWakeAt(0)).toBeNull();
  });

  it("repairs a persisted retired-entity alarm during startup", async () => {
    const first = await createTestDO(WorkspaceDOTestable);
    first.instance.alarmAdoptWorker("driver-1");
    const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
    const rec = first.instance.entityActivate(doInput());
    first.instance.entityRetire(rec.id);

    // Model a crash-era stale row without passing through the guarded ingress.
    first.sql.exec(
      `INSERT INTO do_alarms (source, class_name, object_key, wake_at) VALUES (?, ?, ?, ?)`,
      key.source,
      key.className,
      key.objectKey,
      2_000
    );
    expect(
      first.instance.alarmClaimDue({
        now: 2_000,
        workerId: "driver-1",
        limit: 1,
      })
    ).toEqual([{ ...key, wakeAt: 2_000, dispatchGeneration: 1 }]);

    const restarted = await createTestDO(WorkspaceDOTestable, undefined, { db: first.db });
    restarted.instance.alarmAdoptWorker("driver-2");
    expect(
      restarted.instance.alarmClaimDue({
        now: 2_000,
        workerId: "driver-2",
        limit: 1,
      })
    ).toEqual([]);
  });
});
