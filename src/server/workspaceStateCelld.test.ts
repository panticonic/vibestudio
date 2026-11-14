/**
 * `WorkspaceStateDO` on the real fork: the Dolt class P3 moved the workspace
 * state to, and the one-time import from the SQLite class it replaced. The
 * unit tests (`WorkspaceStateDO.test.ts`, `legacyImport.test.ts`) run on the
 * `FakeDoltStorage` double; this file is what the double cannot show:
 * the real engine's schema text, `dolt_status` inside a transaction, a hard
 * reset that is durable, local tables across a kill, and a crash in the middle
 * of the import. Skipped without a celld binary (`VIBESTUDIO_CELLD_BIN`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { doltLocalPatterns } from "../../packages/durable/src/dolt.js";
import { WORKSPACE_STATE_LOCAL_TABLES } from "../../packages/service-schemas/src/workspaceStateStorage.js";
import {
  LEGACY_COLUMNS,
  LEGACY_IMPORT_TABLES,
  digestRows,
  type LegacyImportTable,
  type LegacyRow,
} from "../../packages/builtin/src/workspace-state/legacyImport.js";
import {
  importLegacyWorkspaceState,
  type LegacyStoreImporter,
  type LegacyStoreReader,
} from "../../packages/builtin/src/workspace-state/legacyImportDriver.js";
import { LEGACY_STORE_DDL } from "../../packages/builtin/src/workspace-state/legacyStoreFixture.js";
import { celldTestBinary, startCelldProbe } from "../../tests/helpers/celldNodeHarness.js";

const SOURCE = "panels/example";
const AUTHORITY = { provides: [], requests: [], serviceRequests: [] };

/**
 * The real classes, each with the probe's endpoints beside them (the probe
 * handler routes by the object's class; the product classes are not touched):
 * `POST /probe` takes `{ method, args }` and calls the method, as the host's
 * dispatch does, and the legacy class takes a `seed` to fill its tables.
 */
function probeSource(): string {
  const root = process.cwd();
  return `
    import { WorkspaceStateDO as RealState } from ${JSON.stringify(`${root}/packages/builtin/src/workspace-state/WorkspaceStateDO.ts`)};
    import { WorkspaceDO as RealLegacy } from ${JSON.stringify(`${root}/packages/builtin/src/workspace-state/WorkspaceDO.ts`)};
    const json = (value) => new Response(JSON.stringify(value ?? null), { headers: { 'content-type': 'application/json' } });
    async function call(self, request) {
      const { method, args } = await request.json();
      const result = await self[method](...(args ?? []));
      return json({ result: result ?? null });
    }
    export class WorkspaceStateDO extends RealState {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== '/probe') return super.fetch(request);
        await this.initializeSchema();
        const body = await request.clone().json();
        if (body.method === '__info') {
          const dolt = this.ctx.storage.dolt;
          const rows = (sql) => this.sql.exec(sql).toArray();
          return json({
            branch: dolt.branch.current(),
            log: dolt.log({ limit: 500 }).map((commit) => ({ message: commit.message, date: commit.date, hash: commit.hash })),
            status: dolt.status(),
            tables: rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name),
            rows: Object.fromEntries(body.args[0].map((table) => [table, rows(body.args[1][table])])),
          });
        }
        if (body.method === '__dolt') {
          const path = body.args[0].split('.');
          const target = path.slice(0, -1).reduce((value, key) => value[key], this.ctx.storage.dolt);
          return json({ result: target[path[path.length - 1]](...body.args[1]) ?? null });
        }
        try { return await call(this, request); }
        catch (error) { return new Response(String(error && error.message || error), { status: 500 }); }
      }
    }
    export class WorkspaceDO extends RealLegacy {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== '/probe') return super.fetch(request);
        const body = await request.clone().json();
        if (body.method === '__seed') {
          for (const statement of body.args[0]) this.sql.exec(statement);
          for (const [table, columns, rows] of body.args[1]) {
            for (const row of rows) {
              this.sql.exec('INSERT OR REPLACE INTO ' + table + ' (' + columns.join(', ') + ') VALUES (' + columns.map(() => '?').join(', ') + ')', ...columns.map((column) => row[column] ?? null));
            }
          }
          return json({ result: true });
        }
        try { return await call(this, request); }
        catch (error) { return new Response(String(error && error.message || error), { status: 500 }); }
      }
    }
    export default {
      fetch(request, env) {
        const url = new URL(request.url);
        const [, kind, name] = url.pathname.split('/');
        const namespace = kind === 'legacy' ? env.LEGACY : env.STATE;
        const stub = namespace.get(namespace.idFromName(name));
        return stub.fetch(new Request(new URL('/probe', url), { method: 'POST', body: request.body, headers: request.headers }));
      }
    };
  `;
}

async function bundleProbe(): Promise<string> {
  const result = await build({
    stdin: {
      contents: probeSource(),
      resolveDir: process.cwd(),
      sourcefile: "workspace-state-probe.ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["worker", "browser"],
    external: ["node:*"],
    write: false,
    logLevel: "error",
  });
  const text = result.outputFiles[0]?.text;
  if (!text) throw new Error("Missing workspace-state probe bundle");
  return text;
}

type Tables = Record<LegacyImportTable, LegacyRow[]>;
const TABLE_SQL: Record<LegacyImportTable, string> = Object.fromEntries(
  LEGACY_IMPORT_TABLES.map((table) => [
    table,
    table === "workspace_meta"
      ? `SELECT key, value FROM workspace_meta UNION ALL SELECT key, value FROM local_workspace_meta`
      : `SELECT ${LEGACY_COLUMNS[table].join(", ")} FROM ${table}`,
  ])
) as Record<LegacyImportTable, string>;

async function startWorkspaceProbe() {
  const root = await mkdtemp(join(homedir(), ".workspace-state-probe-"));
  const probe = await startCelldProbe({
    root,
    bundle: await bundleProbe(),
    classes: ["WorkspaceDO"],
    doltClasses: ["WorkspaceStateDO"],
    bindings: [
      { name: "LEGACY", class_name: "WorkspaceDO" },
      { name: "STATE", class_name: "WorkspaceStateDO" },
    ],
    celld: {
      durable_objects: {
        WorkspaceStateDO: { doltLocal: doltLocalPatterns([...WORKSPACE_STATE_LOCAL_TABLES]) },
      },
    },
    vars: { WORKER_CLASS_NAME: "WorkspaceStateDO" },
  });
  const requests = new AbortController();
  let cleaning: Promise<void> | undefined;
  onTestFinished(
    () =>
      (cleaning ??= (async () => {
        requests.abort(new Error("workspace state probe retired"));
        await probe.kill();
        await rm(root, { recursive: true, force: true });
      })())
  );
  await probe.start();
  const rpc = async <T = unknown>(
    kind: "state" | "legacy",
    name: string,
    method: string,
    ...args: unknown[]
  ): Promise<T> => {
    const response = await fetch(`${probe.endpoint}/${kind}/${name}/x`, {
      method: "POST",
      body: JSON.stringify({ method, args }),
      headers: { "content-type": "application/json" },
      signal: requests.signal,
    });
    if (!response.ok) throw new Error(`${kind}.${method} failed: ${await response.text()}`);
    const body = (await response.json()) as { result?: T } & T;
    return ("result" in body ? body.result : body) as T;
  };
  const state = (name: string) => ({
    call: <T = unknown>(method: string, ...args: unknown[]) =>
      rpc<T>("state", name, method, ...args),
    info: () =>
      rpc<{
        branch: string;
        log: Array<{ message: string; date: string; hash: string }>;
        status: Array<{ table: string; status: string }>;
        tables: string[];
        rows: Record<string, LegacyRow[]>;
      }>("state", name, "__info", LEGACY_IMPORT_TABLES, TABLE_SQL),
    dolt: <T = unknown>(method: string, ...args: unknown[]) =>
      rpc<T>("state", name, "__dolt", method, args),
  });
  const legacy = (name: string) => ({
    call: <T = unknown>(method: string, ...args: unknown[]) =>
      rpc<T>("legacy", name, method, ...args),
  });
  return { probe, state, legacy };
}

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

type StateHandle = ReturnType<Awaited<ReturnType<typeof startWorkspaceProbe>>["state"]>;
type Entity = { id: string; key: string };

/** A workspace with history, built through the class on the real engine. */
async function buildHistory(workspace: StateHandle): Promise<void> {
  const open = async (slotId: string, parent: string | null) => {
    const entity = await workspace.call<Entity>("entityActivate", panel(`${slotId}-entry`));
    await workspace.call("slotCreate", {
      slotId,
      parentSlotId: parent,
      initialEntry: entry(entity),
    });
    return entity;
  };
  await workspace.call("initializePanels", []);
  const root = await open("root", null);
  await open("child", "root");
  const next = await workspace.call<Entity>("entityActivate", panel("root-2"));
  await workspace.call("slotCommitPreparedNavigation", {
    slotId: "root",
    expectedCurrentEntityId: root.id,
    mutation: { kind: "append", entry: { ...entry(next), stateArgs: { page: 2 } } },
  });
  const other = await open("other", null);
  await workspace.call("contextEdgeUpsert", {
    contextId: "ctx-2",
    ownerContextId: "ctx-1",
    kind: "lineage",
  });
  await workspace.call("slotClose", "root");
  await workspace.call("slotClose", "other");
  const retired = await workspace.call<{ id: string; authoritySessionId: string }>(
    "entityRetire",
    other.id
  );
  await workspace.call("entityCleanupComplete", retired.id, retired.authoritySessionId);
  await workspace.call("slotCloseCleanupAck", ["other"]);
  const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
  await workspace.call("entityActivate", {
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
  await workspace.call("alarmAdoptWorker", "driver-1");
  await workspace.call("alarmSet", { ...key, wakeAt: 4_102_444_800_000 });
  await workspace.call("lifecycleLeaseUpsert", { ...key, detail: { turnId: "t-1" } });
}

it.skipIf(!celldTestBinary())(
  "the Dolt workspace store installs, commits each mutation once, undoes a close by a durable reset, and keeps local state across a kill",
  async () => {
    const { probe, state } = await startWorkspaceProbe();
    const workspace = state("ws-1");

    // The schema (partial indexes, foreign keys, CHECK) installs on the real engine as a commit.
    const installed = await workspace.info();
    expect(installed.branch).toBe("main");
    expect(installed.log.map((commit) => commit.message)).toContain("schema: WorkspaceStateDO v1");
    expect(installed.tables).toEqual(
      expect.arrayContaining(["entities", "slots", "slot_history", "do_alarms", "state"])
    );
    expect(installed.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);

    // One commit per mutation, none for an idempotent retry (dolt_status inside the transaction).
    const root = await workspace.call<Entity>("entityActivate", panel("root-entry"));
    const afterActivate = (await workspace.info()).log.length;
    await workspace.call("entityActivate", panel("root-entry"));
    expect((await workspace.info()).log.length).toBe(afterActivate);
    await workspace.call("slotCreate", {
      slotId: "root",
      parentSlotId: null,
      initialEntry: entry(root),
    });
    await workspace.call("slotCreate", {
      slotId: "root",
      parentSlotId: null,
      initialEntry: entry(root),
    });
    const afterCreate = await workspace.info();
    expect(afterCreate.log.length).toBe(afterActivate + 1);
    expect(afterCreate.log[0]?.message).toBe("create slot root");
    expect(afterCreate.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);
    const beforeClose = afterCreate.log[0]!.hash;

    // Close: one commit; the closed-panel list reads rows; the working set is clean.
    await workspace.call("slotClose", "root");
    await workspace.call("slotClose", "root");
    const closed = await workspace.info();
    expect(closed.log.length).toBe(afterCreate.log.length + 1);
    expect(closed.log[0]?.message).toBe("close panel root (1 slots)");
    // The reverse patch of the close commit touches the slot rows only: it is exactly what reopens it.
    const reverse = await workspace.dolt<{
      patch: Array<{ table: string; statement: string }>;
    }>("diff", { from: closed.log[0]!.hash, to: beforeClose });
    expect(reverse.patch.map((entry) => entry.table)).toEqual(["slots"]);
    expect(reverse.patch[0]!.statement).toMatch(/closed_at/u);

    // Operational state that must outlive the undo.
    const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
    await workspace.call("entityActivate", {
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
    await workspace.call("alarmAdoptWorker", "driver-1");
    await workspace.call("alarmSet", { ...key, wakeAt: 4_102_444_800_000 });
    await workspace.call("lifecycleLeaseUpsert", { ...key, detail: { turnId: "t" } });
    const revision = (
      await workspace.call<{ revision: number }>("panelTreeRootGroups", { limit: 5 })
    ).revision;

    // The undo of the close is a hard reset, and it survives a kill.
    await workspace.dolt("reset", { hard: true, to: beforeClose });
    expect(
      (await workspace.call<{ closed_at: number | null }>("slotGet", "root")).closed_at
    ).toBeNull();
    await probe.kill();
    await probe.start();
    expect(
      (await workspace.call<{ closed_at: number | null }>("slotGet", "root")).closed_at
    ).toBeNull();
    // Local tables were neither rewound nor lost; the revision did not go backwards.
    expect(await workspace.call("alarmNextWakeAt", 0)).toBe(4_102_444_800_000);
    expect(await workspace.call<unknown[]>("lifecycleListLeases")).toHaveLength(1);
    expect(
      (await workspace.call<{ revision: number }>("panelTreeRootGroups", { limit: 5 })).revision
    ).toBeGreaterThanOrEqual(revision);

    // Reopen as a commit of its own, after a close, on the restarted node.
    await workspace.call("slotClose", "root");
    await workspace.call("slotCloseCleanupAck", ["root"]);
    const plan = await workspace.call<{
      closedAt: number;
      slots: Array<{ entry: { entry_key: string } }>;
    }>("slotReopenPlan", "root");
    for (const { entry: history } of plan.slots) {
      await workspace.call("entityActivate", panel(history.entry_key));
    }
    await workspace.call("slotReopen", { slotId: "root", closedAt: plan.closedAt });
    const reopened = await workspace.info();
    expect(reopened.log[0]?.message).toBe("reopen panel root (1 slots)");
    expect(reopened.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);
  },
  240_000
);

it.skipIf(!celldTestBinary())(
  "the import moves a retired SQLite workspace into a Dolt cell on the real engine, survives a crash anywhere, and leaves the retired cell as it was",
  async () => {
    const { probe, state, legacy } = await startWorkspaceProbe();

    // A workspace with history, on a Dolt cell; its rows become the retired SQLite store.
    const source = state("ws-source");
    await buildHistory(source);
    const rows = (await source.info()).rows as Tables;
    const legacyCell = legacy("ws-1");
    await legacyCell.call(
      "__seed",
      LEGACY_STORE_DDL.concat([
        "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      ]),
      LEGACY_IMPORT_TABLES.map((table) => [
        table,
        LEGACY_COLUMNS[table],
        // The retired store enforces its foreign keys: parents before children, as they were written.
        [...rows[table]].sort(
          (a, b) =>
            Number(a["created_at"] ?? a["recorded_at"] ?? 0) -
            Number(b["created_at"] ?? b["recorded_at"] ?? 0)
        ),
      ])
    );

    const reader: LegacyStoreReader = {
      legacyManifest: () => legacyCell.call("legacyManifest"),
      legacyReadRows: (input) => legacyCell.call("legacyReadRows", input),
    };
    const manifestBefore = await reader.legacyManifest();
    expect(manifestBefore.present).toBe(true);
    expect(manifestBefore.tables.find((table) => table.name === "slot_history")?.rows).toBe(
      rows.slot_history.length
    );

    const target = state("ws-1");
    const importer = (methods: Set<string> | null, dieAfter: number): LegacyStoreImporter => {
      let seen = 0;
      return Object.fromEntries(
        [
          "legacyImportStatus",
          "legacyImportSkip",
          "legacyImportBegin",
          "legacyImportStage",
          "legacyImportReplay",
          "legacyImportFinish",
        ].map((method) => [
          method,
          async (...args: unknown[]) => {
            if (seen++ >= dieAfter) {
              await probe.kill();
              await probe.start();
              throw new Error("the node was killed mid-import");
            }
            methods?.add(method);
            return target.call(method, ...args);
          },
        ])
      ) as unknown as LegacyStoreImporter;
    };

    // The node is killed in the middle of staging, then in the middle of the replay.
    for (const dieAfter of [4, 5, 6, 7]) {
      await expect(
        importLegacyWorkspaceState({
          legacy: reader,
          target: importer(null, dieAfter),
          pageRows: 4,
          maxEvents: 3,
        })
      ).rejects.toThrow("killed mid-import");
    }
    const partial = await target.call<{ phase: string; applied: number; total: number }>(
      "legacyImportStatus"
    );
    expect(["staging", "replaying"]).toContain(partial.phase);

    // A run after the crashes finishes the move.
    const finished = await importLegacyWorkspaceState({
      legacy: reader,
      target: importer(null, Number.POSITIVE_INFINITY),
      pageRows: 4,
      maxEvents: 3,
    });
    expect(finished.outcome).toBe("imported");
    expect(finished.status.phase).toBe("verified");

    // Every table is the retired store's, row for row.
    const imported = (await target.info()).rows as Tables;
    for (const table of LEGACY_IMPORT_TABLES) {
      if (table === "state") continue;
      expect(await digestRows(table, imported[table])).toBe(await digestRows(table, rows[table]));
    }
    expect(await target.call("alarmNextWakeAt", 0)).toBe(4_102_444_800_000);

    // History: one commit per event with the row's own time, and a marker commit last.
    const info = await target.info();
    const replay = info.log.filter((commit) => commit.message.startsWith("replay: "));
    expect(replay.length).toBeGreaterThan(8);
    expect(info.log[0]?.message).toMatch(/^import: workspace state/u);
    expect(info.log.filter((commit) => commit.message.startsWith("import: "))).toHaveLength(1);
    expect(info.status.filter((entry) => !entry.table.startsWith("dolt_"))).toEqual([]);

    // Idempotent: the next run settles without reading the retired store, adding no commit.
    const again = await importLegacyWorkspaceState({
      legacy: {
        legacyManifest: async () => {
          throw new Error("must not read the retired store");
        },
        legacyReadRows: async () => {
          throw new Error("must not read the retired store");
        },
      },
      target: importer(null, Number.POSITIVE_INFINITY),
    });
    expect(again.outcome).toBe("settled");
    expect((await target.info()).log.length).toBe(info.log.length);

    // The retired cell was only read.
    expect((await reader.legacyManifest()).digest).toBe(manifestBefore.digest);

    // The undo of a replayed close is a hard reset to the commit before it, and it holds across a kill.
    const log = (await target.info()).log;
    const lastClose = log.findIndex((commit) => commit.message.startsWith("replay: close"));
    await target.dolt("reset", { hard: true, to: log[lastClose + 1]!.hash });
    await probe.kill();
    await probe.start();
    expect(
      (await target.call<{ closed_at: number | null }>("slotGet", "other")).closed_at
    ).toBeNull();
    expect(await target.call("alarmNextWakeAt", 0)).toBe(4_102_444_800_000);
  },
  420_000
);

it.skipIf(!celldTestBinary())(
  "a workspace with no retired store (its legacy cell is empty) settles as skipped, and the Dolt store works at once",
  async () => {
    const { state, legacy } = await startWorkspaceProbe();
    const legacyCell = legacy("ws-fresh");
    const target = state("ws-fresh");
    const result = await importLegacyWorkspaceState({
      legacy: {
        legacyManifest: () => legacyCell.call("legacyManifest"),
        legacyReadRows: (input) => legacyCell.call("legacyReadRows", input),
      },
      target: Object.fromEntries(
        [
          "legacyImportStatus",
          "legacyImportSkip",
          "legacyImportBegin",
          "legacyImportStage",
          "legacyImportReplay",
          "legacyImportFinish",
        ].map((method) => [method, (...args: unknown[]) => target.call(method, ...args)])
      ) as unknown as LegacyStoreImporter,
    });
    expect(result.outcome).toBe("skipped");
    const entity = await target.call<Entity>("entityActivate", panel("first"));
    expect(entity.key).toBe("first");
  },
  120_000
);
