import { beforeEach, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";

import { createTestDO } from "@vibestudio/durable/test-utils";
import {
  canonicalEntityId,
  type EntityRecord,
} from "../../../packages/shared/src/runtime/entitySpec.js";
import { WorkspaceDO, type RecurringJobRow } from "./workspaceDO.js";
import { WorkspaceDOTestable } from "./workspaceDO.testFixture.js";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";

const SOURCE = "panels/example";
const VERSION = "v1";
const WORKSPACE_TABLES = [
  "entities",
  "slots",
  "slot_history",
  "panel_search_metadata",
  "workspace_meta",
  "lifecycle_epochs",
  "lifecycle_leases",
  "lifecycle_ops",
  "do_alarms",
  "recurring_jobs",
];
const CURRENT_SCHEMA_VERSION = WorkspaceDO.schemaVersion;
const ACTIVE_AUTHORITY: UnitAuthorityManifest = {
  requests: [
    {
      capability: "service:panel.getInfo",
      resource: { kind: "exact", key: "panel:getInfo" },
      tier: "gated",
      evidence: "exact",
    },
  ],
};

async function createDbAtSchemaVersion(schemaVersion: number) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, [String(schemaVersion)]);
  return db;
}

function panelInput(overrides: Partial<Parameters<WorkspaceDO["entityActivate"]>[0]> = {}) {
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

describe("WorkspaceDO exact pre-release schema", () => {
  it("migrates the v24 production schema to the preparing lifecycle without losing rows", async () => {
    const first = await createTestDO(WorkspaceDOTestable);
    const existing = first.instance.entityActivate(panelInput());
    first.db.run(`DROP TABLE do_alarm_test_policies`);
    first.db.run(`DELETE FROM _vibestudio_schema_migrations`);
    first.db.run(
      `INSERT INTO _vibestudio_schema_migrations (version, name, applied_at)
       VALUES (24, 'fresh-install:workspace-state-v24', 1)`
    );
    first.db.run(`UPDATE state SET value = '24' WHERE key = 'schema_version'`);

    const migrated = await createTestDO(WorkspaceDOTestable, undefined, { db: first.db });
    expect(migrated.instance.entityResolve(existing.id)).toMatchObject({
      id: existing.id,
      status: "active",
    });
    expect(
      first.db.exec(`SELECT version, name FROM _vibestudio_schema_migrations ORDER BY version`)[0]!
        .values
    ).toEqual([
      [24, "fresh-install:workspace-state-v24"],
      [25, "introduce-preparing-panel-lifecycle"],
      [26, "persist-test-authority-with-owned-alarms"],
    ]);
    expect(
      first.db.exec(`SELECT value FROM state WHERE key = 'schema_version'`)[0]!.values
    ).toEqual([["26"]]);
  });

  it("creates one exact fresh schema containing the complete execution identity", async () => {
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
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: String(CURRENT_SCHEMA_VERSION),
    });
  });

  it("rejects drift in a stamped current schema", async () => {
    const db = await createDbAtSchemaVersion(CURRENT_SCHEMA_VERSION);
    await expect(createTestDO(WorkspaceDOTestable, undefined, { db })).rejects.toThrow(
      /missing table/
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
    const reserved = instance.entityReservePanel(
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

describe("WorkspaceDO recurring jobs", () => {
  let instance: WorkspaceDO;
  const job = (overrides: Partial<RecurringJobRow> = {}): RecurringJobRow => ({
    name: "news-briefing",
    source: "workers/news-agent",
    className: "NewsAgentWorker",
    objectKey: "news",
    method: "runScheduledJob",
    argsJson: JSON.stringify([{ job: "briefing" }]),
    intervalMs: 3_600_000,
    atMinutes: null,
    specHash: "hash-1",
    initialNextRunAt: 10_000,
    ...overrides,
  });

  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("marks success and failure state durably", () => {
    instance.recurringSync({ jobs: [job()] });
    expect(instance.recurringDue(10_000)).toHaveLength(1);

    instance.recurringMarkRun({ name: "news-briefing", lastRunAt: 10_000, nextRunAt: 20_000 });
    instance.recurringMarkFailed({
      name: "news-briefing",
      failedAt: 10_050,
      nextRunAt: 15_000,
      failCount: 1,
      error: "boom",
      durationMs: 50,
    });
    expect(instance.recurringList()[0]).toMatchObject({
      name: "news-briefing",
      nextRunAt: 15_000,
      failCount: 1,
      backoffUntil: 15_000,
      lastFailedAt: 10_050,
      lastError: "boom",
      lastDurationMs: 50,
    });
    expect(instance.recurringDue(14_999)).toHaveLength(0);
    expect(instance.recurringDue(15_000)).toHaveLength(1);

    instance.recurringMarkRun({ name: "news-briefing", lastRunAt: 15_000, nextRunAt: 25_000 });
    instance.recurringMarkSucceeded({
      name: "news-briefing",
      finishedAt: 15_025,
      durationMs: 25,
    });
    expect(instance.recurringList()[0]).toMatchObject({
      nextRunAt: 25_000,
      failCount: 0,
      backoffUntil: null,
      lastSucceededAt: 15_025,
      lastError: null,
      lastDurationMs: 25,
    });
  });

  it("preserves recurring run state across unchanged syncs and clears failure state on spec changes", () => {
    instance.recurringSync({ jobs: [job()] });
    instance.recurringMarkFailed({
      name: "news-briefing",
      failedAt: 10_050,
      nextRunAt: 15_000,
      failCount: 2,
      error: "still broken",
      durationMs: 50,
    });

    instance.recurringSync({ jobs: [job({ initialNextRunAt: 99_000 })] });
    expect(instance.recurringList()[0]).toMatchObject({
      nextRunAt: 15_000,
      failCount: 2,
      lastError: "still broken",
    });

    instance.recurringSync({
      jobs: [job({ specHash: "hash-2", initialNextRunAt: 99_000 })],
    });
    expect(instance.recurringList()[0]).toMatchObject({
      nextRunAt: 99_000,
      failCount: 0,
      backoffUntil: null,
      lastError: null,
      lastFailedAt: null,
    });
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
      positionId: "000001000000",
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
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("atomically appends, selects, and replaces prepared panel incarnations", () => {
    const entryA = instance.entityActivate(preparedPanelInput({ key: "a" }));
    const entryB = instance.entityActivate(preparedPanelInput({ key: "b" }));
    const entryC = instance.entityActivate(preparedPanelInput({ key: "c" }));

    instance.slotCreate({
      slotId: "slot-1",
      parentSlotId: null,
      positionId: "000001000000",
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

    const history = instance.slotHistory("slot-1");
    expect(history.map((h) => h.cursor)).toEqual([0, 1]);
    expect(history.map((h) => h.entry_key)).toEqual([entryC.key, entryB.key]);
  });

  it("rejects stale or incomplete prepared swaps without changing history or current", () => {
    const e1 = instance.entityActivate(preparedPanelInput({ key: "e1" }));
    const incomplete = instance.entityActivate(panelInput({ key: "incomplete" }));
    const staleCandidate = instance.entityActivate(preparedPanelInput({ key: "stale" }));
    instance.slotCreate({
      slotId: "slot-r",
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: e1.key,
        entityId: e1.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    const beforeSlot = instance.slotGet("slot-r");
    const beforeHistory = instance.slotHistory("slot-r");

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
    expect(instance.slotHistory("slot-r")).toEqual(beforeHistory);
  });

  it("slotUpdateCurrentStateArgs mutates the current history entry without changing entity id", () => {
    const rec = instance.entityActivate(panelInput({ key: "state-1", stateArgs: { a: 1 } }));
    instance.slotCreate({
      slotId: "slot-state",
      parentSlotId: null,
      positionId: "000001000000",
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
    expect(instance.slotHistory("slot-state")[0]?.state_args).toBe(JSON.stringify({ a: 2 }));
    expect(instance.entityResolve(rec.id)?.stateArgs).toEqual({ a: 2 });
  });

  it("re-owns an entire subtree to the destination root owner", () => {
    instance.slotCreate({
      slotId: "alice-root",
      parentSlotId: null,
      positionId: "000001000000",
      ownerUserId: "alice",
    });
    instance.slotCreate({
      slotId: "bob-root",
      parentSlotId: null,
      positionId: "000002000000",
      ownerUserId: "bob",
    });
    instance.slotCreate({
      slotId: "bob-child",
      parentSlotId: "bob-root",
      positionId: "000001000000",
      ownerUserId: "bob",
    });
    instance.slotCreate({
      slotId: "bob-grandchild",
      parentSlotId: "bob-child",
      positionId: "000001000000",
      ownerUserId: "bob",
    });

    instance.slotMove("bob-child", "alice-root", "000001000000", "bob");

    expect(instance.slotGet("bob-child")).toMatchObject({
      parent_slot_id: "alice-root",
      owner_user_id: "alice",
    });
    expect(instance.slotGet("bob-grandchild")?.owner_user_id).toBe("alice");
  });

  it("attributes a promoted root to the acting mover", () => {
    instance.slotCreate({
      slotId: "bob-root",
      parentSlotId: null,
      positionId: "000001000000",
      ownerUserId: "bob",
    });
    instance.slotCreate({
      slotId: "bob-child",
      parentSlotId: "bob-root",
      positionId: "000001000000",
      ownerUserId: "bob",
    });

    instance.slotMove("bob-child", null, "000002000000", "alice");

    expect(instance.slotGet("bob-child")).toMatchObject({
      parent_slot_id: null,
      owner_user_id: "alice",
    });
  });

  it("rejects a move below the slot's own descendant without corrupting the tree", () => {
    instance.slotCreate({
      slotId: "root",
      parentSlotId: null,
      positionId: "000001000000",
      ownerUserId: "alice",
    });
    instance.slotCreate({
      slotId: "child",
      parentSlotId: "root",
      positionId: "000001000000",
      ownerUserId: "alice",
    });

    expect(() => instance.slotMove("root", "child", "000002000000", "alice")).toThrow(
      "under its own subtree"
    );
    expect(instance.slotGet("root")?.parent_slot_id).toBeNull();
    expect(instance.slotGet("child")?.parent_slot_id).toBe("root");
  });

  it("slotClose marks the slot closed and clears current pointers", () => {
    const rec = instance.entityActivate(panelInput({ key: "close-1" }));
    instance.slotCreate({
      slotId: "slot-c",
      parentSlotId: null,
      positionId: "000001000000",
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

  it("lists due alarms without consuming them and acknowledges explicitly", () => {
    const a = { source: "workers/poller", className: "PollerDO", objectKey: "p-1" };
    const b = { source: "workers/poller", className: "PollerDO", objectKey: "p-2" };
    activateAlarmKey(instance, a);
    activateAlarmKey(instance, b);

    instance.alarmSet({ ...a, wakeAt: 5_000 });
    instance.alarmSet({ ...b, wakeAt: 2_000 });
    // Replace a's wake time.
    instance.alarmSet({ ...a, wakeAt: 1_000 });

    expect(instance.alarmNextWakeAt()).toBe(1_000);

    // Listing does not consume the row; explicit outcome acknowledgement does.
    expect(instance.alarmListDue(1_500)).toEqual([{ ...a, wakeAt: 1_000 }]);
    expect(instance.alarmNextWakeAt()).toBe(1_000);
    instance.alarmClear(a);
    expect(instance.alarmNextWakeAt()).toBe(2_000);

    // Clearing removes a pending alarm.
    instance.alarmClear(b);
    expect(instance.alarmNextWakeAt()).toBeNull();
    expect(instance.alarmListDue(10_000)).toEqual([]);
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

    expect(instance.alarmListDue(2_000)).toEqual([{ ...key, wakeAt: 2_000, testPolicy }]);
    instance.alarmClear(key);
    expect(instance.alarmListDue(2_000)).toEqual([]);
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
    expect(instance.alarmListDue(1_000)).toEqual([]);
    expect(() => instance.alarmSet({ ...key, wakeAt: 2_000 })).toThrow(/is not active/u);
    expect(instance.alarmListDue(2_000)).toEqual([]);
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
    expect(instance.alarmNextWakeAt()).toBeNull();
  });

  it("repairs a persisted retired-entity alarm during startup", async () => {
    const first = await createTestDO(WorkspaceDOTestable);
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
    expect(first.instance.alarmListDue(2_000)).toEqual([{ ...key, wakeAt: 2_000 }]);

    const restarted = await createTestDO(WorkspaceDOTestable, undefined, { db: first.db });
    expect(restarted.instance.alarmListDue(2_000)).toEqual([]);
  });
});

describe("WorkspaceDO panel search metadata (FTS5-free fallback)", () => {
  // sql.js (the test fixture) lacks FTS5, so the panel_fts virtual table is
  // omitted by WorkspaceDOTestable. These tests cover the metadata-only path
  // that the real FTS5 virtual table reads from; the full search query is
  // covered by the workerd integration test.
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  function readMetadata(slotId: string): Record<string, unknown> | undefined {
    return (
      (
        instance as unknown as {
          sql: { exec(s: string, ...b: unknown[]): { toArray(): unknown[] } };
        }
      ).sql
        .exec(`SELECT * FROM panel_search_metadata WHERE slot_id = ?`, slotId)
        .toArray() as Array<Record<string, unknown>>
    )[0];
  }

  // Helper: stand up an entity + slot pair so the title-flow methods have
  // something to bind to. Returns the entity id (= what
  // `panelIndex`/`panelUpdateTitle` will return when they stamp a title).
  function bindSlotToEntity(slotId: string, entityKey: string): string {
    const entity = instance.entityActivate({
      kind: "panel",
      source: { repoPath: "panels/test", effectiveVersion: "ev-1" },
      contextId: "ctx",
      key: entityKey,
    });
    instance.slotCreate({
      slotId,
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: "entry-1",
        entityId: entity.id,
        source: "panels/test",
        contextId: "ctx",
      },
    });
    return entity.id;
  }

  function readEntityTitle(entityId: string): string | null {
    const sql = (
      instance as unknown as {
        sql: { exec(s: string, ...b: unknown[]): { toArray(): unknown[] } };
      }
    ).sql;
    const row = sql
      .exec(`SELECT display_title FROM entities WHERE id = ?`, entityId)
      .toArray()[0] as { display_title: string | null } | undefined;
    return row?.display_title ?? null;
  }

  it("panelIndex stamps the title onto the slot's current entity, then panelUpdateTitle routes through entitySetDisplayTitle", () => {
    const entityId = bindSlotToEntity("slot-1", "key-1");

    const returned = instance.panelIndex({
      id: "slot-1",
      title: "Initial Title",
      path: "/projects/foo",
      manifestDescription: "test panel",
      tags: ["x", "y"],
      keywords: ["alpha"],
    });
    expect(returned).toBe(entityId);
    expect(readEntityTitle(entityId)).toBe("Initial Title");

    const inserted = readMetadata("slot-1");
    // panel_search_metadata.searchable_title is a documented FTS
    // denormalization of entities.display_title; both should agree.
    expect(inserted).toMatchObject({
      slot_id: "slot-1",
      searchable_title: "Initial Title",
      searchable_path: "/projects/foo",
      manifest_description: "test panel",
      access_count: 0,
    });
    expect(JSON.parse(inserted!["tags"] as string)).toEqual(["x", "y"]);
    expect(JSON.parse(inserted!["keywords"] as string)).toEqual(["alpha"]);

    const renamed = instance.panelUpdateTitle("slot-1", "Renamed Title");
    expect(renamed).toBe(entityId);
    expect(readEntityTitle(entityId)).toBe("Renamed Title");
    // The FTS denormalization on panel_search_metadata moves in lockstep.
    expect(readMetadata("slot-1")?.["searchable_title"]).toBe("Renamed Title");

    instance.panelIncrementAccess("slot-1");
    instance.panelIncrementAccess("slot-1");
    instance.panelIncrementAccess("slot-1");
    expect(readMetadata("slot-1")?.["access_count"]).toBe(3);
  });

  it("entitySetDisplayTitle works for non-panel entities and clears with null/empty", () => {
    const worker = instance.entityActivate({
      kind: "worker",
      source: { repoPath: "workers/agent", effectiveVersion: "ev-1" },
      contextId: "ctx",
      key: "agent-key",
    });
    instance.entitySetDisplayTitle(worker.id, "Agent Title");
    expect(readEntityTitle(worker.id)).toBe("Agent Title");

    instance.entitySetDisplayTitle(worker.id, "");
    expect(readEntityTitle(worker.id)).toBeNull();

    instance.entitySetDisplayTitle(worker.id, "Back");
    instance.entitySetDisplayTitle(worker.id, null);
    expect(readEntityTitle(worker.id)).toBeNull();
  });

  it("entityListDisplayTitles returns only active entities with titles", () => {
    const a = instance.entityActivate({
      kind: "worker",
      source: { repoPath: "workers/a", effectiveVersion: "ev" },
      contextId: "ctx",
      key: "a",
    });
    const b = instance.entityActivate({
      kind: "worker",
      source: { repoPath: "workers/b", effectiveVersion: "ev" },
      contextId: "ctx",
      key: "b",
    });
    instance.entitySetDisplayTitle(a.id, "Alpha");
    // b has no title — it should be absent from the list.
    expect(
      instance
        .entityListDisplayTitles()
        .map((r) => r.id)
        .sort()
    ).toEqual([a.id]);
    // Retired entities drop out.
    instance.entitySetDisplayTitle(b.id, "Bravo");
    instance.entityRetire(b.id);
    expect(
      instance
        .entityListDisplayTitles()
        .map((r) => r.id)
        .sort()
    ).toEqual([a.id]);
  });

  it("panelIndex is idempotent — re-indexing the same slot_id updates in place rather than inserting a duplicate", () => {
    bindSlotToEntity("slot-2", "key-2");
    instance.panelIndex({ id: "slot-2", title: "First" });
    instance.panelIndex({ id: "slot-2", title: "Second", path: "/p" });

    const rows = (
      instance as unknown as { sql: { exec(s: string, ...b: unknown[]): { toArray(): unknown[] } } }
    ).sql
      .exec(`SELECT * FROM panel_search_metadata WHERE slot_id = ?`, "slot-2")
      .toArray() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["searchable_title"]).toBe("Second");
    expect(rows[0]?.["searchable_path"]).toBe("/p");
  });
});
