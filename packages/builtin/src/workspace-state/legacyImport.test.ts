/**
 * The move of a workspace's state from the retired SQLite store (`WorkspaceDO`)
 * into the Dolt cell that replaced it: the replay planner, and the whole import
 * (stage, replay, copy, verify) against a legacy store built from realistic
 * history. docs/dolt-redesign.md §9.2, Q2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "sql.js";
import { createTestDO, getSqlJs } from "@vibestudio/durable/test-utils";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { WorkspaceDO } from "./WorkspaceDO.js";
import { createWorkspaceStateTestDO } from "./testFixture.js";
import { createLegacyStoreSchema } from "./legacyStoreFixture.js";
import {
  LEGACY_COLUMNS,
  LEGACY_IMPORT_TABLES,
  digestRows,
  planReplay,
  type LegacyImportTable,
  type LegacyRow,
  type StagedRows,
} from "./legacyImport.js";
import {
  importLegacyWorkspaceState,
  type LegacyStoreImporter,
  type LegacyStoreReader,
} from "./legacyImportDriver.js";

const SOURCE = "panels/example";
const AUTHORITY: UnitAuthorityManifest = { provides: [], requests: [], serviceRequests: [] };
const T0 = 1_700_000_000_000;

const panel = (key: string) => ({
  nativeOwner: null,
  durableWorkQueues: [],
  kind: "panel" as const,
  source: { repoPath: SOURCE, effectiveVersion: "v1" },
  contextId: "ctx-1",
  key,
  activeBuildKey: "b".repeat(64),
  activeExecutionDigest: "a".repeat(64),
  activeAuthority: AUTHORITY,
});
const entry = (entity: { key: string; id: string }) => ({
  entryKey: entity.key,
  entityId: entity.id,
  source: SOURCE,
  contextId: "ctx-1",
});

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

describe("planReplay", () => {
  const row = (values: Record<string, string | number | null>): LegacyRow => values;
  const entity = (id: string, createdAt: number, extra: LegacyRow = {}) =>
    row({ id, created_at: createdAt, status: "active", retired_at: null, agent_entity_id: null, ...extra });
  const slot = (id: string, createdAt: number, extra: LegacyRow = {}) =>
    row({
      slot_id: id,
      created_at: createdAt,
      parent_slot_id: null,
      current_entity_id: null,
      current_entry_key: null,
      closed_at: null,
      ...extra,
    });
  const history = (slotId: string, cursor: number, entryKey: string, entityId: string, at: number) =>
    row({ slot_id: slotId, cursor, entry_key: entryKey, entity_id: entityId, recorded_at: at });
  const empty: StagedRows = {
    entities: [],
    slots: [],
    slot_history: [],
    runtime_resource_bindings: [],
    context_edges: [],
    workspace_meta: [],
  };

  it("orders rows by their own timestamps, with the markers first", () => {
    const events = planReplay({
      ...empty,
      workspace_meta: [row({ key: "initial-panels", value: "[]" }), row({ key: "panel_tree_revision", value: "9" })],
      entities: [entity("e2", T0 + 20), entity("e1", T0 + 10)],
      slots: [slot("s1", T0 + 30, { current_entity_id: "e1", current_entry_key: "k1" })],
      slot_history: [history("s1", 0, "k1", "e1", T0 + 30)],
    });
    expect(events.map((event) => `${event.kind}:${event.key.replace("\u001f", "/")}`)).toEqual([
      "meta:initial-panels",
      "entity:e1",
      "entity:e2",
      "slot:s1",
      "history:s1/0",
    ]);
  });

  it("closes every slot that one close took down in one event at the shared stamp, with the entity each had", () => {
    const events = planReplay({
      ...empty,
      entities: [entity("e1", T0), entity("e2", T0 + 1)],
      slots: [
        slot("root", T0 + 2, { current_entry_key: "k1", closed_at: T0 + 50 }),
        slot("child", T0 + 3, { parent_slot_id: "root", current_entry_key: "k2", closed_at: T0 + 50 }),
      ],
      slot_history: [history("root", 0, "k1", "e1", T0 + 2), history("child", 0, "k2", "e2", T0 + 3)],
    });
    expect(events.filter((event) => event.kind === "close")).toEqual([
      { kind: "close", time: T0 + 50, key: String(T0 + 50) },
    ]);
    // A closed slot first arrives open, on the entity its current entry names.
    expect(events.find((event) => event.kind === "slot" && event.key === "root")?.entityId).toBe("e1");
    expect(events.find((event) => event.kind === "slot" && event.key === "child")?.entityId).toBe("e2");
    expect(events.at(-1)?.kind).toBe("close");
  });

  it("retires an entity at retired_at after it arrived live", () => {
    const events = planReplay({
      ...empty,
      entities: [entity("e1", T0, { status: "retired", retired_at: T0 + 9 })],
    });
    expect(events).toEqual([
      { kind: "entity", time: T0, key: "e1" },
      { kind: "retire", time: T0 + 9, key: "e1" },
    ]);
  });

  it("pulls what a row references ahead of it, however deep the chain", () => {
    // Every slot is a child of the next one created, so by timestamp each arrives before its parent.
    const slots: LegacyRow[] = [];
    const depth = 3_000;
    for (let level = 0; level < depth; level += 1) {
      slots.push(
        slot(`s${level}`, T0 + level, { parent_slot_id: level + 1 < depth ? `s${level + 1}` : null })
      );
    }
    const events = planReplay({ ...empty, slots });
    const order = events.map((event) => event.key);
    expect(order).toHaveLength(depth);
    for (let level = 0; level + 1 < depth; level += 1) {
      expect(order.indexOf(`s${level + 1}`)).toBeLessThan(order.indexOf(`s${level}`));
    }
  });

  it("is a pure function of the rows: the same rows plan the same sequence", () => {
    const rows: StagedRows = {
      ...empty,
      entities: [entity("e1", T0), entity("e2", T0)],
      slots: [slot("s1", T0, { current_entity_id: "e1", current_entry_key: "k" })],
      slot_history: [history("s1", 0, "k", "e1", T0)],
    };
    expect(planReplay(rows)).toEqual(planReplay({ ...rows, entities: [...rows.entities].reverse() }));
  });
});

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

type SourceWorkspace = Awaited<ReturnType<typeof createWorkspaceStateTestDO>>;

/** Rows of every legacy table, as the retired store would hold them. */
function legacyRowsOf(source: SourceWorkspace): Record<LegacyImportTable, LegacyRow[]> {
  const tables = {} as Record<LegacyImportTable, LegacyRow[]>;
  for (const table of LEGACY_IMPORT_TABLES) {
    const columns = LEGACY_COLUMNS[table].join(", ");
    tables[table] = (
      table === "workspace_meta"
        ? source.sql.exec(
            `SELECT ${columns} FROM workspace_meta UNION ALL SELECT ${columns} FROM local_workspace_meta`
          )
        : source.sql.exec(`SELECT ${columns} FROM ${table}`)
    ).toArray() as unknown as LegacyRow[];
  }
  return tables;
}

async function legacyStore(tables: Record<LegacyImportTable, LegacyRow[]>) {
  const SQL = await getSqlJs();
  const db: Database = new SQL.Database();
  createLegacyStoreSchema(db);
  for (const table of LEGACY_IMPORT_TABLES) {
    const columns = LEGACY_COLUMNS[table];
    for (const row of tables[table]) {
      db.run(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        columns.map((column) => row[column] ?? null)
      );
    }
  }
  const { instance } = await createTestDO(WorkspaceDO, undefined, { db });
  return { db, reader: instance as unknown as LegacyStoreReader & WorkspaceDO };
}

async function digestsOf(
  rows: Record<LegacyImportTable, LegacyRow[]>
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const table of LEGACY_IMPORT_TABLES) digests[table] = await digestRows(table, rows[table]);
  return digests;
}

/**
 * A workspace with history: panels that navigate, a subtree closed, a panel
 * closed and cleaned up, a closed panel reopened later, an entity retired, a
 * context edge and a resource binding, and operational state (an alarm, a
 * lifecycle lease, a close-cleanup outbox row). Each step happens at its own time.
 */
async function buildHistory(): Promise<SourceWorkspace> {
  const source = await createWorkspaceStateTestDO();
  const at = (offset: number) => vi.setSystemTime(T0 + offset);
  const { instance } = source;
  at(0);
  instance.initializePanels([]);

  at(1_000);
  const rootEntity = instance.entityActivate(panel("root-1"));
  instance.slotCreate({ slotId: "root", parentSlotId: null, initialEntry: entry(rootEntity) });
  at(2_000);
  const childEntity = instance.entityActivate(panel("child-1"));
  instance.slotCreate({ slotId: "child", parentSlotId: "root", initialEntry: entry(childEntity) });
  at(3_000);
  const second = instance.entityActivate(panel("root-2"));
  instance.slotCommitPreparedNavigation({
    slotId: "root",
    expectedCurrentEntityId: rootEntity.id,
    mutation: { kind: "append", entry: { ...entry(second), stateArgs: { page: 2 } } },
  });
  at(4_000);
  const otherEntity = instance.entityActivate(panel("other-1"));
  instance.slotCreate({ slotId: "other", parentSlotId: null, initialEntry: entry(otherEntity) });
  instance.runtimeResourceBindingsReplace(second.id, [
    {
      resource: { kind: "panel-slot", id: "other" },
      capabilities: ["panel.inspect"],
      scope: { kind: "entity" },
    },
  ]);
  instance.contextEdgeUpsert({ contextId: "ctx-2", ownerContextId: "ctx-1", kind: "lineage" });

  // A subtree closed, whose runtime cleanup has not finished (the outbox keeps it).
  at(5_000);
  instance.slotClose("root");

  // A panel closed, cleaned up, and an entity retired and collected as the runtime does.
  at(6_000);
  instance.slotClose("other");
  const retired = instance.entityRetire(otherEntity.id)!;
  instance.entityCleanupComplete(retired.id, retired.authoritySessionId ?? "");
  instance.slotCloseCleanupAck(["other"]);

  // Operational state of a Durable Object.
  at(7_000);
  const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
  instance.entityActivate({
    nativeOwner: null,
    durableWorkQueues: [],
    kind: "do",
    source: { repoPath: SOURCE, effectiveVersion: "v1" },
    contextId: "ctx-1",
    className: key.className,
    key: key.objectKey,
    activeBuildKey: "b".repeat(64),
    activeExecutionDigest: "a".repeat(64),
    activeAuthority: AUTHORITY,
  });
  instance.alarmAdoptWorker("driver-1");
  instance.alarmSet({ ...key, wakeAt: T0 + 60_000 });
  instance.lifecycleLeaseUpsert({ ...key, detail: { turnId: "t-1" } });
  at(8_000);
  return source;
}

describe("the legacy import", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  const importerOf = (target: SourceWorkspace) =>
    target.instance as unknown as LegacyStoreImporter;

  async function importInto(
    target: SourceWorkspace,
    reader: LegacyStoreReader,
    options: { importer?: LegacyStoreImporter; pageRows?: number } = {}
  ) {
    return importLegacyWorkspaceState({
      legacy: reader,
      target: options.importer ?? importerOf(target),
      pageRows: options.pageRows ?? 3,
    });
  }

  it("settles a fresh workspace without a retired store, and never reads one afterwards", async () => {
    const target = await createWorkspaceStateTestDO();
    const { reader } = await legacyStore(
      Object.fromEntries(LEGACY_IMPORT_TABLES.map((table) => [table, []])) as never
    );
    // An empty SQLite cell has no workspace tables at all.
    const result = await importLegacyWorkspaceState({
      legacy: { ...reader, legacyManifest: async () => ({ present: false, schemaVersion: null, tables: [], digest: "0".repeat(64) }) } as LegacyStoreReader,
      target: importerOf(target),
    });
    expect(result.outcome).toBe("skipped");
    const again = await importLegacyWorkspaceState({
      legacy: {
        legacyManifest: async () => {
          throw new Error("must not read the retired store again");
        },
        legacyReadRows: async () => {
          throw new Error("must not read the retired store again");
        },
      },
      target: importerOf(target),
    });
    expect(again.outcome).toBe("settled");
  });

  it("replays history into commits with their original times, preserves every row, and leaves the retired store untouched", async () => {
    const source = await buildHistory();
    const rows = legacyRowsOf(source);
    const { reader, db } = await legacyStore(rows);
    const before = await reader.legacyManifest();
    const stateBefore = db.export();

    const target = await createWorkspaceStateTestDO();
    const baseCommits = target.fake.dolt.log().length;
    const result = await importInto(target, reader);
    expect(result.outcome).toBe("imported");
    expect(result.status).toMatchObject({ phase: "verified", manifestDigest: before.digest });

    // Every legacy table is equal, row for row (order aside).
    expect(await digestsOf(legacyRowsOf(target))).toMatchObject(
      Object.fromEntries(
        Object.entries(await digestsOf(rows)).filter(([table]) => table !== "state")
      )
    );
    // The source's operational state is carried, and nothing else is lost.
    expect(target.instance.alarmNextWakeAt(0)).toBe(T0 + 60_000);
    expect(target.instance.lifecycleListLeases()).toHaveLength(1);
    expect(target.instance.slotCloseCleanupPage({}).items.map((item) => item.slotId)).toEqual([
      "child",
      "root",
    ]);
    expect(target.instance.panelTreeRootGroups({ limit: 5 }).revision).toBe(
      source.instance.panelTreeRootGroups({ limit: 5 }).revision
    );

    // History: one commit per event, dated as the row's own timestamp, oldest first.
    const replay = target.fake.dolt
      .log({ limit: 500 })
      .filter((commit) => commit.message.startsWith("replay: "))
      .reverse();
    expect(replay.length).toBeGreaterThan(8);
    const dates = replay.map((commit) => new Date(commit.date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    // The workspace marker has no time of its own: it arrives with the first row.
    expect(dates[0]).toBe(T0 + 1_000);
    const closeCommit = replay.find((commit) => commit.message.startsWith("replay: close"))!;
    expect(new Date(closeCommit.date).getTime()).toBe(T0 + 5_000);
    expect(target.fake.dolt.log({ limit: 1 })[0]!.message).toMatch(/^import: workspace state/u);
    expect(target.fake.dolt.log().length).toBeGreaterThan(baseCommits + replay.length);
    expect(target.fake.dolt.status()).toEqual([]);

    // The retired store did not change by a byte.
    expect(db.export()).toEqual(stateBefore);
    expect((await reader.legacyManifest()).digest).toBe(before.digest);
  });

  it("makes the closed panels of the retired store undoable and reopenable on the new cell", async () => {
    const source = await buildHistory();
    const { reader } = await legacyStore(legacyRowsOf(source));
    const target = await createWorkspaceStateTestDO();
    await importInto(target, reader);
    const { instance, fake } = target;

    // The same closed panels, as the retired store listed them.
    expect(instance.slotClosedRoots({}).items).toEqual(source.instance.slotClosedRoots({}).items);

    // Resetting to the commit before the subtree close brings the subtree back whole: the undo.
    const log = fake.dolt.log({ limit: 500 });
    const closeIndex = log.findIndex((commit) => commit.message.startsWith("replay: close"));
    const lastClose = log.slice(closeIndex).find((commit) => commit.message.startsWith("replay: close"))!;
    const beforeLastClose = log[log.indexOf(lastClose) + 1]!;
    expect(instance.slotGet("other")?.closed_at).not.toBeNull();
    fake.dolt.reset({ hard: true, to: beforeLastClose.hash });
    expect(instance.slotGet("other")?.closed_at).toBeNull();
    expect(instance.slotGet("other")?.current_entity_id).not.toBeNull();
    // Operational state did not move.
    expect(instance.alarmNextWakeAt(0)).toBe(T0 + 60_000);

    // And reopening through the class works on the imported rows.
    const live = await createWorkspaceStateTestDO();
    await importInto(live, reader);
    // The runtime's cleanup of the close finishes, the entries are reactivated, the close reopens.
    live.instance.slotCloseCleanupAck(["root", "child"]);
    const plan = live.instance.slotReopenPlan("root");
    for (const { entry: history } of plan.slots) live.instance.entityActivate(panel(history.entry_key));
    expect(
      live.instance.slotReopen({ slotId: "root", closedAt: plan.closedAt }).reopenedCount
    ).toBe(2);
    expect(live.instance.slotGet("child")?.closed_at).toBeNull();
  });

  it("is idempotent: a second run changes nothing, and a run that stops anywhere resumes to the same result", async () => {
    const source = await buildHistory();
    const rows = legacyRowsOf(source);
    const { reader } = await legacyStore(rows);

    const straight = await createWorkspaceStateTestDO();
    await importInto(straight, reader);
    // Every fake store starts with its own initial commit; the history after it is the comparison.
    const messagesOf = (store: SourceWorkspace) =>
      store.fake.dolt
        .log({ limit: 500 })
        .map((commit) => commit.message)
        .slice(0, -1);
    const straightLog = messagesOf(straight);

    const again = await importInto(straight, reader);
    expect(again.outcome).toBe("settled");
    expect(messagesOf(straight)).toEqual(straightLog);

    // A process that dies after k calls to the importer, for every k, then a fresh run.
    const calls = await countCalls(reader, rows);
    for (const stopAfter of [1, 2, 5, Math.floor(calls / 2), calls - 2, calls - 1]) {
      const target = await createWorkspaceStateTestDO();
      let seen = 0;
      const dying = new Proxy(importerOf(target), {
        get(object, property: keyof LegacyStoreImporter) {
          return async (...args: never[]) => {
            if (seen++ >= stopAfter) throw new Error("the process died");
            return (object[property] as (...input: never[]) => unknown)(...args);
          };
        },
      });
      await expect(importInto(target, reader, { importer: dying })).rejects.toThrow("process died");
      // The cell restarts (nothing but its durable state), and the host runs the driver again.
      const restarted = await createWorkspaceStateTestDO({ fake: await target.fake.restart() });
      const finished = await importInto(restarted, reader);
      expect(finished.outcome).toBe("imported");
      expect(await digestsOf(legacyRowsOf(restarted))).toMatchObject(
        Object.fromEntries(
          Object.entries(await digestsOf(rows)).filter(([table]) => table !== "state")
        )
      );
      // One commit per event, no duplicates, no gaps.
      expect(messagesOf(restarted)).toEqual(straightLog);
    }
  });

  it("starts over when the retired store changed since staging began, and imports what it holds now", async () => {
    const source = await buildHistory();
    const rows = legacyRowsOf(source);
    const { reader, db } = await legacyStore(rows);
    const target = await createWorkspaceStateTestDO();
    const importer = importerOf(target);

    // Stage and replay part of the first version, then the process dies.
    const first = await reader.legacyManifest();
    await importer.legacyImportBegin(first);
    for (const table of LEGACY_IMPORT_TABLES) {
      const page = await reader.legacyReadRows({ table, afterRowid: 0, limit: 500 });
      if (page.rows.length > 0) await importer.legacyImportStage({ table, rows: page.rows });
    }
    await importer.legacyImportReplay({ budgetMs: 1 });

    // The retired store is written again (an older build ran against it).
    db.run(`UPDATE slots SET sort_key = sort_key + 7 WHERE slot_id = 'other'`);
    const result = await importInto(target, reader);
    expect(result.outcome).toBe("imported");
    expect(result.status.manifestDigest).not.toBe(first.digest);
    expect(target.instance.slotGet("other")?.sort_key).toBe(
      (source.instance.slotGet("other")?.sort_key ?? 0) + 7
    );
    expect(target.fake.dolt.status()).toEqual([]);
  });

  it("refuses to import into a cell that already holds workspace state, and does not read the retired store", async () => {
    const target = await createWorkspaceStateTestDO();
    target.instance.slotCreate({ slotId: "existing", parentSlotId: null });
    const result = await importLegacyWorkspaceState({
      legacy: {
        legacyManifest: async () => {
          throw new Error("must not be read");
        },
        legacyReadRows: async () => {
          throw new Error("must not be read");
        },
      },
      target: importerOf(target),
    });
    expect(result.outcome).toBe("settled");
    expect(result.status.phase).toBe("adopted");
    expect(target.instance.slotGet("existing")).not.toBeNull();
  });

  it("does not verify an import whose rows differ from the retired store", async () => {
    const source = await buildHistory();
    const { reader } = await legacyStore(legacyRowsOf(source));
    const target = await createWorkspaceStateTestDO();
    const importer = importerOf(target);
    const manifest = await reader.legacyManifest();
    await importer.legacyImportBegin(manifest);
    for (const table of LEGACY_IMPORT_TABLES) {
      const page = await reader.legacyReadRows({ table, afterRowid: 0, limit: 500 });
      if (page.rows.length > 0) await importer.legacyImportStage({ table, rows: page.rows });
    }
    for (;;) {
      if ((await importer.legacyImportReplay({ budgetMs: 1_000 })).done) break;
    }
    // Something writes to the imported rows before the proof.
    target.sql.exec(`UPDATE slots SET sort_key = sort_key + 1 WHERE slot_id = 'other'`);
    await expect(importer.legacyImportFinish(manifest)).rejects.toThrow(
      /does not equal the retired store: slots/u
    );
    expect((await importer.legacyImportStatus()).phase).toBe("replaying");
  });
});

/** How many calls the driver makes to the importer for this store, to pick crash points. */
async function countCalls(reader: LegacyStoreReader, rows: Record<LegacyImportTable, LegacyRow[]>) {
  void rows;
  const target = await createWorkspaceStateTestDO();
  let calls = 0;
  const counting = new Proxy(target.instance as unknown as LegacyStoreImporter, {
    get(object, property: keyof LegacyStoreImporter) {
      return async (...args: never[]) => {
        calls += 1;
        return (object[property] as (...input: never[]) => unknown)(...args);
      };
    },
  });
  await importLegacyWorkspaceState({ legacy: reader, target: counting, pageRows: 3 });
  return calls;
}
